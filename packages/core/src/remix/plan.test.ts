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

/** Test document: 800x600 frame at 0,0; another frame beside it (x 1000) and one far away, below. */
function makeDoc(): Document {
  const doc = createDocument('Remix', { id: 'doc_remix001' });
  doc.tokens = { '--brand': '#ff0000', '--space': '10px' };
  const title = createNode({
    id: TITLE,
    tag: 'h1',
    name: 'Title',
    text: 'Title',
    style: { 'font-size': '32px', color: '#2563eb' },
  });
  const para = createNode({
    id: PARA,
    tag: 'p',
    name: 'Paragraph',
    text: 'Body',
    style: { 'font-size': '16px', color: '#111111' },
  });
  const label = createNode({
    id: 'tx_btnlbl01',
    tag: 'span',
    name: 'Label',
    text: 'Ok',
    style: { 'font-weight': '600' },
  });
  const btn = createNode({
    id: BTN,
    tag: 'button',
    name: 'Button',
    style: { 'background-color': '#2563eb', padding: '12px 20px' },
    children: [label],
  });
  const row = createNode({
    id: ROW,
    tag: 'div',
    name: 'Row',
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
    name: 'Other',
    style: { width: '500px', height: '300px' },
    position: { x: 1000, y: 100 },
  });
  const far = createNode({
    id: FAR,
    type: 'frame',
    tag: 'div',
    name: 'Far',
    style: { width: '9000px', height: '100px' },
    position: { x: 3000, y: 2000 },
  });
  doc.pages[0]!.frames.push(frame, other, far);
  return doc;
}

/** Deterministic id generator (8 characters after the prefix). */
function counter(): (type: NodeType) => string {
  let n = 0;
  return (type) => ID_PREFIX[type] + String(++n).padStart(8, '0');
}

const frameOf = (doc: Document, id: string): Node => findNode(doc, id)!.node;
const sansMeta = (d: Document): Omit<Document, 'meta'> => {
  const { meta: _meta, ...rest } = d;
  return rest;
};

