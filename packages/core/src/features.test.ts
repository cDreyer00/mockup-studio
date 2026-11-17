import { describe, expect, it } from 'vitest';
import { collectAssetRefs, rewriteAssetRefsOps, assetPathOf } from './assetRefs.js';
import { applyOps } from './apply.js';
import { createRepeaterFrom } from './data.js';
import { createDocument, createNodeFromTag, findNode } from './document.js';
import {
  clipPathPresetOf,
  composeImageFilters,
  cropToCss,
  mergeImageFilters,
  normalizeObjectPosition,
  parseCrop,
  parseImageFilters,
  resolveClipPath,
} from './image.js';
import {
  hashSeed,
  placeholderFileName,
  placeholderSvg,
  PLACEHOLDER_KINDS,
} from './placeholders.js';
import { documentText, parseSearchQuery, searchNodes } from './search.js';
import type { Document, Node } from './types.js';

function sampleDoc(): { doc: Document; ids: Record<string, string> } {
  const doc = createDocument('Shop');
  const frame = createNodeFromTag('div', {
    isRoot: true,
    name: 'Home',
    styles: { width: '1200px' },
  });
  const title = createNodeFromTag('h1', { text: 'Summer Sale', name: 'Title' });
  const cta = createNodeFromTag('button', { text: 'Buy now', name: 'CTA' });
  const hero = createNodeFromTag('img', { src: 'photos/hero.jpg', name: 'Hero' });
  const link = createNodeFromTag('a', { text: 'Learn more', attrs: { href: '/about' } });
  const bg = createNodeFromTag('section', {
    name: 'Banner',
    styles: { 'background-image': 'url("assets/backgrounds/sky.png")' },
  });
  const tpl = Object.assign(createNodeFromTag('div', { name: 'Item' }), {
    children: [
      createNodeFromTag('img', { src: '{{photo}}' }),
      createNodeFromTag('span', { text: '{{name}}' }),
    ],
  });
  const list = createRepeaterFrom(
    Object.assign(createNodeFromTag('div', { name: 'Products' }), { children: [tpl] }),
    [
      { photo: 'products/a.webp', name: 'Café Mug' },
      { photo: 'products/b.webp', name: 'Bag' },
    ],
  );
  frame.children = [title, cta, hero, link, bg, list];
  doc.pages[0]!.frames.push(frame);
  doc.fonts = [
    { family: 'Inter', source: 'file', files: ['fonts/inter-400.woff2'], weights: [400] },
  ];
  return {
    doc,
    ids: {
      frame: frame.id,
      title: title.id,
      cta: cta.id,
      hero: hero.id,
      link: link.id,
      bg: bg.id,
      list: list.id,
    },
  };
}

