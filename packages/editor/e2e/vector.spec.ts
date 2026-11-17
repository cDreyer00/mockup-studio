import { expect, test } from '@playwright/test';
import { pathToSubpaths } from '@mockup/core';
import type { Node } from '@mockup/core';
import { Mcp, createDoc, getDoc, gotoEditor } from './helpers';

const LUCIDE_CHECK =
  '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>';

function findSvgs(nodes: Node[]): Node[] {
  return nodes.flatMap((n) => [...(n.type === 'svg' ? [n] : []), ...findSvgs(n.children)]);
}

async function frameWithBox(docId: string, page: import('@playwright/test').Page) {
  const mcp = await new Mcp().init();
  await mcp.call('create_frame', { name: 'Tela', width: 800, height: 600, x: 0, y: 0 });
  const frame = (await getDoc(docId)).pages[0]!.frames[0]!;
  await gotoEditor(page);
  const frameEl = page.getByTestId('canvas-world').locator(`[data-node-id="${frame.id}"]`);
  await expect(frameEl).toBeVisible();
  const box = (await frameEl.boundingBox())!;
  return { frame, box };
}

test('Caneta: caminho fechado de 4 pontos vira nó svg com vetor', async ({ page }) => {
  const info = await createDoc('caneta');
  const { box } = await frameWithBox(info.docId, page);

  await page.getByTestId('tool-pen').click();
  const pts = [
    { x: box.x + 100, y: box.y + 100 },
    { x: box.x + 300, y: box.y + 100 },
    { x: box.x + 300, y: box.y + 260 },
    { x: box.x + 100, y: box.y + 260 },
  ];
  for (const p of pts) await page.mouse.click(p.x, p.y);
  await expect(page.getByTestId('pen-overlay')).toBeVisible();
  // Clicar no primeiro ponto fecha o caminho.
  await page.mouse.click(pts[0]!.x, pts[0]!.y);

  await expect
    .poll(async () => findSvgs((await getDoc(info.docId)).pages[0]!.frames).length)
    .toBe(1);
  const node = findSvgs((await getDoc(info.docId)).pages[0]!.frames)[0]!;
  expect(node.vector).toBeTruthy();
  const d = node.vector!.paths[0]!.d;
  expect(d.trim().toUpperCase().endsWith('Z')).toBe(true);
  const subs = pathToSubpaths(d);
  expect(subs).toHaveLength(1);
  expect(subs[0]!.closed).toBe(true);
  expect(subs[0]!.anchors).toHaveLength(4);
  expect(node.style.position).toBe('absolute');
  await expect(page.getByTestId('tool-select')).toHaveAttribute('aria-pressed', 'true');
});

test('Caneta: Enter conclui um caminho aberto e arrastar cria alças', async ({ page }) => {
  const info = await createDoc('caneta-aberta');
  const { box } = await frameWithBox(info.docId, page);

  await page.keyboard.press('p');
  await page.mouse.click(box.x + 120, box.y + 120);
  // Segunda âncora com arrasto: alças de Bézier.
  await page.mouse.move(box.x + 260, box.y + 200);
  await page.mouse.down();
  await page.mouse.move(box.x + 320, box.y + 200, { steps: 8 });
  await page.mouse.up();
  await page.mouse.click(box.x + 400, box.y + 120);
  await page.keyboard.press('Enter');

  await expect
    .poll(async () => findSvgs((await getDoc(info.docId)).pages[0]!.frames).length)
    .toBe(1);
  const node = findSvgs((await getDoc(info.docId)).pages[0]!.frames)[0]!;
  const d = node.vector!.paths[0]!.d;
  expect(d).toMatch(/C/);
  expect(d.trim().toUpperCase().endsWith('Z')).toBe(false);
});

test('SVG do Lucide colado: troca a cor do traço e regenera o vetor', async ({ page }) => {
  const info = await createDoc('lucide');
  const { frame } = await frameWithBox(info.docId, page);

  await page.getByTestId(`layer-row-${frame.id}`).click();
  await page.getByTestId('canvas').focus();
  await page.evaluate((svg) => {
    const data = new DataTransfer();
    data.setData('text/plain', svg);
    document.dispatchEvent(
      new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }),
    );
  }, LUCIDE_CHECK);

  await expect
    .poll(async () => findSvgs((await getDoc(info.docId)).pages[0]!.frames).length)
    .toBe(1);
  const before = findSvgs((await getDoc(info.docId)).pages[0]!.frames)[0]!;
  expect(before.vector?.raw).toBeTruthy();
  expect(before.vector?.paths[0]!.stroke).toBe('currentColor');

  // O nó colado fica selecionado: o painel mostra a seção de vetor.
  const color = page.getByTestId('vector-stroke-color').locator('input:not([type="color"])');
  await expect(color).toBeVisible();
  await color.fill('#ff0000');
  await color.press('Enter');

  await expect
    .poll(async () => findSvgs((await getDoc(info.docId)).pages[0]!.frames)[0]!.vector?.paths[0]!.stroke)
    .toBe('#ff0000');
  const after = findSvgs((await getDoc(info.docId)).pages[0]!.frames)[0]!;
  expect(after.vector!.raw).toBeUndefined();
  expect(after.svg).toContain('#ff0000');
  expect(after.svg).not.toContain('currentColor');

  // Largura do traço pelo painel.
  const width = page.getByTestId('vector-stroke-width').locator('input');
  await width.fill('4');
  await width.press('Enter');
  await expect
    .poll(async () => findSvgs((await getDoc(info.docId)).pages[0]!.frames)[0]!.vector?.paths[0]!.strokeWidth)
    .toBe(4);
});

test('Edição de pontos: Enter entra, arrastar âncora persiste e Esc sai', async ({ page }) => {
  const info = await createDoc('edicao-pontos');
  const { box } = await frameWithBox(info.docId, page);

  await page.keyboard.press('p');
  for (const [x, y] of [
    [120, 120],
    [320, 120],
    [320, 280],
  ] as const) {
    await page.mouse.click(box.x + x, box.y + y);
  }
  await page.keyboard.press('Enter');
  await expect
    .poll(async () => findSvgs((await getDoc(info.docId)).pages[0]!.frames).length)
    .toBe(1);
  const before = findSvgs((await getDoc(info.docId)).pages[0]!.frames)[0]!;

  // Enter com o svg selecionado entra na edição de pontos.
  await page.getByTestId('canvas').focus();
  await page.keyboard.press('Enter');
  const anchor = page.getByTestId('vector-anchor-0-2');
  await expect(anchor).toBeVisible();
  const a = (await anchor.boundingBox())!;
  const cx = a.x + a.width / 2;
  const cy = a.y + a.height / 2;
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  await page.mouse.move(cx + 60, cy + 40, { steps: 10 });
  await page.mouse.up();

  await expect
    .poll(async () => {
      const n = findSvgs((await getDoc(info.docId)).pages[0]!.frames)[0]!;
      return pathToSubpaths(n.vector!.paths[0]!.d)[0]!.anchors.length;
    })
    .toBe(3);
  await expect
    .poll(async () => {
      const n = findSvgs((await getDoc(info.docId)).pages[0]!.frames)[0]!;
      return parseFloat(n.style.width ?? '0');
    })
    .toBeGreaterThan(parseFloat(before.style.width ?? '0') + 40);

  await page.keyboard.press('Escape');
  await expect(page.getByTestId('vector-edit-overlay')).toHaveCount(0);
});
