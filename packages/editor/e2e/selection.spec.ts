import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import type { Node } from '@mockup/core';
import { Mcp, createDoc, drag, getDoc, gotoEditor } from './helpers';

/** Seleção (clique, Shift, marquee, duplo clique, Esc), setas, reordenar, redimensionar e undo de gesto. */

const HTML =
  '<section class="wrap"><div class="box a"></div><div class="box b"><span class="inner">in</span></div><div class="box c"></div></section>';
const CSS =
  '.wrap{display:flex;gap:20px;padding:40px}.box{width:120px;height:100px;background:#ccc}.b{padding:20px}.inner{display:block;width:50px;height:30px;background:red}';

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

async function centerOfNode(page: Page, id: string) {
  const box = (await nodeEl(page, id).boundingBox())!;
  return { x: box.x + box.width / 2, y: box.y + box.height / 2, box };
}

const rows = async (info: { docId: string }, parentId: string): Promise<string[]> => {
  const doc = await getDoc(info.docId);
  const find = (n: Node): Node | undefined =>
    n.id === parentId ? n : n.children.map(find).find(Boolean);
  const p = doc.pages[0]!.frames.map(find).find(Boolean)!;
  return p.children.map((c) => c.id);
};

test('Shift+clique alterna a seleção e o marquee seleciona vários frames', async ({ page }) => {
  const info = await createDoc('marquee');
  const mcp = await new Mcp().init();
  await mcp.call('create_frame', { name: 'A', width: 300, height: 200, x: 0, y: 0 });
  await mcp.call('create_frame', { name: 'B', width: 300, height: 200, x: 500, y: 0 });
  const [fa, fb] = (await getDoc(info.docId)).pages[0]!.frames;
  await gotoEditor(page);

  await page.getByTestId(`frame-label-${fa!.id}`).click();
  await page.getByTestId(`frame-label-${fb!.id}`).click({ modifiers: ['Shift'] });
  await expect.poll(() => mcp.call('get_selection', {})).toContain(fb!.id);
  expect(await mcp.call('get_selection', {})).toContain(fa!.id);
  // Shift+clique de novo em B tira B da seleção.
  await page.getByTestId(`frame-label-${fb!.id}`).click({ modifiers: ['Shift'] });
  await expect.poll(() => mcp.call('get_selection', {})).not.toContain(fb!.id);
  expect(await mcp.call('get_selection', {})).toContain(fa!.id);

  // Marquee no vazio envolvendo os dois frames.
  await page.keyboard.press('Escape');
  const a = (await nodeEl(page, fa!.id).boundingBox())!;
  const b = (await nodeEl(page, fb!.id).boundingBox())!;
  const canvas = (await page.getByTestId('canvas').boundingBox())!;
  const from = {
    x: Math.max(canvas.x + 4, Math.min(a.x, b.x) - 20),
    y: Math.max(canvas.y + 4, Math.min(a.y, b.y) - 45),
  };
  const to = { x: Math.max(a.x + a.width, b.x + b.width) + 20, y: a.y + a.height + 20 };
  await drag(page, from, to);
  await expect.poll(() => mcp.call('get_selection', {})).toContain(fa!.id);
  expect(await mcp.call('get_selection', {})).toContain(fb!.id);
});

test('clique seleciona o filho do frame, duplo clique desce e Esc sobe', async ({ page }) => {
  const { mcp, info, frame } = await setup('niveis');
  const wrap = frame.children[0]!;
  const a = wrap.children[0]!;
  await gotoEditor(page);
  void info;

  const pa = await centerOfNode(page, a.id);
  await page.mouse.click(pa.x, pa.y);
  await expect.poll(() => mcp.call('get_selection', {})).toContain(wrap.id);
  expect(await mcp.call('get_selection', {})).not.toContain(a.id);

  await page.mouse.dblclick(pa.x, pa.y);
  await expect.poll(() => mcp.call('get_selection', {})).toContain(a.id);
  expect(await mcp.call('get_selection', {})).not.toContain(wrap.id);

  await page.keyboard.press('Escape');
  await expect.poll(() => mcp.call('get_selection', {})).toContain(wrap.id);
  expect(await mcp.call('get_selection', {})).not.toContain(a.id);
});

