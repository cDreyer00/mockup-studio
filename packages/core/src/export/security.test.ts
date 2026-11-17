import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { applyOp } from '../apply.js';
import { createDocument, createNode } from '../document.js';
import { FontRefSchema, parseDocument, serializeDocument } from '../schema.js';
import { fontFaceCss } from '../fonts.js';
import { cssValueProblem, normalizeStyles } from '../styles.js';
import type { Document } from '../types.js';
import { exportHtml } from './html.js';
import { exportReact } from './react.js';
import { exportSvg } from './svg.js';
import { exportTailwind } from './tailwind.js';

const landingRaw = JSON.parse(
  fs.readFileSync(new URL('../../../../examples/landing.mockup.json', import.meta.url), 'utf8'),
);

/** Minimal document as raw JSON (like an old/hand-edited file). */
function rawDoc(style: Record<string, string>, tokens: Record<string, string> = {}): unknown {
  return {
    version: 1,
    id: 'doc_seg',
    name: 'Security',
    tokens,
    pages: [
      {
        id: 'pg_seg',
        name: 'P',
        frames: [
          {
            id: 'fr_seg00001',
            type: 'frame',
            name: 'Screen',
            tag: 'div',
            attrs: {},
            style: { width: '100px', ...style },
            children: [],
          },
        ],
      },
    ],
  };
}

const BAD_VALUES = [
  'red; } body { display: none',
  'red}',
  '{red',
  'url(x) ; color: blue',
  'red </style><script>alert(1)</script>',
  '"abc',
  'red)',
  'rgb(1,2,3',
  'red /* x */',
];

describe('cssValueProblem', () => {
  it.each([
    'red',
    '1px solid var(--color-muted)',
    'url("data:image/svg+xml;utf8,<svg xmlns=\'http://www.w3.org/2000/svg\'/>")',
    'url(data:image/png;base64,AAAA)',
    '"text; with { braces } inside"',
    "'a;b'",
    'calc(100% - (2 * 8px))',
    'Inter, "Open Sans", sans-serif',
    '"\\"; still inside"',
  ])('accepts %s', (v) => {
    expect(cssValueProblem(v)).toBeNull();
  });

  it.each(BAD_VALUES)('rejects %s', (v) => {
    expect(cssValueProblem(v)).toEqual(expect.any(String));
  });

  it('rejects </style in any case, even inside quotes', () => {
    expect(cssValueProblem('"</STYLE>"')).toMatch(/style/);
  });
});

describe('normalizeStyles / updateStyles', () => {
  it('normalizeStyles rejects values that break the rule, with a clear message', () => {
    expect(() => normalizeStyles({ color: 'red; } a { x: y' })).toThrow(
      /Invalid CSS value in "color"/,
    );
    expect(() => normalizeStyles({ 'a b': 'x' })).toThrow(/Invalid CSS property name/);
  });

  it('updateStyles rejects invalid values and keys', () => {
    const doc = createDocument('T', { id: 'doc_t' });
    doc.pages[0].frames.push(
      createNode({ tag: 'div', type: 'frame', id: 'fr_aaaaaaaa', name: 'F' }),
    );
    for (const v of BAD_VALUES) {
      expect(() =>
        applyOp(doc, { type: 'updateStyles', nodeIds: ['fr_aaaaaaaa'], styles: { color: v } }),
      ).toThrow(/Invalid CSS value/);
    }
    expect(() =>
      applyOp(doc, {
        type: 'updateStyles',
        nodeIds: ['fr_aaaaaaaa'],
        styles: { 'color: red; x': 'y' },
      }),
    ).toThrow(/Invalid/);
    const ok = applyOp(doc, {
      type: 'updateStyles',
      nodeIds: ['fr_aaaaaaaa'],
      styles: { color: 'red' },
    }).doc;
    expect(ok.pages[0].frames[0].style.color).toBe('red');
  });
});

