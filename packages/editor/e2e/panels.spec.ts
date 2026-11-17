import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { DAEMON, Mcp, createDoc, docPath, getDoc, gotoEditor } from './helpers';

/** Properties panel, pages, clipboard, image, MCP ↔ editor, file and reconnection. */

const HTML = '<section class="wrap"><div class="box a">A</div><div class="box b">B</div></section>';
const CSS =
  '.wrap{display:flex;gap:20px;padding:40px;width:500px}.box{width:120px;height:100px;background:#ccc}';

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

async function clickNode(page: Page, id: string) {
  const box = (await nodeEl(page, id).boundingBox())!;
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
}

const wrapOf = async (docId: string) => (await getDoc(docId)).pages[0]!.frames[0]!.children[0]!;

async function commitInput(page: Page, selector: string, value: string) {
  const input = page.locator(selector).first();
  await input.fill(value);
  await input.press('Enter');
}

test('properties panel: gap, padding, color, radius, shadow, name and tag', async ({ page }) => {
  const { info, frame } = await setup('props');
  const wrap = frame.children[0]!;
  await gotoEditor(page);
  await clickNode(page, wrap.children[0]!.id);
  await expect(page.getByTestId(`layer-row-${wrap.id}`)).toHaveAttribute('aria-selected', 'true');

  await commitInput(page, 'label[title="Spacing (gap)"] input', '32');
  await commitInput(page, 'label[title="Padding"] input', '24');
  await commitInput(page, 'label[title="Border radius"] input', '8');
  await commitInput(page, '[title="Background color"] input:not([type="color"])', '#ff0000');
  await page.locator('button[title="Add shadow"]').click();
  await expect.poll(async () => (await wrapOf(info.docId)).style['box-shadow']).toContain('12px');
  const st = (await wrapOf(info.docId)).style;
  expect(st.gap).toBe('32px');
  expect(st.padding).toBe('24px');
  expect(st['border-radius']).toBe('8px');
  expect(st.background).toBe('#ff0000');

  // The canvas DOM reflects the styles.
  const css = await nodeEl(page, wrap.id).evaluate((el) => {
    const c = getComputedStyle(el);
    return { gap: c.columnGap, padding: c.paddingLeft, radius: c.borderTopLeftRadius };
  });
  expect(css).toEqual({ gap: '32px', padding: '24px', radius: '8px' });

  // Rename through the panel.
  await commitInput(page, '[data-testid="prop-name"] input', 'Row');
  await expect.poll(async () => (await wrapOf(info.docId)).name).toBe('Row');

  // Change the tag (setTag op).
  await page.getByRole('button', { name: 'Tag and attributes' }).click();
  await page.locator('[data-testid="prop-tag"] select').selectOption('header');
  await expect.poll(async () => (await wrapOf(info.docId)).tag).toBe('header');
  await expect(nodeEl(page, wrap.id)).toHaveJSProperty('tagName', 'HEADER');

  // Advanced CSS: set and unset by diff.
  await page.getByRole('button', { name: 'Advanced CSS' }).click();
  const area = page.getByTestId('prop-css');
  const lines = (await area.inputValue()).split('\n').filter((l) => !l.startsWith('padding'));
  lines.push('opacity: 0.5;');
  await area.fill(lines.join('\n'));
  await area.press('Control+Enter');
  await expect.poll(async () => (await wrapOf(info.docId)).style.opacity).toBe('0.5');
  expect((await wrapOf(info.docId)).style.padding).toBeUndefined();
  expect((await wrapOf(info.docId)).style.gap).toBe('32px');

  // A single Ctrl+Z undoes the last command (the whole advanced CSS).
  await page.getByTestId('canvas').click({ position: { x: 3, y: 3 } });
  await clickNode(page, wrap.children[0]!.id);
  await page.keyboard.press('Control+z');
  await expect.poll(async () => (await wrapOf(info.docId)).style.padding).toBe('24px');
});

