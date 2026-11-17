import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { Mcp, createDoc, getDoc, gotoEditor } from './helpers';

/** "Ligar a token" em campos de tamanho, espaçamento e raio, e o aviso de uso depois de ligar. */

const nodeEl = (page: Page, id: string) =>
  page.getByTestId('canvas-world').locator(`[data-node-id="${id}"]`).first();

test('ligar a token em largura, padding e raio mostra nome e valor resolvido e muda o render', async ({
  page,
}) => {
  const info = await createDoc('tokens-bind');
  const mcp = await new Mcp().init();
  await mcp.call('set_tokens', {
    tokens: { 'size-box': '140px', 'space-4': '16px', 'radius-md': 'calc(var(--space-4) / 2)' },
  });
  await mcp.call('create_frame', { name: 'Tela', width: 600, height: 400, x: 0, y: 0 });
  await mcp.call('write_html', {
    html: '<div class="box"><span>A</span></div>',
    css: '.box{width:100px;height:60px;padding:4px;border-radius:2px}',
  });
  const box = (await getDoc(info.docId)).pages[0]!.frames[0]!.children[0]!;
  await gotoEditor(page);
  await mcp.call('set_selection', { nodeIds: [box.id] });
  await expect(page.getByTestId(`layer-row-${box.id}`)).toHaveAttribute('aria-selected', 'true');

  const style = async () => (await getDoc(info.docId)).pages[0]!.frames[0]!.children[0]!.style;

  // Largura (tamanho).
  await page.locator('[data-testid="prop-w"] [data-testid="token-bind"]').click();
  await page.getByTestId('token-option-size-box').click();
  await expect.poll(async () => (await style()).width).toBe('var(--size-box)');
  await expect(page.locator('[data-testid="prop-w"] [data-testid="token-chip-name"]')).toHaveText(
    '--size-box',
  );
  await expect(page.locator('[data-testid="prop-w"] [data-testid="token-chip-value"]')).toHaveText(
    '140px',
  );
  await expect
    .poll(async () => (await nodeEl(page, box.id).boundingBox())?.width ?? 0)
    .toBeGreaterThan(0);
  await expect
    .poll(() => nodeEl(page, box.id).evaluate((el) => getComputedStyle(el).width))
    .toBe('140px');

  // Padding (espaçamento): o primeiro campo da caixa.
  await page
    .locator('[data-section="props-layout"] .prop-box [data-testid="token-bind"]')
    .first()
    .click();
  await page.getByTestId('token-option-space-4').click();
  await expect.poll(async () => (await style()).padding).toBe('var(--space-4)');
  await expect
    .poll(() => nodeEl(page, box.id).evaluate((el) => getComputedStyle(el).paddingTop))
    .toBe('16px');

  // Raio (tamanho): o campo da seção Aparência.
  await page
    .locator('[data-section="props-appearance"] .prop-box [data-testid="token-bind"]')
    .first()
    .click();
  await page.getByTestId('token-option-radius-md').click();
  await expect.poll(async () => (await style())['border-radius']).toBe('var(--radius-md)');
  await expect
    .poll(() => nodeEl(page, box.id).evaluate((el) => getComputedStyle(el).borderTopLeftRadius))
    .toBe('8px');

  // O token sai do estado "não usado" e o resumo do painel reflete o uso.
  await page.getByTestId('tab-tokens').click();
  await expect(page.getByTestId('token-row-size-box')).toBeVisible();
  await expect(page.getByTestId('token-unused-size-box')).toHaveCount(0);
  await expect(page.getByTestId('token-unused-space-4')).toHaveCount(0);
  await expect(page.getByTestId('token-unused-radius-md')).toHaveCount(0);
});
