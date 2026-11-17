import fs from 'node:fs';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { Mcp, createDoc, drag, getDoc, gotoEditor } from './helpers';

/** Current canvas scale: rendered node width / model width in px. */
async function zoomOf(page: Page, nodeId: string, modelWidth: number): Promise<number> {
  const box = await page
    .getByTestId('canvas-world')
    .locator(`[data-node-id="${nodeId}"]`)
    .first()
    .boundingBox();
  if (!box) throw new Error('node not rendered');
  return box.width / modelWidth;
}

async function frameWithMcp(name: string, w = 400, h = 300) {
  const info = await createDoc(name);
  const mcp = await new Mcp().init();
  await mcp.call('create_frame', { name: 'Target', width: w, height: h, x: 0, y: 0 });
  const frame = (await getDoc(info.docId)).pages[0]!.frames[0]!;
  return { info, mcp, frame };
}

test('creates a frame with the Frame tool', async ({ page }) => {
  const info = await createDoc('frame-tool');
  await gotoEditor(page);
  await page.getByTestId('tool-frame').click();
  const canvas = (await page.getByTestId('canvas').boundingBox())!;
  await drag(
    page,
    { x: canvas.x + 200, y: canvas.y + 200 },
    { x: canvas.x + 500, y: canvas.y + 420 },
  );
  await expect.poll(async () => (await getDoc(info.docId)).pages[0]!.frames.length).toBe(1);
  const frame = (await getDoc(info.docId)).pages[0]!.frames[0]!;
  expect(parseFloat(frame.style.width!)).toBeGreaterThan(100);
  expect(parseFloat(frame.style.height!)).toBeGreaterThan(100);
  await expect(page.getByTestId(`frame-label-${frame.id}`)).toBeVisible();
  // The tool goes back to selection and the new frame is selected.
  await expect(page.getByTestId('selection-box')).toBeVisible();
});

test('HTML written via MCP shows up on the canvas without reloading and the selection syncs', async ({
  page,
}) => {
  const info = await createDoc('mcp');
  await gotoEditor(page);
  const mcp = await new Mcp().init();
  await mcp.call('create_frame', { name: 'Desktop', width: 800, height: 600, x: 0, y: 0 });
  await expect(page.locator('[data-testid^="frame-label-"]')).toHaveCount(1);

  await mcp.call('write_html', {
    html: '<section class="hero"><h1>Hello from the agent</h1><p>Made via MCP</p></section>',
    css: '.hero{display:flex;flex-direction:column;gap:16px;padding:48px}',
  });
  const world = page.getByTestId('canvas-world');
  await expect(world.getByText('Hello from the agent')).toBeVisible();
  // "Agent working" badge on the frame touched by the MCP.
  await expect(page.locator('[data-testid^="agent-badge-"]').first()).toBeVisible();

  // Editor → MCP: deep selection (Ctrl+click) shows up in get_selection.
  const doc = await getDoc(info.docId);
  const section = doc.pages[0]!.frames[0]!.children[0]!;
  const h1 = section.children[0]!;
  await world.getByText('Hello from the agent').click({ modifiers: ['Control'] });
  await expect.poll(() => mcp.call('get_selection', {})).toContain(h1.id);

  // MCP → editor: set_selection selects on the canvas.
  await mcp.call('set_selection', { nodeIds: [section.id] });
  await expect(page.getByTestId(`layer-row-${section.id}`)).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await expect(page.getByTestId('selection-box')).toBeVisible();
});