describe('node search', () => {
  it('finds by text, accent-insensitive and case-insensitive', () => {
    const { doc, ids } = sampleDoc();
    const r = searchNodes(doc, 'summer sale');
    expect(r.map((m) => m.nodeId)).toEqual([ids.title]);
    expect(r[0]!.field).toBe('text');
    expect(r[0]!.frameId).toBe(ids.frame);
    // Accented content ("Café Mug") matches an unaccented, upper-case query.
    expect(searchNodes(doc, 'CAFE MUG').map((m) => m.nodeId)).toContain(ids.list);
  });

  it('filters by tag, name, attribute, class and data', () => {
    const { doc, ids } = sampleDoc();
    expect(searchNodes(doc, 'tag:button').map((m) => m.nodeId)).toEqual([ids.cta]);
    expect(searchNodes(doc, 'name:hero').map((m) => m.nodeId)).toEqual([ids.hero]);
    expect(searchNodes(doc, 'attr:href=/about').map((m) => m.nodeId)).toEqual([ids.link]);
    expect(searchNodes(doc, 'class:banner').map((m) => m.nodeId)).toEqual([ids.bg]);
    expect(searchNodes(doc, 'data:"cafe mug"').map((m) => m.nodeId)).toEqual([ids.list]);
    expect(searchNodes(doc, 'tag:a learn').map((m) => m.nodeId)).toEqual([ids.link]);
    expect(searchNodes(doc, 'tag:button nonexistent')).toEqual([]);
    expect(searchNodes(doc, '   ')).toEqual([]);
  });

  it('still accepts the legacy pt-BR field aliases', () => {
    const { doc, ids } = sampleDoc();
    expect(searchNodes(doc, 'nome:hero').map((m) => m.nodeId)).toEqual([ids.hero]);
    expect(searchNodes(doc, 'classe:banner').map((m) => m.nodeId)).toEqual([ids.bg]);
    expect(searchNodes(doc, 'dados:"cafe mug"').map((m) => m.nodeId)).toEqual([ids.list]);
    expect(searchNodes(doc, 'texto:"buy now"').map((m) => m.nodeId)).toEqual([ids.cta]);
  });

  it('respects the limit', () => {
    const { doc } = sampleDoc();
    expect(searchNodes(doc, 'tag:div', { limit: 1 })).toHaveLength(1);
  });

  it('parses the query', () => {
    expect(parseSearchQuery('tag:H1 "contact us" x:y')).toEqual({
      terms: ['contact us', 'x:y'],
      fields: { tag: ['h1'] },
    });
  });

  it('document text joins names and texts', () => {
    const { doc } = sampleDoc();
    const t = documentText(doc);
    expect(t).toContain('Shop');
    expect(t).toContain('Summer Sale');
    expect(t).toContain('Buy now');
  });
});

describe('asset references', () => {
  it('collects src, style url(), fonts and srcs coming from data', () => {
    const { doc, ids } = sampleDoc();
    const refs = collectAssetRefs(doc);
    expect([...refs.keys()].sort()).toEqual([
      'backgrounds/sky.png',
      'fonts/inter-400.woff2',
      'photos/hero.jpg',
      'products/a.webp',
      'products/b.webp',
    ]);
    expect(refs.get('photos/hero.jpg')).toMatchObject({ nodeIds: [ids.hero], kinds: ['src'] });
    expect(refs.get('backgrounds/sky.png')!.kinds).toEqual(['style']);
    expect(refs.get('products/b.webp')!.kinds).toEqual(['data']);
    expect(refs.get('fonts/inter-400.woff2')!.kinds).toEqual(['font']);
  });

  it('assetPathOf ignores URLs, data URLs, bindings and ..', () => {
    expect(assetPathOf('assets/a.png')).toBe('a.png');
    expect(assetPathOf('https://x/a.png')).toBeNull();
    expect(assetPathOf('data:image/png;base64,xx')).toBeNull();
    expect(assetPathOf('../a.png')).toBeNull();
    expect(assetPathOf('{{photo}}')).toBeNull();
  });

  it('rewrites references in src, style, data and fonts', () => {
    const { doc, ids } = sampleDoc();
    const renamed = new Map([
      ['photos/hero.jpg', 'photos/hero.webp'],
      ['backgrounds/sky.png', 'backgrounds/sky.webp'],
      ['products/a.webp', 'products/a-1.webp'],
      ['fonts/inter-400.woff2', 'fonts/inter.woff2'],
    ]);
    const ops = rewriteAssetRefsOps(doc, renamed);
    const r = applyOps(doc, ops);
    expect(findNode(r.doc, ids.hero)!.node.src).toBe('photos/hero.webp');
    expect(findNode(r.doc, ids.bg)!.node.style['background-image']).toBe(
      'url("assets/backgrounds/sky.webp")',
    );
    expect((findNode(r.doc, ids.list)!.node.data as { photo: string }[])[0]!.photo).toBe(
      'products/a-1.webp',
    );
    expect(r.doc.fonts[0]!.files).toEqual(['fonts/inter.woff2']);
    expect(rewriteAssetRefsOps(doc, new Map())).toEqual([]);
  });
});

