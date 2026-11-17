import { describe, expect, it } from 'vitest';
import { applyOp, applyOps } from './apply.js';
import { documentBaseCss, documentBaseCssFor, documentRootDeclarations } from './base.js';
import { createDocument, createNodeFromTag, findNode } from './document.js';
import { parseDocument, serializeDocument } from './schema.js';
import {
  BREAKPOINT_PX,
  formatStateKey,
  hasStates,
  normalizeStateKey,
  parseStateKey,
  resolveStateStyle,
  sortStateKeys,
  stateMatches,
} from './states.js';
import { getTreeSummary, summarizeNode } from './summary.js';
import type { Document, Node } from './types.js';

function strip(doc: Document): unknown {
  const c = structuredClone(doc);
  c.meta.updatedAt = '';
  return c;
}

function fixture(): Document {
  const doc = createDocument('Estados', { id: 'doc_state001' });
  const frame = createNodeFromTag('div', { isRoot: true });
  frame.id = 'fr_state0001';
  const btn = createNodeFromTag('button', {
    styles: { 'background-color': 'var(--color-primary)' },
  });
  btn.id = 'el_state0001';
  frame.children = [btn];
  doc.pages[0].frames.push(frame);
  doc.tokens['--color-primary'] = '#6c5ce7';
  return doc;
}

type RawDoc = { pages: { frames: { children: Record<string, unknown>[] }[] }[]; cssBase?: string };

describe('chaves de estado', () => {
  it('parse e format aceitam qualquer ordem e canonicalizam', () => {
    expect(parseStateKey('hover')).toEqual({ pseudo: 'hover' });
    expect(parseStateKey('hover:md')).toEqual({ pseudo: 'hover', breakpoint: 'md' });
    expect(normalizeStateKey('hover:dark:lg')).toBe('lg:dark:hover');
    expect(formatStateKey({ breakpoint: 'md', pseudo: 'hover' })).toBe('md:hover');
  });

  it('rejeita chaves inválidas, repetidas ou vazias', () => {
    for (const k of ['', ':', 'foo', 'hover:focus', 'md:lg', 'dark:dark', 'hover:', 'group-hover'])
      expect(parseStateKey(k)).toBeNull();
    expect(normalizeStateKey('foo')).toBeNull();
  });

  it('sortStateKeys: dark e breakpoints (menores primeiro) antes das pseudo-classes', () => {
    expect(sortStateKeys(['hover', 'md', 'dark', 'sm', 'md:hover', 'lg'])).toEqual([
      'dark',
      'sm',
      'md',
      'lg',
      'hover',
      'md:hover',
    ]);
  });
});

describe('stateMatches / resolveStateStyle', () => {
  const node: Node = {
    ...createNodeFromTag('div', { styles: { padding: '8px', color: 'black' } }),
    states: {
      hover: { color: 'red' },
      md: { padding: '16px' },
      dark: { color: 'white' },
      'md:hover': { color: 'blue' },
    },
  };

  it('breakpoints são mobile first e dependem da largura do frame', () => {
    expect(stateMatches('md', { frameWidth: BREAKPOINT_PX.md })).toBe(true);
    expect(stateMatches('md', { frameWidth: BREAKPOINT_PX.md - 1 })).toBe(false);
    expect(stateMatches('md', {})).toBe(false);
    expect(stateMatches('lg', { frameWidth: 800, breakpoints: { lg: 700 } })).toBe(true);
  });

  it('dark e pseudo dependem do contexto', () => {
    expect(stateMatches('dark', { dark: true })).toBe(true);
    expect(stateMatches('dark', {})).toBe(false);
    expect(stateMatches('hover', { pseudo: 'hover' })).toBe(true);
    expect(stateMatches('hover', { pseudo: 'focus' })).toBe(false);
    expect(stateMatches('md:hover', { frameWidth: 800, pseudo: 'hover' })).toBe(true);
    expect(stateMatches('md:hover', { frameWidth: 400, pseudo: 'hover' })).toBe(false);
    expect(stateMatches('invalido', { dark: true })).toBe(false);
  });

  it('sem contexto ativo devolve o próprio estilo', () => {
    expect(resolveStateStyle(node, {})).toBe(node.style);
    expect(resolveStateStyle(createNodeFromTag('div'), { dark: true })).toEqual({});
  });

  it('aplica os estados ativos por cima, na ordem de aplicação', () => {
    expect(resolveStateStyle(node, { frameWidth: 800 })).toEqual({
      padding: '16px',
      color: 'black',
    });
    expect(resolveStateStyle(node, { frameWidth: 800, dark: true, pseudo: 'hover' })).toEqual({
      padding: '16px',
      color: 'blue',
    });
    expect(resolveStateStyle(node, { dark: true, pseudo: 'hover' }).color).toBe('red');
    expect(node.style).toEqual({ padding: '8px', color: 'black' }); // não muta
  });

  it('hasStates ignora estados vazios', () => {
    expect(hasStates(node)).toBe(true);
    expect(hasStates({ ...node, states: { hover: {} } })).toBe(false);
    expect(hasStates(createNodeFromTag('div'))).toBe(false);
  });
});