test('moves and resizes a frame', async ({ page }) => {
  const { info, frame } = await frameWithMcp('move');
  await gotoEditor(page);
  const z = await zoomOf(page, frame.id, 400);

  // Move by dragging the frame name.
  const label = (await page.getByTestId(`frame-label-${frame.id}`).boundingBox())!;
  const from = { x: label.x + 10, y: label.y + label.height / 2 };
  await drag(page, from, { x: from.x + 150, y: from.y + 80 });
  await expect
    .poll(async () => (await getDoc(info.docId)).pages[0]!.frames[0]!.position)
    .toEqual({ x: Math.round(150 / z), y: Math.round(80 / z) });

  // Resize through the southeast handle.
  await expect(page.getByTestId('selection-box')).toBeVisible();
  const handle = (await page.getByTestId('handle-se').boundingBox())!;
  const h0 = { x: handle.x + handle.width / 2, y: handle.y + handle.height / 2 };
  await drag(page, h0, { x: h0.x + 100, y: h0.y + 50 });
  await expect
    .poll(async () => {
      const f = (await getDoc(info.docId)).pages[0]!.frames[0]!;
      return [Math.round(parseFloat(f.style.width!)), Math.round(parseFloat(f.style.height!))];
    })
    .toEqual([Math.round(400 + 100 / z), Math.round(300 + 50 / z)]);
});

test('undoes and redoes with Ctrl+Z and Ctrl+Shift+Z', async ({ page }) => {
  const { info, frame } = await frameWithMcp('undo');
  await gotoEditor(page);
  await page.getByTestId(`frame-label-${frame.id}`).click();
  await page.keyboard.press('Shift+ArrowRight');
  await page.keyboard.press('Shift+ArrowRight');
  await expect
    .poll(async () => (await getDoc(info.docId)).pages[0]!.frames[0]!.position)
    .toEqual({ x: 20, y: 0 });

  await page.keyboard.press('Control+z');
  await expect
    .poll(async () => (await getDoc(info.docId)).pages[0]!.frames[0]!.position)
    .toEqual({ x: 10, y: 0 });
  await page.getByTestId('undo').click();
  await expect
    .poll(async () => (await getDoc(info.docId)).pages[0]!.frames[0]!.position)
    .toEqual({ x: 0, y: 0 });
  await page.keyboard.press('Control+Shift+z');
  await expect
    .poll(async () => (await getDoc(info.docId)).pages[0]!.frames[0]!.position)
    .toEqual({ x: 10, y: 0 });
});

test('saves and reopens keeping the changes', async ({ page }) => {
  const { info, frame } = await frameWithMcp('save');
  await gotoEditor(page);
  await page.getByTestId(`frame-label-${frame.id}`).click();

  // Edit the width through the properties panel and rename.
  const w = page.locator('[data-testid="prop-w"] input');
  await w.fill('640');
  await w.press('Enter');
  const name = page.getByTestId('prop-name');
  const nameInput =
    (await name.evaluate((el) => el.tagName)) === 'INPUT' ? name : name.locator('input');
  await nameInput.fill('Saved screen');
  await nameInput.press('Enter');
  await expect
    .poll(async () => (await getDoc(info.docId)).pages[0]!.frames[0]!.name)
    .toBe('Saved screen');

  await page.getByTestId('canvas').click({ position: { x: 5, y: 5 } });
  await page.keyboard.press('Control+s');
  await expect(page.getByTestId('dirty-indicator')).toHaveCount(0);
  const saved = JSON.parse(fs.readFileSync(info.path!, 'utf8')) as {
    pages: { frames: { name: string; style: Record<string, string> }[] }[];
  };
  expect(saved.pages[0]!.frames[0]!.style.width).toBe('640px');
  expect(saved.pages[0]!.frames[0]!.name).toBe('Saved screen');

  // Close through the File menu and reopen through the path dialog.
  await page.getByTestId('menu-file').click();
  await page.getByTestId('file-close').click();
  // Another open document (from previous tests) may become the active one; the closed one goes away.
  await expect(page.getByTestId(`frame-label-${frame.id}`)).toHaveCount(0);
  await page.getByTestId('menu-file').click();
  await page.getByTestId('file-open').click();
  await page.locator('.modal input[name="path"]').fill(info.path!);
  await page.locator('.modal button[type="submit"]').click();
  await expect(page.getByTestId(`frame-label-${frame.id}`)).toContainText('Saved screen');
  // The reopened document (same file id) keeps the edited width.
  expect((await getDoc(info.docId)).pages[0]!.frames[0]!.style.width).toBe('640px');
});
