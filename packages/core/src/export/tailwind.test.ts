import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseDocument } from '../schema.js';
import { createNodeFromTag } from '../document.js';
import { cssToTailwind, exportTailwind, tailwindNodeParts, tailwindThemeCss } from './tailwind.js';

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

/** [name, css, expected classes] */
type Case = [string, Record<string, string>, string[]];

const cases: Case[] = [
  // layout
  ['flex column', { display: 'flex', 'flex-direction': 'column' }, ['flex', 'flex-col']],
  [
    'alignment and wrap',
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
  ['arbitrary flex', { flex: '2 1 30%' }, ['flex-[2_1_30%]']],
  ['display none', { display: 'none' }, ['hidden']],
  [
    'grid repeat',
    { display: 'grid', 'grid-template-columns': 'repeat(3, minmax(0, 1fr))' },
    ['grid', 'grid-cols-3'],
  ],
  // `repeat(3, 1fr)` has an auto minimum: it is not `grid-cols-3` (minmax(0, 1fr))
  [
    'grid repeat with 1fr',
    { 'grid-template-columns': 'repeat(3, 1fr)' },
    ['grid-cols-[repeat(3,1fr)]'],
  ],
  ['arbitrary grid', { 'grid-template-columns': '200px 1fr 2fr' }, ['grid-cols-[200px_1fr_2fr]']],
  // spacing
  ['gap on the scale', { gap: '24px' }, ['gap-6']],
  ['double gap', { gap: '8px 16px' }, ['gap-y-2', 'gap-x-4']],
  ['padding 16px', { padding: '16px' }, ['p-4']],
  ['padding with half step', { padding: '6px' }, ['p-1.5']],
  ['vertical/horizontal padding', { padding: '20px 64px' }, ['py-5', 'px-16']],
  ['padding 3 values', { padding: '32px 64px 96px' }, ['pt-8', 'pb-24', 'px-16']],
  ['padding off the scale', { padding: '13px' }, ['p-[13px]']],
  ['padding-left longhand', { 'padding-left': '12px' }, ['pl-3']],
  ['horizontal auto margin', { margin: '0 auto' }, ['my-0', 'mx-auto']],
  ['negative margin', { 'margin-top': '-8px' }, ['-mt-2']],
  ['1px', { 'padding-top': '1px' }, ['pt-px']],
  ['padding 0', { padding: '0' }, ['p-0']],
  ['padding in rem', { padding: '1rem' }, ['p-4']],
  // sizes
  ['full width/height', { width: '100%', height: '100%' }, ['size-full']],
  ['equal width and height', { width: '40px', height: '40px' }, ['size-10']],
  ['large arbitrary width', { width: '1440px' }, ['w-[1440px]']],
  ['w auto', { width: 'auto' }, ['w-auto']],
  ['w-full e h-screen', { width: '100%', height: '100vh' }, ['w-full', 'h-screen']],
  ['fraction', { width: '50%' }, ['w-1/2']],
  ['min-height', { 'min-height': '900px' }, ['min-h-[900px]']],
  ['named max-width', { 'max-width': '448px' }, ['max-w-md']],
  ['arbitrary max-width', { 'max-width': '800px' }, ['max-w-[800px]']],
  ['max-width none', { 'max-width': 'none' }, ['max-w-none']],
  // typography
  ['font-size on the scale', { 'font-size': '14px' }, ['text-sm']],
  ['font-size 128', { 'font-size': '128px' }, ['text-9xl']],
  ['font-size off the scale', { 'font-size': '17px' }, ['text-[17px]']],
  ['font-weight', { 'font-weight': '700' }, ['font-bold']],
  ['font-weight keyword', { 'font-weight': 'bold' }, ['font-bold']],
  ['font-weight off the scale', { 'font-weight': '550' }, ['font-[550]']],
  ['named line-height', { 'line-height': '1.5' }, ['leading-normal']],
  ['arbitrary line-height', { 'line-height': '1.4' }, ['leading-[1.4]']],
  ['line-height in px', { 'line-height': '28px' }, ['leading-7']],
  ['named letter-spacing', { 'letter-spacing': '0.05em' }, ['tracking-wider']],
  ['arbitrary letter-spacing', { 'letter-spacing': '2px' }, ['tracking-[2px]']],
  [
    'text',
    {
      'text-align': 'center',
      'text-transform': 'uppercase',
      'font-style': 'italic',
      'text-decoration': 'underline',
      'white-space': 'pre-wrap',
    },
    ['text-center', 'uppercase', 'italic', 'underline', 'whitespace-pre-wrap'],
  ],
  ['no decoration', { 'text-decoration': 'none' }, ['no-underline']],
  // colors
  ['hex color', { 'background-color': '#6c5ce7' }, ['bg-[#6c5ce7]']],
  ['white color', { color: '#ffffff' }, ['text-white']],
  ['rgba color', { 'background-color': 'rgba(0, 0, 0, 0.5)' }, ['bg-[rgba(0,0,0,0.5)]']],
  ['transparent color', { background: 'transparent' }, ['bg-transparent']],
  ['named color', { color: 'red' }, ['text-[color:red]']],
  [
    'background shorthand with gradient',
    { background: 'linear-gradient(90deg, #000, #fff)' },
    ['bg-[linear-gradient(90deg,#000,#fff)]'],
  ],
  // borders and radius
  ['full border', { border: '1px solid #ccc' }, ['border', 'border-solid', 'border-[#ccc]']],
  [
    '2px dashed border',
    { border: '2px dashed #000' },
    ['border-2', 'border-dashed', 'border-black'],
  ],
  ['top border', { 'border-top': '1px solid #eee' }, ['border-t', 'border-t-[#eee]']],
  ['border none', { border: 'none' }, ['border-none']],
  ['border-width', { 'border-width': '4px' }, ['border-4']],
  ['named radius', { 'border-radius': '8px' }, ['rounded-lg']],
  ['radius md', { 'border-radius': '6px' }, ['rounded-md']],
  ['radius full', { 'border-radius': '9999px' }, ['rounded-full']],
  ['arbitrary radius', { 'border-radius': '10px' }, ['rounded-[10px]']],
  [
    'per-corner radius',
    { 'border-radius': '8px 8px 0 0' },
    ['rounded-tl-lg', 'rounded-tr-lg', 'rounded-br-none', 'rounded-bl-none'],
  ],
  ['radius longhand', { 'border-top-left-radius': '12px' }, ['rounded-tl-xl']],
  // shadow and related
  [
    'arbitrary shadow',
    { 'box-shadow': '0 2px 4px rgba(0, 0, 0, 0.2)' },
    ['shadow-[0_2px_4px_rgba(0,0,0,0.2)]'],
  ],
  ['shadow none', { 'box-shadow': 'none' }, ['shadow-none']],
  ['opacity', { opacity: '0.5' }, ['opacity-50']],
  ['fractional opacity', { opacity: '0.333' }, ['opacity-[0.333]']],
  [
    'overflow',
    { overflow: 'hidden', 'overflow-y': 'auto' },
    ['overflow-hidden', 'overflow-y-auto'],
  ],
  // position
  [
    'position + offsets',
    { position: 'absolute', left: '12px', top: '0' },
    ['absolute', 'left-3', 'top-0'],
  ],
  ['inset 0', { inset: '0' }, ['inset-0']],
  ['arbitrary offset', { left: '13px' }, ['left-[13px]']],
  ['z-index', { 'z-index': '10' }, ['z-10']],
  ['arbitrary z-index', { 'z-index': '7' }, ['z-[7]']],
  [
    'object-fit and cursor',
    { 'object-fit': 'cover', cursor: 'pointer' },
    ['object-cover', 'cursor-pointer'],
  ],
  ['!important', { padding: '16px !important' }, ['p-4!']],
  // arbitrary
  ['transition', { transition: 'all 0.2s ease' }, ['[transition:all_0.2s_ease]']],
  ['prop with no equivalent', { 'backdrop-filter': 'blur(8px)' }, ['[backdrop-filter:blur(8px)]']],
  ['custom property', { '--accent': '#f00' }, ['[--accent:#f00]']],
  ['escaped literal underscore', { content: '"a_b"' }, ['[content:"a\\_b"]']],
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

    it('inside a theme namespace they use the short name', () => {
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

    it('outside a namespace they use the v4 variable syntax', () => {
      expect(t({ 'border-radius': 'var(--radius)' })).toEqual(['rounded-(--radius)']);
      expect(t({ 'font-family': 'var(--font)' })).toEqual(['font-(family-name:--font)']);
      expect(t({ background: 'var(--surface)' })).toEqual(['bg-(color:--surface)']);
      expect(t({ padding: 'var(--pad)' })).toEqual(['p-(--pad)']);
    });

    it('a variable from another namespace in the wrong place does not become a short name', () => {
      expect(t({ 'background-color': 'var(--radius-card)' })).toEqual(['bg-(color:--radius-card)']);
    });

    it('missing token (when the list is given) uses the variable syntax', () => {
      expect(t({ color: 'var(--color-missing)' })).toEqual(['text-(color:--color-missing)']);
    });

    it('var with fallback becomes an arbitrary value', () => {
      expect(t({ color: 'var(--x, #fff)' })).toEqual(['text-[color:var(--x,#fff)]']);
    });
  });

  it('value unsafe for an arbitrary class stays in rest', () => {
    const { classes, rest } = cssToTailwind({ content: '"a<b"', color: '#fff' });
    expect(classes).toEqual(['text-white']);
    expect(rest).toEqual({ content: '"a<b"' });
  });

  it('props inherited from Object.prototype do not break', () => {
    expect(() => cssToTailwind({ constructor: 'x', toString: 'y' })).not.toThrow();
  });
});

