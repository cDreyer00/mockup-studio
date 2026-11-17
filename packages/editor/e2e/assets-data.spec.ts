import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import type { Document, Node } from '@mockup/core';
import { DAEMON, E2E_DIR, Mcp, createDoc, findByName, getDoc, gotoEditor } from './helpers';

/** Assets and data phase: upload in the assets panel, visual crop and repeater with 20 items. */

const CRC = Uint32Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (const b of buf) c = CRC[(c ^ b) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
/** RGB PNG with a gradient (no dependencies). */
function makePng(w: number, h: number): Buffer {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    const o = y * (w * 3 + 1);
    for (let x = 0; x < w; x++) {
      raw[o + 1 + x * 3] = Math.round((x / w) * 255);
      raw[o + 2 + x * 3] = Math.round((y / h) * 255);
      raw[o + 3 + x * 3] = 180;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const nodeEls = (page: Page, id: string) =>
  page.getByTestId('canvas-world').locator(`[data-node-id="${id}"]`);

async function setupFrame(name: string) {
  const info = await createDoc(name);
  const mcp = await new Mcp().init();
  await mcp.call('create_frame', { name: 'Screen', width: 960, height: 1400, x: 0, y: 0 });
  const frame = (await getDoc(info.docId)).pages[0]!.frames[0]!;
  return { info, mcp, frame };
}

test('assets: upload in the panel, usage, direct CDN link and insertion', async ({ page }) => {
  const { info } = await setupFrame('assets');
  await gotoEditor(page);
  await page.getByTestId('tab-assets').click();
  const panel = page.getByTestId('assets-panel');
  await expect(panel).toBeVisible();

  const file = path.join(E2E_DIR, 'cover-e2e.png');
  fs.writeFileSync(file, makePng(320, 200));
  await panel.locator('input[type="file"]').setInputFiles(file);
  const item = page.getByTestId('asset-item-cover-e2e.png');
  await expect(item).toBeVisible();

  const list = (await (await fetch(`${DAEMON}/api/assets/${info.docId}`)).json()) as {
    assets: { path: string; cdnUrl: string; uses: number; width?: number }[];
  };
  const asset = list.assets.find((a) => a.path === 'cover-e2e.png')!;
  expect(asset.uses).toBe(0);
  expect(asset.width).toBe(320);
  const cdn = await fetch(asset.cdnUrl);
  expect(cdn.status).toBe(200);
  expect(Buffer.from(await cdn.arrayBuffer()).equals(fs.readFileSync(file))).toBe(true);

  // Insert into the frame: the asset now has 1 use.
  await item.click();
  await page.getByTestId('asset-insert').first().click();
  await expect
    .poll(async () => {
      const doc = await getDoc(info.docId);
      let found = false;
      doc.pages[0]!.frames[0]!.children.forEach((c) => (found ||= c.src === 'cover-e2e.png'));
      return found;
    })
    .toBe(true);
});

test('image: visual crop with handles writes object-view-box', async ({ page }) => {
  const { info, mcp, frame } = await setupFrame('crop');
  const data = `data:image/png;base64,${makePng(400, 300).toString('base64')}`;
  await mcp.call('insert_image', {
    parentId: frame.id,
    source: data,
    name: 'Photo',
    styles: { width: '400px', height: '300px', 'object-fit': 'cover' },
  });
  const img = findByName(await getDoc(info.docId), 'Photo')!;
  await gotoEditor(page);
  await mcp.call('set_selection', { nodeIds: [img.id] });
  await expect(page.getByTestId('image-section')).toBeVisible();
  await page.getByTestId('image-crop-button').click();
  await expect(page.getByTestId('crop-overlay')).toBeVisible();

  // Drag the east handle to the left (~25% of the on-screen width).
  const handle = page.getByTestId('crop-handle-e');
  const hb = (await handle.boundingBox())!;
  const ib = (await nodeEls(page, img.id).first().boundingBox())!;
  await page.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2);
  await page.mouse.down();
  await page.mouse.move(hb.x + hb.width / 2 - ib.width / 4, hb.y + hb.height / 2, { steps: 10 });
  await page.mouse.up();
  await page.getByTestId('crop-apply').click();

  await expect
    .poll(async () => findByName(await getDoc(info.docId), 'Photo')!.style['object-view-box'])
    .toMatch(/^inset\(0% (2[0-9](\.\d+)?|30)% 0% 0%\)$/);
  // Undo removes the crop.
  await mcp.call('undo', {});
  await expect
    .poll(async () => findByName(await getDoc(info.docId), 'Photo')!.style['object-view-box'])
    .toBeUndefined();
});

const PEOPLE = Array.from({ length: 20 }, (_, i) => ({
  name: `Person ${String(i + 1).padStart(2, '0')}`,
  role: ['Design', 'Product', 'Engineering', 'Data'][i % 4],
  color: ['#6c5ce7', '#00b894', '#e17055', '#0984e3'][i % 4],
}));

test('data: JSON bind with 20 items shows up on the canvas and in the render', async ({ page }) => {
  const { info, mcp, frame } = await setupFrame('data');
  await mcp.call('write_html', {
    parentId: frame.id,
    html:
      '<div data-name="Team" style="display:grid;grid-template-columns:repeat(4,1fr);gap:16px;padding:24px">' +
      '<article style="padding:16px;border-radius:12px;background:#f1f2f6;display:flex;flex-direction:column;gap:6px">' +
      '<strong style="font-size:18px;color:#2d3436">{{name}}</strong>' +
      '<span style="font-size:14px;color:#636e72">{{role}} · #{{$number}}</span>' +
      '</article></div>',
  });
  const doc0 = await getDoc(info.docId);
  const grid = doc0.pages[0]!.frames[0]!.children[0]!;
  const text = await mcp.call('bind_data', { nodeId: grid.id, data: PEOPLE });
  expect(text).toMatch(/20 item/);

  const doc = await getDoc(info.docId);
  const rp = doc.pages[0]!.frames[0]!.children[0]!;
  expect(rp.type).toBe('repeater');
  expect(rp.data).toHaveLength(20);
  const card = rp.children[0]!;

  await gotoEditor(page);
  await expect(nodeEls(page, card.id)).toHaveCount(20);
  await expect(page.getByTestId('canvas-world')).toContainText('Person 20');
  await expect(page.getByTestId('canvas-world')).not.toContainText('{{name}}');

  // Selecting a middle item selects the template and shows the data panel on the repeater.
  await nodeEls(page, card.id).nth(9).click();
  await mcp.call('set_selection', { nodeIds: [rp.id] });
  await expect(page.getByTestId('data-section')).toBeVisible();
  await expect(page.getByTestId('data-table')).toBeVisible();
  await expect(page.getByTestId('data-cell-6-name')).toHaveValue('Person 07');
  // Editing a cell becomes setData and the canvas updates.
  await page.getByTestId('data-cell-0-name').fill('Ana Lima');
  await page.getByTestId('data-cell-0-name').blur();
  await expect(page.getByTestId('canvas-world')).toContainText('Ana Lima');
  await expect
    .poll(
      async () =>
        (
          (await getDoc(info.docId)).pages[0]!.frames[0]!.children[0]!.data as { name: string }[]
        )[0]!.name,
    )
    .toBe('Ana Lima');
  // The render below uses the document before the edit (20 original people).

  // Render: the same page the app's screenshot engine uses.
  const shot = await renderFrame(page, doc, info.docId, frame.id);
  const out = path.join(process.env.MOCKUP_E2E_SHOTS ?? E2E_DIR, 'data-20-items.png');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, shot.png);
  console.log(`[e2e] repeater screenshot: ${out}`);
  expect(shot.count).toBe(20);
  expect(shot.texts).toContain('Person 01');
  expect(shot.texts).toContain('Person 20');
});

async function renderFrame(
  page: Page,
  doc: Document,
  docId: string,
  frameId: string,
): Promise<{ png: Buffer; count: number; texts: string }> {
  const r = await page.context().newPage();
  await r.goto('/render.html');
  await r.waitForFunction(() => (window as { __mockupRenderReady?: boolean }).__mockupRenderReady);
  const box = await r.evaluate(
    async ({ doc, docId, nodeId }) =>
      (
        window as unknown as {
          __mockupRender: {
            render(p: unknown): Promise<{ x: number; y: number; width: number; height: number }>;
          };
        }
      ).__mockupRender.render({ doc, docId, nodeId }),
    { doc, docId, nodeId: frameId },
  );
  const card = (doc.pages[0]!.frames[0]!.children[0] as Node).children[0]!;
  const count = await r.locator(`[data-node-id="${card.id}"]`).count();
  const texts = (await r.locator('body').innerText()) ?? '';
  const png = await r.screenshot({ clip: box, type: 'png' });
  await r.close();
  return { png, count, texts };
}
