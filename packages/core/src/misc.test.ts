import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { getComputedLike, resolveVars } from './computed.js';
import { exportHtml } from './export/html.js';
import {
  cloneNodeWithNewIds,
  collectIds,
  createDocument,
  createNode,
  createNodeFromTag,
  findNode,
  getFrameOf,
  getPageOfNode,
  walk,
} from './document.js';
import { newNodeId } from './ids.js';
import { parseDocument, serializeDocument, validateDocument } from './schema.js';
import { normalizeStyles, toCamelCase, toKebabCase } from './styles.js';
import { getDocumentSummary, getTreeSummary, summarizeNode } from './summary.js';
import type { Document, Node } from './types.js';

function tree(): Document {
  const doc = createDocument('Resumo');
  doc.pages[0].name = 'Landing';
  const h1 = createNodeFromTag('h1', {
    name: 'Título',
    text: 'Bem-vindo',
    styles: { fontSize: '48px', fontWeight: '700', color: '#fff' },
  });
  const img = createNodeFromTag('img', {
    name: 'Logo',
    src: 'assets/logo.png',
    styles: { width: '120px', height: '40px' },
  });
  const inner = createNodeFromTag('div', { name: 'Interno', children: [h1] });
  const frame = createNodeFromTag('div', {
    isRoot: true,
    name: 'Hero',
    styles: {
      width: '1440px',
      height: '800px',
      display: 'flex',
      flexDirection: 'column',
      gap: '24px',
      padding: '64px',
      background: '#111',
    },
    children: [inner, img],
  });
  doc.pages[0].frames.push(frame);
  return doc;
}

describe('document helpers', () => {
  it('createDocument / createNode / createNodeFromTag', () => {
    const doc = createDocument('X');
    expect(doc).toMatchObject({ version: 1, tokens: {}, fonts: [] });
    expect(doc.id).toMatch(/^doc_/);
    expect(doc.pages[0]).toMatchObject({ name: 'Página 1', background: '#1e1e1e', frames: [] });
    const n = createNode({ tag: 'section' });
    expect(n).toMatchObject({ name: 'Section', type: 'element', locked: false, children: [] });
    const t = createNode({ tag: 'p', text: 'a'.repeat(50) });
    expect(t.type).toBe('text');
    expect(t.name.length).toBeLessThan(40);
    expect(createNodeFromTag('div', { isRoot: true }).id).toMatch(/^fr_[0-9a-z]{8}$/);
    expect(createNodeFromTag('img').type).toBe('image');
    expect(createNodeFromTag('svg').type).toBe('svg');
    expect(createNodeFromTag('div', { text: 'x', children: [t] }).type).toBe('element');
  });

  it('findNode, getPageOfNode, getFrameOf, walk, collectIds', () => {
    const doc = tree();
    const frame = doc.pages[0].frames[0];
    const h1 = frame.children[0].children[0];
    const p = findNode(doc, h1.id)!;
    expect(p.parent!.name).toBe('Interno');
    expect(p.ancestors.map((a) => a.name)).toEqual(['Hero', 'Interno']);
    expect(getPageOfNode(doc, h1.id)).toBe(doc.pages[0]);
    expect(getFrameOf(doc, h1.id)).toBe(frame);
    expect(getFrameOf(doc, frame.id)).toBe(frame);
    expect(getFrameOf(doc, 'el_zz')).toBeUndefined();
    const seen: string[] = [];
    walk(doc, (n, _p, d) => {
      seen.push(`${d}:${n.name}`);
      if (n.name === 'Interno') return false;
    });
    expect(seen).toEqual(['0:Hero', '1:Interno', '1:Logo']);
    expect(collectIds(doc)).toHaveLength(4);
  });

  it('cloneNodeWithNewIds usa e completa idMap', () => {
    const doc = tree();
    const frame = doc.pages[0].frames[0];
    const fixed = newNodeId('frame');
    const { node, idMap } = cloneNodeWithNewIds(frame, { [frame.id]: fixed });
    expect(node.id).toBe(fixed);
    expect(Object.keys(idMap)).toHaveLength(4);
    expect(collectIds(node).some((id) => collectIds(frame).includes(id))).toBe(false);
    expect(frame.id).not.toBe(fixed);
  });
});

