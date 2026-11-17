import { expect, test } from '@playwright/test';
import type { Node } from '@mockup/core';
import { createDoc, getDoc, gotoEditor } from './helpers';

/** Colar snapshot (Ctrl+V), simplificar importação e diálogo "Importar de URL" sem motor de render. */
test.use({ permissions: ['clipboard-read', 'clipboard-write'] });

const PNG_1X1 =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

function node(over: Partial<Node> & Pick<Node, 'id' | 'type' | 'tag'>): Node {
  return {
    name: over.tag,
    attrs: {},
    style: {},
    children: [],
    locked: false,
    hidden: false,
    ...over,
  };
}

/** Snapshot artesanal: root > [wrapper vazio, wrapper > h1, img]. */
function payload(): unknown {
  const root = node({
    id: 's-root',
    type: 'element',
    tag: 'div',
    name: 'Seção',
    style: { width: '400px', height: '240px', display: 'flex', 'flex-direction': 'column' },
    children: [
      node({ id: 's-empty', type: 'element', tag: 'div', name: 'Vazio' }),
      node({
        id: 's-wrap',
        type: 'element',
        tag: 'div',
        name: 'Embrulho',
        children: [node({ id: 's-h1', type: 'text', tag: 'h1', text: 'Título importado' })],
      }),
      node({
        id: 's-img',
        type: 'image',
        tag: 'img',
        src: 'asset:a1',
        style: { width: '40px', height: '40px' },
      }),
    ],
  });
  return {
    format: 'mockup-snapshot',
    version: 1,
    source: {
      url: 'https://exemplo.com/',
      title: 'Exemplo',
      capturedAt: '2026-01-01T00:00:00.000Z',
      viewport: { width: 1440, height: 900 },
      devicePixelRatio: 1,
    },
    root,
    width: 400,
    height: 240,
    assets: [{ id: 'a1', kind: 'image', url: 'https://exemplo.com/a.png', dataUrl: PNG_1X1 }],
    fonts: [],
    stats: { nodes: 5, truncated: false, warnings: [] },
  };
}

const textsOf = (n: Node): string[] =>
  [n.text ?? '', ...n.children.flatMap(textsOf)].filter(Boolean);

test('cola um snapshot, simplifica a importação e desfaz com um Ctrl+Z', async ({ page }) => {
  const info = await createDoc('snapshot-paste');
  await gotoEditor(page);
  const canvas = page.getByTestId('canvas');
  await canvas.click({ position: { x: 40, y: 40 } });
  await page.evaluate((t) => navigator.clipboard.writeText(t), JSON.stringify(payload()));
  await page.keyboard.press('Control+V');

  // O frame aparece no daemon e no canvas.
  await expect.poll(async () => (await getDoc(info.docId)).pages[0]!.frames.length).toBe(1);
  const frame = (await getDoc(info.docId)).pages[0]!.frames[0]!;
  expect(textsOf(frame)).toContain('Título importado');
  const img = JSON.stringify(frame).match(/"src":"([^"]+)"/)?.[1];
  expect(img && !img.startsWith('asset:')).toBeTruthy();
  const frameEl = page.getByTestId('canvas-world').locator(`[data-node-id="${frame.id}"]`);
  await expect(frameEl).toBeVisible();
  await expect(page.getByRole('status')).toContainText('Seção importada');
  // Selecionado: a linha da camada fica marcada e o menu opera sobre ele.
  const countNodes = (n: Node): number => 1 + n.children.reduce((s, c) => s + countNodes(c), 0);
  const before = countNodes(frame);

  await page.getByTestId(`layer-row-${frame.id}`).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Simplificar importação' }).click();
  await expect(page.getByRole('status')).toContainText(/Simplificado|Nada a simplificar/);
  await expect
    .poll(async () => countNodes((await getDoc(info.docId)).pages[0]!.frames[0]!))
    .toBeLessThan(before);
  expect(textsOf((await getDoc(info.docId)).pages[0]!.frames[0]!)).toContain('Título importado');

  // Uma única entrada de histórico: um undo restaura a árvore antes da simplificação.
  await page.getByTestId('undo').click();
  await expect
    .poll(async () => countNodes((await getDoc(info.docId)).pages[0]!.frames[0]!))
    .toBe(before);
});

test('Importar de URL: sem motor de render mostra a mensagem de render indisponível', async ({
  page,
}) => {
  await createDoc('snapshot-url');
  await gotoEditor(page);
  await page.getByRole('button', { name: 'Importar de URL' }).click();
  const dialog = page.getByRole('dialog', { name: 'Importar de URL' });
  await expect(dialog).toBeVisible();

  await dialog.getByLabel('URL', { exact: true }).fill('ftp://x');
  await dialog.getByRole('button', { name: 'Importar', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('http');

  await dialog.getByLabel('URL', { exact: true }).fill('https://exemplo.com');
  await dialog.getByRole('button', { name: 'Importar', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('motor de render');
  await expect(dialog.getByRole('button', { name: 'Importar', exact: true })).toBeEnabled();
  await dialog.getByRole('button', { name: 'Cancelar' }).click();
  await expect(dialog).toBeHidden();
});