describe('ops setClasses / setStates / setCssBase', () => {
  it('setClasses normaliza, remove com null e tem inverso exato', () => {
    const doc = fixture();
    const r = applyOp(doc, {
      type: 'setClasses',
      changes: [{ nodeId: 'el_state0001', classes: '  p-4   hover:bg-red-500 ' }],
    });
    expect(findNode(r.doc, 'el_state0001')!.node.classes).toBe('p-4 hover:bg-red-500');
    expect(strip(applyOps(r.doc, r.inverse).doc)).toStrictEqual(strip(doc));
    const cleared = applyOp(r.doc, {
      type: 'setClasses',
      changes: [{ nodeId: 'el_state0001', classes: null }],
    });
    expect('classes' in findNode(cleared.doc, 'el_state0001')!.node).toBe(false);
    expect(strip(applyOps(cleared.doc, cleared.inverse).doc)).toStrictEqual(strip(r.doc));
  });

  it('setClasses aceita variantes arbitrárias do shadcn e recusa caracteres perigosos', () => {
    const ok = applyOp(fixture(), {
      type: 'setClasses',
      changes: [
        {
          nodeId: 'el_state0001',
          classes: "has-[>svg]:px-3 [&_svg:not([class*='size-'])]:size-4",
        },
      ],
    });
    expect(findNode(ok.doc, 'el_state0001')!.node.classes).toContain('has-[>svg]:px-3');
    expect(() =>
      applyOp(fixture(), {
        type: 'setClasses',
        changes: [{ nodeId: 'el_state0001', classes: 'a"><script>' }],
      }),
    ).toThrow(/Classes inválidas/);
  });

  it('setStates normaliza chaves e propriedades, remove com null e tem inverso exato', () => {
    const doc = fixture();
    const r = applyOp(doc, {
      type: 'setStates',
      changes: [
        {
          nodeId: 'el_state0001',
          states: { 'hover:md': { backgroundColor: 'red' }, dark: { color: ' white ' } },
        },
      ],
    });
    const node = findNode(r.doc, 'el_state0001')!.node;
    expect(node.states).toEqual({
      'md:hover': { 'background-color': 'red' },
      dark: { color: 'white' },
    });
    expect(strip(applyOps(r.doc, r.inverse).doc)).toStrictEqual(strip(doc));
    const cleared = applyOp(r.doc, {
      type: 'setStates',
      changes: [{ nodeId: 'el_state0001', states: null }],
    });
    expect(findNode(cleared.doc, 'el_state0001')!.node.states).toBeUndefined();
    expect(strip(applyOps(cleared.doc, cleared.inverse).doc)).toStrictEqual(strip(r.doc));
  });

  it('setStates recusa estado e valor inválidos', () => {
    expect(() =>
      applyOp(fixture(), {
        type: 'setStates',
        changes: [{ nodeId: 'el_state0001', states: { foo: { color: 'red' } } }],
      }),
    ).toThrow(/Estado inválido/);
    expect(() =>
      applyOp(fixture(), {
        type: 'setStates',
        changes: [{ nodeId: 'el_state0001', states: { hover: { color: 'red; x: y' } } }],
      }),
    ).toThrow(/Valor inválido/);
  });

  it('setCssBase liga e desliga o preflight com inverso exato', () => {
    const doc = fixture();
    expect(doc.cssBase).toBeUndefined();
    const on = applyOp(doc, { type: 'setCssBase', base: 'tailwind' });
    expect(on.doc.cssBase).toBe('tailwind');
    expect(strip(applyOps(on.doc, on.inverse).doc)).toStrictEqual(strip(doc));
    const off = applyOp(on.doc, { type: 'setCssBase', base: 'default' });
    expect('cssBase' in off.doc).toBe(false);
    expect(strip(applyOps(off.doc, off.inverse).doc)).toStrictEqual(strip(on.doc));
  });

  it('renameToken também atualiza os estados (e o inverso devolve)', () => {
    const doc = fixture();
    const node = findNode(doc, 'el_state0001')!.node;
    node.states = {
      hover: { 'background-color': 'color-mix(in oklab, var(--color-primary) 90%, transparent)' },
      dark: { color: 'var(--color-primary)' },
    };
    const r = applyOp(doc, { type: 'renameToken', from: '--color-primary', to: '--color-brand' });
    const renamed = findNode(r.doc, 'el_state0001')!.node;
    expect(renamed.style['background-color']).toBe('var(--color-brand)');
    expect(renamed.states!.hover['background-color']).toContain('var(--color-brand)');
    expect(renamed.states!.dark.color).toBe('var(--color-brand)');
    expect(JSON.stringify(renamed)).not.toContain('--color-primary');
    expect(strip(applyOps(r.doc, r.inverse).doc)).toStrictEqual(strip(doc));
  });
});

