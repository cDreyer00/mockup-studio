import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import { copyExample, findByName, getDoc, gotoEditor, openDoc, waitForStableBox } from './helpers';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

/**
 * Gera `docs/img/editor.png` (screenshot do README) com o documento de exemplo.
 * Roda só no projeto `screenshot` (`npm run screenshot` na raiz), para que o `test:e2e`
 * comum não altere arquivos do repositório.
 */

test('screenshot do editor com o exemplo landing', async ({ page }) => {
  const file = copyExample(path.join(root, 'examples/landing.mockup.json'));
  const info = await openDoc(file);
  await gotoEditor(page);
  const doc = await getDoc(info.docId);
  const frame = doc.pages[0]!.frames[0]!;
  await expect(page.getByTestId(`frame-label-${frame.id}`)).toBeVisible();
  // Seleciona um nó do conteúdo para mostrar contorno, alças e painel de propriedades.
  const hero = findByName(doc, 'Hero') ?? frame.children[0] ?? frame;
  await page.getByTestId(`layer-row-${hero.id}`).click();
  await expect(page.getByTestId('selection-box')).toBeVisible();
  await page.mouse.move(2, 2);
  await expect(page.locator('.cv-hover')).toHaveCount(0);
  await waitForStableBox(page.getByTestId('selection-box'));
  await page.screenshot({ path: path.join(root, 'docs/img/editor.png') });
});