describe('planRemix: common to all kinds', () => {
  const kinds = [
    ['color-scale', BTN],
    ['font-pairs', FRAME],
    ['spacing', FRAME],
    ['layout', TITLE],
  ] as const;

  it.each(kinds)(
    '%s: side-by-side frames, no overlap, named, and original untouched',
    (kind, node) => {
      const doc = makeDoc();
      const before = structuredClone(doc);
      const plan = planRemix(doc, node, kind, { newId: counter() });
      expect(doc).toEqual(before); // planning does not change the document
      expect(plan.frameIds.length).toBeGreaterThanOrEqual(2);
      expect(plan.labels).toHaveLength(plan.frameIds.length);

      const { doc: after } = applyOps(doc, plan.ops);
      // The source stays untouched.
      expect(frameOf(after, FRAME)).toEqual(frameOf(doc, FRAME));

      // Starts after the rightmost frame that overlaps vertically (OTHER, up to x=1500);
      // the distant frame (below) does not count.
      const rects = plan.frameIds.map((id) => {
        const f = frameOf(after, id);
        return { x: f.position!.x, y: f.position!.y, w: parseInt(f.style['width']!, 10) };
      });
      expect(rects[0]!.x).toBe(1500 + REMIX_GAP);
      for (let i = 0; i < rects.length; i++) {
        expect(rects[i]!.y).toBe(0);
        if (i > 0) expect(rects[i]!.x).toBe(rects[i - 1]!.x + rects[i - 1]!.w + REMIX_GAP);
      }
      // Names `<frame> — <label>`.
      plan.frameIds.forEach((id, i) =>
        expect(frameOf(after, id).name).toBe(`Desktop — ${plan.labels[i]}`),
      );
      // All clones are root frames of the page, with new ids and descendants with their own ids.
      const page = after.pages[0]!;
      for (const id of plan.frameIds) expect(page.frames.map((f) => f.id)).toContain(id);
      expect(page.frames).toHaveLength(3 + plan.frameIds.length);
    },
  );

  it.each(kinds)('%s: deterministic with a fixed newId', (kind, node) => {
    const a = planRemix(makeDoc(), node, kind, { newId: counter() });
    const b = planRemix(makeDoc(), node, kind, { newId: counter() });
    expect(b).toEqual(a);
  });

  it.each(kinds)(
    '%s: applying and undoing with the inverses restores the document',
    (kind, node) => {
      const doc = makeDoc();
      const plan = planRemix(doc, node, kind);
      const applied = applyOps(doc, plan.ops);
      expect(applied.doc.pages[0]!.frames.length).toBeGreaterThan(3);
      const undone = applyOps(applied.doc, applied.inverse).doc;
      expect(sansMeta(undone)).toEqual(sansMeta(doc));
    },
  );

  it('duplicateNodes carries an explicit idMap with all descendants', () => {
    const plan = planRemix(makeDoc(), BTN, 'color-scale', { count: 2, newId: counter() });
    const dups = plan.ops.filter((o) => o.type === 'duplicateNodes');
    expect(dups).toHaveLength(2);
    for (const d of dups) {
      // frame, row, title, paragraph, button and label
      expect(Object.keys(d.idMap!)).toHaveLength(6);
    }
  });

  it('the clone layers stay in variation order', () => {
    const doc = makeDoc();
    const plan = planRemix(doc, BTN, 'color-scale', { count: 3 });
    const { doc: after } = applyOps(doc, plan.ops);
    const ids = after.pages[0]!.frames.map((f) => f.id);
    const at = plan.frameIds.map((id) => ids.indexOf(id));
    expect(at[1]).toBe(at[0]! + 1);
    expect(at[2]).toBe(at[1]! + 1);
  });

  it('invalid count throws an error', () => {
    for (const count of [0, -1, 1.5]) {
      expect(() => planRemix(makeDoc(), BTN, 'color-scale', { count })).toThrow(/Invalid count/);
    }
  });

  it('a nonexistent node, a virtual one (inside an instance) and kind ai throw a clear error', () => {
    const doc = makeDoc();
    expect(() => planRemix(doc, 'el_nope0001', 'spacing')).toThrow(/not found/);
    expect(() => planRemix(doc, 'in_inst0001/el_btn00001', 'spacing')).toThrow(/instance/);
    expect(() => planRemix(doc, BTN, 'ai')).toThrow(/AI/);
  });

  it('clone ids are unique in the document with the default generator', () => {
    const doc = makeDoc();
    const plan = planRemix(doc, BTN, 'color-scale');
    expect(() => applyOps(doc, plan.ops)).not.toThrow();
  });

  it('a frame without px measures uses 400 and, without a position, starts from 0', () => {
    const doc = makeDoc();
    doc.pages[0]!.frames = [
      createNode({
        id: FRAME,
        type: 'frame',
        tag: 'div',
        name: 'Fluid',
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
  it('generates 10 frames and swaps only the node color for the shade in each clone', () => {
    const doc = makeDoc();
    const plan = planRemix(doc, BTN, 'color-scale', { newId: counter() });
    expect(plan.frameIds).toHaveLength(10);
    expect(plan.labels).toEqual(
      [50, 100, 200, 300, 400, 500, 600, 700, 800, 900].map((s) => `shade ${s}`),
    );
    const scale = colorScale('#2563eb');
    const { doc: after } = applyOps(doc, plan.ops);
    plan.frameIds.forEach((id, i) => {
      const clone = frameOf(after, id);
      const btn = clone.children[0]!.children[2]!;
      expect(btn.style['background-color']).toBe(scale[i]!.color);
      // the rest of the button and of the clone does not change
      expect(btn.style['padding']).toBe('12px 20px');
      expect(clone.children[0]!.children[0]!.style['color']).toBe('#2563eb');
    });
    // the original button keeps the original color
    expect(findNode(after, BTN)!.node.style['background-color']).toBe('#2563eb');
  });

  it('a smaller count picks evenly spaced stops', () => {
    const plan = planRemix(makeDoc(), BTN, 'color-scale', { count: 3 });
    expect(plan.labels).toEqual(['shade 50', 'shade 500', 'shade 900']);
    expect(planRemix(makeDoc(), BTN, 'color-scale', { count: 1 }).labels).toEqual(['shade 500']);
    expect(planRemix(makeDoc(), BTN, 'color-scale', { count: 99 }).frameIds).toHaveLength(10);
  });

  it('resolves token var() and uses the first solid color in property order', () => {
    const doc = makeDoc();
    const btn = findNode(doc, BTN)!.node;
    btn.style = { color: '#00ff00', 'background-color': 'var(--brand)' };
    const plan = planRemix(doc, BTN, 'color-scale', { count: 2 });
    const { doc: after } = applyOps(doc, plan.ops);
    const clone = frameOf(after, plan.frameIds[0]!).children[0]!.children[2]!;
    expect(clone.style['background-color']).toBe(colorScale('#ff0000')[0]!.color);
    expect(clone.style['color']).toBe('#00ff00');
  });

  it('uses color when the node only has a text color and ignores a transparent color', () => {
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

  it('background only counts if it is a color (a gradient is ignored)', () => {
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

  it('no solid color throws an error', () => {
    expect(() => planRemix(makeDoc(), ROW, 'color-scale')).toThrow(/no solid color/);
    const doc = makeDoc();
    findNode(doc, BTN)!.node.style = { background: 'linear-gradient(red, blue)' };
    expect(() => planRemix(doc, BTN, 'color-scale')).toThrow(/no solid color/);
  });
});

describe('planRemix font-pairs', () => {
  const FONTS = ['Playfair Display', 'Inter', 'Georgia', 'Verdana', 'Arial'];

  it('filters by the pairs with both families available, in curated-list order', () => {
    const plan = planRemix(makeDoc(), FRAME, 'font-pairs', { fonts: FONTS });
    expect(plan.labels).toEqual(['Playfair Display + Inter', 'Georgia + Verdana']);
  });

  it('is case-insensitive when comparing families', () => {
    const plan = planRemix(makeDoc(), FRAME, 'font-pairs', {
      fonts: ['playfair display', 'INTER'],
    });
    expect(plan.labels).toEqual(['Playfair Display + Inter']);
  });

  it('headings (h1, font size >= 24px, weight >= 600) get the heading font and the rest the body font', () => {
    const doc = makeDoc();
    const plan = planRemix(doc, FRAME, 'font-pairs', { fonts: FONTS, count: 1 });
    const { doc: after } = applyOps(doc, plan.ops);
    const clone = frameOf(after, plan.frameIds[0]!);
    const [title, para, btn] = clone.children[0]!.children as [Node, Node, Node];
    expect(clone.style['font-family']).toBe('"Inter", sans-serif');
    expect(title.style['font-family']).toBe('"Playfair Display", serif');
    expect(para.style['font-family']).toBe('"Inter", sans-serif');
    // button label with weight 600 counts as a heading
    expect(btn.children[0]!.style['font-family']).toBe('"Playfair Display", serif');
    // original untouched
    expect(findNode(after, TITLE)!.node.style['font-family']).toBeUndefined();
  });

  it('font-size >= 24px without a heading tag is also a heading', () => {
    const doc = makeDoc();
    findNode(doc, PARA)!.node.style['font-size'] = '28px';
    const plan = planRemix(doc, PARA, 'font-pairs', { fonts: FONTS, count: 1 });
    const { doc: after } = applyOps(doc, plan.ops);
    const para = frameOf(after, plan.frameIds[0]!).children[0]!.children[1]!;
    expect(para.style['font-family']).toBe('"Playfair Display", serif');
  });

  it('without the font list uses the curated order and the default count 4', () => {
    const plan = planRemix(makeDoc(), FRAME, 'font-pairs');
    expect(plan.frameIds).toHaveLength(4);
    expect(plan.labels).toEqual(FONT_PAIRS.slice(0, 4).map((p) => `${p.heading} + ${p.body}`));
  });

  it('errors: no pair available and a node without text', () => {
    expect(() => planRemix(makeDoc(), FRAME, 'font-pairs', { fonts: ['Comic Sans MS'] })).toThrow(
      /None of the/,
    );
    const doc = makeDoc();
    doc.pages[0]!.frames[1]!.children.push(
      createNode({ id: 'el_empty001', tag: 'div', style: { padding: '8px' } }),
    );
    expect(() => planRemix(doc, 'el_empty001', 'font-pairs')).toThrow(/no text/);
  });
});

describe('planRemix spacing', () => {
  const cloneBtn = (after: Document, id: string): Node =>
    frameOf(after, id).children[0]!.children[2]!;
  const cloneRow = (after: Document, id: string): Node => frameOf(after, id).children[0]!;

  it('4 variations in fixed order, rounded to the grid, without repeating the original', () => {
    const doc = makeDoc();
    const plan = planRemix(doc, FRAME, 'spacing', { newId: counter() });
    // grid 4 drops out: 12px 20px, 24px and 16px are already on the 4 grid (it would equal the original)
    expect(plan.labels).toEqual(['compact', 'grid 8', 'comfortable', 'spacious']);
    const { doc: after } = applyOps(doc, plan.ops);
    const [compact, g8, comfy, roomy] = plan.frameIds;
    // compact: x0.5 on the 4 grid (12px 20px -> 6px 10px -> 8px 12px)
    expect(cloneRow(after, compact!).style['padding']).toBe('12px');
    expect(cloneRow(after, compact!).style['gap']).toBe('8px');
    expect(cloneBtn(after, compact!).style['padding']).toBe('8px 12px');
    // grid 8: 12 -> 16, 20 -> 24
    expect(cloneBtn(after, g8!).style['padding']).toBe('16px 24px');
    expect(cloneRow(after, g8!).style['gap']).toBe('16px');
    // comfortable: x1.5 on the 8 grid (12*1.5=18 -> 16; 20*1.5=30 -> 32)
    expect(cloneBtn(after, comfy!).style['padding']).toBe('16px 32px');
    // spacious: x2 on the 8 grid
    expect(cloneBtn(after, roomy!).style['padding']).toBe('24px 40px');
    expect(cloneRow(after, roomy!).style['padding']).toBe('48px');
    // original untouched
    expect(findNode(after, BTN)!.node.style['padding']).toBe('12px 20px');
  });

  it('grid 4 is included when it changes something; a count above what is available is capped', () => {
    const doc = makeDoc();
    findNode(doc, BTN)!.node.style['padding'] = '10px 18px';
    const plan = planRemix(doc, FRAME, 'spacing', { count: 5 });
    expect(plan.labels).toEqual(['compact', 'grid 4', 'grid 8', 'comfortable', 'spacious']);
    const { doc: after } = applyOps(doc, plan.ops);
    expect(cloneBtn(after, plan.frameIds[1]!).style['padding']).toBe('12px 20px');
    expect(planRemix(doc, FRAME, 'spacing', { count: 8 }).frameIds).toHaveLength(5);
    // in the default fixture there are only 4 distinct variations
    expect(planRemix(makeDoc(), FRAME, 'spacing', { count: 5 }).frameIds).toHaveLength(4);
  });

  it('variations repeated among themselves are dropped: 4px only produces "grid 8"', () => {
    const doc = makeDoc();
    const btn = findNode(doc, BTN)!.node;
    btn.style = { padding: '4px' };
    // compact and grid 4 give 4px (same as the original); comfortable and spacious give 8px (same as grid 8)
    const plan = planRemix(doc, BTN, 'spacing', { count: 5 });
    expect(plan.labels).toEqual(['grid 8']);
  });

  it('does not zero small positive values and resolves token var()', () => {
    const doc = makeDoc();
    const btn = findNode(doc, BTN)!.node;
    btn.style = { padding: '1px', 'margin-left': 'var(--space)', margin: '0 auto' };
    const plan = planRemix(doc, BTN, 'spacing', { count: 1 });
    const { doc: after } = applyOps(doc, plan.ops);
    const clone = cloneBtn(after, plan.frameIds[0]!);
    expect(clone.style['padding']).toBe('4px'); // 0.5px -> grid 4, but not zeroed
    expect(clone.style['margin-left']).toBe('4px'); // 10px x0.5 = 5 -> grid 4
    expect(clone.style['margin']).toBe('0 auto'); // 0 and auto do not change
  });

  it('applies within the node subtree, not outside it', () => {
    const doc = makeDoc();
    const plan = planRemix(doc, BTN, 'spacing', { count: 1 });
    const { doc: after } = applyOps(doc, plan.ops);
    const row = cloneRow(after, plan.frameIds[0]!);
    expect(row.style['padding']).toBe('24px');
    expect(row.style['gap']).toBe('16px');
    expect(cloneBtn(after, plan.frameIds[0]!).style['padding']).toBe('8px 12px');
  });

  it('no spacing in px throws an error', () => {
    expect(() => planRemix(makeDoc(), TITLE, 'spacing')).toThrow(/spacing in px/);
    const doc = makeDoc();
    findNode(doc, BTN)!.node.style = { padding: '1rem', gap: 'calc(100% - 2rem)' };
    expect(() => planRemix(doc, BTN, 'spacing')).toThrow(/spacing in px/);
  });
});

describe('planRemix layout', () => {
  const cloneRow = (after: Document, id: string): Node => frameOf(after, id).children[0]!;

  it('3 rearrangements of the nearest ancestor flex', () => {
    const doc = makeDoc();
    const plan = planRemix(doc, TITLE, 'layout', { newId: counter() });
    expect(plan.labels).toEqual(['reversed direction', 'reversed order', 'centered with wrap']);
    const { doc: after } = applyOps(doc, plan.ops);
    const [dir, order, wrap] = plan.frameIds.map((id) => cloneRow(after, id)) as [Node, Node, Node];
    // reversed direction: row -> column, justify center becomes align center and align flex-start becomes justify
    expect(dir.style['flex-direction']).toBe('column');
    expect(dir.style['align-items']).toBe('center');
    expect(dir.style['justify-content']).toBe('flex-start');
    // reversed order: children reversed in the clone
    expect(order.children.map((c) => c.name)).toEqual(['Button', 'Paragraph', 'Title']);
    expect(order.style['flex-direction']).toBe('row');
    // centered with wrap
    expect(wrap.style['flex-wrap']).toBe('wrap');
    expect(wrap.style['justify-content']).toBe('center');
    expect(wrap.style['align-items']).toBe('center');
    // original untouched
    const orig = findNode(after, ROW)!.node;
    expect(orig.children.map((c) => c.name)).toEqual(['Title', 'Paragraph', 'Button']);
    expect(orig.style['flex-direction']).toBe('row');
  });

  it('the flex node itself is used when it is the target; column goes back to row', () => {
    const doc = makeDoc();
    const row = findNode(doc, ROW)!.node;
    row.style['flex-direction'] = 'column';
    const plan = planRemix(doc, ROW, 'layout', { count: 1 });
    const { doc: after } = applyOps(doc, plan.ops);
    expect(cloneRow(after, plan.frameIds[0]!).style['flex-direction']).toBe('row');
  });

  it('count caps at 3 and accepts fewer', () => {
    const doc = makeDoc();
    expect(planRemix(doc, ROW, 'layout', { count: 2 }).frameIds).toHaveLength(2);
    expect(planRemix(doc, ROW, 'layout', { count: 9 }).frameIds).toHaveLength(3);
  });

  it('with fewer than 2 children the reversed order is left out', () => {
    const doc = makeDoc();
    findNode(doc, ROW)!.node.children.splice(1);
    const plan = planRemix(doc, ROW, 'layout');
    expect(plan.labels).toEqual(['reversed direction', 'centered with wrap']);
  });

  it('no flex on the node and its ancestors throws an error', () => {
    const doc = makeDoc();
    findNode(doc, ROW)!.node.style = { padding: '8px' };
    expect(() => planRemix(doc, TITLE, 'layout')).toThrow(/flex/);
  });
});