describe('file reading', () => {
  it('parseDocument only drops the bad declaration, without rejecting the file', () => {
    const doc = parseDocument(
      rawDoc({
        color: 'red; } body { display: none',
        'background-color': 'blue',
        'bad key': 'x',
        content: '"</style>"',
      }),
    );
    expect(doc.pages[0].frames[0].style).toEqual({ width: '100px', 'background-color': 'blue' });
  });

  it('parseDocument drops tokens with a dangerous value and keeps the rest', () => {
    const doc = parseDocument(rawDoc({}, { '--a': 'red; } x {', '--b': '#fff' }));
    expect(doc.tokens).toEqual({ '--b': '#fff' });
  });
});

describe('exporters sanitize old files', () => {
  /** Document with bad style that escaped reading (built directly, without going through the parser). */
  function dirtyDoc(): Document {
    const doc = createDocument('Dirty', { id: 'doc_dirty' });
    const frame = createNode({
      tag: 'div',
      type: 'frame',
      id: 'fr_dirt0001',
      name: 'Screen',
      style: { width: '100px', height: '50px' },
    });
    frame.style.color = 'red; } body { display: none';
    frame.style['bad key'] = 'x';
    frame.style['background-color'] = 'blue';
    frame.style.content = '"</style><script>alert(1)</script>"';
    doc.pages[0].frames.push(frame);
    doc.tokens = { '--ok': '#fff', '--bad': 'red; } body { display: none', noprefix: '1' };
    return doc;
  }

  const checks = (out: string): void => {
    expect(out).not.toContain('display: none');
    expect(out).not.toContain('alert(1)');
    expect(out).not.toContain('bad key');
    expect(out).not.toContain('--bad');
    expect(out).not.toContain('noprefix');
    expect(out).not.toMatch(/<\/style><script/);
  };

  it('html (classes and inline)', () => {
    for (const mode of ['classes', 'inline'] as const) {
      const out = exportHtml(dirtyDoc(), { mode });
      checks(out);
      expect(out).toContain('blue');
      expect(out).toContain('--ok: #fff');
    }
  });

  it('tailwind', () => {
    const out = exportTailwind(dirtyDoc());
    checks(out);
    expect(out).toContain('--ok: #fff');
  });

  it('react (tailwind and inline)', () => {
    for (const styles of ['tailwind', 'inline'] as const) {
      const r = exportReact(dirtyDoc(), { nodeId: 'fr_dirt0001', styles });
      checks(r.code + (r.css ?? ''));
    }
  });

  it('svg (fallback)', () => {
    checks(exportSvg(dirtyDoc(), { nodeId: 'fr_dirt0001' }));
  });
});

describe('-- prefix of tokens', () => {
  it('parseDocument adds the prefix and keeps those that already have it', () => {
    const raw = structuredClone(landingRaw) as { tokens: Record<string, string> };
    raw.tokens = { primary: '#6c5ce7', '--color-bg': '#000', ' space ': '1' };
    const doc = parseDocument(raw);
    expect(doc.tokens).toEqual({ '--primary': '#6c5ce7', '--color-bg': '#000', '--space': '1' });
    // stable round-trip
    expect(parseDocument(serializeDocument(doc)).tokens).toEqual(doc.tokens);
  });

  it('setTokens adds the prefix in set and in unset', () => {
    const doc = parseDocument(landingRaw);
    const a = applyOp(doc, { type: 'setTokens', set: { accent: '#f0f', '--ok': '1' } });
    expect(a.doc.tokens.accent).toBeUndefined();
    expect(a.doc.tokens['--accent']).toBe('#f0f');
    expect(a.doc.tokens['--ok']).toBe('1');
    const b = applyOp(a.doc, { type: 'setTokens', unset: ['accent'] });
    expect(b.doc.tokens['--accent']).toBeUndefined();
    // the inverse restores the previous state
    const back = applyOp(b.doc, b.inverse[0]);
    expect(back.doc.tokens['--accent']).toBe('#f0f');
  });

  it('setTokens rejects an invalid name and a dangerous value', () => {
    const doc = parseDocument(landingRaw);
    expect(() => applyOp(doc, { type: 'setTokens', set: { 'a b': '1' } })).toThrow(/token/);
    expect(() => applyOp(doc, { type: 'setTokens', set: { '--x': 'red; } a {' } })).toThrow(
      /invalid value/i,
    );
  });
});

