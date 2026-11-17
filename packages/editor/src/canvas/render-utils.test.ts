import { describe, expect, it } from 'vitest';
import type { Node } from '@mockup/core';
import { isSafeAttrName, resolveTag, safeAttrs, svgToDataUri } from './render-utils';

const node = (tag: string, attrs: Record<string, string>): Node =>
  ({ id: 'n1', type: 'frame', tag, attrs }) as unknown as Node;

describe('resolveTag', () => {
  it('blocks dangerous and invalid tags', () => {
    for (const t of ['SCRIPT', 'iframe', 'x y', 'svg', 'math', 'template'])
      expect(resolveTag(t)).toBe('div');
  });
  it('normalizes case', () => expect(resolveTag('H1')).toBe('h1'));
});

describe('isSafeAttrName', () => {
  it('rejects dangerous names', () => {
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
  it('accepts common names', () => {
    for (const n of ['alt', 'data-x', 'aria-label', 'type']) expect(isSafeAttrName(n)).toBe(true);
  });
});

describe('safeAttrs', () => {
  it('maps href and drops handlers', () => {
    const out = safeAttrs(node('a', { href: '/x', onclick: 'x()', class: 'c' }), 'd');
    expect(out).toEqual({ 'data-href': '/x', className: 'c' });
  });
  it('src only on img', () => {
    expect(safeAttrs(node('div', { src: 'a.png' }), 'd')).toEqual({});
    expect(safeAttrs(node('img', { src: 'a.png' }), 'd')).toEqual({ src: '/assets/d/a.png' });
  });
});

describe('svgToDataUri', () => {
  it('encodes the SVG', () => {
    const u = svgToDataUri('<svg><circle/></svg>');
    expect(u.startsWith('data:image/svg+xml;utf8,')).toBe(true);
    expect(u).toContain('%3Csvg');
  });
  it('adds xmlns when missing (without it the <img> does not load the SVG)', () => {
    const dec = (u: string) => decodeURIComponent(u.slice(u.indexOf(',') + 1));
    expect(dec(svgToDataUri('<svg width="4"><circle/></svg>'))).toBe(
      '<svg xmlns="http://www.w3.org/2000/svg" width="4"><circle/></svg>',
    );
    expect(dec(svgToDataUri('<svg>x</svg>'))).toBe(
      '<svg xmlns="http://www.w3.org/2000/svg">x</svg>',
    );
    const ok = '<svg viewBox="0 0 1 1" xmlns="http://www.w3.org/2000/svg"/>';
    expect(dec(svgToDataUri(ok))).toBe(ok);
  });
});
