import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import type { Document } from '@mockup/core';
import { Mcp, createDoc, getDoc, gotoEditor } from './helpers';

/** Componentes no editor: criar (Ctrl+Alt+K), instâncias com props, edição do principal e kit. */

const nodeEl = (page: Page, id: string) =>
  page.getByTestId('canvas-world').locator(`[data-node-id="${id}"]`).first();

const bg = (page: Page, id: string) =>
  nodeEl(page, id).evaluate((el) => getComputedStyle(el).backgroundColor);

const frameOf = async (docId: string) => (await getDoc(docId)).pages[0]!.frames[0]!;

async function setup(name: string) {
  const info = await createDoc(name);
  const mcp = await new Mcp().init();
  await mcp.call('create_frame', { name: 'Tela', width: 800, height: 600, x: 0, y: 0 });
  await mcp.call('write_html', {
    html: '<div class="card"><p class="t">{{label}}</p></div>',
    css: '.card{padding:12px;background:#eeeeee;width:200px}.t{margin:0;font-size:16px;min-height:20px}',
  });
  const frame = await frameOf(info.docId);
  return { info, mcp, frame };
}

/** Seleciona pelo painel de camadas (aba Camadas). */
async function selectLayer(page: Page, id: string) {
  await page.getByTestId('tab-layers').click();
  await page.getByTestId(`layer-row-${id}`).click();
}

async function setLabel(page: Page, value: string) {
  const input = page.locator('[data-testid="instance-prop-label"] input');
  await input.fill(value);
  await input.press('Enter');
}

const component = (doc: Document) => doc.components?.[0];

test('cria componente (Ctrl+Alt+K), 3 instâncias com props, edita o principal e propaga; undo volta', async ({
  page,
}) => {
  const { info, frame } = await setup('componentes');
  const card = frame.children[0]!;
  const textId = card.children[0]!.id;
  await gotoEditor(page);

  // Ctrl+Alt+K transforma o nó em componente; o nó vira a primeira instância (selecionada).
  await selectLayer(page, card.id);
  await page.keyboard.press('Control+Alt+k');
  await expect.poll(async () => (await getDoc(info.docId)).components?.length ?? 0).toBe(1);
  const doc1 = await getDoc(info.docId);
  const cid = component(doc1)!.id;
  const name = component(doc1)!.name;
  const first = (await frameOf(info.docId)).children[0]!;
  expect(first.type).toBe('instance');
  expect(first.componentId).toBe(cid);
  expect(component(doc1)!.props.map((p) => p.name)).toEqual(['label']);
  await expect(page.getByTestId('instance-component-name')).toHaveText(name);
  await expect(page.getByTestId(`layer-row-${first.id}`)).toHaveAttribute(
    'data-component-role',
    'instance',
  );

  // Mais duas instâncias pela aba Componentes (+), cada uma logo depois da selecionada.
  await page.getByTestId('tab-components').click();
  const item = page.getByTestId(`component-item-${cid}`);
  await expect(item).toContainText('1 instância');
  await item.hover();
  await page.getByTestId(`component-insert-${cid}`).click();
  await expect.poll(async () => (await frameOf(info.docId)).children.length).toBe(2);
  await item.hover();
  await page.getByTestId(`component-insert-${cid}`).click();
  await expect.poll(async () => (await frameOf(info.docId)).children.length).toBe(3);
  await expect(item).toContainText('3 instâncias');
  const ids = (await frameOf(info.docId)).children.map((n) => n.id);
  expect((await frameOf(info.docId)).children.every((n) => n.componentId === cid)).toBe(true);

  // Props diferentes pelo painel de propriedades.
  const labels = ['Um', 'Dois', 'Três'];
  for (let i = 0; i < 3; i++) {
    await selectLayer(page, ids[i]!);
    await setLabel(page, labels[i]!);
    await expect(nodeEl(page, `${ids[i]}/${textId}`)).toHaveText(labels[i]!);
  }
  const insts = (await frameOf(info.docId)).children;
  expect(insts.map((n) => n.props?.label)).toEqual(labels);

  // Instância com contorno roxo na seleção.
  await expect(page.getByTestId('selection-box')).toHaveAttribute('data-component', '');

  // Ir para principal: modo isolado (só o principal no canvas).
  await page.getByTestId('instance-go-main').click();
  await expect(page.getByTestId('component-edit-bar')).toBeVisible();
  await expect(page.getByTestId('component-edit-name')).toHaveText(name);
  await expect(nodeEl(page, card.id)).toBeVisible();
  await expect(nodeEl(page, ids[1]!)).toHaveCount(0);
  await expect(nodeEl(page, card.id)).toContainText('{{label}}');

  // Estilo no principal (a raiz já vem selecionada) e texto num nó do principal.
  const color = page.locator('[title="Cor de fundo"] input:not([type="color"])').first();
  await color.fill('#ff0000');
  await color.press('Enter');
  await expect
    .poll(async () => component(await getDoc(info.docId))!.root.style.background)
    .toBe('#ff0000');
  expect(await bg(page, card.id)).toBe('rgb(255, 0, 0)');

  // Concluir: volta à página e seleciona a instância de origem; as 3 refletem o principal.
  await page.getByTestId('component-edit-done').click();
  await expect(page.getByTestId('component-edit-bar')).toHaveCount(0);
  await expect(page.getByTestId(`layer-row-${ids[2]}`)).toHaveAttribute('aria-selected', 'true');
  for (const id of ids) await expect.poll(() => bg(page, id)).toBe('rgb(255, 0, 0)');
  for (let i = 0; i < 3; i++)
    await expect(nodeEl(page, `${ids[i]}/${textId}`)).toHaveText(labels[i]!);

  // Undo desfaz a edição do principal em todas as instâncias.
  await page.getByTestId('canvas').focus();
  await page.keyboard.press('Control+z');
  await expect
    .poll(async () => component(await getDoc(info.docId))!.root.style.background)
    .toBe('#eeeeee');
  for (const id of ids) await expect.poll(() => bg(page, id)).toBe('rgb(238, 238, 238)');

  // Texto de um nó interno vira override da instância; Restaurar volta ao valor da prop.
  const inner = `${ids[0]}/${textId}`;
  await selectLayer(page, inner);
  await nodeEl(page, inner).dblclick();
  const editor = page.getByTestId('text-editor');
  await expect(editor).toBeVisible();
  await page.keyboard.press('Control+a');
  await page.keyboard.type('Outro');
  await page.keyboard.press('Enter');
  await expect
    .poll(async () => (await frameOf(info.docId)).children[0]!.overrides?.[textId]?.text)
    .toBe('Outro');
  await expect(nodeEl(page, inner)).toHaveText('Outro');
  await expect(nodeEl(page, `${ids[1]}/${textId}`)).toHaveText('Dois');
  await selectLayer(page, ids[0]!);
  await expect(page.getByTestId('instance-reset')).toBeEnabled();
  await page.getByTestId('instance-reset').click();
  await expect(nodeEl(page, inner)).toHaveText('Um');
  await expect(page.getByTestId('instance-reset')).toBeDisabled();

  // Nó interno não pode ser excluído (aviso, nada muda).
  await selectLayer(page, inner);
  await page.getByTestId('canvas').focus();
  await page.keyboard.press('Delete');
  await expect(page.getByText(/não podem ser movidos/)).toBeVisible();
  expect((await frameOf(info.docId)).children).toHaveLength(3);
});

