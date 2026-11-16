import fs from 'node:fs';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { Mcp, createDoc, drag, getDoc, gotoEditor } from './helpers';

/** Escala atual do canvas: largura renderizada do nó / largura em px do modelo. */
async function zoomOf(page: Page, nodeId: string, modelWidth: number): Promise<number> {
  const box = await page
    .getByTestId('canvas-world')
    .locator(`[data-node-id="${nodeId}"]`)
    .first()
    .boundingBox();
  if (!box) throw new Error('nó não renderizado');
  return box.width / modelWidth;
}

async function frameWithMcp(name: string, w = 400, h = 300) {
  const info = await createDoc(name);
  const mcp = await new Mcp().init();
  await mcp.call('create_frame', { name: 'Alvo', width: w, height: h, x: 0, y: 0 });
  const frame = (await getDoc(info.docId)).pages[0]!.frames[0]!;
  return { info, mcp, frame };
}

test('cria um frame com a ferramenta Frame', async ({ page }) => {
  const info = await createDoc('ferramenta-frame');
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
  // A ferramenta volta para seleção e o frame novo fica selecionado.
  await expect(page.getByTestId('selection-box')).toBeVisible();
});

test('HTML escrito via MCP aparece no canvas sem recarregar e a seleção sincroniza', async ({
  page,
}) => {
  const info = await createDoc('mcp');
  await gotoEditor(page);
  const mcp = await new Mcp().init();
  await mcp.call('create_frame', { name: 'Desktop', width: 800, height: 600, x: 0, y: 0 });
  await expect(page.locator('[data-testid^="frame-label-"]')).toHaveCount(1);

  await mcp.call('write_html', {
    html: '<section class="hero"><h1>Olá do agente</h1><p>Feito via MCP</p></section>',
    css: '.hero{display:flex;flex-direction:column;gap:16px;padding:48px}',
  });
  const world = page.getByTestId('canvas-world');
  await expect(world.getByText('Olá do agente')).toBeVisible();
  // Badge "agente trabalhando" no frame tocado pelo MCP.
  await expect(page.locator('[data-testid^="agent-badge-"]').first()).toBeVisible();

  // Editor → MCP: seleção profunda (Ctrl+clique) aparece em get_selection.
  const doc = await getDoc(info.docId);
  const section = doc.pages[0]!.frames[0]!.children[0]!;
  const h1 = section.children[0]!;
  await world.getByText('Olá do agente').click({ modifiers: ['Control'] });
  await expect.poll(() => mcp.call('get_selection', {})).toContain(h1.id);

  // MCP → editor: set_selection seleciona no canvas.
  await mcp.call('set_selection', { nodeIds: [section.id] });
  await expect(page.getByTestId(`layer-row-${section.id}`)).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await expect(page.getByTestId('selection-box')).toBeVisible();
});

test('move e redimensiona um frame', async ({ page }) => {
  const { info, frame } = await frameWithMcp('mover');
  await gotoEditor(page);
  const z = await zoomOf(page, frame.id, 400);

  // Mover arrastando o nome do frame.
  const label = (await page.getByTestId(`frame-label-${frame.id}`).boundingBox())!;
  const from = { x: label.x + 10, y: label.y + label.height / 2 };
  await drag(page, from, { x: from.x + 150, y: from.y + 80 });
  await expect
    .poll(async () => (await getDoc(info.docId)).pages[0]!.frames[0]!.position)
    .toEqual({ x: Math.round(150 / z), y: Math.round(80 / z) });

  // Redimensionar pela alça sudeste.
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

test('desfaz e refaz com Ctrl+Z e Ctrl+Shift+Z', async ({ page }) => {
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

test('salva e reabre mantendo as alterações', async ({ page }) => {
  const { info, frame } = await frameWithMcp('salvar');
  await gotoEditor(page);
  await page.getByTestId(`frame-label-${frame.id}`).click();

  // Edita a largura pelo painel de propriedades e renomeia.
  const w = page.locator('[data-testid="prop-w"] input');
  await w.fill('640');
  await w.press('Enter');
  const name = page.getByTestId('prop-name');
  const nameInput =
    (await name.evaluate((el) => el.tagName)) === 'INPUT' ? name : name.locator('input');
  await nameInput.fill('Tela salva');
  await nameInput.press('Enter');
  await expect
    .poll(async () => (await getDoc(info.docId)).pages[0]!.frames[0]!.name)
    .toBe('Tela salva');

  await page.getByTestId('canvas').click({ position: { x: 5, y: 5 } });
  await page.keyboard.press('Control+s');
  await expect(page.getByTestId('dirty-indicator')).toHaveCount(0);
  const saved = JSON.parse(fs.readFileSync(info.path!, 'utf8')) as {
    pages: { frames: { name: string; style: Record<string, string> }[] }[];
  };
  expect(saved.pages[0]!.frames[0]!.style.width).toBe('640px');
  expect(saved.pages[0]!.frames[0]!.name).toBe('Tela salva');

  // Fecha pelo menu Arquivo e reabre pelo diálogo de caminho.
  await page.getByTestId('menu-file').click();
  await page.getByTestId('file-close').click();
  // Outro documento aberto (de testes anteriores) pode virar o ativo; o fechado some.
  await expect(page.getByTestId(`frame-label-${frame.id}`)).toHaveCount(0);
  await page.getByTestId('menu-file').click();
  await page.getByTestId('file-open').click();
  await page.locator('.modal input[name="path"]').fill(info.path!);
  await page.locator('.modal button[type="submit"]').click();
  await expect(page.getByTestId(`frame-label-${frame.id}`)).toContainText('Tela salva');
  // O documento reaberto (mesmo id do arquivo) mantém a largura editada.
  expect((await getDoc(info.docId)).pages[0]!.frames[0]!.style.width).toBe('640px');
});
