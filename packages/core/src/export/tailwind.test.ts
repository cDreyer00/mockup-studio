import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseDocument } from '../schema.js';
import { createNodeFromTag } from '../document.js';
import {
  cssToTailwind,
  exportTailwind,
  tailwindNodeParts,
  tailwindThemeCss,
} from './tailwind.js';

const landing = parseDocument(
  fs.readFileSync(new URL('../../../../examples/landing.mockup.json', import.meta.url), 'utf8'),
);

const TOKENS = {
  '--color-primary': '#6c5ce7',
  '--color-bg': '#0f1115',
  '--radius-card': '14px',
  '--radius': '12px',
  '--font-sans': 'Inter, sans-serif',
  '--font': 'Inter, system-ui, sans-serif',
  '--shadow-soft': '0 2px 8px rgba(0,0,0,0.2)',
  '--spacing-gutter': '28px',
  '--text-hero': '56px',
  '--font-weight-heavy': '850',
};

/** [nome, css, classes esperadas] */
type Case = [string, Record<string, string>, string[]];

const cases: Case[] = [
  // layout
  ['flex em coluna', { display: 'flex', 'flex-direction': 'column' }, ['flex', 'flex-col']],
  [
    'alinhamento e wrap',
    {
      'align-items': 'center',
      'justify-content': 'space-between',
      'flex-wrap': 'wrap',
      'align-self': 'flex-end',
    },
    ['items-center', 'justify-between', 'flex-wrap', 'self-end'],
  ],
  ['flex: 1', { flex: '1' }, ['flex-1']],
  ['flex longhands', { 'flex-grow': '1', 'flex-shrink': '0' }, ['grow', 'shrink-0']],
  ['flex arbitrário', { flex: '2 1 30%' }, ['flex-[2_1_30%]']],
  ['display none', { display: 'none' }, ['hidden']],
  [
    'grid repeat',
    { display: 'grid', 'grid-template-columns': 'repeat(3, 1fr)' },
    ['grid', 'grid-cols-3'],
  ],
  ['grid arbitrário', { 'grid-template-columns': '200px 1fr 2fr' }, ['grid-cols-[200px_1fr_2fr]']],
  // espaçamento
  ['gap na escala', { gap: '24px' }, ['gap-6']],
  ['gap duplo', { gap: '8px 16px' }, ['gap-y-2', 'gap-x-4']],
  ['padding 16px', { padding: '16px' }, ['p-4']],
  ['padding com meio passo', { padding: '6px' }, ['p-1.5']],
  ['padding vertical/horizontal', { padding: '20px 64px' }, ['py-5', 'px-16']],
  ['padding 3 valores', { padding: '32px 64px 96px' }, ['pt-8', 'pb-24', 'px-16']],
  ['padding fora da escala', { padding: '13px' }, ['p-[13px]']],
  ['padding-left longhand', { 'padding-left': '12px' }, ['pl-3']],
  ['margin auto horizontal', { margin: '0 auto' }, ['my-0', 'mx-auto']],
  ['margin negativo', { 'margin-top': '-8px' }, ['-mt-2']],
  ['1px', { 'padding-top': '1px' }, ['pt-px']],
  ['padding 0', { padding: '0' }, ['p-0']],
  ['padding em rem', { padding: '1rem' }, ['p-4']],
  // tamanhos
  ['largura/altura cheia', { width: '100%', height: '100%' }, ['size-full']],
  ['largura e altura iguais', { width: '40px', height: '40px' }, ['size-10']],
  ['largura grande arbitrária', { width: '1440px' }, ['w-[1440px]']],
  ['w auto', { width: 'auto' }, ['w-auto']],
  ['w-full e h-screen', { width: '100%', height: '100vh' }, ['w-full', 'h-screen']],
  ['fração', { width: '50%' }, ['w-1/2']],
  ['min-height', { 'min-height': '900px' }, ['min-h-[900px]']],
  ['max-width nomeado', { 'max-width': '448px' }, ['max-w-md']],
  ['max-width arbitrário', { 'max-width': '800px' }, ['max-w-[800px]']],
  ['max-width none', { 'max-width': 'none' }, ['max-w-none']],
  // tipografia
  ['font-size na escala', { 'font-size': '14px' }, ['text-sm']],
  ['font-size 128', { 'font-size': '128px' }, ['text-9xl']],
  ['font-size fora da escala', { 'font-size': '17px' }, ['text-[17px]']],
  ['font-weight', { 'font-weight': '700' }, ['font-bold']],
  ['font-weight palavra', { 'font-weight': 'bold' }, ['font-bold']],
  ['font-weight fora da escala', { 'font-weight': '550' }, ['font-[550]']],
  ['line-height nomeado', { 'line-height': '1.5' }, ['leading-normal']],
  ['line-height arbitrário', { 'line-height': '1.4' }, ['leading-[1.4]']],
  ['line-height em px', { 'line-height': '28px' }, ['leading-7']],
  ['letter-spacing nomeado', { 'letter-spacing': '0.05em' }, ['tracking-wider']],
  ['letter-spacing arbitrário', { 'letter-spacing': '2px' }, ['tracking-[2px]']],
  [
    'texto',
    {
      'text-align': 'center',
      'text-transform': 'uppercase',
      'font-style': 'italic',
      'text-decoration': 'underline',
      'white-space': 'pre-wrap',
    },
    ['text-center', 'uppercase', 'italic', 'underline', 'whitespace-pre-wrap'],
  ],
  ['sem decoração', { 'text-decoration': 'none' }, ['no-underline']],
  // cores
  ['cor hex', { 'background-color': '#6c5ce7' }, ['bg-[#6c5ce7]']],
  ['cor branca', { color: '#ffffff' }, ['text-white']],
  ['cor rgba', { 'background-color': 'rgba(0, 0, 0, 0.5)' }, ['bg-[rgba(0,0,0,0.5)]']],
  ['cor transparente', { background: 'transparent' }, ['bg-transparent']],
  ['cor nomeada', { color: 'red' }, ['text-[color:red]']],
  [
    'background shorthand com gradiente',
    { background: 'linear-gradient(90deg, #000, #fff)' },
    ['bg-[linear-gradient(90deg,#000,#fff)]'],
  ],
  // bordas e raio
  ['borda completa', { border: '1px solid #ccc' }, ['border', 'border-solid', 'border-[#ccc]']],
  [
    'borda 2px tracejada',
    { border: '2px dashed #000' },
    ['border-2', 'border-dashed', 'border-black'],
  ],
  ['borda superior', { 'border-top': '1px solid #eee' }, ['border-t', 'border-t-[#eee]']],
  ['borda none', { border: 'none' }, ['border-none']],
  ['border-width', { 'border-width': '4px' }, ['border-4']],
  ['radius nomeado', { 'border-radius': '8px' }, ['rounded-lg']],
  ['radius md', { 'border-radius': '6px' }, ['rounded-md']],
  ['radius full', { 'border-radius': '9999px' }, ['rounded-full']],
  ['radius arbitrário', { 'border-radius': '10px' }, ['rounded-[10px]']],
  [
    'radius por canto',
    { 'border-radius': '8px 8px 0 0' },
    ['rounded-tl-lg', 'rounded-tr-lg', 'rounded-br-none', 'rounded-bl-none'],
  ],
  ['radius longhand', { 'border-top-left-radius': '12px' }, ['rounded-tl-xl']],
  // sombra e afins
  [
    'sombra arbitrária',
    { 'box-shadow': '0 2px 4px rgba(0, 0, 0, 0.2)' },
    ['shadow-[0_2px_4px_rgba(0,0,0,0.2)]'],
  ],
  ['sombra none', { 'box-shadow': 'none' }, ['shadow-none']],
  ['opacity', { opacity: '0.5' }, ['opacity-50']],
  ['opacity fracionária', { opacity: '0.333' }, ['opacity-[0.333]']],
  [
    'overflow',
    { overflow: 'hidden', 'overflow-y': 'auto' },
    ['overflow-hidden', 'overflow-y-auto'],
  ],
  // posição
  [
    'position + offsets',
    { position: 'absolute', left: '12px', top: '0' },
    ['absolute', 'left-3', 'top-0'],
  ],
  ['inset 0', { inset: '0' }, ['inset-0']],
  ['offset arbitrário', { left: '13px' }, ['left-[13px]']],
  ['z-index', { 'z-index': '10' }, ['z-10']],
  ['z-index arbitrário', { 'z-index': '7' }, ['z-[7]']],
  [
    'object-fit e cursor',
    { 'object-fit': 'cover', cursor: 'pointer' },
    ['object-cover', 'cursor-pointer'],
  ],
  ['!important', { padding: '16px !important' }, ['p-4!']],
  // arbitrários
  ['transição', { transition: 'all 0.2s ease' }, ['[transition:all_0.2s_ease]']],
  [
    'propriedade sem equivalente',
    { 'backdrop-filter': 'blur(8px)' },
    ['[backdrop-filter:blur(8px)]'],
  ],
  ['custom property', { '--accent': '#f00' }, ['[--accent:#f00]']],
  ['underscore literal escapado', { content: '"a_b"' }, ['[content:"a\\_b"]']],
];

