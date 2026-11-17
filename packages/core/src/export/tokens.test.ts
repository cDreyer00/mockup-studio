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
  return Object.assign(createDocument('Teste', { id: 'doc_test0001' }), extra);
}

const sistema = (): Document =>
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
      '--color-primary': { description: 'Cor da marca' },
      '--brand': { group: 'marca' },
    },
    themes: [{ name: 'dark', overrides: { '--color-primary': '#a29bfe' } }],
  });

describe('exportTokens', () => {
  it('css: :root e regra do tema com os tokens dependentes', () => {
    expect(exportTokens(sistema(), 'css')).toBe(`:root {
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

  it('json: DTCG aninhado com $type, descrição, grupo e temas', () => {
    const json = JSON.parse(exportTokens(sistema(), 'json'));
    expect(json.color.primary).toEqual({
      $type: 'color',
      $value: '#6c5ce7',
      $description: 'Cor da marca',
      $extensions: {
        'mockup-studio': { group: 'color', themes: { dark: '#a29bfe' } },
      },
    });
    // alias vira {a.b}
    expect(json.color.surface.$value).toBe('{color.primary}');
    expect(json.color.surface.$type).toBeUndefined();
    expect(json.space['4']).toMatchObject({ $type: 'dimension', $value: '16px' });
    expect(json.font.sans.$value).toBe('Inter, sans-serif');
    expect(json.shadow.md.$value).toBe('0 1px 2px rgba(0,0,0,.2)');
    expect(json.brand.$extensions['mockup-studio'].group).toBe('marca');
    expect(json.$extensions['mockup-studio'].themes).toEqual(['dark']);
  });

  it('json: nome que é prefixo de outro vira grupo com $root', () => {
    const doc = docWith({ tokens: { '--color': '#000', '--color-a': '#fff' } });
    const json = tokensToDtcg(doc) as Record<string, Record<string, unknown>>;
    expect(json.color.$root).toBeDefined();
    expect(json.color.a).toBeDefined();
    // e volta para os mesmos nomes
    const back = parseTokensJson(json);
    expect(back.tokens).toEqual({ '--color': '#000', '--color-a': '#fff' });
  });

  it('tailwind: @theme, :root, regra do tema e @custom-variant', () => {
    const css = exportTokens(sistema(), 'tailwind');
    expect(css).toMatch(/@theme \{[^}]*--color-primary: #6c5ce7;[^}]*\}/);
    expect(css).toMatch(/:root \{[^}]*--brand: oklch/);
    expect(css).toContain('[data-theme="dark"] {');
    expect(css).toContain(
      '@custom-variant theme-dark (&:where([data-theme="dark"], [data-theme="dark"] *));',
    );
    expect(css).toContain('@custom-variant dark ');
  });

  it('sem tokens exporta só a quebra de linha', () => {
    expect(exportTokens(docWith({ tokens: {} }), 'css')).toBe('\n');
  });
});

describe('round-trip', () => {
  it('JSON → doc → JSON', () => {
    const doc = sistema();
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

  it('CSS → doc: tokens e temas, sem redeclarações redundantes', () => {
    const doc = sistema();
    const set = parseTokensCss(exportTokens(doc, 'css'));
    expect(set.tokens).toEqual(doc.tokens);
    // --color-surface redeclarado no tema com o mesmo valor base é descartado
    expect(set.themes).toEqual(doc.themes);
  });

  it('importar em modo merge mantém o que existe e mescla temas', () => {
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
  it('grupos aninhados com $type herdado e aliases', () => {
    const set = parseTokensJson({
      color: {
        $type: 'color',
        brand: {
          primary: { $value: '#ff0000', $description: 'Principal' },
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
    expect(set.tokenMeta['--color-brand-primary']).toEqual({ description: 'Principal' });
  });

  it('dimensão como objeto {value, unit} e número', () => {
    const set = parseTokensJson({
      a: { $type: 'dimension', $value: { value: 1.5, unit: 'rem' } },
      b: { $type: 'dimension', $value: 12 },
    });
    expect(set.tokens).toEqual({ '--a': '1.5rem', '--b': '12px' });
  });

  it('cor como objeto {colorSpace, components, alpha}', () => {
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

  it('sombra composta (objeto e lista)', () => {
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

  it('tipografia composta vira vários tokens', () => {
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

  it('aceita valores sem $ (Tokens Studio)', () => {
    const set = parseTokensJson({ color: { red: { value: '#f00', type: 'color' } } });
    expect(set.tokens).toEqual({ '--color-red': '#f00' });
  });

  it('valor perigoso é descartado com aviso e nome inválido é ignorado', () => {
    const set = parseTokensJson({
      ok: { $value: '1px' },
      mau: { $value: 'red; } body { x: y' },
      'a b': { $value: '1px' },
    });
    expect(set.tokens).toEqual({ '--ok': '1px' });
    expect(set.warnings.length).toBe(2);
  });

  it('erros: JSON malformado, não-objeto e sem tokens', () => {
    expect(() => parseTokensJson('{ nope')).toThrow(/JSON malformado/);
    expect(() => parseTokensJson('[1]')).toThrow(/objeto/);
    expect(() => parseTokensJson({ grupo: { $description: 'x' } })).toThrow(/Nenhum token/);
  });
});

describe('parseTokensCss', () => {
  it('lê :root, seletores de tema e @theme', () => {
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

  it('seletor .dark e seletor com aspas', () => {
    const set = parseTokensCss(':root{--a:1px} .dark{--a:2px} [data-theme="x"]{--a:3px}');
    expect(set.themes.map((t) => t.name)).toEqual(['dark', 'x']);
  });

  it('@media (prefers-color-scheme: dark) vira o tema dark', () => {
    const set = parseTokensCss(`
      :root { --bg: white }
      @media (prefers-color-scheme: dark) { :root { --bg: black } }
    `);
    expect(set.tokens).toEqual({ '--bg': 'white' });
    expect(set.themes).toEqual([{ name: 'dark', overrides: { '--bg': 'black' } }]);
  });

  it('regra ignorada vira aviso', () => {
    const set = parseTokensCss(
      ':root { --a: 1px } .card > p { --b: 2px } @media print { :root { --c: 1px } }',
    );
    expect(set.tokens).toEqual({ '--a': '1px' });
    expect(set.warnings.some((w) => w.includes('.card>p'))).toBe(true);
    expect(set.warnings.some((w) => w.includes('@media'))).toBe(true);
  });

  it('valor perigoso é descartado', () => {
    const set = parseTokensCss(':root { --a: 1px; --c: x</style><script> }');
    expect(set.tokens['--a']).toBe('1px');
    expect('--c' in set.tokens).toBe(false);
    expect(set.warnings.some((w) => w.includes('--c'))).toBe(true);
  });

  it('erro quando não há tokens', () => {
    expect(() => parseTokensCss('body { color: red }')).toThrow(/Nenhum token/);
    expect(() => parseTokensCss('')).toThrow(/Nenhum token/);
  });
});

describe('parseTokens', () => {
  it('detecta o formato', () => {
    expect(parseTokens('{"a":{"$value":"1px"}}').tokens).toEqual({ '--a': '1px' });
    expect(parseTokens(':root { --a: 1px }').tokens).toEqual({ '--a': '1px' });
    expect(parseTokens('{"a":{"$value":"1px"}}', 'json').tokens).toEqual({ '--a': '1px' });
  });
});

describe('revisão de import/export', () => {
  it('json: token só de tema sobrevive ao round-trip', () => {
    const doc = docWith({
      tokens: { '--color-primary': '#111111' },
      tokenMeta: { '--color-accent': { description: 'Só no escuro' } },
      themes: [{ name: 'dark', overrides: { '--color-accent': '#ff00ff' } }],
    });
    const out = parseTokensJson(exportTokens(doc, 'json'));
    expect(out.tokens).toEqual({ '--color-primary': '#111111' });
    expect(out.tokens).not.toHaveProperty('--color-accent');
    expect(out.themes.find((t) => t.name === 'dark')?.overrides).toEqual({
      '--color-accent': '#ff00ff',
    });
    expect(out.tokenMeta['--color-accent']?.description).toBe('Só no escuro');
  });

  it('json: grupo inválido, descrição longa e com tab não derrubam o import', () => {
    const set = parseTokensJson({
      a: {
        $value: '1px',
        $extensions: { 'mockup-studio': { group: 'Marca!' } },
      },
      b: { $value: '2px', $description: 'x'.repeat(600) },
      c: { $value: '3px', $description: 'linha\tcom\ttab\nsegunda' },
    });
    expect(set.tokens).toEqual({ '--a': '1px', '--b': '2px', '--c': '3px' });
    expect(set.tokenMeta['--a']?.group).toBeUndefined();
    expect(set.warnings.some((w) => w.includes('grupo "Marca!" ignorado'))).toBe(true);
    expect(set.tokenMeta['--b']?.description).toHaveLength(500);
    expect(set.tokenMeta['--c']?.description).toBe('linha com tab\nsegunda');
    expect(() => planImportTokens(docWith({}), set, 'merge')).not.toThrow();
  });

  it('json: meta com tipo errado descarta só o meta, com aviso', () => {
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
      '--a: $extensions["mockup-studio"].group ignorado (deve ser texto; veio 123)',
      '--b: $description ignorado (deve ser texto; veio {"x":1})',
      '--c: $extensions["mockup-studio"].themes ignorado (deve ser um objeto tema → valor; veio ["#000"])',
    ]);
  });

  it('css: lê @layer base (formato shadcn), com @media aninhado', () => {
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

  it('css: só seletores de tema conhecidos viram tema', () => {
    const ruim = parseTokensCss(':root { --a: 1px } .button { --x: 1px }');
    expect(ruim.themes).toEqual([]);
    expect(ruim.warnings.some((w) => w.includes('Regra ignorada'))).toBe(true);
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

  it('url() remoto gera aviso (css e json, base e tema)', () => {
    const css = parseTokensCss(
      `:root { --bg-image: url("https://x.com/a.png") } .dark { --bg-image: URL(//cdn.x/b.png) } :root { --local: url(a.png) }`,
    );
    expect(css.warnings.filter((w) => w.includes('url() remoto'))).toHaveLength(2);
    expect(
      css.warnings.some((w) => w.includes('--bg-image usa url() remoto (https://x.com/a.png)')),
    ).toBe(true);
    const json = parseTokensJson({
      bgImage: {
        $value: 'url(https://x.com/a.png)',
        $extensions: { 'mockup-studio': { themes: { dark: "url('http://x.com/b.png')" } } },
      },
    });
    expect(json.warnings.filter((w) => w.includes('url() remoto'))).toHaveLength(2);
    expect(json.tokens['--bgImage']).toBe('url(https://x.com/a.png)');
  });
});
