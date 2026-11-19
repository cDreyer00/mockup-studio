import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { Mcp, createDoc, getDoc, gotoEditor } from './helpers';

/** Doc with 3 frames ("Slide 1..3", side by side), each with a heading. */
async function deck(name: string) {
  const info = await createDoc(name);
  const mcp = await new Mcp().init();
  for (const [i, n] of [1, 2, 3].entries()) {
    await mcp.call('create_frame', {
      name: `Slide ${n}`,
      width: 600,
      height: 400,
      x: i * 700,
      y: 0,
    });
    const doc = await getDoc(info.docId);
    await mcp.call('write_html', {
      parentId: doc.pages[0]!.frames[i]!.id,
      html: `<h1 class="t">Title ${n}</h1>`,
      css: '.t{margin:0;padding:40px;font-size:48px}',
    });
  }
  const frames = (await getDoc(info.docId)).pages[0]!.frames;
  return {
    info,
    mcp,
    frames,
    headings: frames.map((f) => f.children[0]!),
  };
}

const counter = (page: Page) => page.getByTestId('presentation-counter');
const overlay = (page: Page) => page.getByTestId('presentation');

async function nodeCount(docId: string): Promise<number> {
  const count = (n: { children: unknown[] }): number =>
    1 + (n.children as { children: unknown[] }[]).reduce((a, c) => a + count(c), 0);
  return (await getDoc(docId)).pages[0]!.frames.reduce((a, f) => a + count(f), 0);
}

test('Present button: starts from the selection, keys navigate, editor shortcuts are inert, Esc restores', async ({
  page,
}) => {
  const { info, mcp, frames, headings } = await deck('present');
  await gotoEditor(page);
  await expect(page.locator('[data-testid^="frame-label-"]')).toHaveCount(3);

  // Select something inside frame 2 and fix a known zoom.
  await mcp.call('set_selection', { nodeIds: [headings[1]!.id] });
  await expect(page.getByTestId(`layer-row-${headings[1]!.id}`)).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await page.getByTestId('zoom-menu').click();
  await page.getByTestId('zoom-100').click();
  await expect(page.getByTestId('zoom-menu')).toContainText('100%');
  const nodes = await nodeCount(info.docId);

  await page.getByTestId('present-button').click();
  await expect(overlay(page)).toBeVisible();
  await expect(counter(page)).toHaveText('2 / 3');
  const slide = page.getByTestId('presentation-slide');
  await expect(slide).toHaveAttribute('data-frame-id', frames[1]!.id);
  await expect(slide).toContainText('Title 2');

  // Scaled to fit the stage keeping the aspect ratio (600x400 fills one dimension).
  const stage = (await page.getByTestId('presentation-stage').boundingBox())!;
  await expect
    .poll(async () => {
      const box = await slide.locator(`[data-node-id="${frames[1]!.id}"]`).boundingBox();
      if (!box) return false;
      const fitsWidth = Math.abs(box.width - stage.width) < 2;
      const fitsHeight = Math.abs(box.height - stage.height) < 2;
      return Math.abs(box.width / box.height - 1.5) < 0.01 && (fitsWidth || fitsHeight);
    })
    .toBe(true);

  await page.keyboard.press('ArrowRight');
  await expect(counter(page)).toHaveText('3 / 3');
  await expect(page.getByTestId('presentation-next')).toBeDisabled();
  await page.keyboard.press('ArrowLeft');
  await expect(counter(page)).toHaveText('2 / 3');
  await page.keyboard.press('Home');
  await expect(counter(page)).toHaveText('1 / 3');
  await expect(page.getByTestId('presentation-prev')).toBeDisabled();
  await page.keyboard.press('End');
  await expect(counter(page)).toHaveText('3 / 3');
  await page.keyboard.press('Backspace'); // previous, not delete
  await expect(counter(page)).toHaveText('2 / 3');

  // Editor shortcuts do not run while presenting.
  await page.keyboard.press('r');
  await page.keyboard.press('f');
  await page.keyboard.press('Delete');
  await expect(page.getByTestId('tool-select')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('tool-rect')).toHaveAttribute('aria-pressed', 'false');
  expect(await nodeCount(info.docId)).toBe(nodes);
  await expect(counter(page)).toHaveText('2 / 3');

  // Click anywhere on the stage = next.
  await page.getByTestId('presentation-stage').click({ position: { x: 100, y: 100 } });
  await expect(counter(page)).toHaveText('3 / 3');
  await page.getByTestId('presentation-prev').click();
  await expect(counter(page)).toHaveText('2 / 3');

  await page.keyboard.press('Escape');
  await expect(overlay(page)).toHaveCount(0);
  // Zoom untouched; the start frame is the last shown one, so the selection is kept.
  await expect(page.getByTestId('zoom-menu')).toContainText('100%');
  await expect.poll(() => mcp.call('get_selection', {})).toContain(headings[1]!.id);
});

