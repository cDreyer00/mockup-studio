import { describe, expect, it } from 'vitest';
import { applyOps } from '../apply.js';
import { createDocument, createNode, findNode } from '../document.js';
import { ID_PREFIX } from '../ids.js';
import type { Document, Node, NodeType } from '../types.js';
import { colorScale } from './color.js';
import { FONT_PAIRS } from './fontPairs.js';
import { planRemix, REMIX_GAP } from './plan.js';

const FRAME = 'fr_main0001';
const OTHER = 'fr_other001';
const FAR = 'fr_far00001';
const BTN = 'el_btn00001';
const ROW = 'el_row00001';
const TITLE = 'tx_title001';
const PARA = 'tx_para0001';

/** Documento de teste: frame 800x600 em 0,0; outro frame ao lado (x 1000) e um longe, abaixo. */
function makeDoc(): Document {
  const doc = createDocument('Remix', { id: 'doc_remix001' });
  doc.tokens = { '--brand': '#ff0000', '--space': '10px' };
  const title = createNode({
    id: TITLE,
    tag: 'h1',
    name: 'Título',
    text: 'Título',
    style: { 'font-size': '32px', color: '#2563eb' },
  });
  const para = createNode({
    id: PARA,
    tag: 'p',
    name: 'Parágrafo',
    text: 'Corpo',
    style: { 'font-size': '16px', color: '#111111' },
  });
  const label = createNode({
    id: 'tx_btnlbl01',
    tag: 'span',
    name: 'Rótulo',
    text: 'Ok',
    style: { 'font-weight': '600' },
  });
  const btn = createNode({
    id: BTN,
    tag: 'button',
    name: 'Botão',
    style: { 'background-color': '#2563eb', padding: '12px 20px' },
    children: [label],
  });
  const row = createNode({
    id: ROW,
    tag: 'div',
    name: 'Linha',
    style: {
      display: 'flex',
      'flex-direction': 'row',
      'justify-content': 'center',
      'align-items': 'flex-start',
      gap: '16px',
      padding: '24px',
    },
    children: [title, para, btn],
  });
  const frame = createNode({
    id: FRAME,
    type: 'frame',
    tag: 'div',
    name: 'Desktop',
    style: { width: '800px', height: '600px', background: '#ffffff' },
    position: { x: 0, y: 0 },
    children: [row],
  });
  const other = createNode({
    id: OTHER,
    type: 'frame',
    tag: 'div',
    name: 'Outro',
    style: { width: '500px', height: '300px' },
    position: { x: 1000, y: 100 },
  });
  const far = createNode({
    id: FAR,
    type: 'frame',
    tag: 'div',
    name: 'Longe',
    style: { width: '9000px', height: '100px' },
    position: { x: 3000, y: 2000 },
  });
  doc.pages[0]!.frames.push(frame, other, far);
  return doc;
}

/** Gerador de ids determinístico (8 caracteres depois do prefixo). */
function counter(): (type: NodeType) => string {
  let n = 0;
  return (type) => ID_PREFIX[type] + String(++n).padStart(8, '0');
}

const frameOf = (doc: Document, id: string): Node => findNode(doc, id)!.node;
const sansMeta = (d: Document): Omit<Document, 'meta'> => {
  const { meta: _meta, ...rest } = d;
  return rest;
};