test('setas movem 1 px e Shift+setas 10 px (frame e nó absolute)', async ({ page }) => {
  const { info, frame } = await setup(
    'setas',
    '<div class="abs">x</div>',
    '.abs{position:absolute;left:30px;top:40px;width:80px;height:50px;background:#9cf}',
  );
  const abs = frame.children[0]!;
  await gotoEditor(page);

  await page.getByTestId(`frame-label-${frame.id}`).click();
  // Espera o canvas refletir cada seta antes da próxima (setas calculam a partir do documento local).
  const press = async (key: string) => {
    const before = await nodeEl(page, frame.id).boundingBox();
    await page.keyboard.press(key);
    await expect
      .poll(async () => {
        const b = await nodeEl(page, frame.id).boundingBox();
        return b?.x !== before?.x || b?.y !== before?.y;
      })
      .toBe(true);
  };
  await press('ArrowRight');
  await press('ArrowDown');
  await expect
    .poll(async () => (await getDoc(info.docId)).pages[0]!.frames[0]!.position)
    .toEqual({ x: 1, y: 1 });
  await press('Shift+ArrowLeft');
  await expect
    .poll(async () => (await getDoc(info.docId)).pages[0]!.frames[0]!.position)
    .toEqual({ x: -9, y: 1 });

  const p = await centerOfNode(page, abs.id);
  await page.keyboard.down('Control');
  await page.mouse.click(p.x, p.y);
  await page.keyboard.up('Control');
  await expect(page.getByTestId(`layer-row-${abs.id}`)).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('Shift+ArrowDown');
  await expect
    .poll(async () => {
      const n = (await getDoc(info.docId)).pages[0]!.frames[0]!.children[0]!;
      return [n.style.left, n.style.top];
    })
    .toEqual(['31px', '50px']);
});

test('reordenar filho em pai flex arrastando (para depois e para antes)', async ({ page }) => {
  const { info, frame } = await setup('reordenar');
  const wrap = frame.children[0]!;
  const [a, b, c] = wrap.children.map((n) => n.id) as [string, string, string];
  await gotoEditor(page);

  // A -> depois de C: ordem B, C, A.
  const pa = await centerOfNode(page, a);
  await page.mouse.dblclick(pa.x, pa.y);
  await expect(page.getByTestId(`layer-row-${a}`)).toHaveAttribute('aria-selected', 'true');
  const pc = await centerOfNode(page, c);
  await drag(page, pa, { x: pc.box.x + pc.box.width - 10, y: pc.y }, { steps: 20 });
  await expect.poll(() => rows(info, wrap.id)).toEqual([b, c, a]);
  // O daemon responde ao HTTP antes de o editor renderizar o `doc:changed`: mede A só depois
  // de o DOM refletir a nova ordem (senão o arrasto começa na posição antiga).
  const domRows = () =>
    page
      .getByTestId('canvas-world')
      .locator(`[data-node-id="${wrap.id}"] > [data-node-id]`)
      .evaluateAll((els) => els.map((e) => e.getAttribute('data-node-id')));
  await expect.poll(domRows).toEqual([b, c, a]);

  // A (agora por último) -> antes de B: ordem A, B, C.
  const pa2 = await centerOfNode(page, a);
  const pb = await centerOfNode(page, b);
  await drag(page, pa2, { x: pb.box.x + 10, y: pb.y }, { steps: 20 });
  await expect.poll(() => rows(info, wrap.id)).toEqual([a, b, c]);

  // Um único undo desfaz o gesto inteiro.
  await page.keyboard.press('Control+z');
  await expect.poll(() => rows(info, wrap.id)).toEqual([b, c, a]);
});

