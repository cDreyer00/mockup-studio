import { collectIds, createNodeFromTag } from '@mockup/core';
import type { Node } from '@mockup/core';
import { describe, expect, it } from 'vitest';
import { makeDoc } from '../test/fixtures';
import {
  classifyPaste,
  extractMarker,
  looksLikeHtml,
  makeMarker,
  prepareNodesForPaste,
  resolvePasteTarget,
  serializeNodes,
} from './paste';

const center = { x: 1000, y: 500 };

describe('looksLikeHtml', () => {
  it('reconhece HTML', () => {
    expect(looksLikeHtml('<div>oi</div>')).toBe(true);
    expect(looksLikeHtml('  <section class="a">')).toBe(true);
    expect(looksLikeHtml('<img src="a.png">')).toBe(true);
    expect(looksLikeHtml('<!--mockup-studio:abc--><div></div>')).toBe(true);
  });
  it('rejeita texto puro', () => {
    expect(looksLikeHtml('olá mundo')).toBe(false);
    expect(looksLikeHtml('1 < 2 e <b')).toBe(false);
    expect(looksLikeHtml('a <div>b</div>')).toBe(false);
    expect(looksLikeHtml('')).toBe(false);
    expect(looksLikeHtml(null)).toBe(false);
  });
});

describe('marcador e serialização', () => {
  it('serializa com o marcador no início', () => {
    const { a } = makeDoc();
    const html = serializeNodes([a], 'tok-1');
    expect(html.startsWith('<!--mockup-studio:tok-1-->')).toBe(true);
    expect(html).toContain('<div');
    expect(extractMarker(html)).toBe('tok-1');
    expect(extractMarker('<div></div>')).toBeNull();
    expect(makeMarker('x')).toBe('<!--mockup-studio:x-->');
  });

  it('classifyPaste', () => {
    const html = serializeNodes([], 'tok');
    expect(classifyPaste({ html, text: html, imageCount: 0 }, 'tok')).toBe('internal');
    expect(classifyPaste({ html, text: '', imageCount: 0 }, 'outro')).toBe('html');
    expect(classifyPaste({ html: '', text: '', imageCount: 2 }, null)).toBe('images');
    expect(classifyPaste({ html: '<p>a</p>', text: 'a', imageCount: 0 }, null)).toBe('html');
    expect(classifyPaste({ html: '', text: '<div></div>', imageCount: 0 }, null)).toBe('html');
    expect(classifyPaste({ html: '', text: 'oi', imageCount: 0 }, null)).toBe('text');
    expect(classifyPaste({ html: '', text: '', imageCount: 0 }, null)).toBe('none');
  });
});

describe('resolvePasteTarget', () => {
  it('sem seleção: raiz da página', () => {
    const { doc } = makeDoc();
    const t = resolvePasteTarget(doc, [], null)!;
    expect(t.parentId).toBeNull();
    expect(t.pageId).toBe(doc.pages[0]!.id);
    expect(t.index).toBeUndefined();
  });
  it('um contêiner: dentro dele, ao final', () => {
    const { doc, frame, c } = makeDoc();
    expect(resolvePasteTarget(doc, [frame.id], null)).toMatchObject({ parentId: frame.id });
    const t = resolvePasteTarget(doc, [c.id], null)!;
    expect(t.parentId).toBe(c.id);
    expect(t.index).toBeUndefined();
  });
  it('nó folha: depois dele no mesmo pai', () => {
    const { doc, frame, b } = makeDoc();
    expect(resolvePasteTarget(doc, [b.id], null)).toMatchObject({
      parentId: frame.id,
      index: 2,
    });
  });
  it('vários: depois do último', () => {
    const { doc, frame, a, c } = makeDoc();
    expect(resolvePasteTarget(doc, [c.id, a.id], null)).toMatchObject({
      parentId: frame.id,
      index: 3,
    });
  });
});

