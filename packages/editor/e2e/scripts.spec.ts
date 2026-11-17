import { expect, test } from '@playwright/test';
import type { Node } from '@mockup/core';
import { Mcp, createDoc, getDoc, gotoEditor } from './helpers';

/** Scripts panel: editor, execution, and the whole script becomes ONE undo entry. */

const textNodes = (nodes: Node[]): Node[] =>
  nodes.flatMap((n) => [...(n.type === 'text' ? [n] : []), ...textNodes(n.children)]);

test('script renames 10 text nodes and a single Ctrl+Z undoes everything', async ({ page }) => {
  const info = await createDoc('scripts');
  const mcp = await new Mcp().init();
  await mcp.call('create_frame', { name: 'Screen', width: 800, height: 600, x: 0, y: 0 });
  const html = `<div class="wrap">${Array.from({ length: 10 }, (_, i) => `<p>Text ${i + 1}</p>`).join('')}</div>`;
  await mcp.call('write_html', {
    html,
    css: '.wrap{display:flex;flex-direction:column;padding:20px}',
  });

  const texts = async () => textNodes((await getDoc(info.docId)).pages[0]!.frames[0]!.children);
  const original = (await texts()).map((n) => n.name);
  expect(original).toHaveLength(10);

  await gotoEditor(page);
  await page.getByTestId('tab-scripts').click();
  const editor = page.getByTestId('script-editor');
  // CodeMirror loads on demand; the container exposes the EditorView for the test.
  await expect(editor).toHaveAttribute('data-ready', 'true');
  await editor.evaluate((el, code) => {
    const view = (
      el as unknown as {
        mockupEditorView: {
          state: { doc: { length: number } };
          dispatch: (tr: unknown) => void;
        };
      }
    ).mockupEditorView;
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: code } });
  }, "doc.select('text').forEach((n, i) => n.name = 'Item ' + (i + 1));");

  await page.getByTestId('script-run').click();
  await expect(page.getByTestId('script-output')).toHaveAttribute('data-state', 'ok');
  await expect(page.getByTestId('script-meta')).toContainText('ops');

  await expect
    .poll(async () => (await texts()).map((n) => n.name))
    .toEqual(Array.from({ length: 10 }, (_, i) => `Item ${i + 1}`));

  // A single Ctrl+Z on the canvas undoes the whole script.
  await page.getByTestId('canvas').focus();
  await page.keyboard.press('Control+z');
  await expect.poll(async () => (await texts()).map((n) => n.name)).toEqual(original);
});

test('script with an error shows the message and does not change the document', async ({
  page,
}) => {
  const info = await createDoc('scripts-error');
  const mcp = await new Mcp().init();
  await mcp.call('create_frame', { name: 'Screen', width: 400, height: 300, x: 0, y: 0 });
  await gotoEditor(page);
  await page.getByTestId('tab-scripts').click();
  const editor = page.getByTestId('script-editor');
  await expect(editor).toHaveAttribute('data-ready', 'true');
  await editor.evaluate((el) => {
    const view = (
      el as unknown as {
        mockupEditorView: { dispatch: (tr: unknown) => void; state: { doc: { length: number } } };
      }
    ).mockupEditorView;
    view.dispatch({
      changes: {
        from: 0,
        to: view.state.doc.length,
        insert: 'throw new Error("failed on purpose")',
      },
    });
  });
  await page.getByTestId('script-run').click();
  await expect(page.getByTestId('script-error')).toContainText('failed on purpose');
  expect((await getDoc(info.docId)).pages[0]!.frames).toHaveLength(1);
});