describe('normalizeStyles', () => {
  it('camelCase → kebab, trim e vazios', () => {
    expect(
      normalizeStyles({ backgroundColor: ' red ', '--Meu-X': '1', color: '', ' margin ': '0' }),
    ).toEqual({ 'background-color': 'red', '--Meu-X': '1', margin: '0' });
    expect(toKebabCase('WebkitTransition')).toBe('-webkit-transition');
    expect(toCamelCase('border-top-left-radius')).toBe('borderTopLeftRadius');
  });
  it('nome inválido lança', () => {
    expect(() => normalizeStyles({ '1a': 'x' })).toThrow(/inválido/);
    expect(() => normalizeStyles({ 'a b': 'x' })).toThrow(/"a b"/);
  });
});

describe('summary', () => {
  it('formato por tipo de nó', () => {
    const doc = tree();
    const frame = doc.pages[0].frames[0];
    expect(summarizeNode(frame)).toBe(
      `${frame.id} "Hero" div 1440x800 flex-col gap:24 p:64 bg:#111`,
    );
    const h1 = frame.children[0].children[0];
    expect(summarizeNode(h1)).toBe(`${h1.id} "Título" h1 "Bem-vindo" 48px/700 color:#fff`);
    const img = frame.children[1];
    expect(summarizeNode(img)).toBe(`${img.id} "Logo" img src:assets/logo.png 120x40`);
  });

  it('indentação, profundidade e "… +N filhos"', () => {
    const doc = tree();
    const frame = doc.pages[0].frames[0];
    const lines = getTreeSummary(frame, 1).split('\n');
    expect(lines).toHaveLength(4);
    expect(lines[1].startsWith('  ')).toBe(true);
    expect(lines[2]).toBe('    … +1 filhos');
    expect(getTreeSummary(frame, 0).split('\n')).toHaveLength(1);
    expect(getTreeSummary(frame, 5).split('\n')).toHaveLength(4);
  });

  it('flags e texto truncado', () => {
    const n = createNodeFromTag('p', { text: 'x'.repeat(60) });
    n.hidden = true;
    n.locked = true;
    const s = summarizeNode(n);
    expect(s).toContain('…"');
    expect(s.endsWith('[hidden] [locked]')).toBe(true);
    const abs = createNodeFromTag('div', {
      styles: { position: 'absolute', width: '100%' },
      position: { x: 3, y: 4 },
    });
    expect(summarizeNode(abs)).toContain('w:100% abs@3,4');
  });

  it('getDocumentSummary', () => {
    const doc = tree();
    const out = getDocumentSummary(doc).split('\n');
    expect(out[0]).toBe(`${doc.pages[0].id} "Landing" (1 frame)`);
    expect(out[1].startsWith('  fr_')).toBe(true);
  });
});

describe('computed', () => {
  it('resolveVars com fallback, aninhado e ciclo', () => {
    const t = { '--a': 'var(--b)', '--b': '#fff', '--loop': 'var(--loop)' };
    expect(resolveVars('var(--a)', t)).toBe('#fff');
    expect(resolveVars('1px solid var(--x, rgb(0, 0, 0))', t)).toBe('1px solid rgb(0, 0, 0)');
    expect(resolveVars('var(--x)', t)).toBe('var(--x)');
    expect(resolveVars('var(--loop)', t)).toContain('var(');
  });

  it('getComputedLike: herança e var()', () => {
    const doc = tree();
    doc.tokens['--fg'] = 'tomato';
    const frame = doc.pages[0].frames[0];
    frame.style.color = 'var(--fg)';
    frame.style['font-family'] = 'Inter';
    frame.style.padding = '10px';
    const h1 = frame.children[0].children[0];
    delete h1.style.color;
    const c = getComputedLike(doc, h1.id);
    expect(c).toMatchObject({ color: 'tomato', 'font-family': 'Inter', 'font-size': '48px' });
    expect(c.padding).toBeUndefined();
    expect(() => getComputedLike(doc, 'el_zz')).toThrow(/não encontrado/);
  });
});