test('multi-selection shows "Mixed" for differing values', async ({ page }) => {
  const { frame } = await setup(
    'mixed',
    '<div class="a"><span>A</span></div><div class="b"><span>B</span></div>',
    '.a{width:100px;height:50px;padding:10px;background:#111}.b{width:100px;height:80px;padding:20px;background:#111}',
  );
  const [a, b] = frame.children;
  await gotoEditor(page);
  await page.getByTestId(`layer-row-${a!.id}`).click();
  await page.getByTestId(`layer-row-${b!.id}`).click({ modifiers: ['Control'] });
  await expect(page.getByTestId('prop-name').locator('input')).toHaveAttribute(
    'placeholder',
    'Mixed',
  );
  await expect(page.locator('label[title="Padding"] input')).toHaveAttribute(
    'placeholder',
    'Mixed',
  );
  await expect(page.locator('[data-testid="prop-h"] input')).toHaveAttribute(
    'placeholder',
    'Mixed',
  );
  // A value equal in both (width) is shown normally.
  await expect(page.locator('[data-testid="prop-w"] input')).toHaveValue('100px');
});

test('pages: create, rename, switch and delete (never the last one)', async ({ page }) => {
  const { info, frame } = await setup('pages');
  await gotoEditor(page);
  await page.getByTestId('add-page').click();
  await expect.poll(async () => (await getDoc(info.docId)).pages.length).toBe(2);
  const [p1, p2] = (await getDoc(info.docId)).pages;

  // Rename the new one (double-click on the name).
  await page.getByTestId(`page-item-${p2!.id}`).locator('.page-name').dblclick();
  const input = page.getByTestId('page-rename-input');
  await input.fill('Second');
  await input.press('Enter');
  await expect.poll(async () => (await getDoc(info.docId)).pages[1]!.name).toBe('Second');

  // Switch: the first has the frame, the second does not.
  await page.getByTestId(`page-item-${p1!.id}`).click();
  await expect(page.getByTestId(`frame-label-${frame.id}`)).toBeVisible();
  await page.getByTestId(`page-item-${p2!.id}`).click();
  await expect(page.getByTestId(`frame-label-${frame.id}`)).toHaveCount(0);

  // Delete the second one through the context menu.
  await page.getByTestId(`page-item-${p2!.id}`).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Delete' }).click();
  await expect.poll(async () => (await getDoc(info.docId)).pages.length).toBe(1);
  await expect(page.getByTestId(`frame-label-${frame.id}`)).toBeVisible();

  // The last one cannot be deleted.
  await page.getByTestId(`page-item-${p1!.id}`).click({ button: 'right' });
  await expect(page.getByRole('menuitem', { name: 'Delete' })).toBeDisabled();
  await page.keyboard.press('Escape');
  expect((await getDoc(info.docId)).pages.length).toBe(1);
});

test('clipboard: copy/paste with new ids, paste external HTML and cut', async ({ page }) => {
  const { info, frame } = await setup('clipboard');
  const wrap = frame.children[0]!;
  const a = wrap.children[0]!;
  await gotoEditor(page);
  const ids = async () => (await wrapOf(info.docId)).children.map((c) => c.id);

  await page.getByTestId(`layer-row-${a.id}`).click();
  await page.getByTestId('canvas').focus();
  await page.keyboard.press('Control+c');
  await page.keyboard.press('Control+v');
  await expect.poll(async () => (await ids()).length).toBe(3);
  const afterCopy = await ids();
  expect(new Set(afterCopy).size).toBe(3);
  expect(afterCopy).toContain(a.id);

  // External HTML (synthetic paste event with text/html).
  await page.getByTestId(`layer-row-${wrap.id}`).click();
  await page.evaluate(() => {
    const dt = new DataTransfer();
    dt.setData('text/html', '<p style="margin:0">Pasted from outside</p>');
    dt.setData('text/plain', 'Pasted from outside');
    document.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true }));
  });
  await expect(page.getByTestId('canvas-world').getByText('Pasted from outside')).toBeVisible();

  // Ctrl+X removes the selected node and Ctrl+V brings it back.
  const count = (await wrapOf(info.docId)).children.length;
  const last = (await wrapOf(info.docId)).children[count - 1]!;
  await page.getByTestId(`layer-row-${last.id}`).click();
  await page.getByTestId('canvas').focus();
  await page.keyboard.press('Control+x');
  await expect.poll(async () => (await ids()).length).toBe(count - 1);
  expect(await ids()).not.toContain(last.id);
});

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);

