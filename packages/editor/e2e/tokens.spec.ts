import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { Mcp, createDoc, getDoc, gotoEditor } from './helpers';

/** Painel de tokens e temas: criar/editar/renomear, tema com sobrescrita, ligar a token e trocar o tema do frame. */

async function setup(name: string) {
  const info = await createDoc(name);
  const mcp = await new Mcp().init();
  await mcp.call('create_frame', { name: 'Tela', width: 600, height: 400, x: 0, y: 0 });
  await mcp.call('write_html', {
    html: '<section class="wrap"><div class="box">A</div></section>',
    css: '.wrap{padding:20px;width:500px;height:300px}.box{width:100px;height:60px}',
  });
  const frame = (await getDoc(info.docId)).pages[0]!.frames[0]!;
  return { info, frame };
}

const nodeEl = (page: Page, id: string) =>
  page.getByTestId('canvas-world').locator(`[data-node-id="${id}"]`).first();

const bgOf = (page: Page, id: string) =>
  nodeEl(page, id).evaluate((el) => getComputedStyle(el).backgroundColor);

async function createToken(page: Page, name: string, value: string) {
  await page.getByTestId('tokens-add').click();
  await page.getByTestId('new-token-name').fill(name);
  await page.getByTestId('new-token-value').fill(value);
  await page.getByTestId('new-token-submit').click();
}

async function editValue(page: Page, slug: string, value: string) {
  const row = page.getByTestId(`token-row-${slug}`);
  await row.getByTestId(`token-value-${slug}`).click();
  const input = row.getByTestId('token-value-input');
  await input.fill(value);
  await input.press('Enter');
}

test('tokens e temas: criar, editar, renomear, tema com sobrescrita e troca de tema no frame', async ({
  page,
}) => {
  const { info, frame } = await setup('tokens');
  await gotoEditor(page);

  // Aba Tokens.
  await page.getByTestId('tab-tokens').click();
  await expect(page.getByTestId('tokens-panel')).toBeVisible();

  // Criar token de cor e editar o valor.
  await createToken(page, 'color-surface', '#ffffff');
  const row = page.getByTestId('token-row-color-surface');
  await expect(row).toBeVisible();
  await expect
    .poll(async () => (await getDoc(info.docId)).tokens['--color-surface'])
    .toBe('#ffffff');
  await editValue(page, 'color-surface', '#eeeeee');
  await expect
    .poll(async () => (await getDoc(info.docId)).tokens['--color-surface'])
    .toBe('#eeeeee');

  // Valor inválido é bloqueado com mensagem.
  await row.getByTestId('token-value-color-surface').click();
  await row.getByTestId('token-value-input').fill('rgb(1,2');
  await row.getByTestId('token-value-input').press('Enter');
  await expect(row.getByTestId('inline-error')).toBeVisible();
  await row.getByTestId('token-value-input').press('Escape');
  expect((await getDoc(info.docId)).tokens['--color-surface']).toBe('#eeeeee');

  // Renomear (duplo clique no nome).
  await row.getByTestId('token-name-color-surface').dblclick();
  await row.getByTestId('token-name-input').fill('color-bg');
  await row.getByTestId('token-name-input').press('Enter');
  await expect(page.getByTestId('token-row-color-bg')).toBeVisible();
  await expect
    .poll(async () => Object.keys((await getDoc(info.docId)).tokens))
    .toContain('--color-bg');

  // Criar o tema dark e sobrescrever o token nele.
  await page.getByTestId('tokens-theme-add').click();
  const dialog = page.getByRole('dialog', { name: 'Novo tema' });
  await dialog.locator('input[name="name"]').fill('dark');
  await dialog.locator('input[name="name"]').press('Enter');
  await expect(page.getByTestId('tokens-theme-select')).toHaveValue('dark');
  await editValue(page, 'color-bg', '#111111');
  await expect(page.getByTestId('token-override-color-bg')).toBeVisible();
  await expect
    .poll(async () => (await getDoc(info.docId)).themes?.[0]?.overrides['--color-bg'])
    .toBe('#111111');
  // A base não mudou.
  expect((await getDoc(info.docId)).tokens['--color-bg']).toBe('#eeeeee');
  await page.getByTestId('tokens-theme-select').selectOption('');

  // Ligar o fundo do frame ao token pelo seletor do painel de propriedades.
  await page.getByTestId('tab-layers').click();
  await page.getByTestId(`layer-row-${frame.id}`).click();
  await page.locator('.prop-bg [data-testid="token-bind"]').click();
  await page.getByTestId('token-option-color-bg').click();
  await expect
    .poll(async () => (await getDoc(info.docId)).pages[0]!.frames[0]!.style.background)
    .toBe('var(--color-bg)');
  await expect(page.getByTestId('token-chip-name')).toHaveText('--color-bg');
  await expect(page.getByTestId('token-chip-value')).toHaveText('#eeeeee');
  await expect.poll(() => bgOf(page, frame.id)).toBe('rgb(238, 238, 238)');

  // Trocar o tema do frame: o canvas passa a usar a sobrescrita.
  await page.locator('[data-testid="prop-theme"] select').selectOption('dark');
  await expect
    .poll(async () => (await getDoc(info.docId)).pages[0]!.frames[0]!.attrs['data-theme'])
    .toBe('dark');
  await expect(nodeEl(page, frame.id)).toHaveAttribute('data-theme', 'dark');
  await expect.poll(() => bgOf(page, frame.id)).toBe('rgb(17, 17, 17)');
  await expect(page.getByTestId('token-chip-value')).toHaveText('#111111');

  // Voltar ao padrão (base).
  await page.locator('[data-testid="prop-theme"] select').selectOption('');
  await expect.poll(() => bgOf(page, frame.id)).toBe('rgb(238, 238, 238)');

  // Desligar do token grava o valor resolvido.
  await page.getByTestId('token-unbind').click();
  await expect
    .poll(async () => (await getDoc(info.docId)).pages[0]!.frames[0]!.style.background)
    .toBe('#eeeeee');
});