test('Esc leaves the last shown frame selected', async ({ page }) => {
  const { mcp, frames } = await deck('present-last');
  await gotoEditor(page);
  await expect(page.locator('[data-testid^="frame-label-"]')).toHaveCount(3);
  await mcp.call('set_selection', { nodeIds: [frames[0]!.id] });
  await page.getByTestId('present-button').click();
  await expect(counter(page)).toHaveText('1 / 3');
  await page.keyboard.press('End');
  await expect(counter(page)).toHaveText('3 / 3');
  await page.getByTestId('presentation-exit').click();
  await expect(overlay(page)).toHaveCount(0);
  await expect(page.getByTestId(`layer-row-${frames[2]!.id}`)).toHaveAttribute(
    'aria-selected',
    'true',
  );
});

test('F5 starts from the first frame and Shift+F5 from the selected one', async ({ page }) => {
  const { mcp, frames } = await deck('present-f5');
  await gotoEditor(page);
  await expect(page.locator('[data-testid^="frame-label-"]')).toHaveCount(3);
  await mcp.call('set_selection', { nodeIds: [frames[2]!.id] });
  await expect(page.getByTestId(`layer-row-${frames[2]!.id}`)).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await page.keyboard.press('F5');
  await expect(counter(page)).toHaveText('1 / 3');
  await page.keyboard.press('Escape');
  await expect(overlay(page)).toHaveCount(0);
  await page.keyboard.press('Shift+F5');
  await expect(counter(page)).toHaveText('3 / 3');
  await page.keyboard.press('Escape');
  await expect(overlay(page)).toHaveCount(0);
});

test('the Present button is disabled on a page with no visible frames', async ({ page }) => {
  await createDoc('present-empty');
  await gotoEditor(page);
  await expect(page.getByTestId('present-button')).toBeDisabled();
});

test('edits made through the MCP show up live while presenting', async ({ page }) => {
  const { info, mcp, frames, headings } = await deck('present-live');
  await gotoEditor(page);
  await expect(page.locator('[data-testid^="frame-label-"]')).toHaveCount(3);
  await page.keyboard.press('F5');
  await expect(counter(page)).toHaveText('1 / 3');

  await mcp.call('set_text', { nodeIds: [headings[0]!.id], content: 'Edited live' });
  await expect(page.getByTestId('presentation-slide')).toContainText('Edited live');
  await expect(counter(page)).toHaveText('1 / 3');

  await mcp.call('delete_nodes', { nodeIds: [frames[2]!.id] });
  await expect(counter(page)).toHaveText('1 / 2');
  await mcp.call('delete_nodes', { nodeIds: [frames[0]!.id] });
  await expect(counter(page)).toHaveText('1 / 1');
  await expect(page.getByTestId('presentation-slide')).toHaveAttribute(
    'data-frame-id',
    frames[1]!.id,
  );
  expect((await getDoc(info.docId)).pages[0]!.frames).toHaveLength(1);
  await page.keyboard.press('Escape');
  await expect(overlay(page)).toHaveCount(0);
});

test('MCP start_presentation / presentation_goto / stop_presentation drive the editor', async ({
  page,
}) => {
  const { mcp, frames } = await deck('present-mcp');
  await gotoEditor(page);
  await expect(page.locator('[data-testid^="frame-label-"]')).toHaveCount(3);

  await mcp.call('start_presentation', { frameId: frames[2]!.id });
  await expect(overlay(page)).toBeVisible();
  await expect(counter(page)).toHaveText('3 / 3');

  const goto = await mcp.call('presentation_goto', { step: 'first' });
  expect(goto).toContain('1 / 3');
  await expect(counter(page)).toHaveText('1 / 3');
  await mcp.call('presentation_goto', { frameId: frames[1]!.id });
  await expect(counter(page)).toHaveText('2 / 3');
  await mcp.call('presentation_goto', { index: 2 });
  await expect(counter(page)).toHaveText('3 / 3');

  await mcp.call('stop_presentation', {});
  await expect(overlay(page)).toHaveCount(0);
  expect(await mcp.call('stop_presentation', {})).toContain('No presentation was running');
});
