import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import type { Node } from '@mockup/core';
import { Mcp, createDoc, drag, getDoc, gotoEditor } from './helpers';

/** Selection (click, Shift, marquee, double-click, Esc), arrows, reorder, resize and gesture undo. */

const HTML =
  '<section class="wrap"><div class="box a"></div><div class="box b"><span class="inner">in</span></div><div class="box c"></div></section>';
const CSS =
  '.wrap{display:flex;gap:20px;padding:40px}.box{width:120px;height:100px;background:#ccc}.b{padding:20px}.inner{display:block;width:50px;height:30px;background:red}';

async function setup(name: string, html = HTML, css = CSS) {
  const info = await createDoc(name);
  const mcp = await new Mcp().init();
  await mcp.call('create_frame', { name: 'Screen', width: 800, height: 600, x: 0, y: 0 });
  await mcp.call('write_html', { html, css });
  const frame = (await getDoc(info.docId)).pages[0]!.frames[0]!;
  return { info, mcp, frame };
}

const nodeEl = (page: Page, id: string) =>
  page.getByTestId('canvas-world').locator(`[data-node-id="${id}"]`).first();

async function centerOfNode(page: Page, id: string) {
  const box = (await nodeEl(page, id).boundingBox())!;
  return { x: box.x + box.width / 2, y: box.y + box.height / 2, box };
}

const rows = async (info: { docId: string }, parentId: string): Promise<string[]> => {
  const doc = await getDoc(info.docId);
  const find = (n: Node): Node | undefined =>
    n.id === parentId ? n : n.children.map(find).find(Boolean);
  const p = doc.pages[0]!.frames.map(find).find(Boolean)!;
  return p.children.map((c) => c.id);
};

test('Shift+click toggles the selection and the marquee selects multiple frames', async ({
  page,
}) => {
  const info = await createDoc('marquee');
  const mcp = await new Mcp().init();
  await mcp.call('create_frame', { name: 'A', width: 300, height: 200, x: 0, y: 0 });
  await mcp.call('create_frame', { name: 'B', width: 300, height: 200, x: 500, y: 0 });
  const [fa, fb] = (await getDoc(info.docId)).pages[0]!.frames;
  await gotoEditor(page);

  await page.getByTestId(`frame-label-${fa!.id}`).click();
  await page.getByTestId(`frame-label-${fb!.id}`).click({ modifiers: ['Shift'] });
  await expect.poll(() => mcp.call('get_selection', {})).toContain(fb!.id);
  expect(await mcp.call('get_selection', {})).toContain(fa!.id);
  // Shift+click on B again removes B from the selection.
  await page.getByTestId(`frame-label-${fb!.id}`).click({ modifiers: ['Shift'] });
  await expect.poll(() => mcp.call('get_selection', {})).not.toContain(fb!.id);
  expect(await mcp.call('get_selection', {})).toContain(fa!.id);

  // Marquee on empty space enclosing both frames.
  await page.keyboard.press('Escape');
  const a = (await nodeEl(page, fa!.id).boundingBox())!;
  const b = (await nodeEl(page, fb!.id).boundingBox())!;
  const canvas = (await page.getByTestId('canvas').boundingBox())!;
  const from = {
    x: Math.max(canvas.x + 4, Math.min(a.x, b.x) - 20),
    y: Math.max(canvas.y + 4, Math.min(a.y, b.y) - 45),
  };
  const to = { x: Math.max(a.x + a.width, b.x + b.width) + 20, y: a.y + a.height + 20 };
  await drag(page, from, to);
  await expect.poll(() => mcp.call('get_selection', {})).toContain(fa!.id);
  expect(await mcp.call('get_selection', {})).toContain(fb!.id);
});

test('click selects the frame child, double-click goes down and Esc goes up', async ({ page }) => {
  const { mcp, info, frame } = await setup('levels');
  const wrap = frame.children[0]!;
  const a = wrap.children[0]!;
  await gotoEditor(page);
  void info;

  const pa = await centerOfNode(page, a.id);
  await page.mouse.click(pa.x, pa.y);
  await expect.poll(() => mcp.call('get_selection', {})).toContain(wrap.id);
  expect(await mcp.call('get_selection', {})).not.toContain(a.id);

  await page.mouse.dblclick(pa.x, pa.y);
  await expect.poll(() => mcp.call('get_selection', {})).toContain(a.id);
  expect(await mcp.call('get_selection', {})).not.toContain(wrap.id);

  await page.keyboard.press('Escape');
  await expect.poll(() => mcp.call('get_selection', {})).toContain(wrap.id);
  expect(await mcp.call('get_selection', {})).not.toContain(a.id);
});