describe('image adjustments', () => {
  it('parses and composes filters preserving unknown ones', () => {
    const { filters, rest } = parseImageFilters(
      'blur(2px) brightness(1.2) drop-shadow(0 0 2px rgba(0,0,0,.5)) hue-rotate(0.5turn)',
    );
    expect(filters).toEqual({ blur: 2, brightness: 120, 'hue-rotate': 180 });
    expect(rest).toEqual(['drop-shadow(0 0 2px rgba(0,0,0,.5))']);
    expect(composeImageFilters({ ...filters, contrast: 100, sepia: 30 }, rest)).toBe(
      'blur(2px) brightness(120%) hue-rotate(180deg) sepia(30%) drop-shadow(0 0 2px rgba(0,0,0,.5))',
    );
    expect(mergeImageFilters('blur(4px)', { blur: null, grayscale: 100 })).toBe('grayscale(100%)');
    expect(mergeImageFilters('grayscale(100%)', { grayscale: 0 })).toBe('');
    expect(composeImageFilters({ blur: 999 })).toBe('blur(50px)');
  });

  it('crop becomes object-view-box and back', () => {
    expect(cropToCss({ top: 10, right: 0, bottom: 5, left: 20 })).toBe('inset(10% 0% 5% 20%)');
    expect(cropToCss({ top: 0, right: 0, bottom: 0, left: 0 })).toBe('');
    expect(parseCrop('inset(10% 0% 5% 20%)')).toEqual({ top: 10, right: 0, bottom: 5, left: 20 });
    expect(parseCrop('inset(10%)')).toEqual({ top: 10, right: 10, bottom: 10, left: 10 });
    expect(parseCrop(undefined)).toEqual({ top: 0, right: 0, bottom: 0, left: 0 });
    expect(parseCrop('inset(10px)')).toBeNull();
    expect(cropToCss({ top: 80, right: 0, bottom: 80, left: 0 })).toBe('inset(80% 0% 19% 0%)');
  });

  it('mask shapes and position', () => {
    expect(resolveClipPath('circle')).toBe('circle(50% at 50% 50%)');
    expect(resolveClipPath('none')).toBe('');
    expect(resolveClipPath('inset(5px)')).toBe('inset(5px)');
    expect(clipPathPresetOf('circle(50% at 50% 50%)')).toBe('circle');
    expect(normalizeObjectPosition('top-left')).toBe('0% 0%');
    expect(normalizeObjectPosition('30% 70%')).toBe('30% 70%');
  });
});

describe('placeholders', () => {
  it('are deterministic per seed and vary between seeds', () => {
    for (const kind of PLACEHOLDER_KINDS) {
      const a = placeholderSvg(kind, { seed: 'ana' });
      expect(placeholderSvg(kind, { seed: 'ana' })).toBe(a);
      expect(placeholderSvg(kind, { seed: 'bob' })).not.toBe(a);
      expect(a.startsWith('<svg xmlns="http://www.w3.org/2000/svg"')).toBe(true);
      expect(a).not.toMatch(/<script|on\w+=|href=/i);
    }
  });

  it('respects size, label and stable file names', () => {
    const svg = placeholderSvg('logo', { seed: 3, width: 300, height: 100, label: 'Acme <b>' });
    expect(svg).toContain('width="300" height="100"');
    expect(svg).toContain('Acme &#60;b&#62;');
    expect(placeholderSvg('avatar', { label: 'Ana Lima' })).toContain('>AL<');
    expect(placeholderFileName('avatar', { seed: 'Zoë Ray' })).toBe('avatar-Zoe-Ray-256x256.svg');
    expect(placeholderFileName('landscape', { seed: 7, width: 640, height: 360 })).toBe(
      'landscape-7-640x360.svg',
    );
    expect(hashSeed('a')).toBe(hashSeed('a'));
    expect(() => placeholderSvg('photo' as never)).toThrow(/invalid/i);
  });
});

// Ensures the Node type still accepts repeater in the common helpers.
const _n: Node['type'] = 'repeater';
void _n;