test('insere shadcn-like/Button pela aba Componentes e troca a variante', async ({ page }) => {
  const info = await createDoc('kit');
  const mcp = await new Mcp().init();
  await mcp.call('create_frame', { name: 'Tela', width: 800, height: 600, x: 0, y: 0 });
  await gotoEditor(page);

  await page.getByTestId('tab-components').click();
  const button = page.getByTestId('kit-item-shadcn-like-Button');
  await expect(button).toBeVisible();
  await button.click();
  await expect.poll(async () => (await frameOf(info.docId)).children.length).toBe(1);
  const doc = await getDoc(info.docId);
  const inst = doc.pages[0]!.frames[0]!.children[0]!;
  expect(inst.type).toBe('instance');
  expect(inst.componentId).toBe('cp_sbutton1');
  expect(doc.components?.find((c) => c.id === 'cp_sbutton1')?.kit).toBe('shadcn-like');
  // Tokens do kit importados junto (uma chamada).
  expect(doc.tokens['--color-primary']).toBeDefined();

  // No canvas: <button> com o texto padrão e o estilo do kit.
  const el = nodeEl(page, inst.id);
  await expect(el).toHaveJSProperty('tagName', 'BUTTON');
  await expect(el).toHaveText('Botão');
  const st = await el.evaluate((e) => {
    const c = getComputedStyle(e);
    return { display: c.display, height: c.height, bg: c.backgroundColor };
  });
  expect(st.display).toBe('inline-flex');
  expect(st.height).toBe('36px');

  // A biblioteca do documento passa a listar o Button; trocar a variante muda o estilo.
  await expect(page.getByTestId('component-item-cp_sbutton1')).toContainText('shadcn-like');
  await page.locator('[data-testid="instance-prop-variant"] select').selectOption('outline');
  await expect
    .poll(async () => (await frameOf(info.docId)).children[0]!.props?.variant)
    .toBe('outline');
  await expect.poll(() => bg(page, inst.id)).not.toBe(st.bg);

  // Arrastar do kit para o canvas: instância no ponto solto (absoluta no frame não-flex).
  const frameId = (await frameOf(info.docId)).id;
  await page
    .getByTestId('kit-item-shadcn-like-Input')
    .dragTo(nodeEl(page, frameId), { targetPosition: { x: 300, y: 200 } });
  await expect.poll(async () => (await frameOf(info.docId)).children.length).toBe(2);
  const dropped = (await frameOf(info.docId)).children[1]!;
  expect(dropped.componentId).toBe('cp_sinput01');
  expect(dropped.style.position).toBe('absolute');
  await expect(nodeEl(page, dropped.id)).toHaveJSProperty('tagName', 'INPUT');
  await page.getByTestId('canvas').focus();
  await page.keyboard.press('Control+z');
  await expect.poll(async () => (await frameOf(info.docId)).children.length).toBe(1);

  // Undo: primeiro a variante; depois a inserção inteira (kit importado + instância, uma entrada).
  await page.getByTestId('canvas').focus();
  await page.keyboard.press('Control+z');
  await expect
    .poll(async () => (await frameOf(info.docId)).children[0]!.props?.variant)
    .toBeUndefined();
  await page.keyboard.press('Control+z');
  await expect.poll(async () => (await frameOf(info.docId)).children.length).toBe(0);
  expect((await getDoc(info.docId)).components ?? []).toHaveLength(0);
});

