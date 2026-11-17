import { expect, test } from '@playwright/test';
import { Mcp, createDoc, getDoc, gotoEditor } from './helpers';

/** Remix from the context menu: the variations are added side by side and a single Ctrl+Z removes them all. */

test('Remix: color scale creates 10 frames and Ctrl+Z removes all 10', async ({ page }) => {
  const info = await createDoc('remix');
  const mcp = await new Mcp().init();
  await mcp.call('create_frame', { name: 'Screen', width: 600, height: 400, x: 0, y: 0 });
  await mcp.call('write_html', {
    html: '<div class="card">Card</div>',
    css: '.card{background-color:#3366ff;color:#fff;width:240px;height:120px;padding:16px}',
  });
  const frames = async () => (await getDoc(info.docId)).pages[0]!.frames;
  const card = (await frames())[0]!.children[0]!;

  await gotoEditor(page);
  const el = page.getByTestId('canvas-world').locator(`[data-node-id="${card.id}"]`).first();
  await el.click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Remix: color scale' }).click();

  await expect.poll(async () => (await frames()).length).toBe(11);
  // The daemon selects the created frames.
  await expect
    .poll(async () => page.locator('[data-testid^="layer-row-"][aria-selected="true"]').count())
    .toBeGreaterThan(0);

  await page.getByTestId('canvas').focus();
  await page.keyboard.press('Control+z');
  await expect.poll(async () => (await frames()).length).toBe(1);
});

test('Remix items are disabled without a single selection', async ({ page }) => {
  await createDoc('remix-menu');
  const mcp = await new Mcp().init();
  await mcp.call('create_frame', { name: 'Screen', width: 600, height: 400, x: 0, y: 0 });
  await mcp.call('write_html', {
    html: '<div class="a">A</div><div class="b">B</div>',
    css: '.a,.b{background-color:#ccc;width:100px;height:50px}',
  });
  await gotoEditor(page);
  const rows = page.locator('[data-testid^="layer-row-"]');
  await expect.poll(async () => rows.count()).toBeGreaterThan(2);
  // Select two nodes (Ctrl+click) and open the menu on one of them.
  await rows.nth(1).click();
  await rows.nth(2).click({ modifiers: ['Control'] });
  await rows.nth(2).click({ button: 'right' });
  await expect(page.getByRole('menuitem', { name: 'Remix: layout' })).toBeDisabled();
  await expect(page.getByRole('menuitem', { name: 'Remix with AI…' })).toBeDisabled();
});