describe('planRemix: comum a todos os tipos', () => {
  const kinds = [
    ['color-scale', BTN],
    ['font-pairs', FRAME],
    ['spacing', FRAME],
    ['layout', TITLE],
  ] as const;

  it.each(kinds)(
    '%s: frames lado a lado, sem sobreposição, nomeados e original intacto',
    (kind, node) => {
      const doc = makeDoc();
      const before = structuredClone(doc);
      const plan = planRemix(doc, node, kind, { newId: counter() });
      expect(doc).toEqual(before); // planejar não muda o documento
      expect(plan.frameIds.length).toBeGreaterThanOrEqual(2);
      expect(plan.labels).toHaveLength(plan.frameIds.length);

      const { doc: after } = applyOps(doc, plan.ops);
      // A origem fica intacta.
      expect(frameOf(after, FRAME)).toEqual(frameOf(doc, FRAME));

      // Começa depois do frame mais à direita que se sobrepõe verticalmente (OTHER, até x=1500);
      // o frame distante (abaixo) não conta.
      const rects = plan.frameIds.map((id) => {
        const f = frameOf(after, id);
        return { x: f.position!.x, y: f.position!.y, w: parseInt(f.style['width']!, 10) };
      });
      expect(rects[0]!.x).toBe(1500 + REMIX_GAP);
      for (let i = 0; i < rects.length; i++) {
        expect(rects[i]!.y).toBe(0);
        if (i > 0) expect(rects[i]!.x).toBe(rects[i - 1]!.x + rects[i - 1]!.w + REMIX_GAP);
      }
      // Nomes `<frame> — <label>`.
      plan.frameIds.forEach((id, i) =>
        expect(frameOf(after, id).name).toBe(`Desktop — ${plan.labels[i]}`),
      );
      // Todos os clones são frames raiz da página, com ids novos e descendentes com ids próprios.
      const page = after.pages[0]!;
      for (const id of plan.frameIds) expect(page.frames.map((f) => f.id)).toContain(id);
      expect(page.frames).toHaveLength(3 + plan.frameIds.length);
    },
  );

  it.each(kinds)('%s: determinístico com newId fixo', (kind, node) => {
    const a = planRemix(makeDoc(), node, kind, { newId: counter() });
    const b = planRemix(makeDoc(), node, kind, { newId: counter() });
    expect(b).toEqual(a);
  });

  it.each(kinds)('%s: aplicar e desfazer com os inversos restaura o documento', (kind, node) => {
    const doc = makeDoc();
    const plan = planRemix(doc, node, kind);
    const applied = applyOps(doc, plan.ops);
    expect(applied.doc.pages[0]!.frames.length).toBeGreaterThan(3);
    const undone = applyOps(applied.doc, applied.inverse).doc;
    expect(sansMeta(undone)).toEqual(sansMeta(doc));
  });

  it('o duplicateNodes leva idMap explícito com todos os descendentes', () => {
    const plan = planRemix(makeDoc(), BTN, 'color-scale', { count: 2, newId: counter() });
    const dups = plan.ops.filter((o) => o.type === 'duplicateNodes');
    expect(dups).toHaveLength(2);
    for (const d of dups) {
      // frame, linha, título, parágrafo, botão e rótulo
      expect(Object.keys(d.idMap!)).toHaveLength(6);
    }
  });

  it('as camadas dos clones ficam na ordem das variações', () => {
    const doc = makeDoc();
    const plan = planRemix(doc, BTN, 'color-scale', { count: 3 });
    const { doc: after } = applyOps(doc, plan.ops);
    const ids = after.pages[0]!.frames.map((f) => f.id);
    const at = plan.frameIds.map((id) => ids.indexOf(id));
    expect(at[1]).toBe(at[0]! + 1);
    expect(at[2]).toBe(at[1]! + 1);
  });

  it('count inválido lança erro', () => {
    for (const count of [0, -1, 1.5]) {
      expect(() => planRemix(makeDoc(), BTN, 'color-scale', { count })).toThrow(/count inválido/);
    }
  });

  it('nó inexistente, virtual (dentro de instância) e kind ai lançam erro claro', () => {
    const doc = makeDoc();
    expect(() => planRemix(doc, 'el_nope0001', 'spacing')).toThrow(/não encontrado/);
    expect(() => planRemix(doc, 'in_inst0001/el_btn00001', 'spacing')).toThrow(/instância/);
    expect(() => planRemix(doc, BTN, 'ai')).toThrow(/IA/);
  });

  it('ids dos clones são únicos no documento com o gerador padrão', () => {
    const doc = makeDoc();
    const plan = planRemix(doc, BTN, 'color-scale');
    expect(() => applyOps(doc, plan.ops)).not.toThrow();
  });

  it('frame sem medidas em px usa 400 e, sem posição, parte de 0', () => {
    const doc = makeDoc();
    doc.pages[0]!.frames = [
      createNode({
        id: FRAME,
        type: 'frame',
        tag: 'div',
        name: 'Fluido',
        style: { width: '100%', 'background-color': '#ff0000' },
      }),
    ];
    const plan = planRemix(doc, FRAME, 'color-scale', { count: 2 });
    const { doc: after } = applyOps(doc, plan.ops);
    expect(frameOf(after, plan.frameIds[0]!).position).toEqual({ x: 400 + REMIX_GAP, y: 0 });
    expect(frameOf(after, plan.frameIds[1]!).position).toEqual({
      x: 400 + REMIX_GAP + 400 + REMIX_GAP,
      y: 0,
    });
  });
});