test('slot editável: texto criado dentro do slot content do Card do kit', async ({ page }) => {
  const info = await createDoc('slot');
  const mcp = await new Mcp().init();
  await mcp.call('create_frame', { name: 'Tela', width: 800, height: 600, x: 0, y: 0 });
  await gotoEditor(page);
  await page.getByTestId('tab-components').click();
  await page.getByTestId('kit-item-shadcn-like-Card').click();
  await expect.poll(async () => (await frameOf(info.docId)).children.length).toBe(1);
  const inst = (await frameOf(info.docId)).children[0]!;
  const slot = inst.children.find((c) => c.attrs['data-slot'] === 'content')!;
  // Conteúdo padrão do principal enquanto o slot está vazio.
  await expect(nodeEl(page, slot.id)).toContainText('Conteúdo do cartão');

  // O botão do slot seleciona o contêiner real; o texto (T) entra nele.
  await page.getByTestId('instance-slot-content').click();
  await expect(page.getByTestId(`layer-row-${slot.id}`)).toHaveAttribute(
    'data-component-role',
    'slot',
  );
  const box = (await nodeEl(page, slot.id).boundingBox())!;
  await page.keyboard.press('t');
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await expect(page.getByTestId('text-editor')).toBeVisible();
  await page.keyboard.press('Control+a');
  await page.keyboard.type('Olá slot');
  await page.keyboard.press('Enter');
  await expect
    .poll(async () => {
      const i = (await frameOf(info.docId)).children[0]!;
      return i.children.find((c) => c.id === slot.id)?.children[0]?.text;
    })
    .toBe('Olá slot');
  await expect(nodeEl(page, slot.id)).toContainText('Olá slot');
  await expect(nodeEl(page, slot.id)).not.toContainText('Conteúdo do cartão');
});

test('go_to_main do MCP entra no modo de edição; Esc volta', async ({ page }) => {
  const { info, mcp, frame } = await setup('go-to-main');
  const card = frame.children[0]!;
  await gotoEditor(page);
  await selectLayer(page, card.id);
  await page.keyboard.press('Control+Alt+k');
  await expect.poll(async () => (await getDoc(info.docId)).components?.length ?? 0).toBe(1);
  const inst = (await frameOf(info.docId)).children[0]!;

  await mcp.call('go_to_main', { nodeId: inst.id });
  await expect(page.getByTestId('component-edit-bar')).toBeVisible();
  await expect(page.getByTestId(`layer-row-${card.id}`)).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByTestId('component-section')).toBeVisible();

  // Esc sobe da raiz (seleção vazia) e o segundo Esc conclui.
  await page.getByTestId('canvas').focus();
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('component-edit-bar')).toHaveCount(0);
  await expect(nodeEl(page, inst.id)).toBeVisible();
});