describe('exportHtml', () => {
  it('gera documento standalone', () => {
    const doc = tree();
    doc.tokens['--c'] = '#abc';
    const html = exportHtml(doc, { title: 'A & B' });
    expect(html).toContain('<!doctype html>');
    expect(html).toContain('<meta charset="utf-8">');
    expect(html).toContain('<title>A &amp; B</title>');
    expect(html).toContain('--c: #abc;');
    expect(html).toContain('*,*::before,*::after{box-sizing:border-box;margin:0}');
    expect(html).toContain('<h1 class=');
    const inline = exportHtml(doc, {
      mode: 'inline',
      nodeIds: [doc.pages[0].frames[0].children[1].id],
    });
    expect(inline).toContain('<img src="assets/logo.png"');
    expect(inline).not.toContain('<h1');
  });
});

describe('schema', () => {
  it('aplica defaults', () => {
    const doc = parseDocument({
      version: 1,
      id: 'doc_x',
      name: 'N',
      pages: [
        {
          id: 'pg_1',
          name: 'P',
          frames: [
            {
              id: 'fr_1',
              type: 'frame',
              name: 'F',
              tag: 'div',
              children: [{ id: 'el_1', type: 'element', name: 'E', tag: 'p' }],
            },
          ],
        },
      ],
    });
    expect(doc.tokens).toEqual({});
    expect(doc.fonts).toEqual([]);
    expect(doc.pages[0].background).toBe('#1e1e1e');
    const child: Node = doc.pages[0].frames[0].children[0];
    expect(child).toMatchObject({
      attrs: {},
      style: {},
      children: [],
      locked: false,
      hidden: false,
    });
    expect(doc.meta.createdAt).toBeTruthy();
  });

  it('rejeita versão 2, ids duplicados e JSON inválido', () => {
    const doc = createDocument('X');
    expect(() => parseDocument({ ...doc, version: 2 })).toThrow(/Documento inválido: version/);
    const dup = structuredClone(doc);
    const f = createNodeFromTag('div', { isRoot: true });
    dup.pages[0].frames.push(f, { ...f });
    expect(() => parseDocument(dup)).toThrow(/duplicado/);
    expect(() => parseDocument('{nope')).toThrow(/Documento inválido/);
    const v = validateDocument({ foo: 1 });
    expect(v.ok).toBe(false);
    expect(validateDocument(JSON.stringify(doc)).ok).toBe(true);
  });

  it('serializeDocument tem ordem de chaves estável e newline final', () => {
    const doc = tree();
    const s = serializeDocument(doc);
    expect(s.endsWith('}\n')).toBe(true);
    expect(Object.keys(JSON.parse(s))).toEqual([
      'version',
      'id',
      'name',
      'tokens',
      'fonts',
      'meta',
      'pages',
    ]);
    const frame = JSON.parse(s).pages[0].frames[0];
    expect(Object.keys(frame)).toEqual([
      'id',
      'type',
      'name',
      'tag',
      'attrs',
      'style',
      'locked',
      'hidden',
      'children',
    ]);
    expect(serializeDocument(parseDocument(s))).toBe(s);
  });

  it('exemplo landing.mockup.json é válido e estável', () => {
    const file = readFileSync(
      new URL('../../../examples/landing.mockup.json', import.meta.url),
      'utf8',
    );
    const doc = parseDocument(file);
    expect(doc.id).toBe('doc_landing1');
    expect(doc.pages.map((p) => p.name)).toEqual(['Landing', 'Componentes']);
    expect(doc.pages[0].frames.map((f) => f.name)).toEqual(['Desktop 1440', 'Mobile 390']);
    expect(serializeDocument(doc)).toBe(file);
  });
});