describe('planRemix color-scale', () => {
  it('gera 10 frames e troca só a cor do nó pelo tom em cada clone', () => {
    const doc = makeDoc();
    const plan = planRemix(doc, BTN, 'color-scale', { newId: counter() });
    expect(plan.frameIds).toHaveLength(10);
    expect(plan.labels).toEqual(
      [50, 100, 200, 300, 400, 500, 600, 700, 800, 900].map((s) => `tom ${s}`),
    );
    const scale = colorScale('#2563eb');
    const { doc: after } = applyOps(doc, plan.ops);
    plan.frameIds.forEach((id, i) => {
      const clone = frameOf(after, id);
      const btn = clone.children[0]!.children[2]!;
      expect(btn.style['background-color']).toBe(scale[i]!.color);
      // o resto do botão e do clone não muda
      expect(btn.style['padding']).toBe('12px 20px');
      expect(clone.children[0]!.children[0]!.style['color']).toBe('#2563eb');
    });
    // o botão original continua com a cor original
    expect(findNode(after, BTN)!.node.style['background-color']).toBe('#2563eb');
  });

  it('count menor escolhe stops espaçados', () => {
    const plan = planRemix(makeDoc(), BTN, 'color-scale', { count: 3 });
    expect(plan.labels).toEqual(['tom 50', 'tom 500', 'tom 900']);
    expect(planRemix(makeDoc(), BTN, 'color-scale', { count: 1 }).labels).toEqual(['tom 500']);
    expect(planRemix(makeDoc(), BTN, 'color-scale', { count: 99 }).frameIds).toHaveLength(10);
  });

  it('resolve var() de tokens e usa a primeira cor sólida na ordem das propriedades', () => {
    const doc = makeDoc();
    const btn = findNode(doc, BTN)!.node;
    btn.style = { color: '#00ff00', 'background-color': 'var(--brand)' };
    const plan = planRemix(doc, BTN, 'color-scale', { count: 2 });
    const { doc: after } = applyOps(doc, plan.ops);
    const clone = frameOf(after, plan.frameIds[0]!).children[0]!.children[2]!;
    expect(clone.style['background-color']).toBe(colorScale('#ff0000')[0]!.color);
    expect(clone.style['color']).toBe('#00ff00');
  });

  it('usa color quando o nó só tem cor de texto e ignora cor transparente', () => {
    const doc = makeDoc();
    const btn = findNode(doc, BTN)!.node;
    btn.style = {
      'background-color': 'transparent',
      'border-color': 'rgba(0,0,0,0.5)',
      color: 'red',
    };
    const plan = planRemix(doc, BTN, 'color-scale', { count: 1 });
    const { doc: after } = applyOps(doc, plan.ops);
    const clone = frameOf(after, plan.frameIds[0]!).children[0]!.children[2]!;
    expect(clone.style['color']).toBe(colorScale('red')[5]!.color);
    expect(clone.style['background-color']).toBe('transparent');
  });

  it('background só vale se for cor (gradiente é ignorado)', () => {
    const doc = makeDoc();
    findNode(doc, BTN)!.node.style = {
      background: 'linear-gradient(red, blue)',
      'border-color': '#123456',
    };
    const plan = planRemix(doc, BTN, 'color-scale', { count: 1 });
    const { doc: after } = applyOps(doc, plan.ops);
    const clone = frameOf(after, plan.frameIds[0]!).children[0]!.children[2]!;
    expect(clone.style['border-color']).toBe(colorScale('#123456')[5]!.color);
    expect(clone.style['background']).toBe('linear-gradient(red, blue)');
  });

  it('sem cor sólida lança erro', () => {
    expect(() => planRemix(makeDoc(), ROW, 'color-scale')).toThrow(/não tem cor sólida/);
    const doc = makeDoc();
    findNode(doc, BTN)!.node.style = { background: 'linear-gradient(red, blue)' };
    expect(() => planRemix(doc, BTN, 'color-scale')).toThrow(/não tem cor sólida/);
  });
});

