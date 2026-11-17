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
  const doc = createDocument('Loja');
  const frame = createNodeFromTag('div', {
    isRoot: true,
    name: 'Home',
    styles: { width: '1200px' },
  });
  const title = createNodeFromTag('h1', { text: 'Promoção de Verão', name: 'Título' });
  const cta = createNodeFromTag('button', { text: 'Comprar agora', name: 'CTA' });
  const hero = createNodeFromTag('img', { src: 'fotos/hero.jpg', name: 'Hero' });
  const link = createNodeFromTag('a', { text: 'Saiba mais', attrs: { href: '/sobre' } });
  const bg = createNodeFromTag('section', {
    name: 'Banner',
    styles: { 'background-image': 'url("assets/fundos/ceu.png")' },
  });
  const tpl = Object.assign(createNodeFromTag('div', { name: 'Item' }), {
    children: [
      createNodeFromTag('img', { src: '{{foto}}' }),
      createNodeFromTag('span', { text: '{{nome}}' }),
    ],
  });
  const list = createRepeaterFrom(
    Object.assign(createNodeFromTag('div', { name: 'Produtos' }), { children: [tpl] }),
    [
      { foto: 'produtos/a.webp', nome: 'Tênis Azul' },
      { foto: 'produtos/b.webp', nome: 'Bolsa' },
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

describe('busca de nós', () => {
  it('acha por texto sem acento e sem caixa', () => {
    const { doc, ids } = sampleDoc();
    const r = searchNodes(doc, 'promocao verao');
    expect(r.map((m) => m.nodeId)).toEqual([ids.title]);
    expect(r[0]!.field).toBe('text');
    expect(r[0]!.frameId).toBe(ids.frame);
  });

  it('filtra por tag, nome, atributo, classe e dados', () => {
    const { doc, ids } = sampleDoc();
    expect(searchNodes(doc, 'tag:button').map((m) => m.nodeId)).toEqual([ids.cta]);
    expect(searchNodes(doc, 'name:hero').map((m) => m.nodeId)).toEqual([ids.hero]);
    expect(searchNodes(doc, 'attr:href=/sobre').map((m) => m.nodeId)).toEqual([ids.link]);
    expect(searchNodes(doc, 'class:banner').map((m) => m.nodeId)).toEqual([ids.bg]);
    expect(searchNodes(doc, 'data:"tenis azul"').map((m) => m.nodeId)).toEqual([ids.list]);
    expect(searchNodes(doc, 'tag:a saiba').map((m) => m.nodeId)).toEqual([ids.link]);
    expect(searchNodes(doc, 'tag:button inexistente')).toEqual([]);
    expect(searchNodes(doc, '   ')).toEqual([]);
  });

  it('respeita o limite', () => {
    const { doc } = sampleDoc();
    expect(searchNodes(doc, 'tag:div', { limit: 1 })).toHaveLength(1);
  });

  it('interpreta a consulta', () => {
    expect(parseSearchQuery('tag:H1 "fale conosco" x:y')).toEqual({
      terms: ['fale conosco', 'x:y'],
      fields: { tag: ['h1'] },
    });
  });

  it('texto do documento junta nomes e textos', () => {
    const { doc } = sampleDoc();
    const t = documentText(doc);
    expect(t).toContain('Loja');
    expect(t).toContain('Promoção de Verão');
    expect(t).toContain('Comprar agora');
  });
});

describe('referências de assets', () => {
  it('coleta src, url() de estilo, fontes e srcs vindos de dados', () => {
    const { doc, ids } = sampleDoc();
    const refs = collectAssetRefs(doc);
    expect([...refs.keys()].sort()).toEqual([
      'fonts/inter-400.woff2',
      'fotos/hero.jpg',
      'fundos/ceu.png',
      'produtos/a.webp',
      'produtos/b.webp',
    ]);
    expect(refs.get('fotos/hero.jpg')).toMatchObject({ nodeIds: [ids.hero], kinds: ['src'] });
    expect(refs.get('fundos/ceu.png')!.kinds).toEqual(['style']);
    expect(refs.get('produtos/b.webp')!.kinds).toEqual(['data']);
    expect(refs.get('fonts/inter-400.woff2')!.kinds).toEqual(['font']);
  });

  it('assetPathOf ignora URLs, data URLs, bindings e ..', () => {
    expect(assetPathOf('assets/a.png')).toBe('a.png');
    expect(assetPathOf('https://x/a.png')).toBeNull();
    expect(assetPathOf('data:image/png;base64,xx')).toBeNull();
    expect(assetPathOf('../a.png')).toBeNull();
    expect(assetPathOf('{{foto}}')).toBeNull();
  });

  it('reescreve referências em src, estilo, dados e fontes', () => {
    const { doc, ids } = sampleDoc();
    const renamed = new Map([
      ['fotos/hero.jpg', 'fotos/hero.webp'],
      ['fundos/ceu.png', 'fundos/ceu.webp'],
      ['produtos/a.webp', 'produtos/a-1.webp'],
      ['fonts/inter-400.woff2', 'fonts/inter.woff2'],
    ]);
    const ops = rewriteAssetRefsOps(doc, renamed);
    const r = applyOps(doc, ops);
    expect(findNode(r.doc, ids.hero)!.node.src).toBe('fotos/hero.webp');
    expect(findNode(r.doc, ids.bg)!.node.style['background-image']).toBe(
      'url("assets/fundos/ceu.webp")',
    );
    expect((findNode(r.doc, ids.list)!.node.data as { foto: string }[])[0]!.foto).toBe(
      'produtos/a-1.webp',
    );
    expect(r.doc.fonts[0]!.files).toEqual(['fonts/inter.woff2']);
    expect(rewriteAssetRefsOps(doc, new Map())).toEqual([]);
  });
});

describe('ajustes de imagem', () => {
  it('lê e compõe filtros preservando os desconhecidos', () => {
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

  it('recorte vira object-view-box e volta', () => {
    expect(cropToCss({ top: 10, right: 0, bottom: 5, left: 20 })).toBe('inset(10% 0% 5% 20%)');
    expect(cropToCss({ top: 0, right: 0, bottom: 0, left: 0 })).toBe('');
    expect(parseCrop('inset(10% 0% 5% 20%)')).toEqual({ top: 10, right: 0, bottom: 5, left: 20 });
    expect(parseCrop('inset(10%)')).toEqual({ top: 10, right: 10, bottom: 10, left: 10 });
    expect(parseCrop(undefined)).toEqual({ top: 0, right: 0, bottom: 0, left: 0 });
    expect(parseCrop('inset(10px)')).toBeNull();
    expect(cropToCss({ top: 80, right: 0, bottom: 80, left: 0 })).toBe('inset(80% 0% 19% 0%)');
  });

  it('formas de máscara e posição', () => {
    expect(resolveClipPath('circle')).toBe('circle(50% at 50% 50%)');
    expect(resolveClipPath('none')).toBe('');
    expect(resolveClipPath('inset(5px)')).toBe('inset(5px)');
    expect(clipPathPresetOf('circle(50% at 50% 50%)')).toBe('circle');
    expect(normalizeObjectPosition('top-left')).toBe('0% 0%');
    expect(normalizeObjectPosition('30% 70%')).toBe('30% 70%');
  });
});

describe('placeholders', () => {
  it('são determinísticos pela semente e variam entre sementes', () => {
    for (const kind of PLACEHOLDER_KINDS) {
      const a = placeholderSvg(kind, { seed: 'ana' });
      expect(placeholderSvg(kind, { seed: 'ana' })).toBe(a);
      expect(placeholderSvg(kind, { seed: 'beto' })).not.toBe(a);
      expect(a.startsWith('<svg xmlns="http://www.w3.org/2000/svg"')).toBe(true);
      expect(a).not.toMatch(/<script|on\w+=|href=/i);
    }
  });

  it('respeita tamanho, rótulo e nomes de arquivo estáveis', () => {
    const svg = placeholderSvg('logo', { seed: 3, width: 300, height: 100, label: 'Acme <b>' });
    expect(svg).toContain('width="300" height="100"');
    expect(svg).toContain('Acme &#60;b&#62;');
    expect(placeholderSvg('avatar', { label: 'Ana Lima' })).toContain('>AL<');
    expect(placeholderFileName('avatar', { seed: 'Maria José' })).toBe(
      'avatar-Maria-Jose-256x256.svg',
    );
    expect(placeholderFileName('landscape', { seed: 7, width: 640, height: 360 })).toBe(
      'landscape-7-640x360.svg',
    );
    expect(hashSeed('a')).toBe(hashSeed('a'));
    expect(() => placeholderSvg('foto' as never)).toThrow(/inválido/);
  });
});

// Garante que o tipo Node segue aceitando repeater nos helpers comuns.
const _n: Node['type'] = 'repeater';
void _n;
