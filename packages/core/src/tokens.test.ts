import { describe, expect, it } from 'vitest';
import { applyOps } from './apply.js';
import { getComputedLike } from './computed.js';
import { createDocument, createNode } from './document.js';
import { History } from './history.js';
import type { Op } from './ops.js';
import {
  canonicalTokenGroup,
  effectiveTheme,
  findVarRefs,
  getTokenReport,
  inferTokenGroup,
  planApplyToken,
  planCreateTheme,
  planDeleteTheme,
  planDeleteTokens,
  planRenameTheme,
  planSetFrameTheme,
  renameTokenProblem,
  replaceVarRefs,
  resolvedTokens,
  resolveScope,
  resolveTokenValue,
  substituteVars,
  themeDeclarations,
  tokenGroup,
  validateTokenValue,
} from './tokens.js';
import type { Document, Node } from './types.js';

function strip(doc: Document): unknown {
  const c = structuredClone(doc);
  c.meta.updatedAt = '';
  return c;
}

function el(id: string, style: Record<string, string> = {}, children: Node[] = []): Node {
  return createNode({ tag: 'div', id, name: id, style, children });
}

/** Document with a frame `fr_main0001` (given children) and optional tokens/themes. */
function docWith(
  children: Node[],
  extra: Partial<Pick<Document, 'tokens' | 'tokenMeta' | 'themes'>> = {},
  frameAttrs: Record<string, string> = {},
): Document {
  const doc = createDocument('Test', { id: 'doc_test0001' });
  doc.pages[0].frames.push(
    createNode({
      tag: 'div',
      type: 'frame',
      id: 'fr_main0001',
      name: 'Screen',
      attrs: frameAttrs,
      style: { width: '400px' },
      children,
    }),
  );
  Object.assign(doc, extra);
  return doc;
}

/** Applies through History, checks exact undo and redo, and returns the document after the ops. */
function applyAndUndo(doc: Document, ops: Op[]): Document {
  const h = new History(structuredClone(doc));
  const after = h.apply(ops).doc;
  expect(strip(h.undo()!.doc)).toEqual(strip(doc));
  expect(strip(h.redo()!.doc)).toEqual(strip(after));
  return after;
}

