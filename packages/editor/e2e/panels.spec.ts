import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { DAEMON, Mcp, createDoc, docPath, getDoc, gotoEditor } from './helpers';

/** Painel de propriedades, páginas, clipboard, imagem, MCP ↔ editor, arquivo e reconexão. */

const HTML = '<section class="wrap"><div class="box a">A</div><div class="box b">B</div></section>';
const CSS =
  '.wrap{display:flex;gap:20px;padding:40px;width:500px}.box{width:120px;height:100px;background:#ccc}';

async function setup(name: string, html = HTML, css = CSS) {
  const info = await createDoc(name);
  const mcp = await new Mcp().init();
  await mcp.call('create_frame', { name: 'Tela', width: 800, height: 600, x: 0, y: 0 });
  await mcp.call('write_html', { html, css });
  const frame = (await getDoc(info.docId)).pages[0]!.frames[0]!;
  return { info, mcp, frame };
}

const nodeEl = (page: Page, id: string) =>
  page.getByTestId('canvas-world').locator(`[data-node-id="${id}"]`).first();

async function clickNode(page: Page, id: string) {
  const box = (await nodeEl(page, id).boundingBox())!;
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
}

const wrapOf = async (docId: string) => (await getDoc(docId)).pages[0]!.frames[0]!.children[0]!;

async function commitInput(page: Page, selector: string, value: string) {
  const input = page.locator(selector).first();
  await input.fill(value);
  await input.press('Enter');
}

test('painel de propriedades: gap, padding, cor, raio, sombra, nome e tag', async ({ page }) => {
  const { info, frame } = await setup('props');
  const wrap = frame.children[0]!;
  await gotoEditor(page);
  await clickNode(page, wrap.children[0]!.id);
  await expect(page.getByTestId(`layer-row-${wrap.id}`)).toHaveAttribute('aria-selected', 'true');

  await commitInput(page, 'label[title="Espaçamento (gap)"] input', '32');
  await commitInput(page, 'label[title="Padding"] input', '24');
  await commitInput(page, 'label[title="Raio da borda"] input', '8');
  await commitInput(page, '[title="Cor de fundo"] input:not([type="color"])', '#ff0000');
  await page.locator('button[title="Adicionar sombra"]').click();
  await expect.poll(async () => (await wrapOf(info.docId)).style['box-shadow']).toContain('12px');
  const st = (await wrapOf(info.docId)).style;
  expect(st.gap).toBe('32px');
  expect(st.padding).toBe('24px');
  expect(st['border-radius']).toBe('8px');
  expect(st.background).toBe('#ff0000');

  // O DOM do canvas reflete os estilos.
  const css = await nodeEl(page, wrap.id).evaluate((el) => {
    const c = getComputedStyle(el);
    return { gap: c.columnGap, padding: c.paddingLeft, radius: c.borderTopLeftRadius };
  });
  expect(css).toEqual({ gap: '32px', padding: '24px', radius: '8px' });

  // Renomear pelo painel.
  await commitInput(page, '[data-testid="prop-name"] input', 'Linha');
  await expect.poll(async () => (await wrapOf(info.docId)).name).toBe('Linha');

  // Mudar a tag (op setTag).
  await page.getByRole('button', { name: 'Tag e atributos' }).click();
  await page.locator('[data-testid="prop-tag"] select').selectOption('header');
  await expect.poll(async () => (await wrapOf(info.docId)).tag).toBe('header');
  await expect(nodeEl(page, wrap.id)).toHaveJSProperty('tagName', 'HEADER');

  // CSS avançado: set e unset por diff.
  await page.getByRole('button', { name: 'CSS avançado' }).click();
  const area = page.getByTestId('prop-css');
  const lines = (await area.inputValue()).split('\n').filter((l) => !l.startsWith('padding'));
  lines.push('opacity: 0.5;');
  await area.fill(lines.join('\n'));
  await area.press('Control+Enter');
  await expect.poll(async () => (await wrapOf(info.docId)).style.opacity).toBe('0.5');
  expect((await wrapOf(info.docId)).style.padding).toBeUndefined();
  expect((await wrapOf(info.docId)).style.gap).toBe('32px');

  // Um único Ctrl+Z desfaz o último comando (o CSS avançado inteiro).
  await page.getByTestId('canvas').click({ position: { x: 3, y: 3 } });
  await clickNode(page, wrap.children[0]!.id);
  await page.keyboard.press('Control+z');
  await expect.poll(async () => (await wrapOf(info.docId)).style.padding).toBe('24px');
});

