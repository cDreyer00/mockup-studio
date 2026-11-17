import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import { copyExample, findByName, getDoc, gotoEditor, openDoc, waitForStableBox } from './helpers';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

/**
 * Generates `docs/img/editor.png` (README screenshot) with the example document.
 * Runs only in the `screenshot` project (`npm run screenshot` at the root), so that the regular
 * `test:e2e` does not change repository files.
 */

test('editor screenshot with the landing example', async ({ page }) => {
  const file = copyExample(path.join(root, 'examples/landing.mockup.json'));
  const info = await openDoc(file);
  await gotoEditor(page);
  const doc = await getDoc(info.docId);
  const frame = doc.pages[0]!.frames[0]!;
  await expect(page.getByTestId(`frame-label-${frame.id}`)).toBeVisible();
  // Select a content node to show the outline, handles and properties panel.
  const hero = findByName(doc, 'Hero') ?? frame.children[0] ?? frame;
  await page.getByTestId(`layer-row-${hero.id}`).click();
  await expect(page.getByTestId('selection-box')).toBeVisible();
  await page.mouse.move(2, 2);
  await expect(page.locator('.cv-hover')).toHaveCount(0);
  await waitForStableBox(page.getByTestId('selection-box'));
  await page.screenshot({ path: path.join(root, 'docs/img/editor.png') });
});