describe('fonts: injection via family, style and file', () => {
  const lines = (fonts: unknown[]): Document => {
    const doc = createDocument('Fonts');
    doc.fonts = fonts as Document['fonts'];
    return doc;
  };

  it('FontRefSchema rejects dangerous family, style and file', () => {
    const base = { family: 'Inter', source: 'file', files: ['fonts/a.woff2'] };
    const parse = (f: unknown) => FontRefSchema.safeParse(f).success;
    expect(parse(base)).toBe(true);
    expect(parse({ ...base, family: 'X</style><script>alert(1)</script>' })).toBe(false);
    expect(parse({ ...base, styles: ['italic;}body{'] })).toBe(false);
    expect(parse({ ...base, files: ['../x.woff2'] })).toBe(false);
    expect(parse({ ...base, files: ['fonts/a.woff2");}</style>'] })).toBe(false);
    expect(parse({ ...base, files: ['/etc/x.woff2'] })).toBe(false);
    expect(parse({ ...base, weights: [0] })).toBe(false);
    expect(parse({ ...base, weights: [400.5] })).toBe(false);
    expect(parse({ ...base, styles: ['oblique'], weights: [1000] })).toBe(true);
  });

  it('parseDocument drops only the dangerous font and opens the document', () => {
    const raw = JSON.parse(serializeDocument(createDocument('F'))) as Record<string, unknown>;
    raw.fonts = [
      { family: 'A</style><script>', source: 'file', files: ['fonts/a.woff2'] },
      { family: 'B', source: 'file', files: ['../x.woff2'] },
      { family: 'Inter', source: 'file', files: ['fonts/inter.woff2'], weights: [400] },
    ];
    const doc = parseDocument(JSON.stringify(raw));
    expect(doc.fonts.map((f) => f.family)).toEqual(['Inter']);
  });

  it('setFonts still rejects a dangerous font', () => {
    const doc = createDocument('F');
    expect(() =>
      applyOp(doc, {
        type: 'setFonts',
        fonts: [{ family: 'A</style>', source: 'file', files: ['fonts/a.woff2'] }],
      }),
    ).toThrow();
  });

  it('fontFaceCss drops invalid entries (defense in depth)', () => {
    const css = fontFaceCss(
      lines([
        { family: 'A</style><script>', source: 'file', files: ['fonts/a.woff2'] },
        {
          family: 'B',
          source: 'file',
          files: ['../x.woff2', 'fonts/ok.woff2'],
          styles: ['italic;}body{', 'italic'],
        },
        { family: 'C', source: 'file', files: ['fonts/c.woff2'], styles: ['italic;}body{'] },
      ]),
      (f) => `assets/${f}`,
    );
    expect(css).not.toMatch(/<|body\{|script|\.\./);
    expect(css).toContain('font-family:"B"');
    expect(css).toContain('font-family:"C"');
    expect(css).toContain('font-style:normal');
    expect(css).not.toContain('font-family:"A');
  });

  it('the SVG <style> is escaped and the data URL survives', () => {
    const doc = lines([{ family: 'Inter', source: 'file', files: ['fonts/a.woff2'] }]);
    doc.pages[0]!.frames.push(
      createNode({ tag: 'div', type: 'frame', id: 'fr_x0000001', name: 'F' }),
    );
    const svg = exportSvg(doc, {
      nodeId: 'fr_x0000001',
      layout: {
        id: 'fr_x0000001',
        type: 'frame',
        x: 0,
        y: 0,
        width: 10,
        height: 10,
        style: {},
        children: [],
      } as never,
      resolveImage: () => 'data:font/woff2;base64,Zm9v',
    });
    expect(svg).toContain('data:font/woff2;base64,Zm9v');
    expect(svg).toContain('font-family:"Inter"');
    expect(svg.match(/<style>/g)).toHaveLength(1);
  });
});