test('multisseleção mostra "Misto" nos valores diferentes', async ({ page }) => {
  const { frame } = await setup(
    'misto',
    '<div class="a"><span>A</span></div><div class="b"><span>B</span></div>',
    '.a{width:100px;height:50px;padding:10px;background:#111}.b{width:100px;height:80px;padding:20px;background:#111}',
  );
  const [a, b] = frame.children;
  await gotoEditor(page);
  await page.getByTestId(`layer-row-${a!.id}`).click();
  await page.getByTestId(`layer-row-${b!.id}`).click({ modifiers: ['Control'] });
  await expect(page.getByTestId('prop-name').locator('input')).toHaveAttribute(
    'placeholder',
    'Misto',
  );
  await expect(page.locator('label[title="Padding"] input')).toHaveAttribute(
    'placeholder',
    'Misto',
  );
  await expect(page.locator('[data-testid="prop-h"] input')).toHaveAttribute(
    'placeholder',
    'Misto',
  );
  // Valor igual nos dois (largura) é mostrado normalmente.
  await expect(page.locator('[data-testid="prop-w"] input')).toHaveValue('100px');
});

test('páginas: criar, renomear, trocar e excluir (nunca a última)', async ({ page }) => {
  const { info, frame } = await setup('paginas');
  await gotoEditor(page);
  await page.getByTestId('add-page').click();
  await expect.poll(async () => (await getDoc(info.docId)).pages.length).toBe(2);
  const [p1, p2] = (await getDoc(info.docId)).pages;

  // Renomear a nova (duplo clique no nome).
  await page.getByTestId(`page-item-${p2!.id}`).locator('.page-name').dblclick();
  const input = page.getByTestId('page-rename-input');
  await input.fill('Segunda');
  await input.press('Enter');
  await expect.poll(async () => (await getDoc(info.docId)).pages[1]!.name).toBe('Segunda');

  // Trocar: a primeira tem o frame, a segunda não.
  await page.getByTestId(`page-item-${p1!.id}`).click();
  await expect(page.getByTestId(`frame-label-${frame.id}`)).toBeVisible();
  await page.getByTestId(`page-item-${p2!.id}`).click();
  await expect(page.getByTestId(`frame-label-${frame.id}`)).toHaveCount(0);

  // Excluir a segunda pelo menu de contexto.
  await page.getByTestId(`page-item-${p2!.id}`).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Excluir' }).click();
  await expect.poll(async () => (await getDoc(info.docId)).pages.length).toBe(1);
  await expect(page.getByTestId(`frame-label-${frame.id}`)).toBeVisible();

  // A última não pode ser excluída.
  await page.getByTestId(`page-item-${p1!.id}`).click({ button: 'right' });
  await expect(page.getByRole('menuitem', { name: 'Excluir' })).toBeDisabled();
  await page.keyboard.press('Escape');
  expect((await getDoc(info.docId)).pages.length).toBe(1);
});

test('clipboard: copiar/colar com ids novos, colar HTML externo e recortar', async ({ page }) => {
  const { info, frame } = await setup('clipboard');
  const wrap = frame.children[0]!;
  const a = wrap.children[0]!;
  await gotoEditor(page);
  const ids = async () => (await wrapOf(info.docId)).children.map((c) => c.id);

  await page.getByTestId(`layer-row-${a.id}`).click();
  await page.getByTestId('canvas').focus();
  await page.keyboard.press('Control+c');
  await page.keyboard.press('Control+v');
  await expect.poll(async () => (await ids()).length).toBe(3);
  const afterCopy = await ids();
  expect(new Set(afterCopy).size).toBe(3);
  expect(afterCopy).toContain(a.id);

  // HTML externo (evento paste sintético com text/html).
  await page.getByTestId(`layer-row-${wrap.id}`).click();
  await page.evaluate(() => {
    const dt = new DataTransfer();
    dt.setData('text/html', '<p style="margin:0">Colado de fora</p>');
    dt.setData('text/plain', 'Colado de fora');
    document.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true }));
  });
  await expect(page.getByTestId('canvas-world').getByText('Colado de fora')).toBeVisible();

  // Ctrl+X remove o nó selecionado e Ctrl+V o traz de volta.
  const count = (await wrapOf(info.docId)).children.length;
  const last = (await wrapOf(info.docId)).children[count - 1]!;
  await page.getByTestId(`layer-row-${last.id}`).click();
  await page.getByTestId('canvas').focus();
  await page.keyboard.press('Control+x');
  await expect.poll(async () => (await ids()).length).toBe(count - 1);
  expect(await ids()).not.toContain(last.id);
});

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);

