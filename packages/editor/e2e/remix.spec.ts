import { expect, test } from '@playwright/test';
import { Mcp, createDoc, getDoc, gotoEditor } from './helpers';

/** Remix pelo menu de contexto: as variações entram lado a lado e um Ctrl+Z remove todas. */

test('Remix: escala de cor cria 10 frames e Ctrl+Z remove os 10', async ({ page }) => {
  const info = await createDoc('remix');
  const mcp = await new Mcp().init();
  await mcp.call('create_frame', { name: 'Tela', width: 600, height: 400, x: 0, y: 0 });
  await mcp.call('write_html', {
    html: '<div class="card">Cartão</div>',
    css: '.card{background-color:#3366ff;color:#fff;width:240px;height:120px;padding:16px}',
  });
  const frames = async () => (await getDoc(info.docId)).pages[0]!.frames;
  const card = (await frames())[0]!.children[0]!;

  await gotoEditor(page);
  const el = page.getByTestId('canvas-world').locator(`[data-node-id="${card.id}"]`).first();
  await el.click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Remix: escala de cor' }).click();

  await expect.poll(async () => (await frames()).length).toBe(11);
  // O daemon seleciona os frames criados.
  await expect
    .poll(async () => page.locator('[data-testid^="layer-row-"][aria-selected="true"]').count())
    .toBeGreaterThan(0);

  await page.getByTestId('canvas').focus();
  await page.keyboard.press('Control+z');
  await expect.poll(async () => (await frames()).length).toBe(1);
});

test('itens de Remix ficam desabilitados sem seleção única', async ({ page }) => {
  await createDoc('remix-menu');
  const mcp = await new Mcp().init();
  await mcp.call('create_frame', { name: 'Tela', width: 600, height: 400, x: 0, y: 0 });
  await mcp.call('write_html', {
    html: '<div class="a">A</div><div class="b">B</div>',
    css: '.a,.b{background-color:#ccc;width:100px;height:50px}',
  });
  await gotoEditor(page);
  const rows = page.locator('[data-testid^="layer-row-"]');
  await expect.poll(async () => rows.count()).toBeGreaterThan(2);
  // Seleciona dois nós (Ctrl+clique) e abre o menu num deles.
  await rows.nth(1).click();
  await rows.nth(2).click({ modifiers: ['Control'] });
  await rows.nth(2).click({ button: 'right' });
  await expect(page.getByRole('menuitem', { name: 'Remix: layout' })).toBeDisabled();
  await expect(page.getByRole('menuitem', { name: 'Remix com IA…' })).toBeDisabled();
});