test('arrows move 1 px and Shift+arrows 10 px (frame and absolute node)', async ({ page }) => {
  const { info, frame } = await setup(
    'arrows',
    '<div class="abs">x</div>',
    '.abs{position:absolute;left:30px;top:40px;width:80px;height:50px;background:#9cf}',
  );
  const abs = frame.children[0]!;
  await gotoEditor(page);

  await page.getByTestId(`frame-label-${frame.id}`).click();
  // Waits for the canvas to reflect each arrow before the next one (arrows compute from the local document).
  const press = async (key: string) => {
    const before = await nodeEl(page, frame.id).boundingBox();
    await page.keyboard.press(key);
    await expect
      .poll(async () => {
        const b = await nodeEl(page, frame.id).boundingBox();
        return b?.x !== before?.x || b?.y !== before?.y;
      })
      .toBe(true);
  };
  await press('ArrowRight');
  await press('ArrowDown');
  await expect
    .poll(async () => (await getDoc(info.docId)).pages[0]!.frames[0]!.position)
    .toEqual({ x: 1, y: 1 });
  await press('Shift+ArrowLeft');
  await expect
    .poll(async () => (await getDoc(info.docId)).pages[0]!.frames[0]!.position)
    .toEqual({ x: -9, y: 1 });

  const p = await centerOfNode(page, abs.id);
  await page.keyboard.down('Control');
  await page.mouse.click(p.x, p.y);
  await page.keyboard.up('Control');
  await expect(page.getByTestId(`layer-row-${abs.id}`)).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('Shift+ArrowDown');
  await expect
    .poll(async () => {
      const n = (await getDoc(info.docId)).pages[0]!.frames[0]!.children[0]!;
      return [n.style.left, n.style.top];
    })
    .toEqual(['31px', '50px']);
});

test('reorder a child in a flex parent by dragging (to after and to before)', async ({ page }) => {
  const { info, frame } = await setup('reorder');
  const wrap = frame.children[0]!;
  const [a, b, c] = wrap.children.map((n) => n.id) as [string, string, string];
  await gotoEditor(page);

  // A -> after C: order B, C, A.
  const pa = await centerOfNode(page, a);
  await page.mouse.dblclick(pa.x, pa.y);
  await expect(page.getByTestId(`layer-row-${a}`)).toHaveAttribute('aria-selected', 'true');
  const pc = await centerOfNode(page, c);
  await drag(page, pa, { x: pc.box.x + pc.box.width - 10, y: pc.y }, { steps: 20 });
  await expect.poll(() => rows(info, wrap.id)).toEqual([b, c, a]);
  // The daemon answers the HTTP request before the editor renders `doc:changed`: measure A only after
  // the DOM reflects the new order (otherwise the drag starts at the old position).
  const domRows = () =>
    page
      .getByTestId('canvas-world')
      .locator(`[data-node-id="${wrap.id}"] > [data-node-id]`)
      .evaluateAll((els) => els.map((e) => e.getAttribute('data-node-id')));
  await expect.poll(domRows).toEqual([b, c, a]);

  // A (now last) -> before B: order A, B, C.
  const pa2 = await centerOfNode(page, a);
  const pb = await centerOfNode(page, b);
  await drag(page, pa2, { x: pb.box.x + 10, y: pb.y }, { steps: 20 });
  await expect.poll(() => rows(info, wrap.id)).toEqual([a, b, c]);

  // A single undo reverts the whole gesture.
  await page.keyboard.press('Control+z');
  await expect.poll(() => rows(info, wrap.id)).toEqual([b, c, a]);
});