test('ferramenta Imagem envia o arquivo para assets/ e renderiza o nó com src relativo', async ({
  page,
}) => {
  const { info, frame } = await setup('imagem');
  await gotoEditor(page);
  const box = (await nodeEl(page, frame.id).boundingBox())!;
  const chooser = page.waitForEvent('filechooser');
  await page.getByTestId('tool-image').click();
  await page.mouse.click(box.x + 400, box.y + 450);
  (await chooser).setFiles({ name: 'foto.png', mimeType: 'image/png', buffer: PNG });

  await expect
    .poll(async () => {
      const f = (await getDoc(info.docId)).pages[0]!.frames[0]!;
      return f.children.some((c) => c.type === 'image');
    })
    .toBe(true);
  const img = (await getDoc(info.docId)).pages[0]!.frames[0]!.children.find(
    (c) => c.type === 'image',
  )!;
  expect(img.src).toBe('foto.png');
  expect(fs.existsSync(path.join(path.dirname(info.path!), 'assets', 'foto.png'))).toBe(true);
  await expect
    .poll(() =>
      nodeEl(page, img.id).evaluate((el) => {
        const i = el instanceof HTMLImageElement ? el : el.querySelector('img');
        return !!i && i.complete && i.naturalWidth > 0;
      }),
    )
    .toBe(true);
});

test('upload de asset: nome com ../ é sanitizado e não escapa de assets/', async () => {
  const info = await createDoc('upload');
  const res = await fetch(
    `${DAEMON}/api/assets/${info.docId}?name=${encodeURIComponent('../../fora.png')}`,
    { method: 'POST', headers: { 'Content-Type': 'image/png' }, body: new Uint8Array(PNG) },
  );
  expect(res.status).toBe(200);
  expect(((await res.json()) as { src: string }).src).toBe('fora.png');
  const dir = path.dirname(info.path!);
  expect(fs.existsSync(path.join(dir, 'assets', 'fora.png'))).toBe(true);
  expect(fs.existsSync(path.join(dir, '..', 'fora.png'))).toBe(false);
  const missing = await fetch(`${DAEMON}/api/assets/doc_inexistente?name=a.png`, {
    method: 'POST',
    body: new Uint8Array(PNG),
  });
  expect(missing.status).toBe(404);
});

test('MCP → editor: set_selection enquadra o nó fora da tela', async ({ page }) => {
  const { info, mcp } = await setup('enquadrar');
  await gotoEditor(page);
  await page.keyboard.press('Shift+0');
  await mcp.call('create_frame', { name: 'Longe', width: 300, height: 200, x: 5000, y: 4000 });
  const far = (await getDoc(info.docId)).pages[0]!.frames[1]!;
  const canvas = (await page.getByTestId('canvas').boundingBox())!;
  await expect(page.getByTestId(`frame-label-${far.id}`)).toBeVisible();
  const outside = (await nodeEl(page, far.id).boundingBox())!;
  expect(outside.x > canvas.x + canvas.width || outside.y > canvas.y + canvas.height).toBe(true);

  await mcp.call('set_selection', { nodeIds: [far.id] });
  await expect(page.getByTestId(`layer-row-${far.id}`)).toHaveAttribute('aria-selected', 'true');
  await expect
    .poll(async () => {
      const b = (await nodeEl(page, far.id).boundingBox())!;
      return (
        b.x >= canvas.x - 1 &&
        b.y >= canvas.y - 1 &&
        b.x + b.width <= canvas.x + canvas.width + 1 &&
        b.y + b.height <= canvas.y + canvas.height + 1
      );
    })
    .toBe(true);
});

