import { parseTrackList } from '@mockup/core';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { Mcp, createDoc, drag, getDoc, gotoEditor } from './helpers';

/** CSS Grid in the editor: Grid mode of the Layout panel, track editor, cells and child span. */

const HTML =
  '<section class="g"><div class="c">A</div><div class="c">B</div><div class="c">C</div><div class="c">D</div></section>';
const CSS = '.g{width:600px;padding:20px}.c{height:80px;background:#ccc}';

const nodeEl = (page: Page, id: string) =>
  page.getByTestId('canvas-world').locator(`[data-node-id="${id}"]`).first();

async function centerOfNode(page: Page, id: string) {
  const box = (await nodeEl(page, id).boundingBox())!;
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

/**
 * Ctrl+click: selects the child instead of the container. Retries until the layer is selected: right after
 * a commit the grid may still be repositioning the children and the click would land on another node.
 */
async function selectDeep(page: Page, id: string) {
  await expect(async () => {
    const c = await centerOfNode(page, id);
    await page.keyboard.down('Control');
    await page.mouse.click(c.x, c.y);
    await page.keyboard.up('Control');
    await expect(page.getByTestId(`layer-row-${id}`)).toHaveAttribute('aria-selected', 'true', {
      timeout: 1000,
    });
  }).toPass({ timeout: 10_000 });
}

/** Waits for the node box to stop moving (the grid repositions the children after each commit). */
async function waitStable(page: Page, id: string) {
  let last = '';
  await expect
    .poll(
      async () => {
        const cur = JSON.stringify(await nodeEl(page, id).boundingBox());
        const same = cur === last;
        last = cur;
        return same;
      },
      { intervals: [150] },
    )
    .toBe(true);
}

async function fillCommit(page: Page, testId: string, value: string) {
  const input = page.getByTestId(testId);
  await input.fill(value);
  await input.press('Enter');
}

async function boxOf(page: Page, testId: string) {
  return (await page.getByTestId(testId).boundingBox())!;
}

test('grid: mode, 3 columns x 2 rows, cells and child span', async ({ page }) => {
  const info = await createDoc('grid');
  const mcp = await new Mcp().init();
  await mcp.call('create_frame', { name: 'Screen', width: 800, height: 600, x: 0, y: 0 });
  await mcp.call('write_html', { html: HTML, css: CSS });
  const container = async () => (await getDoc(info.docId)).pages[0]!.frames[0]!.children[0]!;
  const kids = (await container()).children;
  expect(kids).toHaveLength(4);
  const [a, b, c, d] = kids.map((k) => k.id) as [string, string, string, string];
  const style = async (id: string) => (await container()).children.find((k) => k.id === id)!.style;

  await gotoEditor(page);

  // Clicking a child selects the container; the Layout panel offers Grid mode.
  const first = await centerOfNode(page, a);
  await page.mouse.click(first.x, first.y);
  await expect(page.getByTestId('layout-mode-grid')).toBeVisible();
  await page.getByTestId('layout-mode-grid').click();
  await expect.poll(async () => (await container()).style.display).toBe('grid');
  await expect(page.getByTestId('grid-col-1-value')).toBeVisible();

  // Two starting columns; the third column and the two rows come from the add buttons.
  await page.getByTestId('grid-col-add').click();
  await expect(page.getByTestId('grid-col-2-value')).toBeVisible();
  await page.getByTestId('grid-row-add').click();
  await expect(page.getByTestId('grid-row-0-value')).toBeVisible();
  await page.getByTestId('grid-row-add').click();
  await expect(page.getByTestId('grid-row-1-value')).toBeVisible();
  await page.getByTestId('grid-gap').locator('input').fill('16');
  await page.getByTestId('grid-gap').locator('input').press('Enter');

  await expect
    .poll(async () => parseTrackList((await container()).style['grid-template-columns']).length)
    .toBe(3);
  await expect
    .poll(async () => parseTrackList((await container()).style['grid-template-rows']).length)
    .toBe(2);
  await expect.poll(async () => (await container()).style.gap).toBe('16px');

  // Changing a track's unit: column 1 becomes 200px.
  await page.getByTestId('grid-col-0-unit').selectOption('px');
  await fillCommit(page, 'grid-col-0-value', '200');
  await expect
    .poll(async () => parseTrackList((await container()).style['grid-template-columns'])[0]?.value)
    .toBe('200px');

  // The overlay shows the 3 columns and 2 rows measured from the DOM.
  await expect(page.getByTestId('grid-track-col-2')).toBeVisible();
  await expect(page.getByTestId('grid-track-row-1')).toBeVisible();
  await expect(page.getByTestId('grid-track-col-3')).toHaveCount(0);

  // A: column 3, row 2 through the "Grid cell" fields.
  await selectDeep(page, a);
  await expect(page.getByTestId('grid-cell-column')).toBeVisible();
  await fillCommit(page, 'grid-cell-column', '3');
  await fillCommit(page, 'grid-cell-row', '2');
  await expect.poll(async () => (await style(a))['grid-column']).toBe('3');
  await expect.poll(async () => (await style(a))['grid-row']).toBe('2');

  // B: dragged to the cell (column 3, row 1).
  // The layout may still be settling after A's commit: redo the gesture until the target cell shows up.
  await expect(async () => {
    await selectDeep(page, b);
    await expect(page.getByTestId('grid-track-col-2')).toBeVisible();
    await waitStable(page, b);
    const col3 = await boxOf(page, 'grid-track-col-2');
    const row1 = await boxOf(page, 'grid-track-row-0');
    const from = await centerOfNode(page, b);
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move(col3.x + col3.width / 2, row1.y + row1.height / 2, { steps: 12 });
    try {
      await expect(page.getByTestId('grid-drop-cell')).toBeVisible({ timeout: 1500 });
    } catch (e) {
      await page.mouse.up();
      throw e;
    }
  }).toPass({ timeout: 15_000 });
  await page.mouse.up();
  await expect.poll(async () => (await style(b))['grid-column']).toBe('3');
  await expect.poll(async () => (await style(b))['grid-row']).toBe('1');
  await expect(page.getByTestId('grid-drop-cell')).toHaveCount(0);
  // Still a child of the same parent, in the same order (not reordered).
  await expect
    .poll(async () => (await container()).children.map((k) => k.id))
    .toEqual([a, b, c, d]);

  // C: span of 2 columns starting at column 1, row 1.
  await selectDeep(page, c);
  await fillCommit(page, 'grid-cell-colspan', '2');
  await fillCommit(page, 'grid-cell-column', '1');
  await fillCommit(page, 'grid-cell-row', '1');
  await expect.poll(async () => (await style(c))['grid-column']).toBe('1 / span 2');
  await expect.poll(async () => (await style(c))['grid-row']).toBe('1');

  // D: column 1, row 2 and stretched to column 2 by the span handle.
  await selectDeep(page, d);
  await fillCommit(page, 'grid-cell-column', '1');
  await fillCommit(page, 'grid-cell-row', '2');
  await expect.poll(async () => (await style(d))['grid-row']).toBe('2');
  const handle = page.getByTestId('grid-span-handle-e');
  await expect(handle).toBeVisible();
  const hb = (await handle.boundingBox())!;
  const col2 = await boxOf(page, 'grid-track-col-1');
  await drag(
    page,
    { x: hb.x + hb.width / 2, y: hb.y + hb.height / 2 },
    { x: col2.x + col2.width - 2, y: hb.y + hb.height / 2 },
  );
  await expect.poll(async () => (await style(d))['grid-column']).toBe('1 / span 2');

  // Final styles of the container and the children.
  await expect
    .poll(async () => {
      const st = (await container()).style;
      return [
        st.display,
        parseTrackList(st['grid-template-columns']).length,
        parseTrackList(st['grid-template-rows']).length,
      ];
    })
    .toEqual(['grid', 3, 2]);

  // Rendered boxes: A in column 3 / row 2; B in column 3 / row 1; C and D cover 2 columns.
  await page.keyboard.press('Escape');
  await expect
    .poll(async () =>
      nodeEl(page, (await container()).id).evaluate((el) => {
        const cs = getComputedStyle(el);
        return {
          cols: cs.gridTemplateColumns.split(' ').length,
          rows: cs.gridTemplateRows.split(' ').length,
        };
      }),
    )
    .toEqual({ cols: 3, rows: 2 });
  const measure = async () =>
    Object.fromEntries(
      await Promise.all(
        [a, b, c, d].map(async (id) => [id, (await nodeEl(page, id).boundingBox())!] as const),
      ),
    );
  await expect
    .poll(async () => {
      const boxes = await measure();
      return [
        boxes[a]!.x > boxes[c]!.x + boxes[c]!.width - 1,
        boxes[a]!.y > boxes[b]!.y,
        Math.abs(boxes[a]!.x - boxes[b]!.x) < 1,
        boxes[c]!.width > boxes[b]!.width,
        Math.abs(boxes[c]!.width - boxes[d]!.width) < 1,
      ];
    })
    .toEqual([true, true, true, true, true]);
});
