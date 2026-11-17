import { describe, expect, it } from 'vitest';
import { applyOps } from '../apply.js';
import { createDocument } from '../document.js';
import { planImportTokens } from '../tokens.js';
import type { Document } from '../types.js';
import {
  exportTokens,
  parseTokens,
  parseTokensCss,
  parseTokensJson,
  tokensToDtcg,
} from './tokens.js';

function docWith(extra: Partial<Pick<Document, 'tokens' | 'tokenMeta' | 'themes'>>): Document {
  return Object.assign(createDocument('Test', { id: 'doc_test0001' }), extra);
}

const system = (): Document =>
  docWith({
    tokens: {
      '--color-primary': '#6c5ce7',
      '--color-surface': 'var(--color-primary)',
      '--space-4': '16px',
      '--radius': '12px',
      '--shadow-md': '0 1px 2px rgba(0,0,0,.2)',
      '--font-sans': 'Inter, sans-serif',
      '--brand': 'oklch(0.6 0.2 250)',
    },
    tokenMeta: {
      '--color-primary': { description: 'Brand color' },
      '--brand': { group: 'brand' },
    },
    themes: [{ name: 'dark', overrides: { '--color-primary': '#a29bfe' } }],
  });

describe('exportTokens', () => {
  it('css: :root and the theme rule with the dependent tokens', () => {
    expect(exportTokens(system(), 'css')).toBe(`:root {
  --color-primary: #6c5ce7;
  --color-surface: var(--color-primary);
  --space-4: 16px;
  --radius: 12px;
  --shadow-md: 0 1px 2px rgba(0,0,0,.2);
  --font-sans: Inter, sans-serif;
  --brand: oklch(0.6 0.2 250);
}
[data-theme="dark"] {
  --color-surface: var(--color-primary);
  --color-primary: #a29bfe;
}
`);
  });

  it('json: nested DTCG with $type, description, group and themes', () => {
    const json = JSON.parse(exportTokens(system(), 'json'));
    expect(json.color.primary).toEqual({
      $type: 'color',
      $value: '#6c5ce7',
      $description: 'Brand color',
      $extensions: {
        'mockup-studio': { group: 'color', themes: { dark: '#a29bfe' } },
      },
    });
    // alias becomes {a.b}
    expect(json.color.surface.$value).toBe('{color.primary}');
    expect(json.color.surface.$type).toBeUndefined();
    expect(json.space['4']).toMatchObject({ $type: 'dimension', $value: '16px' });
    expect(json.font.sans.$value).toBe('Inter, sans-serif');
    expect(json.shadow.md.$value).toBe('0 1px 2px rgba(0,0,0,.2)');
    expect(json.brand.$extensions['mockup-studio'].group).toBe('brand');
    expect(json.$extensions['mockup-studio'].themes).toEqual(['dark']);
  });

  it('json: a name that is a prefix of another becomes a group with $root', () => {
    const doc = docWith({ tokens: { '--color': '#000', '--color-a': '#fff' } });
    const json = tokensToDtcg(doc) as Record<string, Record<string, unknown>>;
    expect(json.color.$root).toBeDefined();
    expect(json.color.a).toBeDefined();
    // and goes back to the same names
    const back = parseTokensJson(json);
    expect(back.tokens).toEqual({ '--color': '#000', '--color-a': '#fff' });
  });

  it('tailwind: @theme, :root, theme rule and @custom-variant', () => {
    const css = exportTokens(system(), 'tailwind');
    expect(css).toMatch(/@theme \{[^}]*--color-primary: #6c5ce7;[^}]*\}/);
    expect(css).toMatch(/:root \{[^}]*--brand: oklch/);
    expect(css).toContain('[data-theme="dark"] {');
    expect(css).toContain(
      '@custom-variant theme-dark (&:where([data-theme="dark"], [data-theme="dark"] *));',
    );
    expect(css).toContain('@custom-variant dark ');
  });

  it('without tokens exports only the line break', () => {
    expect(exportTokens(docWith({ tokens: {} }), 'css')).toBe('\n');
  });
});

describe('round-trip', () => {
  it('JSON → doc → JSON', () => {
    const doc = system();
    const json = exportTokens(doc, 'json');
    const set = parseTokensJson(json);
    expect(set.warnings).toEqual([]);
    const out = applyOps(
      docWith({ tokens: {} }),
      planImportTokens(docWith({ tokens: {} }), set, 'replace'),
    ).doc;
    expect(out.tokens).toEqual(doc.tokens);
    expect(out.tokenMeta).toEqual(doc.tokenMeta);
    expect(out.themes).toEqual(doc.themes);
    expect(exportTokens(out, 'json')).toBe(json);
  });

  it('CSS → doc: tokens and themes, without redundant redeclarations', () => {
    const doc = system();
    const set = parseTokensCss(exportTokens(doc, 'css'));
    expect(set.tokens).toEqual(doc.tokens);
    // --color-surface redeclared in the theme with the same base value is dropped
    expect(set.themes).toEqual(doc.themes);
  });

  it('importing in merge mode keeps what exists and merges themes', () => {
    const base = docWith({
      tokens: { '--a': '1px', '--b': '2px' },
      themes: [{ name: 'dark', overrides: { '--a': '3px' } }],
    });
    const set = parseTokensCss(':root { --b: 5px; --c: 6px } [data-theme=dark] { --c: 7px }');
    const out = applyOps(base, planImportTokens(base, set)).doc;
    expect(out.tokens).toEqual({ '--a': '1px', '--b': '5px', '--c': '6px' });
    expect(out.themes![0].overrides).toEqual({ '--a': '3px', '--c': '7px' });
  });
});

describe('parseTokensJson (DTCG)', () => {
  it('nested groups with inherited $type and aliases', () => {
    const set = parseTokensJson({
      color: {
        $type: 'color',
        brand: {
          primary: { $value: '#ff0000', $description: 'Main' },
          secondary: { $value: '{color.brand.primary}' },
        },
      },
      space: { $type: 'dimension', sm: { $value: '4px' }, md: { $value: '8px' } },
    });
    expect(set.tokens).toEqual({
      '--color-brand-primary': '#ff0000',
      '--color-brand-secondary': 'var(--color-brand-primary)',
      '--space-sm': '4px',
      '--space-md': '8px',
    });
    expect(set.tokenMeta['--color-brand-primary']).toEqual({ description: 'Main' });
  });

  it('dimension as a {value, unit} object and a number', () => {
    const set = parseTokensJson({
      a: { $type: 'dimension', $value: { value: 1.5, unit: 'rem' } },
      b: { $type: 'dimension', $value: 12 },
    });
    expect(set.tokens).toEqual({ '--a': '1.5rem', '--b': '12px' });
  });

  it('color as a {colorSpace, components, alpha} object', () => {
    const set = parseTokensJson({
      a: { $type: 'color', $value: { colorSpace: 'srgb', components: [1, 0, 0] } },
      b: {
        $type: 'color',
        $value: { colorSpace: 'oklch', components: [0.5, 0.2, 200], alpha: 0.5 },
      },
      c: { $type: 'color', $value: { colorSpace: 'srgb', components: [0, 0, 0], hex: '#000000' } },
    });
    expect(set.tokens['--a']).toBe('color(srgb 1 0 0)');
    expect(set.tokens['--b']).toBe('oklch(0.5 0.2 200 / 0.5)');
    expect(set.tokens['--c']).toBe('#000000');
  });

  it('composite shadow (object and list)', () => {
    const set = parseTokensJson({
      s1: {
        $type: 'shadow',
        $value: {
          color: '#00000033',
          offsetX: { value: 0, unit: 'px' },
          offsetY: { value: 4, unit: 'px' },
          blur: { value: 8, unit: 'px' },
          spread: { value: 0, unit: 'px' },
        },
      },
      s2: {
        $type: 'shadow',
        $value: [
          { color: '#000', offsetX: 0, offsetY: 1, blur: 2, spread: 0, inset: true },
          { color: '#111', offsetX: 0, offsetY: 2, blur: 4, spread: 1 },
        ],
      },
    });
    expect(set.tokens['--s1']).toBe('0px 4px 8px 0px #00000033');
    expect(set.tokens['--s2']).toBe('inset 0px 1px 2px 0px #000, 0px 2px 4px 1px #111');
    expect(set.tokenMeta['--s1']).toBeUndefined();
  });

  it('composite typography becomes several tokens', () => {
    const set = parseTokensJson({
      heading: {
        $type: 'typography',
        $value: {
          fontFamily: ['Inter', 'Helvetica Neue', 'sans-serif'],
          fontSize: { value: 24, unit: 'px' },
          fontWeight: 700,
          lineHeight: 1.2,
          letterSpacing: { value: 0.5, unit: 'px' },
        },
      },
    });
    expect(set.tokens).toEqual({
      '--heading-font-family': 'Inter, "Helvetica Neue", sans-serif',
      '--heading-font-size': '24px',
      '--heading-font-weight': '700',
      '--heading-line-height': '1.2',
      '--heading-letter-spacing': '0.5px',
    });
    expect(set.tokenMeta['--heading-font-size']).toEqual({ group: 'typography' });
  });

  it('accepts values without $ (Tokens Studio)', () => {
    const set = parseTokensJson({ color: { red: { value: '#f00', type: 'color' } } });
    expect(set.tokens).toEqual({ '--color-red': '#f00' });
  });

  it('a dangerous value is dropped with a warning and an invalid name is ignored', () => {
    const set = parseTokensJson({
      ok: { $value: '1px' },
      bad: { $value: 'red; } body { x: y' },
      'a b': { $value: '1px' },
    });
    expect(set.tokens).toEqual({ '--ok': '1px' });
    expect(set.warnings.length).toBe(2);
  });

  it('errors: malformed JSON, non-object and no tokens', () => {
    expect(() => parseTokensJson('{ nope')).toThrow(/Malformed JSON/);
    expect(() => parseTokensJson('[1]')).toThrow(/object/);
    expect(() => parseTokensJson({ group: { $description: 'x' } })).toThrow(/No tokens/);
  });
});

describe('parseTokensCss', () => {
  it('reads :root, theme selectors and @theme', () => {
    const set = parseTokensCss(`
      :root { --a: 1px; --b: #fff }
      [data-theme=dark] { --b: #000 }
      .light { --b: #eee }
      :root.theme-sepia { --b: #ccc }
      @theme { --color-x: red; }
    `);
    expect(set.tokens).toEqual({ '--a': '1px', '--b': '#fff', '--color-x': 'red' });
    const byName = Object.fromEntries(set.themes.map((t) => [t.name, t.overrides]));
    expect(byName).toEqual({
      dark: { '--b': '#000' },
      light: { '--b': '#eee' },
      sepia: { '--b': '#ccc' },
    });
    expect(set.warnings).toEqual([]);
  });

  it('.dark selector and quoted selector', () => {
    const set = parseTokensCss(':root{--a:1px} .dark{--a:2px} [data-theme="x"]{--a:3px}');
    expect(set.themes.map((t) => t.name)).toEqual(['dark', 'x']);
  });

  it('@media (prefers-color-scheme: dark) becomes the dark theme', () => {
    const set = parseTokensCss(`
      :root { --bg: white }
      @media (prefers-color-scheme: dark) { :root { --bg: black } }
    `);
    expect(set.tokens).toEqual({ '--bg': 'white' });
    expect(set.themes).toEqual([{ name: 'dark', overrides: { '--bg': 'black' } }]);
  });

  it('an ignored rule becomes a warning', () => {
    const set = parseTokensCss(
      ':root { --a: 1px } .card > p { --b: 2px } @media print { :root { --c: 1px } }',
    );
    expect(set.tokens).toEqual({ '--a': '1px' });
    expect(set.warnings.some((w) => w.includes('.card>p'))).toBe(true);
    expect(set.warnings.some((w) => w.includes('@media'))).toBe(true);
  });

  it('a dangerous value is dropped', () => {
    const set = parseTokensCss(':root { --a: 1px; --c: x</style><script> }');
    expect(set.tokens['--a']).toBe('1px');
    expect('--c' in set.tokens).toBe(false);
    expect(set.warnings.some((w) => w.includes('--c'))).toBe(true);
  });

  it('error when there are no tokens', () => {
    expect(() => parseTokensCss('body { color: red }')).toThrow(/No tokens/);
    expect(() => parseTokensCss('')).toThrow(/No tokens/);
  });
});

describe('parseTokens', () => {
  it('detects the format', () => {
    expect(parseTokens('{"a":{"$value":"1px"}}').tokens).toEqual({ '--a': '1px' });
    expect(parseTokens(':root { --a: 1px }').tokens).toEqual({ '--a': '1px' });
    expect(parseTokens('{"a":{"$value":"1px"}}', 'json').tokens).toEqual({ '--a': '1px' });
  });
});

describe('import/export review', () => {
  it('json: a theme-only token survives the round-trip', () => {
    const doc = docWith({
      tokens: { '--color-primary': '#111111' },
      tokenMeta: { '--color-accent': { description: 'Dark only' } },
      themes: [{ name: 'dark', overrides: { '--color-accent': '#ff00ff' } }],
    });
    const out = parseTokensJson(exportTokens(doc, 'json'));
    expect(out.tokens).toEqual({ '--color-primary': '#111111' });
    expect(out.tokens).not.toHaveProperty('--color-accent');
    expect(out.themes.find((t) => t.name === 'dark')?.overrides).toEqual({
      '--color-accent': '#ff00ff',
    });
    expect(out.tokenMeta['--color-accent']?.description).toBe('Dark only');
  });

  it('json: an invalid group, a long description and one with tabs do not break the import', () => {
    const set = parseTokensJson({
      a: {
        $value: '1px',
        $extensions: { 'mockup-studio': { group: 'Brand!' } },
      },
      b: { $value: '2px', $description: 'x'.repeat(600) },
      c: { $value: '3px', $description: 'line\twith\ttab\nsecond' },
    });
    expect(set.tokens).toEqual({ '--a': '1px', '--b': '2px', '--c': '3px' });
    expect(set.tokenMeta['--a']?.group).toBeUndefined();
    expect(set.warnings.some((w) => w.includes('group "Brand!" ignored'))).toBe(true);
    expect(set.tokenMeta['--b']?.description).toHaveLength(500);
    expect(set.tokenMeta['--c']?.description).toBe('line with tab\nsecond');
    expect(() => planImportTokens(docWith({}), set, 'merge')).not.toThrow();
  });

  it('json: meta with a wrong type drops only the meta, with a warning', () => {
    const set = parseTokensJson({
      a: { $value: '1px', $extensions: { 'mockup-studio': { group: 123 } } },
      b: { $value: '2px', $description: { x: 1 } },
      c: { $value: '#fff', $extensions: { 'mockup-studio': { themes: ['#000'] } } },
      d: { $value: '4px', $description: 'ok' },
    });
    expect(set.tokens).toEqual({ '--a': '1px', '--b': '2px', '--c': '#fff', '--d': '4px' });
    expect(set.tokenMeta['--a']).toBeUndefined();
    expect(set.tokenMeta['--b']).toBeUndefined();
    expect(set.tokenMeta['--d']?.description).toBe('ok');
    expect(set.themes).toEqual([]);
    expect(set.warnings).toEqual([
      '--a: $extensions["mockup-studio"].group ignored (must be text; got 123)',
      '--b: $description ignored (must be text; got {"x":1})',
      '--c: $extensions["mockup-studio"].themes ignored (must be an object of theme → value; got ["#000"])',
    ]);
  });

  it('css: reads @layer base (shadcn format), with nested @media', () => {
    const set = parseTokensCss(`@layer base {
      :root { --background: 0 0% 100%; }
      .dark { --background: 222 84% 5%; }
      @media (prefers-color-scheme: light) { :root { --fg: #000; } }
    }
    @media (prefers-color-scheme: dark) { @layer x { :root { --fg: #fff; } } }`);
    expect(set.tokens['--background']).toBe('0 0% 100%');
    expect(set.themes.find((t) => t.name === 'dark')?.overrides).toEqual({
      '--background': '222 84% 5%',
      '--fg': '#fff',
    });
    expect(set.themes.find((t) => t.name === 'light')?.overrides['--fg']).toBe('#000');
  });

  it('css: only known theme selectors become a theme', () => {
    const bad = parseTokensCss(':root { --a: 1px } .button { --x: 1px }');
    expect(bad.themes).toEqual([]);
    expect(bad.warnings.some((w) => w.includes('Rule ignored'))).toBe(true);
    const set = parseTokensCss(`:root { --a: 1px }
      .dark { --a: 2px } .theme-sepia { --a: 3px } html.light { --a: 4px }
      [data-theme="x"] { --a: 5px }`);
    expect(Object.fromEntries(set.themes.map((t) => [t.name, t.overrides['--a']]))).toEqual({
      dark: '2px',
      sepia: '3px',
      light: '4px',
      x: '5px',
    });
  });

  it('remote url() produces a warning (css and json, base and theme)', () => {
    const css = parseTokensCss(
      `:root { --bg-image: url("https://x.com/a.png") } .dark { --bg-image: URL(//cdn.x/b.png) } :root { --local: url(a.png) }`,
    );
    expect(css.warnings.filter((w) => w.includes('remote url()'))).toHaveLength(2);
    expect(
      css.warnings.some((w) => w.includes('--bg-image uses a remote url() (https://x.com/a.png)')),
    ).toBe(true);
    const json = parseTokensJson({
      bgImage: {
        $value: 'url(https://x.com/a.png)',
        $extensions: { 'mockup-studio': { themes: { dark: "url('http://x.com/b.png')" } } },
      },
    });
    expect(json.warnings.filter((w) => w.includes('remote url()'))).toHaveLength(2);
    expect(json.tokens['--bgImage']).toBe('url(https://x.com/a.png)');
  });
});