test('badge "IA" aparece no frame alterado via MCP e some depois de alguns segundos', async ({
  page,
}) => {
  const { info, mcp, frame } = await setup('badge');
  await gotoEditor(page);
  // espera o badge da criação inicial expirar
  await expect(page.getByTestId(`agent-badge-${frame.id}`)).toHaveCount(0, { timeout: 9000 });
  const a = (await wrapOf(info.docId)).children[0]!;
  await mcp.call('update_styles', { nodeIds: [a.id], styles: { background: '#0f0' } });
  await expect(page.getByTestId(`agent-badge-${frame.id}`)).toBeVisible();
  await expect(page.getByTestId(`agent-badge-${frame.id}`)).toHaveCount(0, { timeout: 9000 });
});

test('arquivo: Novo, recentes, indicador de não salvo e título da janela', async ({ page }) => {
  await createDoc('base');
  await gotoEditor(page);
  const file = docPath('novo-doc');
  await page.getByTestId('menu-file').click();
  await page.getByTestId('file-new').click();
  await page.locator('.modal input[name="path"]').fill(file);
  await page.locator('.modal input[name="name"]').fill('Doc Novo');
  await page.locator('.modal button[type="submit"]').click();
  await expect(page.getByTestId('doc-title')).toContainText('Doc Novo');
  expect(fs.existsSync(file)).toBe(true);

  // Edita (frame pela ferramenta): fica "não salvo" e o título ganha ●; depois do autosave some.
  await page.getByTestId('tool-frame').click();
  const canvas = (await page.getByTestId('canvas').boundingBox())!;
  await page.mouse.move(canvas.x + 200, canvas.y + 200);
  await page.mouse.down();
  await page.mouse.move(canvas.x + 400, canvas.y + 350, { steps: 8 });
  await page.mouse.up();
  await expect(page.getByTestId('dirty-indicator')).toBeVisible();
  await expect(page).toHaveTitle(/●/);
  await expect(page.getByTestId('dirty-indicator')).toHaveCount(0);
  await expect(page).not.toHaveTitle(/●/);
  await expect(page).toHaveTitle(/novo-doc-\d+-\d+\.mockup\.json — Mockup Studio/);

  // Recentes: o primeiro item é o documento acabado de criar; fechar e reabrir por ele.
  await page.getByTestId('menu-file').click();
  await page.getByTestId('file-close').click();
  await page.getByTestId('menu-file').click();
  await expect(page.getByTestId('file-recent-0')).toContainText(path.basename(file));
  await page.getByTestId('file-recent-0').click();
  await expect(page.getByTestId('doc-title')).toContainText('Doc Novo');
});

test('reconexão do WS: o editor reconecta e recarrega o documento', async ({ page }) => {
  const { mcp, frame } = await setup('reconexao');
  let current: { close(): void } | null = null;
  await page.routeWebSocket(/\/ws$/, (ws) => {
    const server = ws.connectToServer();
    ws.onMessage((m) => server.send(m));
    server.onMessage((m) => ws.send(m));
    current = ws;
  });
  await gotoEditor(page);
  const status = page.getByTestId('connection-status');
  await expect(status).toHaveAttribute('data-status', 'online');
  await expect.poll(() => current !== null).toBe(true);

  // Derruba a conexão do lado da página, muda o documento fora do editor e espera a volta.
  (current as unknown as { close(): void }).close();
  await expect(status).toHaveAttribute('data-status', 'offline');
  await mcp.call('update_styles', {
    nodeIds: [frame.id],
    styles: { background: '#123456' },
  });
  await expect(status).toHaveAttribute('data-status', 'online', { timeout: 15_000 });
  await expect
    .poll(() => nodeEl(page, frame.id).evaluate((el) => getComputedStyle(el).backgroundColor))
    .toBe('rgb(18, 52, 86)');
});

test('arquivo: Salvar como grava no novo caminho e o título passa a usá-lo', async ({ page }) => {
  await createDoc('origem');
  await gotoEditor(page);
  const dest = docPath('copia');
  await page.getByTestId('menu-file').click();
  await page.getByTestId('file-save-as').click();
  await page.locator('.modal input[name="path"]').fill(dest);
  await page.locator('.modal button[type="submit"]').click();
  await expect.poll(() => page.title()).toContain(`${path.basename(dest)} — Mockup Studio`);
  expect(fs.existsSync(dest)).toBe(true);
});
