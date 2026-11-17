import { expect, test } from '@playwright/test';
import type { Node } from '@mockup/core';
import { createDoc, getDoc, gotoEditor } from './helpers';

/** Paste snapshot (Ctrl+V), simplify import and the "Import from URL" dialog without a render engine. */
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

/** Hand-made snapshot: root > [empty wrapper, wrapper > h1, img]. */
function payload(): unknown {
  const root = node({
    id: 's-root',
    type: 'element',
    tag: 'div',
    name: 'Section',
    style: { width: '400px', height: '240px', display: 'flex', 'flex-direction': 'column' },
    children: [
      node({ id: 's-empty', type: 'element', tag: 'div', name: 'Empty' }),
      node({
        id: 's-wrap',
        type: 'element',
        tag: 'div',
        name: 'Wrapper',
        children: [node({ id: 's-h1', type: 'text', tag: 'h1', text: 'Imported title' })],
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
      url: 'https://example.com/',
      title: 'Example',
      capturedAt: '2026-01-01T00:00:00.000Z',
      viewport: { width: 1440, height: 900 },
      devicePixelRatio: 1,
    },
    root,
    width: 400,
    height: 240,
    assets: [{ id: 'a1', kind: 'image', url: 'https://example.com/a.png', dataUrl: PNG_1X1 }],
    fonts: [],
    stats: { nodes: 5, truncated: false, warnings: [] },
  };
}

const textsOf = (n: Node): string[] =>
  [n.text ?? '', ...n.children.flatMap(textsOf)].filter(Boolean);

test('pastes a snapshot, simplifies the import and undoes it with a single Ctrl+Z', async ({
  page,
}) => {
  const info = await createDoc('snapshot-paste');
  await gotoEditor(page);
  const canvas = page.getByTestId('canvas');
  await canvas.click({ position: { x: 40, y: 40 } });
  await page.evaluate((t) => navigator.clipboard.writeText(t), JSON.stringify(payload()));
  await page.keyboard.press('Control+V');

  // The frame shows up in the daemon and on the canvas.
  await expect.poll(async () => (await getDoc(info.docId)).pages[0]!.frames.length).toBe(1);
  const frame = (await getDoc(info.docId)).pages[0]!.frames[0]!;
  expect(textsOf(frame)).toContain('Imported title');
  const img = JSON.stringify(frame).match(/"src":"([^"]+)"/)?.[1];
  expect(img && !img.startsWith('asset:')).toBeTruthy();
  const frameEl = page.getByTestId('canvas-world').locator(`[data-node-id="${frame.id}"]`);
  await expect(frameEl).toBeVisible();
  await expect(page.getByRole('status')).toContainText('Section imported');
  // Selected: the layer row is marked and the menu operates on it.
  const countNodes = (n: Node): number => 1 + n.children.reduce((s, c) => s + countNodes(c), 0);
  const before = countNodes(frame);

  await page.getByTestId(`layer-row-${frame.id}`).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Simplify import' }).click();
  await expect(page.getByRole('status')).toContainText(/Simplified|Nothing to simplify/);
  await expect
    .poll(async () => countNodes((await getDoc(info.docId)).pages[0]!.frames[0]!))
    .toBeLessThan(before);
  expect(textsOf((await getDoc(info.docId)).pages[0]!.frames[0]!)).toContain('Imported title');

  // A single history entry: one undo restores the tree from before the simplification.
  await page.getByTestId('undo').click();
  await expect
    .poll(async () => countNodes((await getDoc(info.docId)).pages[0]!.frames[0]!))
    .toBe(before);
});

test('Import from URL: without a render engine shows the render unavailable message', async ({
  page,
}) => {
  await createDoc('snapshot-url');
  await gotoEditor(page);
  await page.getByRole('button', { name: 'Import from URL' }).click();
  const dialog = page.getByRole('dialog', { name: 'Import from URL' });
  await expect(dialog).toBeVisible();

  await dialog.getByLabel('URL', { exact: true }).fill('ftp://x');
  await dialog.getByRole('button', { name: 'Import', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('http');

  await dialog.getByLabel('URL', { exact: true }).fill('https://example.com');
  await dialog.getByRole('button', { name: 'Import', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('render engine');
  await expect(dialog.getByRole('button', { name: 'Import', exact: true })).toBeEnabled();
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(dialog).toBeHidden();
});