describe('planRemix font-pairs', () => {
  const FONTS = ['Playfair Display', 'Inter', 'Georgia', 'Verdana', 'Arial'];

  it('filtra pelos pares com as duas famílias disponíveis, na ordem da lista curada', () => {
    const plan = planRemix(makeDoc(), FRAME, 'font-pairs', { fonts: FONTS });
    expect(plan.labels).toEqual(['Playfair Display + Inter', 'Georgia + Verdana']);
  });

  it('é insensível a maiúsculas ao comparar famílias', () => {
    const plan = planRemix(makeDoc(), FRAME, 'font-pairs', {
      fonts: ['playfair display', 'INTER'],
    });
    expect(plan.labels).toEqual(['Playfair Display + Inter']);
  });

  it('títulos (h1, fonte >= 24px, peso >= 600) recebem a fonte de título e o resto a de corpo', () => {
    const doc = makeDoc();
    const plan = planRemix(doc, FRAME, 'font-pairs', { fonts: FONTS, count: 1 });
    const { doc: after } = applyOps(doc, plan.ops);
    const clone = frameOf(after, plan.frameIds[0]!);
    const [title, para, btn] = clone.children[0]!.children as [Node, Node, Node];
    expect(clone.style['font-family']).toBe('"Inter", sans-serif');
    expect(title.style['font-family']).toBe('"Playfair Display", serif');
    expect(para.style['font-family']).toBe('"Inter", sans-serif');
    // rótulo do botão com peso 600 conta como título
    expect(btn.children[0]!.style['font-family']).toBe('"Playfair Display", serif');
    // original intacto
    expect(findNode(after, TITLE)!.node.style['font-family']).toBeUndefined();
  });

  it('font-size >= 24px sem tag de título também é título', () => {
    const doc = makeDoc();
    findNode(doc, PARA)!.node.style['font-size'] = '28px';
    const plan = planRemix(doc, PARA, 'font-pairs', { fonts: FONTS, count: 1 });
    const { doc: after } = applyOps(doc, plan.ops);
    const para = frameOf(after, plan.frameIds[0]!).children[0]!.children[1]!;
    expect(para.style['font-family']).toBe('"Playfair Display", serif');
  });

  it('sem a lista de fontes usa a ordem curada e o count padrão 4', () => {
    const plan = planRemix(makeDoc(), FRAME, 'font-pairs');
    expect(plan.frameIds).toHaveLength(4);
    expect(plan.labels).toEqual(FONT_PAIRS.slice(0, 4).map((p) => `${p.heading} + ${p.body}`));
  });

  it('erros: nenhum par disponível e nó sem texto', () => {
    expect(() => planRemix(makeDoc(), FRAME, 'font-pairs', { fonts: ['Comic Sans MS'] })).toThrow(
      /Nenhum par/,
    );
    const doc = makeDoc();
    doc.pages[0]!.frames[1]!.children.push(
      createNode({ id: 'el_empty001', tag: 'div', style: { padding: '8px' } }),
    );
    expect(() => planRemix(doc, 'el_empty001', 'font-pairs')).toThrow(/não tem texto/);
  });
});

describe('planRemix spacing', () => {
  const cloneBtn = (after: Document, id: string): Node =>
    frameOf(after, id).children[0]!.children[2]!;
  const cloneRow = (after: Document, id: string): Node => frameOf(after, id).children[0]!;

  it('4 variações em ordem fixa, arredondadas à grade', () => {
    const doc = makeDoc();
    const plan = planRemix(doc, FRAME, 'spacing', { newId: counter() });
    expect(plan.labels).toEqual(['compacto', 'grade 4', 'grade 8', 'confortável']);
    const { doc: after } = applyOps(doc, plan.ops);
    const [compact, g4, g8, comfy] = plan.frameIds;
    // compacto: x0,5 na grade de 4 (12px 20px -> 6px 10px -> 8px 12px)
    expect(cloneRow(after, compact!).style['padding']).toBe('12px');
    expect(cloneRow(after, compact!).style['gap']).toBe('8px');
    expect(cloneBtn(after, compact!).style['padding']).toBe('8px 12px');
    // grade 4: 12px 20px já estão na grade -> sem mudança no botão
    expect(cloneBtn(after, g4!).style['padding']).toBe('12px 20px');
    // grade 8: 12 -> 16, 20 -> 24
    expect(cloneBtn(after, g8!).style['padding']).toBe('16px 24px');
    expect(cloneRow(after, g8!).style['gap']).toBe('16px');
    // confortável: x1,5 na grade de 8 (12*1,5=18 -> 16; 20*1,5=30 -> 32)
    expect(cloneBtn(after, comfy!).style['padding']).toBe('16px 32px');
    // original intacto
    expect(findNode(after, BTN)!.node.style['padding']).toBe('12px 20px');
  });

  it('espaçoso é a quinta variação (count 5; acima disso limita a 5)', () => {
    const doc = makeDoc();
    const plan = planRemix(doc, FRAME, 'spacing', { count: 5 });
    expect(plan.labels.at(-1)).toBe('espaçoso');
    expect(planRemix(doc, FRAME, 'spacing', { count: 8 }).frameIds).toHaveLength(5);
    const { doc: after } = applyOps(doc, plan.ops);
    expect(cloneBtn(after, plan.frameIds[4]!).style['padding']).toBe('24px 40px');
    expect(cloneRow(after, plan.frameIds[4]!).style['padding']).toBe('48px');
  });

  it('não zera valores positivos pequenos e resolve var() de tokens', () => {
    const doc = makeDoc();
    const btn = findNode(doc, BTN)!.node;
    btn.style = { padding: '1px', 'margin-left': 'var(--space)', margin: '0 auto' };
    const plan = planRemix(doc, BTN, 'spacing', { count: 1 });
    const { doc: after } = applyOps(doc, plan.ops);
    const clone = cloneBtn(after, plan.frameIds[0]!);
    expect(clone.style['padding']).toBe('4px'); // 0,5px -> grade 4, mas não zera
    expect(clone.style['margin-left']).toBe('4px'); // 10px x0,5 = 5 -> grade 4
    expect(clone.style['margin']).toBe('0 auto'); // 0 e auto não mudam
  });

  it('aplica na subárvore do nó, não fora dela', () => {
    const doc = makeDoc();
    const plan = planRemix(doc, BTN, 'spacing', { count: 1 });
    const { doc: after } = applyOps(doc, plan.ops);
    const row = cloneRow(after, plan.frameIds[0]!);
    expect(row.style['padding']).toBe('24px');
    expect(row.style['gap']).toBe('16px');
    expect(cloneBtn(after, plan.frameIds[0]!).style['padding']).toBe('8px 12px');
  });

  it('sem espaçamento em px lança erro', () => {
    expect(() => planRemix(makeDoc(), TITLE, 'spacing')).toThrow(/espaçamento em px/);
    const doc = makeDoc();
    findNode(doc, BTN)!.node.style = { padding: '1rem', gap: 'calc(100% - 2rem)' };
    expect(() => planRemix(doc, BTN, 'spacing')).toThrow(/espaçamento em px/);
  });
});