test('Shift keeps the proportion and Alt resizes from the center', async ({ page }) => {
  const { info, frame } = await setup('resize');
  await gotoEditor(page);
  await page.getByTestId(`frame-label-${frame.id}`).click();
  const size = async () => {
    const f = (await getDoc(info.docId)).pages[0]!.frames[0]!;
    return { w: parseFloat(f.style.width!), h: parseFloat(f.style.height!), pos: f.position };
  };
  /** Adjusts the zoom to fit everything (the handle stays visible) and returns the southeast handle and the scale. */
  const prepare = async () => {
    // The overlay re-measures via rAF: wait for the southeast handle to reach the corner of the already framed frame.
    // Shift+1 frames by the model size: if the previous resize has not reached the editor yet,
    // it frames the old size and the handle ends up outside the canvas (under the panel). Retry until it fits.
    const handle = page.getByTestId('handle-se');
    const canvas = page.getByTestId('canvas');
    await expect
      .poll(async () => {
        await page.keyboard.press('Shift+1');
        const f = await nodeEl(page, frame.id).boundingBox();
        const h = await handle.boundingBox();
        const c = await canvas.boundingBox();
        if (!f || !h || !c) return Infinity;
        if (h.x + h.width > c.x + c.width || h.y + h.height > c.y + c.height) return Infinity;
        const dx = h.x + h.width / 2 - (f.x + f.width);
        const dy = h.y + h.height / 2 - (f.y + f.height);
        return Math.hypot(dx, dy);
      })
      .toBeLessThan(1.5);
    const s = await size();
    const z = (await nodeEl(page, frame.id).boundingBox())!.width / s.w;
    const h = (await handle.boundingBox())!;
    return { x: h.x + h.width / 2, y: h.y + h.height / 2, z };
  };

  // Shift: dragging only in x keeps the 4:3 proportion.
  let h0 = await prepare();
  await page.keyboard.down('Shift');
  await page.mouse.move(h0.x, h0.y);
  await page.mouse.down();
  await page.mouse.move(h0.x + 100 * h0.z, h0.y, { steps: 10 });
  await page.mouse.up();
  await page.keyboard.up('Shift');
  await expect.poll(async () => (await size()).w).toBeGreaterThan(850);
  const s1 = await size();
  expect(s1.w / s1.h).toBeCloseTo(800 / 600, 1);

  // Alt: grows to both sides; the position moves back by half of the increase.
  h0 = await prepare();
  await page.keyboard.down('Alt');
  await page.mouse.move(h0.x, h0.y);
  await page.mouse.down();
  await page.mouse.move(h0.x + 100 * h0.z, h0.y + 60 * h0.z, { steps: 10 });
  await page.mouse.up();
  await page.keyboard.up('Alt');
  await expect.poll(async () => (await size()).w).toBeGreaterThan(s1.w + 50);
  const after = await size();
  expect(s1.pos!.x - after.pos!.x).toBeCloseTo((after.w - s1.w) / 2, 0);
  expect(s1.pos!.y - after.pos!.y).toBeCloseTo((after.h - s1.h) / 2, 0);
});

test('a drag is a single undo entry', async ({ page }) => {
  const { info, frame } = await setup('undo-drag');
  await gotoEditor(page);
  const label = (await page.getByTestId(`frame-label-${frame.id}`).boundingBox())!;
  const from = { x: label.x + 10, y: label.y + label.height / 2 };
  await drag(page, from, { x: from.x + 200, y: from.y + 120 }, { steps: 30 });
  await expect
    .poll(async () => (await getDoc(info.docId)).pages[0]!.frames[0]!.position!.x)
    .toBeGreaterThan(50);
  await page.keyboard.press('Control+z');
  await expect
    .poll(async () => (await getDoc(info.docId)).pages[0]!.frames[0]!.position)
    .toEqual({ x: 0, y: 0 });
});

test('rapidly repeated arrows do not lose moves', async ({ page }) => {
  const { info, frame } = await setup('fast-arrows');
  await gotoEditor(page);
  await page.getByTestId(`frame-label-${frame.id}`).click();
  for (let i = 0; i < 10; i++) await page.keyboard.press('ArrowDown');
  await expect
    .poll(async () => (await getDoc(info.docId)).pages[0]!.frames[0]!.position!.y)
    .toBe(10);
});
