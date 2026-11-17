import { expect, test } from '@playwright/test';
import { Mcp, createDoc, drag, getDoc, gotoEditor } from './helpers';

/** Plan editing flow: container, inline text, layers, clipboard and pages. */
test('creates a container and text, edits inline text, renames, copies and pastes', async ({
  page,
}) => {
  const info = await createDoc('flow');
  const mcp = await new Mcp().init();
  await mcp.call('create_frame', { name: 'Screen', width: 800, height: 600, x: 0, y: 0 });
  const frame = (await getDoc(info.docId)).pages[0]!.frames[0]!;
  await gotoEditor(page);
  const frameEl = page.getByTestId('canvas-world').locator(`[data-node-id="${frame.id}"]`);
  const box = (await frameEl.boundingBox())!;

  // Container (R) drawn inside the frame: becomes an absolute child.
  await page.keyboard.press('r');
  await drag(page, { x: box.x + 40, y: box.y + 40 }, { x: box.x + 200, y: box.y + 140 });
  await expect
    .poll(async () => (await getDoc(info.docId)).pages[0]!.frames[0]!.children.length)
    .toBe(1);
  const rect = (await getDoc(info.docId)).pages[0]!.frames[0]!.children[0]!;
  expect(rect.style.position).toBe('absolute');

  // Text (T): click creates it and enters inline editing; Enter confirms.
  await page.keyboard.press('t');
  await page.mouse.click(box.x + 300, box.y + 300);
  const editor = page.getByTestId('text-editor');
  await expect(editor).toBeVisible();
  await page.keyboard.press('Control+a');
  await page.keyboard.type('Hello, world');
  await page.keyboard.press('Enter');
  await expect
    .poll(async () => (await getDoc(info.docId)).pages[0]!.frames[0]!.children[1]?.text)
    .toBe('Hello, world');
  const text = (await getDoc(info.docId)).pages[0]!.frames[0]!.children[1]!;

  // Rename through the layer tree (double-click).
  await page.getByTestId(`layer-row-${text.id}`).dblclick();
  const rename = page.getByTestId('layer-rename-input');
  await rename.fill('Greeting');
  await rename.press('Enter');
  await expect
    .poll(async () => (await getDoc(info.docId)).pages[0]!.frames[0]!.children[1]!.name)
    .toBe('Greeting');

  // Copy and paste (new ids), then undo the paste.
  await page.getByTestId(`layer-row-${text.id}`).click();
  await page.getByTestId('canvas').focus();
  await page.keyboard.press('Control+c');
  await page.keyboard.press('Control+v');
  await expect
    .poll(async () => (await getDoc(info.docId)).pages[0]!.frames[0]!.children.length)
    .toBe(3);
  const pasted = (await getDoc(info.docId)).pages[0]!.frames[0]!.children[2]!;
  expect(pasted.id).not.toBe(text.id);
  expect(pasted.text).toBe('Hello, world');
  await page.keyboard.press('Control+z');
  await expect
    .poll(async () => (await getDoc(info.docId)).pages[0]!.frames[0]!.children.length)
    .toBe(2);

  // Duplicate (Ctrl+D) and delete (Delete).
  await page.getByTestId(`layer-row-${rect.id}`).click();
  await page.keyboard.press('Control+d');
  await expect
    .poll(async () => (await getDoc(info.docId)).pages[0]!.frames[0]!.children.length)
    .toBe(3);
  await page.keyboard.press('Delete');
  await expect
    .poll(async () => (await getDoc(info.docId)).pages[0]!.frames[0]!.children.length)
    .toBe(2);

  // The new page becomes the active one and is empty.
  await page.getByTestId('add-page').click();
  await expect.poll(async () => (await getDoc(info.docId)).pages.length).toBe(2);
  await expect(page.getByTestId(`frame-label-${frame.id}`)).toHaveCount(0);
});

test('Shift+Enter breaks the line and the break stays visible after confirming (one undo)', async ({
  page,
}) => {
  const info = await createDoc('line-break');
  const mcp = await new Mcp().init();
  await mcp.call('create_frame', { name: 'Screen', width: 600, height: 400, x: 0, y: 0 });
  const frame = (await getDoc(info.docId)).pages[0]!.frames[0]!;
  await gotoEditor(page);
  const box = (await page
    .getByTestId('canvas-world')
    .locator(`[data-node-id="${frame.id}"]`)
    .boundingBox())!;
  await page.keyboard.press('t');
  await page.mouse.click(box.x + 60, box.y + 60);
  await expect(page.getByTestId('text-editor')).toBeVisible();
  await expect
    .poll(async () => (await getDoc(info.docId)).pages[0]!.frames[0]!.children.length)
    .toBe(1);
  const created = (await getDoc(info.docId)).pages[0]!.frames[0]!.children[0]!;
  await page.keyboard.press('Control+a');
  await page.keyboard.type('line 1');
  await page.keyboard.press('Shift+Enter');
  await page.keyboard.type('line 2');
  await page.keyboard.press('Enter');
  const node = async () => (await getDoc(info.docId)).pages[0]!.frames[0]!.children[0]!;
  await expect.poll(async () => (await node()).text).toBe('line 1\nline 2');
  expect((await node()).style['white-space']).toBe('pre-wrap');
  await expect(page.getByTestId('text-editor')).toHaveCount(0);
  const el = page.getByTestId('canvas-world').locator(`[data-node-id="${created.id}"]`);
  expect(await el.evaluate((e) => (e as HTMLElement).innerText)).toBe('line 1\nline 2');
  // A single undo reverts text and white-space together.
  await page.getByTestId('canvas').focus();
  await page.keyboard.press('Control+z');
  await expect.poll(async () => (await node()).text).toBe(created.text);
  expect((await node()).style['white-space']).toBeUndefined();
});