describe('tailwindThemeCss', () => {
  it('separates @theme, :root and @font-face', () => {
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

  it('neutralizes the default line-height of the text-* sizes used', () => {
    const css = tailwindThemeCss(landing);
    expect(css).toContain('--text-sm--line-height: inherit;');
    expect(css).not.toContain('--text-9xl--line-height');
  });

  it('no import when requested', () => {
    expect(tailwindThemeCss(landing, { import: false })).not.toContain('@import');
  });
});

describe('exportTailwind', () => {
  it('snapshot of the example (full document)', () => {
    expect(exportTailwind(landing)).toMatchSnapshot();
  });

  it('includes CDN and theme; cdn: false removes only the script', () => {
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

  it('fragment is markup only', () => {
    const frag = exportTailwind(landing, { nodeIds: ['el_dsk00007'], fragment: true });
    expect(frag.startsWith('<header class="')).toBe(true);
    expect(frag).not.toContain('<style');
    expect(frag).not.toContain('<script');
  });

  it('uses theme names and the variable syntax of the example', () => {
    const frag = exportTailwind(landing, { nodeIds: ['el_dsk00007'], fragment: true });
    expect(frag).toContain('bg-surface');
    expect(frag).toContain('rounded-(--radius)');
    expect(frag).toContain('py-5 px-16');
  });
});

describe('props with no equivalent class and node states', () => {
  it('prop changed by a state goes as an arbitrary class, not as inline style', () => {
    const node = createNodeFromTag('div', {
      styles: { 'scroll-snap-type': 'x mandatory', 'text-wrap': 'balance' },
    });
    node.states = { hover: { 'scroll-snap-type': 'none' } };
    const { classes, rest } = tailwindNodeParts(node, {});
    expect(rest).toEqual({});
    expect(classes).toContain('[scroll-snap-type:x_mandatory]');
    expect(classes).toContain('hover:[scroll-snap-type:none]');
  });

  it('value that does not become a safe arbitrary class stays inline', () => {
    const node = createNodeFromTag('div', { styles: { 'font-feature-settings': '"a;b"' } });
    node.states = { hover: { 'font-feature-settings': 'normal' } };
    expect(tailwindNodeParts(node, {}).rest).toEqual({ 'font-feature-settings': '"a;b"' });
  });
});