test('Shift mantém a proporção e Alt redimensiona a partir do centro', async ({ page }) => {
  const { info, frame } = await setup('resize');
  await gotoEditor(page);
  await page.getByTestId(`frame-label-${frame.id}`).click();
  const size = async () => {
    const f = (await getDoc(info.docId)).pages[0]!.frames[0]!;
    return { w: parseFloat(f.style.width!), h: parseFloat(f.style.height!), pos: f.position };
  };
  /** Ajusta o zoom para caber tudo (a alça fica visível) e devolve a alça sudeste e a escala. */
  const prepare = async () => {
    // O overlay remede por rAF: espera a alça sudeste chegar ao canto do frame já enquadrado.
    // O Shift+1 enquadra pelo tamanho do modelo: se o resize anterior ainda não chegou ao editor,
    // enquadra o tamanho antigo e a alça fica fora do canvas (sob o painel). Repete até caber.
    const handle = page.getByTestId('handle-se');
    const canvas = page.getByTestId('canvas');
    await expect
      .poll(async () => {
        await page.keyboard.press('Shift+1');
        const f = await nodeEl(page, frame.id).boundingBox();
        const h = await handle.boundingBox();
        const c = await canvas.boundingBox();
        if (!f || !h || !c) return Infinity;
        if (h.x + h.width > c.x + c.width || h.y + h.height > c.y + c.height) return Infinity;
        const dx = h.x + h.width / 2 - (f.x + f.width);
        const dy = h.y + h.height / 2 - (f.y + f.height);
        return Math.hypot(dx, dy);
      })
      .toBeLessThan(1.5);
    const s = await size();
    const z = (await nodeEl(page, frame.id).boundingBox())!.width / s.w;
    const h = (await handle.boundingBox())!;
    return { x: h.x + h.width / 2, y: h.y + h.height / 2, z };
  };

  // Shift: arrastar só em x mantém a proporção 4:3.
  let h0 = await prepare();
  await page.keyboard.down('Shift');
  await page.mouse.move(h0.x, h0.y);
  await page.mouse.down();
  await page.mouse.move(h0.x + 100 * h0.z, h0.y, { steps: 10 });
  await page.mouse.up();
  await page.keyboard.up('Shift');
  await expect.poll(async () => (await size()).w).toBeGreaterThan(850);
  const s1 = await size();
  expect(s1.w / s1.h).toBeCloseTo(800 / 600, 1);

  // Alt: cresce para os dois lados; a posição recua pela metade do aumento.
  h0 = await prepare();
  await page.keyboard.down('Alt');
  await page.mouse.move(h0.x, h0.y);
  await page.mouse.down();
  await page.mouse.move(h0.x + 100 * h0.z, h0.y + 60 * h0.z, { steps: 10 });
  await page.mouse.up();
  await page.keyboard.up('Alt');
  await expect.poll(async () => (await size()).w).toBeGreaterThan(s1.w + 50);
  const after = await size();
  expect(s1.pos!.x - after.pos!.x).toBeCloseTo((after.w - s1.w) / 2, 0);
  expect(s1.pos!.y - after.pos!.y).toBeCloseTo((after.h - s1.h) / 2, 0);
});

test('um arrasto é uma única entrada de undo', async ({ page }) => {
  const { info, frame } = await setup('undo-arrasto');
  await gotoEditor(page);
  const label = (await page.getByTestId(`frame-label-${frame.id}`).boundingBox())!;
  const from = { x: label.x + 10, y: label.y + label.height / 2 };
  await drag(page, from, { x: from.x + 200, y: from.y + 120 }, { steps: 30 });
  await expect
    .poll(async () => (await getDoc(info.docId)).pages[0]!.frames[0]!.position!.x)
    .toBeGreaterThan(50);
  await page.keyboard.press('Control+z');
  await expect
    .poll(async () => (await getDoc(info.docId)).pages[0]!.frames[0]!.position)
    .toEqual({ x: 0, y: 0 });
});

test('setas repetidas rapidamente não perdem movimentos', async ({ page }) => {
  const { info, frame } = await setup('setas-rapidas');
  await gotoEditor(page);
  await page.getByTestId(`frame-label-${frame.id}`).click();
  for (let i = 0; i < 10; i++) await page.keyboard.press('ArrowDown');
  await expect
    .poll(async () => (await getDoc(info.docId)).pages[0]!.frames[0]!.position!.y)
    .toBe(10);
});