describe('cssToTailwind', () => {
  it.each(cases)('%s', (_name, style, expected) => {
    const { classes, rest } = cssToTailwind(style);
    expect([...classes].sort()).toEqual([...expected].sort());
    expect(rest).toEqual({});
  });

  describe('tokens', () => {
    const opts = { tokens: TOKENS };
    const t = (style: Record<string, string>): string[] => cssToTailwind(style, opts).classes;

    it('dentro de namespace de tema usam o nome curto', () => {
      expect(t({ 'background-color': 'var(--color-primary)' })).toEqual(['bg-primary']);
      expect(t({ color: 'var(--color-bg)' })).toEqual(['text-bg']);
      expect(t({ border: '1px solid var(--color-primary)' })).toEqual([
        'border',
        'border-solid',
        'border-primary',
      ]);
      expect(t({ 'border-radius': 'var(--radius-card)' })).toEqual(['rounded-card']);
      expect(t({ 'font-family': 'var(--font-sans)' })).toEqual(['font-sans']);
      expect(t({ 'box-shadow': 'var(--shadow-soft)' })).toEqual(['shadow-soft']);
      expect(t({ padding: 'var(--spacing-gutter)' })).toEqual(['p-gutter']);
      expect(t({ gap: 'var(--spacing-gutter)' })).toEqual(['gap-gutter']);
      expect(t({ 'font-size': 'var(--text-hero)' })).toEqual(['text-hero']);
      expect(t({ 'font-weight': 'var(--font-weight-heavy)' })).toEqual(['font-heavy']);
    });

    it('fora de namespace usam a sintaxe de variável do v4', () => {
      expect(t({ 'border-radius': 'var(--radius)' })).toEqual(['rounded-(--radius)']);
      expect(t({ 'font-family': 'var(--font)' })).toEqual(['font-(family-name:--font)']);
      expect(t({ background: 'var(--surface)' })).toEqual(['bg-(color:--surface)']);
      expect(t({ padding: 'var(--pad)' })).toEqual(['p-(--pad)']);
    });

    it('variável de outro namespace no lugar errado não vira nome curto', () => {
      expect(t({ 'background-color': 'var(--radius-card)' })).toEqual(['bg-(color:--radius-card)']);
    });

    it('token inexistente (quando a lista é dada) usa a sintaxe de variável', () => {
      expect(t({ color: 'var(--color-missing)' })).toEqual(['text-(color:--color-missing)']);
    });

    it('var com fallback vira valor arbitrário', () => {
      expect(t({ color: 'var(--x, #fff)' })).toEqual(['text-[color:var(--x,#fff)]']);
    });
  });

  it('valor inseguro para classe arbitrária fica em rest', () => {
    const { classes, rest } = cssToTailwind({ content: '"a<b"', color: '#fff' });
    expect(classes).toEqual(['text-white']);
    expect(rest).toEqual({ content: '"a<b"' });
  });

  it('propriedades herdadas de Object.prototype não quebram', () => {
    expect(() => cssToTailwind({ constructor: 'x', toString: 'y' })).not.toThrow();
  });
});

