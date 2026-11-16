import { describe, expect, it } from 'vitest';
import type { Node } from '@mockup/core';
import { isSafeAttrName, resolveTag, safeAttrs, svgToDataUri } from './render-utils';

const node = (tag: string, attrs: Record<string, string>): Node =>
  ({ id: 'n1', type: 'frame', tag, attrs }) as unknown as Node;

describe('resolveTag', () => {
  it('bloqueia tags perigosas e inválidas', () => {
    for (const t of ['SCRIPT', 'iframe', 'x y', 'svg', 'math', 'template'])
      expect(resolveTag(t)).toBe('div');
  });
  it('normaliza caixa', () => expect(resolveTag('H1')).toBe('h1'));
});

describe('isSafeAttrName', () => {
  it('rejeita nomes perigosos', () => {
    const bad = [
      'onClick',
      'ONLOAD',
      'dangerouslySetInnerHTML',
      'style',
      'ref',
      'key',
      'children',
      'srcdoc',
      'formaction',
      'x" y',
    ];
    for (const n of bad) expect(isSafeAttrName(n), n).toBe(false);
  });
  it('aceita nomes comuns', () => {
    for (const n of ['alt', 'data-x', 'aria-label', 'type']) expect(isSafeAttrName(n)).toBe(true);
  });
});

describe('safeAttrs', () => {
  it('mapeia href e descarta handlers', () => {
    const out = safeAttrs(node('a', { href: '/x', onclick: 'x()', class: 'c' }), 'd');
    expect(out).toEqual({ 'data-href': '/x', className: 'c' });
  });
  it('src só em img', () => {
    expect(safeAttrs(node('div', { src: 'a.png' }), 'd')).toEqual({});
    expect(safeAttrs(node('img', { src: 'a.png' }), 'd')).toEqual({ src: '/assets/d/a.png' });
  });
});

describe('svgToDataUri', () => {
  it('codifica o SVG', () => {
    const u = svgToDataUri('<svg><circle/></svg>');
    expect(u.startsWith('data:image/svg+xml;utf8,')).toBe(true);
    expect(u).toContain('%3Csvg');
  });
});