test('tokens: avisos de não usado e de referência quebrada; resumo do documento', async ({
  page,
}) => {
  const { info } = await setup('tokens-avisos');
  await gotoEditor(page);
  await page.getByTestId('tab-tokens').click();

  await createToken(page, 'space-solto', '8px');
  await expect(page.getByTestId('token-unused-space-solto')).toBeVisible();

  // Referência a token inexistente é aceita (aviso) e aparece como problema com a mensagem.
  await createToken(page, 'color-ref', 'var(--nao-existe)');
  const problem = page.getByTestId('token-problem-color-ref');
  await expect(problem).toBeVisible();
  await expect(problem).toHaveAttribute('title', /nao-existe/);
  await expect(page.getByTestId('tokens-footer')).toBeVisible();
  await expect.poll(async () => Object.keys((await getDoc(info.docId)).tokens).length).toBe(2);

  // Busca e exclusão.
  await page.getByTestId('tokens-search').fill('solto');
  await expect(page.getByTestId('token-row-color-ref')).toHaveCount(0);
  await page.getByTestId('token-menu-space-solto').click();
  await page.getByTestId('token-delete-space-solto').click();
  await expect(page.getByTestId('token-row-space-solto')).toHaveCount(0);

  // Sem seleção, o painel de propriedades mostra o resumo e abre a aba Tokens.
  await page.getByTestId('tab-layers').click();
  await page.keyboard.press('Escape');
  await page.getByTestId('canvas').click({ position: { x: 5, y: 5 } });
  await expect(page.getByTestId('tokens-summary')).toContainText('1 token');
  await expect(page.getByTestId('tokens-summary-broken')).toBeVisible();
  await page.getByTestId('open-tokens').click();
  await expect(page.getByTestId('tokens-panel')).toBeVisible();
});

test('tokens: importar CSS e exportar', async ({ page }) => {
  const { info } = await setup('tokens-io');
  await gotoEditor(page);
  await page.getByTestId('tab-tokens').click();

  await page.getByTestId('tokens-import').click();
  await page
    .getByTestId('tokens-import-text')
    .fill(
      ':root { --color-brand: #ff00aa; --space-1: 4px; }\n[data-theme="dark"] { --color-brand: #aa00ff; }',
    );
  await expect(page.getByTestId('tokens-import-info')).toContainText('2 tokens');
  await page.getByTestId('tokens-import-confirm').click();
  await expect.poll(async () => (await getDoc(info.docId)).tokens['--color-brand']).toBe('#ff00aa');
  expect((await getDoc(info.docId)).themes?.map((t) => t.name)).toEqual(['dark']);

  await page.getByTestId('tokens-export').click();
  await expect(page.getByTestId('tokens-export-text')).toHaveValue(/--color-brand: #ff00aa/);
  await page.getByTestId('tokens-export-format').selectOption('json');
  await expect(page.getByTestId('tokens-export-text')).toHaveValue(/\$value/);
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('tokens-export-dialog')).toHaveCount(0);
});