describe('schema: classes, states e cssBase', () => {
  const raw = (): RawDoc => JSON.parse(serializeDocument(fixture())) as RawDoc;

  it('parseDocument normaliza e descarta chaves de estado inválidas', () => {
    const json = raw();
    const child = json.pages[0].frames[0].children[0];
    child.classes = '  p-4    hover:bg-red-500  ';
    child.states = {
      'hover:md': { color: 'red' },
      foo: { color: 'blue' },
      'hover:focus': { color: 'green' },
      dark: { color: 'white', 'background-image': 'red; x: y' },
      active: {},
    };
    json.cssBase = 'tailwind';
    const doc = parseDocument(json);
    const node = findNode(doc, 'el_state0001')!.node;
    expect(node.classes).toBe('p-4 hover:bg-red-500');
    expect(Object.keys(node.states!).sort()).toEqual(['dark', 'md:hover']);
    expect(node.states!.dark).toEqual({ color: 'white' });
    expect(doc.cssBase).toBe('tailwind');
  });

  it('classes vazias e estados vazios somem do nó', () => {
    const json = raw();
    const child = json.pages[0].frames[0].children[0];
    child.classes = '   ';
    child.states = { foo: { color: 'red' } };
    const node = findNode(parseDocument(json), 'el_state0001')!.node;
    expect('classes' in node).toBe(false);
    expect('states' in node).toBe(false);
  });

  it('serializeDocument mantém classes, states e cssBase (round-trip estável)', () => {
    const doc = fixture();
    const node = findNode(doc, 'el_state0001')!.node;
    node.classes = 'p-4 hover:bg-red-500';
    node.states = { hover: { 'background-color': 'red' }, 'md:dark': { color: 'white' } };
    doc.cssBase = 'tailwind';
    const text = serializeDocument(doc);
    const back = parseDocument(text);
    const n2 = findNode(back, 'el_state0001')!.node;
    expect(n2.classes).toBe('p-4 hover:bg-red-500');
    expect(n2.states).toEqual({
      hover: { 'background-color': 'red' },
      'md:dark': { color: 'white' },
    });
    expect(back.cssBase).toBe('tailwind');
    expect(serializeDocument(back)).toBe(text);
  });
});

describe('documentBaseCss com preflight', () => {
  it('sem preflight é a base de sempre', () => {
    const css = documentBaseCss();
    expect(css).toContain('*,*::before,*::after{box-sizing:border-box;margin:0}');
    expect(css).not.toContain('border:0 solid');
    expect(documentBaseCssFor({})).toBe(css);
  });

  it('com preflight global traz o reset do Tailwind e a raiz tipográfica do Tailwind', () => {
    const css = documentBaseCss(undefined, undefined, { preflight: true });
    expect(css).toContain('box-sizing:border-box;margin:0;padding:0;border:0 solid');
    expect(css).toContain('h1,h2,h3,h4,h5,h6{font-size:inherit;font-weight:inherit}');
    expect(css).toContain('body{font-family:-apple-system');
    expect(css).toContain('line-height:1.5');
    expect(documentBaseCssFor({ cssBase: 'tailwind' })).toBe(css);
  });

  it('com escopo os seletores ficam dentro do contêiner e pseudo-elementos viram *::x', () => {
    const css = documentBaseCss('.cv-world', '.cv-frame', { preflight: true });
    expect(css).toContain('.cv-world *,.cv-world *::after,.cv-world *::before');
    expect(css).toContain('.cv-world h1,.cv-world h2');
    expect(css).toContain('.cv-world img,.cv-world svg');
    expect(css).toContain('.cv-frame{font-family:');
    const rules = css.split('\n').slice(0, -1);
    for (const rule of rules) expect(rule.startsWith('.cv-world ')).toBe(true);
    expect(css).not.toMatch(/(^|\n)(\*|body|h1|button)[,{]/);
  });

  it('documentRootDeclarations segue cssBase', () => {
    expect(documentRootDeclarations({})).toContain('system-ui');
    expect(documentRootDeclarations({ cssBase: 'tailwind' })).toContain('-apple-system');
  });
});

describe('summarizeNode', () => {
  it('marca tw e states', () => {
    const n = createNodeFromTag('div', { styles: { width: '10px', height: '10px' } });
    n.id = 'el_sum00001';
    expect(summarizeNode(n)).not.toMatch(/ tw|states:/);
    n.classes = 'p-4';
    n.states = { md: { padding: '8px' }, hover: { color: 'red' }, active: {} };
    expect(summarizeNode(n)).toContain(' tw states:md,hover');
    const t = createNodeFromTag('p', { text: 'oi' });
    t.classes = 'text-sm';
    expect(summarizeNode(t)).toContain(' tw');
    expect(getTreeSummary(n, 0)).toContain('states:md,hover');
  });
});