describe('variable resolution', () => {
  it('simple alias and chain', () => {
    const doc = docWith([], {
      tokens: { '--a': '#111', '--b': 'var(--a)', '--c': 'var(--b)' },
    });
    expect(resolvedTokens(doc)['--b']).toBe('#111');
    expect(resolveTokenValue(doc, 'c')).toBe('#111');
  });

  it('fallback when the variable does not exist', () => {
    expect(substituteVars('var(--x, 4px)', () => undefined)).toEqual({ value: '4px', missing: [] });
    expect(substituteVars('var(--x)', () => undefined).missing).toEqual(['--x']);
    expect(findVarRefs('var(--x, var(--y, 1px))').map((r) => r.name)).toEqual(['--x', '--y']);
  });

  it('a cycle does not hang and leaves the variables without a value', () => {
    const doc = docWith([], { tokens: { '--a': 'var(--b)', '--b': 'var(--a)', '--ok': '1px' } });
    const r = resolvedTokens(doc);
    expect(r['--ok']).toBe('1px');
    expect(Object.keys(r)).not.toContain('--a');
    expect(resolveTokenValue(doc, '--a')).toBeUndefined();
    expect(resolveScope({}, { '--a': 'var(--a)' })).toEqual({});
  });

  it('ancestor local custom property overrides the token', () => {
    const doc = docWith(
      [el('el_parent001', { '--c': 'blue' }, [el('el_child001', { color: 'var(--c)' })])],
      { tokens: { '--c': 'red' } },
    );
    expect(getComputedLike(doc, 'el_child001').color).toBe('blue');
  });

  it('theme on the frame changes the resolved value of a dependent alias', () => {
    const doc = docWith(
      [el('el_child001', { background: 'var(--surface)' })],
      {
        tokens: { '--gray-50': '#fafafa', '--surface': 'var(--gray-50)' },
        themes: [{ name: 'dark', overrides: { '--gray-50': '#111111' } }],
      },
      { 'data-theme': 'dark' },
    );
    expect(getComputedLike(doc, 'el_child001').background).toBe('#111111');
    expect(effectiveTheme(doc, 'el_child001')).toBe('dark');
    expect(resolvedTokens(doc)['--surface']).toBe('#fafafa');
    expect(resolvedTokens(doc, 'dark')['--surface']).toBe('#111111');
    // unknown theme in the attribute is ignored
    const noTheme = docWith([el('el_child001')], { tokens: {} }, { 'data-theme': 'none' });
    expect(effectiveTheme(noTheme, 'el_child001')).toBeUndefined();
  });

  it('themeDeclarations includes the base tokens that depend on the overrides', () => {
    const doc = docWith([], {
      tokens: { '--gray-50': '#fafafa', '--surface': 'var(--gray-50)', '--x': '1px' },
      themes: [{ name: 'dark', overrides: { '--gray-50': '#111' } }],
    });
    expect(themeDeclarations(doc, 'dark')).toEqual({
      '--surface': 'var(--gray-50)',
      '--gray-50': '#111',
    });
    expect(themeDeclarations(doc, 'none')).toEqual({});
  });

  it('getComputedLike evaluates calc() and color-mix(), with the evaluate:false option', () => {
    const doc = docWith(
      [
        el('el_a0000001', {
          padding: 'calc(var(--space) * 2)',
          color: 'color-mix(in srgb, var(--c) 50%, transparent)',
        }),
      ],
      { tokens: { '--space': '8px', '--c': '#ff0000' } },
    );
    const c = getComputedLike(doc, 'el_a0000001');
    expect(c.padding).toBe('16px');
    expect(c.color).toMatch(/^#ff000080$/i);
    const raw = getComputedLike(doc, 'el_a0000001', { evaluate: false });
    expect(raw.padding).toBe('calc(8px * 2)');
    expect(raw.color).toContain('color-mix(');
  });

  it('getComputedLike with the theme option', () => {
    const doc = docWith([el('el_a0000001', { color: 'var(--c)' })], {
      tokens: { '--c': 'white' },
      themes: [{ name: 'dark', overrides: { '--c': 'black' } }],
    });
    expect(getComputedLike(doc, 'el_a0000001').color).toBe('white');
    expect(getComputedLike(doc, 'el_a0000001', { theme: 'dark' }).color).toBe('black');
  });
});

describe('renameToken', () => {
  function rich(): Document {
    const doc = docWith(
      [
        el('el_a0000001', {
          color: 'var(--old)',
          '--old-extra': '1px',
          border: '1px solid var(--old-extra, red)',
        }),
        el('el_b0000002', { '--old': 'green', background: 'var(--old, #000)' }),
      ],
      {
        tokens: {
          '--old': '#123456',
          '--old-extra': '2px',
          '--dep': 'var(--old)',
          '--keep': '3px',
        },
        tokenMeta: { '--old': { group: 'color', description: 'color' } },
        themes: [{ name: 'dark', overrides: { '--old': '#abcdef', '--dep2': 'var(--old)' } }],
      },
    );
    doc.pages.push({
      id: 'pg_segunda1',
      name: 'Other',
      background: '#fff',
      frames: [
        createNode({
          tag: 'div',
          type: 'frame',
          id: 'fr_other001',
          children: [el('el_c0000003', { color: 'var( --old )' })],
        }),
      ],
    });
    return doc;
  }

  it('updates tokens, metadata, themes and styles across several pages', () => {
    const { doc: out } = applyOps(rich(), [{ type: 'renameToken', from: 'old', to: '--new' }]);
    expect(out.tokens['--new']).toBe('#123456');
    expect('--old' in out.tokens).toBe(false);
    expect(out.tokens['--dep']).toBe('var(--new)');
    expect(out.tokenMeta).toEqual({ '--new': { group: 'color', description: 'color' } });
    expect(out.themes![0].overrides).toEqual({ '--new': '#abcdef', '--dep2': 'var(--new)' });
    const a = out.pages[0].frames[0].children[0].style;
    expect(a.color).toBe('var(--new)');
    // a name sharing the prefix is left alone
    expect(a['--old-extra']).toBe('1px');
    expect(a.border).toBe('1px solid var(--old-extra, red)');
    expect(out.tokens['--old-extra']).toBe('2px');
    const b = out.pages[0].frames[0].children[1].style;
    expect(b['--new']).toBe('green');
    expect(b.background).toBe('var(--new, #000)');
    expect(out.pages[1].frames[0].children[0].style.color).toBe('var(--new )');
  });

  it('updates node.classes (short name, variants, opacity, arbitrary) and undo restores', () => {
    const n = el('el_k0000001');
    n.classes =
      'bg-brand hover:bg-brand/90 md:dark:!text-brand border-x-brand bg-brand-500 bg-[var(--color-brand)] bg-(--color-brand) hover:[&:not(:first-child)]:ring-brand! p-4 bg-hov';
    const doc = docWith([n], { tokens: { '--color-brand': '#111', '--color-hov': '#222' } });
    const ops: Op[] = [{ type: 'renameToken', from: '--color-brand', to: '--color-accent' }];
    const { doc: out, results } = applyOps(doc, ops);
    expect(out.pages[0].frames[0].children[0].classes).toBe(
      'bg-accent hover:bg-accent/90 md:dark:!text-accent border-x-accent bg-brand-500 bg-[var(--color-accent)] bg-(--color-accent) hover:[&:not(:first-child)]:ring-accent! p-4 bg-hov',
    );
    expect(JSON.stringify(results)).toContain('"references":7');
    applyAndUndo(doc, ops);
  });

  it('different namespaces only touch the var() forms of the classes', () => {
    const n = el('el_k0000002');
    n.classes = 'bg-brand bg-[var(--color-brand)] text-brand';
    const doc = docWith([n], { tokens: { '--color-brand': '#111' } });
    const { doc: out } = applyOps(doc, [
      { type: 'renameToken', from: '--color-brand', to: '--spacing-brand' },
    ]);
    expect(out.pages[0].frames[0].children[0].classes).toBe(
      'bg-brand bg-[var(--spacing-brand)] text-brand',
    );
  });

  it('errors: destination exists, source does not exist, invalid name', () => {
    const doc = rich();
    expect(() => applyOps(doc, [{ type: 'renameToken', from: '--old', to: '--keep' }])).toThrow(
      /already exists/,
    );
    expect(() => applyOps(doc, [{ type: 'renameToken', from: '--none', to: '--x' }])).toThrow(
      /not found/,
    );
    expect(() => applyOps(doc, [{ type: 'renameToken', from: '--old', to: '--a b' }])).toThrow(
      /invalid/i,
    );
    expect(() => applyOps(doc, [{ type: 'renameToken', from: '--old', to: '--old' }])).toThrow();
  });

  it('undo restores the document exactly and redo reapplies', () => {
    const after = applyAndUndo(rich(), [{ type: 'renameToken', from: '--old', to: '--new' }]);
    expect(after.tokens['--new']).toBe('#123456');
  });

  function withAttrsAndSvg(): Document {
    return docWith(
      [
        createNode({
          tag: 'div',
          id: 'el_attr0001',
          attrs: { fill: 'var(--a)', title: 'x' },
        }),
        createNode({
          tag: 'svg',
          id: 'el_svg00001',
          svg: '<svg width="10"><path fill="var(--a)"/><path stroke="var(--a, red)"/></svg>',
        }),
        createNode({
          tag: 'svg',
          id: 'el_svg00002',
          attrs: { color: 'var(--a)' },
          svg: '<svg><g fill="var(--a)"/></svg>',
        }),
        createNode({ tag: 'svg', id: 'el_svg00003', attrs: { color: 'var(--a)' } }),
      ],
      { tokens: { '--a': '#fff' } },
    );
  }

  it('replaces var() in attrs and in SVG markup, counts nodes and references', () => {
    const { doc: out, results } = applyOps(withAttrsAndSvg(), [
      { type: 'renameToken', from: '--a', to: '--b' },
    ]);
    const [attr, svg1, svg2, svg3] = out.pages[0].frames[0].children;
    expect(attr.attrs.fill).toBe('var(--b)');
    expect(attr.attrs.title).toBe('x');
    expect(svg1.svg).toBe(
      '<svg width="10"><path fill="var(--b)"/><path stroke="var(--b, red)"/></svg>',
    );
    expect(svg2.svg).toBe('<svg><g fill="var(--b)"/></svg>');
    expect(svg2.attrs.color).toBe('var(--b)');
    expect(svg3.attrs.color).toBe('var(--b)');
    expect(results[0]).toMatchObject({ nodes: 4, references: 6 });
  });

  it('undo of attrs and SVG restores the original document exactly', () => {
    const doc = withAttrsAndSvg();
    const { doc: out, inverse } = applyOps(doc, [{ type: 'renameToken', from: '--a', to: '--b' }]);
    expect(strip(applyOps(out, inverse).doc)).toEqual(strip(doc));
    applyAndUndo(doc, [{ type: 'renameToken', from: '--a', to: '--b' }]);
  });

  it('setSvg rejects a node that is not svg and sanitizes the markup', () => {
    const doc = withAttrsAndSvg();
    expect(() =>
      applyOps(doc, [{ type: 'setSvg', changes: [{ nodeId: 'el_attr0001', svg: '<svg/>' }] }]),
    ).toThrow(/is not an SVG/);
    const { doc: out } = applyOps(doc, [
      {
        type: 'setSvg',
        changes: [{ nodeId: 'el_svg00001', svg: '<svg><rect onclick="x()"/><script/></svg>' }],
      },
    ]);
    expect(out.pages[0].frames[0].children[1].svg).toBe('<svg><rect/></svg>');
    expect(() =>
      applyOps(doc, [
        {
          type: 'setSvg',
          changes: [{ nodeId: 'el_svg00001', svg: '<svg/>', attrs: { onload: 'x()' } }],
        },
      ]),
    ).toThrow(/on\*/);
  });

  it('rejects a destination already declared in the style of some node', () => {
    const doc = docWith([el('el_a0000001', { '--new': '1px' })], { tokens: { '--old': '#000' } });
    expect(() => applyOps(doc, [{ type: 'renameToken', from: '--old', to: '--new' }])).toThrow(
      /is already declared in the style of node "el_a0000001" \(el_a0000001\)/,
    );
  });

  it('renameTokenProblem covers each rejection and returns null when allowed', () => {
    const doc = docWith([el('el_a0000001', { '--local': '1px' })], {
      tokens: { '--old': '#000', '--keep': '1px' },
      themes: [{ name: 'dark', overrides: { '--theme-only': '#111' } }],
    });
    expect(renameTokenProblem(doc, 'old', 'new')).toBeNull();
    expect(renameTokenProblem(doc, '--old', '--a b')).toMatch(/invalid/i);
    expect(renameTokenProblem(doc, '--old', 'old')).toMatch(/same as/);
    expect(renameTokenProblem(doc, '--none', '--x')).toMatch(/not found/);
    expect(renameTokenProblem(doc, '--old', '--keep')).toMatch(/already exists/);
    expect(renameTokenProblem(doc, '--old', '--theme-only')).toMatch(/already exists/);
    expect(renameTokenProblem(doc, '--old', '--local')).toMatch(/is already declared/);
  });

  it('replaceVarRefs matches VAR( case-insensitively and preserves the spelling', () => {
    expect(replaceVarRefs('VAR(--a) Var( --a, 1px) var(--A)', '--a', '--z')).toBe(
      'VAR(--z) Var(--z, 1px) var(--A)',
    );
  });
});

describe('token and theme ops', () => {
  const base = (): Document =>
    docWith([], {
      tokens: { '--a': '1px' },
      themes: [{ name: 'dark', overrides: { '--a': '2px' } }],
    });

  it('setTokens with theme writes to the overrides and undoes', () => {
    const after = applyAndUndo(base(), [
      { type: 'setTokens', theme: 'dark', set: { b: '3px' }, unset: ['--a'] },
    ]);
    expect(after.themes![0].overrides).toEqual({ '--b': '3px' });
    expect(after.tokens).toEqual({ '--a': '1px' });
  });

  it('setTokens with a nonexistent theme fails', () => {
    expect(() =>
      applyOps(base(), [{ type: 'setTokens', theme: 'none', set: { '--a': '1px' } }]),
    ).toThrow(/not found/);
  });

  it('setTokens rejects a value that escapes the declaration', () => {
    expect(() =>
      applyOps(base(), [{ type: 'setTokens', set: { '--a': 'red; color: blue' } }]),
    ).toThrow();
  });

  it('setTokenMeta sets, removes and clears the empty field', () => {
    const after = applyAndUndo(base(), [
      { type: 'setTokenMeta', set: { a: { group: 'spacing', description: 'x' } } },
    ]);
    expect(after.tokenMeta).toEqual({ '--a': { group: 'spacing', description: 'x' } });
    const h = new History(after);
    const without = h.apply([{ type: 'setTokenMeta', unset: ['--a'] }]).doc;
    expect('tokenMeta' in without).toBe(false);
    h.undo();
    expect(strip(h.doc)).toEqual(strip(after));
    // an empty entry is the same as removing
    const empty = applyOps(after, [{ type: 'setTokenMeta', set: { '--a': {} } }]).doc;
    expect('tokenMeta' in empty).toBe(false);
  });

  it('setThemes replaces the list, removes the field when empty and undoes', () => {
    const after = applyAndUndo(base(), [
      { type: 'setThemes', themes: [{ name: 'light', overrides: {} }] },
    ]);
    expect(after.themes).toEqual([{ name: 'light', overrides: {} }]);
    const none = applyAndUndo(base(), [{ type: 'setThemes', themes: [] }]);
    expect('themes' in none).toBe(false);
  });

  it('setThemes rejects an invalid and a duplicate name', () => {
    expect(() =>
      applyOps(base(), [{ type: 'setThemes', themes: [{ name: 'a b', overrides: {} }] }]),
    ).toThrow();
    expect(() =>
      applyOps(base(), [
        {
          type: 'setThemes',
          themes: [
            { name: 'x', overrides: {} },
            { name: 'x', overrides: {} },
          ],
        },
      ]),
    ).toThrow();
  });

  it('replaceTokens replaces everything and undoes', () => {
    const after = applyAndUndo(base(), [
      {
        type: 'replaceTokens',
        tokens: { n: '5px' },
        tokenMeta: { '--n': { group: 'spacing' } },
        themes: [{ name: 'alto', overrides: { '--n': '9px' } }],
      },
    ]);
    expect(after.tokens).toEqual({ '--n': '5px' });
    expect(after.themes![0].name).toBe('alto');
    const cleared = applyAndUndo(base(), [{ type: 'replaceTokens', tokens: {} }]);
    expect('themes' in cleared).toBe(false);
    expect('tokenMeta' in cleared).toBe(false);
  });
});

describe('planners', () => {
  const base = (): Document =>
    docWith(
      [el('el_a0000001')],
      {
        tokens: { '--a': '1px', '--b': '2px' },
        tokenMeta: { '--a': { group: 'spacing' } },
        themes: [{ name: 'dark', overrides: { '--a': '9px' } }],
      },
      { 'data-theme': 'dark' },
    );

  it('planDeleteTokens removes from base, metadata and themes', () => {
    const doc = base();
    const out = applyAndUndo(doc, planDeleteTokens(doc, ['a']));
    expect(out.tokens).toEqual({ '--b': '2px' });
    expect('tokenMeta' in out).toBe(false);
    expect(out.themes![0].overrides).toEqual({});
    expect(() => planDeleteTokens(doc, ['--none'])).toThrow(/not found/);
  });

  it('planApplyToken generates var(--x) and rejects a nonexistent token', () => {
    const doc = base();
    const out = applyOps(doc, planApplyToken(doc, ['el_a0000001'], 'backgroundColor', 'b')).doc;
    expect(out.pages[0].frames[0].children[0].style['background-color']).toBe('var(--b)');
    expect(() => planApplyToken(doc, ['el_a0000001'], 'color', '--none')).toThrow(/doesn't exist/);
    expect(() => planApplyToken(doc, ['el_zzzzzzzz'], 'color', '--a')).toThrow(/not found/);
  });

  it("creating, renaming and removing a theme update the nodes' data-theme", () => {
    const doc = base();
    const created = applyOps(
      doc,
      planCreateTheme(doc, 'hc', { copyFrom: 'dark', overrides: { b: '7px' } }),
    ).doc;
    expect(created.themes![1]).toEqual({ name: 'hc', overrides: { '--a': '9px', '--b': '7px' } });
    expect(() => planCreateTheme(doc, 'dark')).toThrow(/already exists/);
    expect(() => planCreateTheme(doc, 'a b')).toThrow(/invalid/i);

    const ren = applyAndUndo(doc, planRenameTheme(doc, 'dark', 'night'));
    expect(ren.themes![0].name).toBe('night');
    expect(ren.pages[0].frames[0].attrs['data-theme']).toBe('night');

    const del = applyAndUndo(doc, planDeleteTheme(doc, 'dark'));
    expect('themes' in del).toBe(false);
    expect('data-theme' in del.pages[0].frames[0].attrs).toBe(false);
    expect(() => planDeleteTheme(doc, 'none')).toThrow(/not found/);
  });

  it('planSetFrameTheme sets and, with null, removes', () => {
    const doc = base();
    const without = applyOps(doc, planSetFrameTheme(doc, ['fr_main0001'], null)).doc;
    expect('data-theme' in without.pages[0].frames[0].attrs).toBe(false);
    const withTheme = applyOps(without, planSetFrameTheme(without, ['fr_main0001'], 'dark')).doc;
    expect(withTheme.pages[0].frames[0].attrs['data-theme']).toBe('dark');
    expect(() => planSetFrameTheme(doc, ['fr_main0001'], 'none')).toThrow();
  });
});

describe('getTokenReport', () => {
  it('considers node.states: usage only in hover is not unused and a broken reference points to the state', () => {
    const n = el('el_st000001');
    n.states = {
      hover: { 'background-color': 'var(--hov)', color: 'var(--none)' },
      dark: { '--loc': '1px', margin: 'var(--loc)' },
    };
    const doc = docWith([n], { tokens: { '--hov': '#222' } });
    const r = getTokenReport(doc);
    expect(r.unused).not.toContain('--hov');
    expect(r.tokens.find((t) => t.name === '--hov')!.usage.nodeIds).toEqual(['el_st000001']);
    expect(r.broken).toEqual([
      { nodeId: 'el_st000001', property: 'state:hover:color', missing: '--none' },
    ]);
  });

  it('counts usage and broken references in attrs and in SVG markup', () => {
    const doc = docWith(
      [
        createNode({
          tag: 'div',
          id: 'el_attr0001',
          attrs: { fill: 'var(--a)', stroke: 'var(--x)' },
        }),
        createNode({
          tag: 'svg',
          id: 'el_svg00001',
          svg: '<svg><path fill="var(--a)"/><g fill="var(--y)"/></svg>',
        }),
      ],
      { tokens: { '--a': '#fff' } },
    );
    const r = getTokenReport(doc);
    expect(r.tokens.find((t) => t.name === '--a')!.usage.nodeIds).toEqual([
      'el_attr0001',
      'el_svg00001',
    ]);
    expect(r.broken).toEqual([
      { nodeId: 'el_attr0001', property: 'attr:stroke', missing: '--x' },
      { nodeId: 'el_svg00001', property: 'svg', missing: '--y' },
    ]);
  });

  it('usage by nodes and by tokens, and unused ones', () => {
    const doc = docWith(
      [
        el('el_a0000001', { color: 'var(--a)' }),
        el('el_b0000002', { background: 'var(--a)', margin: 'var(--c)' }),
      ],
      { tokens: { '--a': '#fff', '--b': 'var(--a)', '--c': '1px', '--spare': '3px' } },
    );
    const r = getTokenReport(doc);
    const a = r.tokens.find((t) => t.name === '--a')!;
    expect(a.usage.nodeIds).toEqual(['el_a0000001', 'el_b0000002']);
    expect(a.usage.tokens).toEqual(['--b']);
    expect(r.unused.sort()).toEqual(['--b', '--spare']);
    expect(r.broken).toEqual([]);
    expect(a.group).toBe('color');
    expect(a.resolved).toBe('#fff');
  });

  it('broken references in token, theme and style; an ancestor custom property does not count', () => {
    const doc = docWith(
      [
        el('el_parent001', { '--local': '4px' }, [
          el('el_child001', {
            padding: 'var(--local)',
            margin: 'var(--missing)',
            gap: 'var(--missing2, 1px)',
          }),
        ]),
      ],
      {
        tokens: { '--a': 'var(--gone)' },
        themes: [{ name: 'dark', overrides: { '--a': 'var(--gone2)' } }],
      },
    );
    const broken = getTokenReport(doc).broken;
    expect(broken).toContainEqual({ token: '--a', missing: '--gone' });
    expect(broken).toContainEqual({ token: '--a', theme: 'dark', missing: '--gone2' });
    expect(broken).toContainEqual({
      nodeId: 'el_child001',
      property: 'margin',
      missing: '--missing',
    });
    expect(broken).toHaveLength(3);
  });

  it('validation problem, per-theme values and description', () => {
    const doc = docWith([], {
      tokens: { '--color-x': '12px', '--color-ok': '#fff' },
      tokenMeta: { '--color-ok': { description: 'ok' } },
      themes: [{ name: 'dark', overrides: { '--color-ok': '#000' } }],
    });
    const r = getTokenReport(doc);
    const x = r.tokens.find((t) => t.name === '--color-x')!;
    expect(x.problem?.level).toBe('warning');
    const ok = r.tokens.find((t) => t.name === '--color-ok')!;
    expect(ok.problem).toBeUndefined();
    expect(ok.description).toBe('ok');
    expect(ok.themes).toEqual({ dark: '#000' });
    expect(ok.resolvedByTheme).toEqual({ dark: '#000' });
    expect(r.themes).toEqual([{ name: 'dark', overrides: 1, frames: [] }]);
  });
});

describe('validateTokenValue', () => {
  it('accepts valid color-mix and calc', () => {
    expect(validateTokenValue('--color-a', 'color-mix(in srgb, #fff 50%, #000)')).toBeNull();
    expect(validateTokenValue('--space-a', 'calc(1px + 2px)')).toBeNull();
  });

  it('unclosed parentheses are an error', () => {
    expect(validateTokenValue('--space-a', 'calc(1px + 2px')?.level).toBe('error');
  });

  it('wrong type is a warning', () => {
    expect(validateTokenValue('--color-a', '12px')?.level).toBe('warning');
    expect(validateTokenValue('--space-a', 'banana')?.level).toBe('warning');
  });

  it('nonexistent reference is a warning', () => {
    const p = validateTokenValue('--color-a', 'var(--none)', { vars: {} });
    expect(p?.level).toBe('warning');
    expect(p?.message).toContain('--none');
    expect(validateTokenValue('--color-a', 'var(--c)', { vars: { '--c': '#fff' } })).toBeNull();
  });

  it('dangerous and empty values are an error', () => {
    for (const v of ['red}', 'red; color: blue', '<b>', '']) {
      expect(validateTokenValue('--x', v)?.level, v).toBe('error');
    }
  });
});

describe('groups', () => {
  it('inferTokenGroup by prefix', () => {
    expect(inferTokenGroup('--color-primary')).toBe('color');
    expect(inferTokenGroup('--bg-card')).toBe('color');
    expect(inferTokenGroup('--shadow-md')).toBe('shadow');
    expect(inferTokenGroup('--radius')).toBe('radius');
    expect(inferTokenGroup('--font-sans')).toBe('typography');
    expect(inferTokenGroup('--text-lg')).toBe('typography');
    expect(inferTokenGroup('--spacing-4')).toBe('spacing');
    expect(inferTokenGroup('--zzz')).toBe('other');
  });

  it('inferTokenGroup by value', () => {
    expect(inferTokenGroup('--zzz', '#abc')).toBe('color');
    expect(inferTokenGroup('--zzz', 'oklch(0.5 0.2 200)')).toBe('color');
    expect(inferTokenGroup('--zzz', '0 1px 2px rgba(0,0,0,.2)')).toBe('shadow');
    expect(inferTokenGroup('--zzz', '12px')).toBe('spacing');
    expect(inferTokenGroup('--zzz', 'abc')).toBe('other');
  });

  it('tokenGroup prefers the metadata', () => {
    const doc = docWith([], {
      tokens: { '--a': '#fff' },
      tokenMeta: { '--a': { group: 'marca' } },
    });
    expect(tokenGroup(doc, '--a')).toBe('marca');
  });

  it('replaceVarRefs only replaces the exact name', () => {
    expect(replaceVarRefs('var(--a) var(--a-b) var(--a, 1px)', '--a', '--z')).toBe(
      'var(--z) var(--a-b) var(--z, 1px)',
    );
  });
});

describe('canonicalTokenGroup', () => {
  it('a free group with the label or id of a built-in one becomes the built-in (case and accents do not matter)', () => {
    expect(canonicalTokenGroup('Colors')).toBe('color');
    expect(canonicalTokenGroup(' colors ')).toBe('color');
    expect(canonicalTokenGroup('Espacamento')).toBe('spacing');
    expect(canonicalTokenGroup('COLOR')).toBe('color');
    expect(canonicalTokenGroup('Brand')).toBe('Brand');
  });

  it('migrates stored legacy Portuguese group labels to the built-in group', () => {
    expect(canonicalTokenGroup('Cores')).toBe('color');
    expect(canonicalTokenGroup('Tipografia')).toBe('typography');
    expect(canonicalTokenGroup('Espaçamento')).toBe('spacing');
    expect(canonicalTokenGroup('espacamento')).toBe('spacing');
    expect(canonicalTokenGroup('Raio')).toBe('radius');
    expect(canonicalTokenGroup('Sombra')).toBe('shadow');
    expect(canonicalTokenGroup('Outros')).toBe('other');
  });

  it('the report merges the free group "Colors" into the color group', () => {
    const doc = createDocument('Test', { id: 'doc_grp00001' });
    doc.tokens = { '--brand': '#2563eb', '--color-a': '#000' };
    doc.tokenMeta = { '--brand': { group: 'Colors' } };
    expect(getTokenReport(doc).tokens.map((t) => t.group)).toEqual(['color', 'color']);
  });
});