test('Image tool uploads the file to assets/ and renders the node with a relative src', async ({
  page,
}) => {
  const { info, frame } = await setup('image');
  await gotoEditor(page);
  const box = (await nodeEl(page, frame.id).boundingBox())!;
  const chooser = page.waitForEvent('filechooser');
  await page.getByTestId('tool-image').click();
  await page.mouse.click(box.x + 400, box.y + 450);
  (await chooser).setFiles({ name: 'photo.png', mimeType: 'image/png', buffer: PNG });

  await expect
    .poll(async () => {
      const f = (await getDoc(info.docId)).pages[0]!.frames[0]!;
      return f.children.some((c) => c.type === 'image');
    })
    .toBe(true);
  const img = (await getDoc(info.docId)).pages[0]!.frames[0]!.children.find(
    (c) => c.type === 'image',
  )!;
  expect(img.src).toBe('photo.png');
  expect(fs.existsSync(path.join(path.dirname(info.path!), 'assets', 'photo.png'))).toBe(true);
  await expect
    .poll(() =>
      nodeEl(page, img.id).evaluate((el) => {
        const i = el instanceof HTMLImageElement ? el : el.querySelector('img');
        return !!i && i.complete && i.naturalWidth > 0;
      }),
    )
    .toBe(true);
});

test('asset upload: a name with ../ is sanitized and does not escape assets/', async () => {
  const info = await createDoc('upload');
  const res = await fetch(
    `${DAEMON}/api/assets/${info.docId}?name=${encodeURIComponent('../../outside.png')}`,
    { method: 'POST', headers: { 'Content-Type': 'image/png' }, body: new Uint8Array(PNG) },
  );
  expect(res.status).toBe(200);
  expect(((await res.json()) as { src: string }).src).toBe('outside.png');
  const dir = path.dirname(info.path!);
  expect(fs.existsSync(path.join(dir, 'assets', 'outside.png'))).toBe(true);
  expect(fs.existsSync(path.join(dir, '..', 'outside.png'))).toBe(false);
  const missing = await fetch(`${DAEMON}/api/assets/doc_missing?name=a.png`, {
    method: 'POST',
    body: new Uint8Array(PNG),
  });
  expect(missing.status).toBe(404);
});

test('MCP → editor: set_selection frames the off-screen node', async ({ page }) => {
  const { info, mcp } = await setup('frame-it');
  await gotoEditor(page);
  await page.keyboard.press('Shift+0');
  await mcp.call('create_frame', { name: 'Far', width: 300, height: 200, x: 5000, y: 4000 });
  const far = (await getDoc(info.docId)).pages[0]!.frames[1]!;
  const canvas = (await page.getByTestId('canvas').boundingBox())!;
  await expect(page.getByTestId(`frame-label-${far.id}`)).toBeVisible();
  const outside = (await nodeEl(page, far.id).boundingBox())!;
  expect(outside.x > canvas.x + canvas.width || outside.y > canvas.y + canvas.height).toBe(true);

  await mcp.call('set_selection', { nodeIds: [far.id] });
  await expect(page.getByTestId(`layer-row-${far.id}`)).toHaveAttribute('aria-selected', 'true');
  await expect
    .poll(async () => {
      const b = (await nodeEl(page, far.id).boundingBox())!;
      return (
        b.x >= canvas.x - 1 &&
        b.y >= canvas.y - 1 &&
        b.x + b.width <= canvas.x + canvas.width + 1 &&
        b.y + b.height <= canvas.y + canvas.height + 1
      );
    })
    .toBe(true);
});

