import { expect, test } from '@playwright/test';
import { Mcp, createDoc, drag, getDoc, gotoEditor } from './helpers';

/** Fluxo de edição do plano: container, texto inline, camadas, clipboard e páginas. */
test('cria container e texto, edita texto inline, renomeia, copia e cola', async ({ page }) => {
  const info = await createDoc('fluxo');
  const mcp = await new Mcp().init();
  await mcp.call('create_frame', { name: 'Tela', width: 800, height: 600, x: 0, y: 0 });
  const frame = (await getDoc(info.docId)).pages[0]!.frames[0]!;
  await gotoEditor(page);
  const frameEl = page.getByTestId('canvas-world').locator(`[data-node-id="${frame.id}"]`);
  const box = (await frameEl.boundingBox())!;

  // Container (R) desenhado dentro do frame: vira filho absoluto.
  await page.keyboard.press('r');
  await drag(page, { x: box.x + 40, y: box.y + 40 }, { x: box.x + 200, y: box.y + 140 });
  await expect
    .poll(async () => (await getDoc(info.docId)).pages[0]!.frames[0]!.children.length)
    .toBe(1);
  const rect = (await getDoc(info.docId)).pages[0]!.frames[0]!.children[0]!;
  expect(rect.style.position).toBe('absolute');

  // Texto (T): clique cria e entra em edição inline; Enter confirma.
  await page.keyboard.press('t');
  await page.mouse.click(box.x + 300, box.y + 300);
  const editor = page.getByTestId('text-editor');
  await expect(editor).toBeVisible();
  await page.keyboard.press('Control+a');
  await page.keyboard.type('Olá, mundo');
  await page.keyboard.press('Enter');
  await expect
    .poll(async () => (await getDoc(info.docId)).pages[0]!.frames[0]!.children[1]?.text)
    .toBe('Olá, mundo');
  const text = (await getDoc(info.docId)).pages[0]!.frames[0]!.children[1]!;

  // Renomear pela árvore de camadas (duplo clique).
  await page.getByTestId(`layer-row-${text.id}`).dblclick();
  const rename = page.getByTestId('layer-rename-input');
  await rename.fill('Saudação');
  await rename.press('Enter');
  await expect
    .poll(async () => (await getDoc(info.docId)).pages[0]!.frames[0]!.children[1]!.name)
    .toBe('Saudação');

  // Copiar e colar (ids novos), depois desfazer a colagem.
  await page.getByTestId(`layer-row-${text.id}`).click();
  await page.getByTestId('canvas').focus();
  await page.keyboard.press('Control+c');
  await page.keyboard.press('Control+v');
  await expect
    .poll(async () => (await getDoc(info.docId)).pages[0]!.frames[0]!.children.length)
    .toBe(3);
  const pasted = (await getDoc(info.docId)).pages[0]!.frames[0]!.children[2]!;
  expect(pasted.id).not.toBe(text.id);
  expect(pasted.text).toBe('Olá, mundo');
  await page.keyboard.press('Control+z');
  await expect
    .poll(async () => (await getDoc(info.docId)).pages[0]!.frames[0]!.children.length)
    .toBe(2);

  // Duplicar (Ctrl+D) e excluir (Delete).
  await page.getByTestId(`layer-row-${rect.id}`).click();
  await page.keyboard.press('Control+d');
  await expect
    .poll(async () => (await getDoc(info.docId)).pages[0]!.frames[0]!.children.length)
    .toBe(3);
  await page.keyboard.press('Delete');
  await expect
    .poll(async () => (await getDoc(info.docId)).pages[0]!.frames[0]!.children.length)
    .toBe(2);

  // Página nova vira a ativa e fica vazia.
  await page.getByTestId('add-page').click();
  await expect.poll(async () => (await getDoc(info.docId)).pages.length).toBe(2);
  await expect(page.getByTestId(`frame-label-${frame.id}`)).toHaveCount(0);
});