describe('prepareNodesForPaste', () => {
  it('na raiz: frames com ids novos únicos e posição no centro', () => {
    const { a, c } = makeDoc();
    const out = prepareNodesForPaste([a, c], { parentId: null, parent: null }, { center });
    expect(out).toHaveLength(2);
    const ids = out.flatMap((n) => collectIds(n));
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).not.toContain(a.id);
    expect(ids).not.toContain(c.id);
    expect(out.every((n) => n.type === 'frame' && n.id.startsWith('fr_'))).toBe(true);
    expect(out[0]!.position).toBeDefined();
    // largura/altura padrão quando faltam
    expect(out[1]!.style.width).toBe('400px');
    expect(out[1]!.style.height).toBe('300px');
    expect(out[0]!.style.width).toBe('10px');
    // grupo centralizado
    const x0 = out[0]!.position!.x;
    const x1 = out[1]!.position!.x + 400;
    expect((x0 + x1) / 2).toBeCloseTo(center.x, -1);
    // original intacto
    expect(a.type).toBe('element');
  });

  it('na raiz: usa a medida do original e desloca +40 por colagem repetida', () => {
    const { c } = makeDoc();
    const measure = () => ({ w: 222, h: 111 });
    const p0 = prepareNodesForPaste([c], { parentId: null, parent: null }, { center, measure })[0]!;
    const p2 = prepareNodesForPaste(
      [c],
      { parentId: null, parent: null },
      { center, measure, pasteCount: 2 },
    )[0]!;
    expect(p0.style.width).toBe('222px');
    expect(p0.style.height).toBe('111px');
    expect(p2.position!.x - p0.position!.x).toBe(80);
    expect(p2.position!.y - p0.position!.y).toBe(80);
  });

  it('na raiz: frames copiados preservam posição relativa; folhas são embrulhadas', () => {
    const { frame, b } = makeDoc();
    const f2 = { ...structuredClone(frame), position: { x: frame.position!.x + 500, y: 50 } };
    const [p1, p2] = prepareNodesForPaste(
      [frame, f2],
      { parentId: null, parent: null },
      { center },
    );
    expect(p2!.position!.x - p1!.position!.x).toBe(500);
    expect(p1!.children).toHaveLength(frame.children.length);
    const [wrapped] = prepareNodesForPaste([b], { parentId: null, parent: null }, { center });
    expect(wrapped!.type).toBe('frame');
    expect(wrapped!.children).toHaveLength(1);
    expect(wrapped!.children[0]!.text).toBe('b');
    expect(wrapped!.children[0]!.id).not.toBe(b.id);
  });

  it('dentro de um nó: frame vira element, sem position', () => {
    const { frame, c } = makeDoc();
    const out = prepareNodesForPaste([frame], { parentId: c.id, parent: c }, { center });
    expect(out[0]!.type).toBe('element');
    expect(out[0]!.position).toBeUndefined();
    expect(out[0]!.id.startsWith('fr_')).toBe(false);
    const ids = collectIds(out[0]!);
    expect(ids.some((id) => collectIds(frame).includes(id))).toBe(false);
  });

  it('absoluto em pai não-flex: left/top +16px; em pai flex: inalterado', () => {
    const { abs, c, frame } = makeDoc();
    const inBlock = prepareNodesForPaste([abs], { parentId: c.id, parent: c }, { center })[0]!;
    expect(inBlock.style.left).toBe('26px');
    expect(inBlock.style.top).toBe('36px');
    const inFlex = prepareNodesForPaste(
      [abs],
      { parentId: frame.id, parent: frame },
      { center },
    )[0]!;
    expect(inFlex.style.left).toBe('10px');
    expect(inFlex.style.top).toBe('20px');
  });

  it('nó com tipo não-frame mantém o tipo dentro', () => {
    const t: Node = createNodeFromTag('p', { text: 'x' });
    const { frame } = makeDoc();
    const out = prepareNodesForPaste([t], { parentId: frame.id, parent: frame }, { center });
    expect(out[0]!.type).toBe('text');
    expect(out[0]!.id).not.toBe(t.id);
  });
});