describe('tailwindThemeCss', () => {
  it('separa @theme, :root e @font-face', () => {
    const doc = parseDocument(
      JSON.stringify({
        ...landing,
        fonts: [{ family: 'Inter', source: 'file', files: ['fonts/i.woff2'], weights: [400] }],
      }),
    );
    const css = tailwindThemeCss(doc);
    expect(css.startsWith('@import "tailwindcss";')).toBe(true);
    expect(css).toMatch(/@theme \{[^}]*--color-primary: #6c5ce7;[^}]*\}/);
    expect(css).toContain(':root {\n  --radius: 12px;\n  --font: Inter, system-ui, sans-serif;\n}');
    expect(css).not.toMatch(/@theme \{[^}]*--radius:/);
    expect(css).toContain('@font-face{font-family:"Inter";src:url("assets/fonts/i.woff2")');
  });

  it('neutraliza o line-height padrão dos tamanhos text-* usados', () => {
    const css = tailwindThemeCss(landing);
    expect(css).toContain('--text-sm--line-height: inherit;');
    expect(css).not.toContain('--text-9xl--line-height');
  });

  it('sem import quando pedido', () => {
    expect(tailwindThemeCss(landing, { import: false })).not.toContain('@import');
  });
});

describe('exportTailwind', () => {
  it('snapshot do exemplo (documento completo)', () => {
    expect(exportTailwind(landing)).toMatchSnapshot();
  });

  it('inclui CDN e tema; cdn: false remove só o script', () => {
    const full = exportTailwind(landing, { nodeIds: ['fr_m0b10390'] });
    expect(full).toContain(
      '<script src="https://cdn.jsdelivr.net/npm/@tailwindcss/browser@4"></script>',
    );
    expect(full).toContain('<style type="text/tailwindcss">');
    expect(full).toContain('--color-primary: #6c5ce7;');
    const noCdn = exportTailwind(landing, { nodeIds: ['fr_m0b10390'], cdn: false });
    expect(noCdn).not.toContain('@tailwindcss/browser');
    expect(noCdn).toContain('<style type="text/tailwindcss">');
  });

  it('fragmento é só o markup', () => {
    const frag = exportTailwind(landing, { nodeIds: ['el_dsk00007'], fragment: true });
    expect(frag.startsWith('<header class="')).toBe(true);
    expect(frag).not.toContain('<style');
    expect(frag).not.toContain('<script');
  });

  it('usa nomes de tema e a sintaxe de variável do exemplo', () => {
    const frag = exportTailwind(landing, { nodeIds: ['el_dsk00007'], fragment: true });
    expect(frag).toContain('bg-surface');
    expect(frag).toContain('rounded-(--radius)');
    expect(frag).toContain('py-5 px-16');
  });
});

describe('propriedades sem classe equivalente e estados do nó', () => {
  it('propriedade alterada por um estado vai como classe arbitrária, não como style inline', () => {
    const node = createNodeFromTag('div', {
      styles: { 'scroll-snap-type': 'x mandatory', 'text-wrap': 'balance' },
    });
    node.states = { hover: { 'scroll-snap-type': 'none' } };
    const { classes, rest } = tailwindNodeParts(node, {});
    expect(rest).toEqual({});
    expect(classes).toContain('[scroll-snap-type:x_mandatory]');
    expect(classes).toContain('hover:[scroll-snap-type:none]');
  });

  it('valor que não vira classe arbitrária segura continua inline', () => {
    const node = createNodeFromTag('div', { styles: { 'font-feature-settings': '"a;b"' } });
    node.states = { hover: { 'font-feature-settings': 'normal' } };
    expect(tailwindNodeParts(node, {}).rest).toEqual({ 'font-feature-settings': '"a;b"' });
  });
});