describe('planRemix layout', () => {
  const cloneRow = (after: Document, id: string): Node => frameOf(after, id).children[0]!;

  it('3 rearranjos do flex do ancestral mais próximo', () => {
    const doc = makeDoc();
    const plan = planRemix(doc, TITLE, 'layout', { newId: counter() });
    expect(plan.labels).toEqual([
      'direção invertida',
      'ordem invertida',
      'centralizado com quebra',
    ]);
    const { doc: after } = applyOps(doc, plan.ops);
    const [dir, order, wrap] = plan.frameIds.map((id) => cloneRow(after, id)) as [Node, Node, Node];
    // direção invertida: row -> column, justify center vira align center e align flex-start vira justify
    expect(dir.style['flex-direction']).toBe('column');
    expect(dir.style['align-items']).toBe('center');
    expect(dir.style['justify-content']).toBe('flex-start');
    // ordem invertida: filhos ao contrário no clone
    expect(order.children.map((c) => c.name)).toEqual(['Botão', 'Parágrafo', 'Título']);
    expect(order.style['flex-direction']).toBe('row');
    // centralizado com quebra
    expect(wrap.style['flex-wrap']).toBe('wrap');
    expect(wrap.style['justify-content']).toBe('center');
    expect(wrap.style['align-items']).toBe('center');
    // original intacto
    const orig = findNode(after, ROW)!.node;
    expect(orig.children.map((c) => c.name)).toEqual(['Título', 'Parágrafo', 'Botão']);
    expect(orig.style['flex-direction']).toBe('row');
  });

  it('o próprio nó flex é usado quando for o alvo; column volta para row', () => {
    const doc = makeDoc();
    const row = findNode(doc, ROW)!.node;
    row.style['flex-direction'] = 'column';
    const plan = planRemix(doc, ROW, 'layout', { count: 1 });
    const { doc: after } = applyOps(doc, plan.ops);
    expect(cloneRow(after, plan.frameIds[0]!).style['flex-direction']).toBe('row');
  });

  it('count limita a 3 e aceita menos', () => {
    const doc = makeDoc();
    expect(planRemix(doc, ROW, 'layout', { count: 2 }).frameIds).toHaveLength(2);
    expect(planRemix(doc, ROW, 'layout', { count: 9 }).frameIds).toHaveLength(3);
  });

  it('com menos de 2 filhos a ordem invertida fica de fora', () => {
    const doc = makeDoc();
    findNode(doc, ROW)!.node.children.splice(1);
    const plan = planRemix(doc, ROW, 'layout');
    expect(plan.labels).toEqual(['direção invertida', 'centralizado com quebra']);
  });

  it('sem flex no nó e nos ancestrais lança erro', () => {
    const doc = makeDoc();
    findNode(doc, ROW)!.node.style = { padding: '8px' };
    expect(() => planRemix(doc, TITLE, 'layout')).toThrow(/flex/);
  });
});