test('"AI" badge shows on the frame changed via MCP and disappears after a few seconds', async ({
  page,
}) => {
  const { info, mcp, frame } = await setup('badge');
  await gotoEditor(page);
  // wait for the initial creation badge to expire
  await expect(page.getByTestId(`agent-badge-${frame.id}`)).toHaveCount(0, { timeout: 9000 });
  const a = (await wrapOf(info.docId)).children[0]!;
  await mcp.call('update_styles', { nodeIds: [a.id], styles: { background: '#0f0' } });
  await expect(page.getByTestId(`agent-badge-${frame.id}`)).toBeVisible();
  await expect(page.getByTestId(`agent-badge-${frame.id}`)).toHaveCount(0, { timeout: 9000 });
});

test('file: New, recent, unsaved indicator and window title', async ({ page }) => {
  await createDoc('base');
  await gotoEditor(page);
  const file = docPath('new-doc');
  await page.getByTestId('menu-file').click();
  await page.getByTestId('file-new').click();
  await page.locator('.modal input[name="path"]').fill(file);
  await page.locator('.modal input[name="name"]').fill('New Doc');
  await page.locator('.modal button[type="submit"]').click();
  await expect(page.getByTestId('doc-title')).toContainText('New Doc');
  expect(fs.existsSync(file)).toBe(true);

  // Edit (frame via the tool): becomes "unsaved" and the title gets a ●; after autosave it goes away.
  await page.getByTestId('tool-frame').click();
  const canvas = (await page.getByTestId('canvas').boundingBox())!;
  await page.mouse.move(canvas.x + 200, canvas.y + 200);
  await page.mouse.down();
  await page.mouse.move(canvas.x + 400, canvas.y + 350, { steps: 8 });
  await page.mouse.up();
  await expect(page.getByTestId('dirty-indicator')).toBeVisible();
  await expect(page).toHaveTitle(/●/);
  await expect(page.getByTestId('dirty-indicator')).toHaveCount(0);
  await expect(page).not.toHaveTitle(/●/);
  await expect(page).toHaveTitle(/new-doc-\d+-\d+\.mockup\.json — Mockup Studio/);

  // Recent: the first item is the document just created; close and reopen through it.
  await page.getByTestId('menu-file').click();
  await page.getByTestId('file-close').click();
  await page.getByTestId('menu-file').click();
  await expect(page.getByTestId('file-recent-0')).toContainText(path.basename(file));
  await page.getByTestId('file-recent-0').click();
  await expect(page.getByTestId('doc-title')).toContainText('New Doc');
});

test('WS reconnection: the editor reconnects and reloads the document', async ({ page }) => {
  const { mcp, frame } = await setup('reconnect');
  let current: { close(): void } | null = null;
  await page.routeWebSocket(/\/ws$/, (ws) => {
    const server = ws.connectToServer();
    ws.onMessage((m) => server.send(m));
    server.onMessage((m) => ws.send(m));
    current = ws;
  });
  await gotoEditor(page);
  const status = page.getByTestId('connection-status');
  await expect(status).toHaveAttribute('data-status', 'online');
  await expect.poll(() => current !== null).toBe(true);

  // Drop the connection on the page side, change the document outside the editor and wait for it to come back.
  (current as unknown as { close(): void }).close();
  await expect(status).toHaveAttribute('data-status', 'offline');
  await mcp.call('update_styles', {
    nodeIds: [frame.id],
    styles: { background: '#123456' },
  });
  await expect(status).toHaveAttribute('data-status', 'online', { timeout: 15_000 });
  await expect
    .poll(() => nodeEl(page, frame.id).evaluate((el) => getComputedStyle(el).backgroundColor))
    .toBe('rgb(18, 52, 86)');
});

test('file: Save as writes to the new path and the title starts using it', async ({ page }) => {
  await createDoc('origin');
  await gotoEditor(page);
  const dest = docPath('copy');
  await page.getByTestId('menu-file').click();
  await page.getByTestId('file-save-as').click();
  await page.locator('.modal input[name="path"]').fill(dest);
  await page.locator('.modal button[type="submit"]').click();
  await expect.poll(() => page.title()).toContain(`${path.basename(dest)} — Mockup Studio`);
  expect(fs.existsSync(dest)).toBe(true);
});
