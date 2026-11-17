import { beforeAll, describe, expect, it } from 'vitest';
import { createDocument, createNodeFromTag } from '../document.js';
import type { Node } from '../types.js';
import { comparableCss, createTailwindEngine, type TailwindEngine } from './engine.js';

let engine: TailwindEngine;

beforeAll(async () => {
  const doc = createDocument('Round-trip');
  doc.tokens['--color-primary'] = '#6c5ce7';
  doc.tokens['--radius-card'] = '14px';
  engine = await createTailwindEngine(doc);
});

/** Node with the style and states that `classes` produces (without the `node.classes` hint). */
function nodeFrom(classes: string, withHint: boolean): Node {
  const r = engine.classesToStyles(classes);
  const node = createNodeFromTag('div', { styles: r.style });
  if (Object.keys(r.states).length > 0) node.states = r.states;
  if (withHint) node.classes = classes;
  return node;
}

type Compiled = ReturnType<TailwindEngine['classesToStyles']>;

function expectSameCss(a: Compiled, b: Compiled): void {
  const norm = (rec: Record<string, string>): Record<string, string> =>
    Object.fromEntries(Object.entries(rec).map(([k, v]) => [k, comparableCss(v)]));
  expect(norm(b.style)).toEqual(norm(a.style));
  expect(Object.keys(b.states).sort()).toEqual(Object.keys(a.states).sort());
  for (const k of Object.keys(a.states)) expect(norm(b.states[k])).toEqual(norm(a.states[k]));
}

/** Classes the author wrote → style → classes (with and without hint) → the same style. */
function roundTrip(classes: string): { hinted: string[]; plain: string[] } {
  const before = engine.classesToStyles(classes);
  const hinted = engine.nodeClasses(nodeFrom(classes, true));
  const plain = engine.nodeClasses(nodeFrom(classes, false));
  expect(hinted.rest).toEqual({});
  expect(plain.rest).toEqual({});
  expectSameCss(before, engine.classesToStyles(hinted.classes.join(' ')));
  expectSameCss(before, engine.classesToStyles(plain.classes.join(' ')));
  return { hinted: hinted.classes, plain: plain.classes };
}

describe('round-trip classes → style → classes', () => {
  // [classes, what the no-hint output should contain idiomatically]
  const idiomatic: [string, string[]][] = [
    // spacing
    ['p-4', ['p-4']],
    ['px-6 py-2', ['px-6', 'py-2']],
    ['m-4 mx-auto', ['m-4', 'mx-auto']],
    ['-mt-2', ['-mt-2']],
    ['gap-4', ['gap-4']],
    ['gap-x-2 gap-y-4', ['gap-x-2', 'gap-y-4']],
    // colors
    ['bg-blue-500 text-white', ['bg-blue-500', 'text-white']],
    ['bg-black text-white', ['bg-black']],
    ['bg-primary text-primary', ['bg-primary', 'text-primary']],
    // flex and grid
    ['flex flex-col items-center justify-between', ['flex', 'flex-col', 'items-center']],
    ['grid grid-cols-3 gap-4', ['grid', 'grid-cols-3', 'gap-4']],
    // tipografia
    ['text-sm font-semibold', ['text-sm', 'font-semibold']],
    ['text-lg leading-6 tracking-tight', ['text-lg/6', 'tracking-tight']],
    ['text-sm/tight', ['text-sm/tight']],
    // borders
    ['border border-red-500', ['border', 'border-red-500']],
    ['border-b-2', ['border-b-2']],
    // shadows, radius
    ['shadow-md', ['shadow-md']],
    ['rounded-lg', ['rounded-lg']],
    ['rounded-full', ['rounded-full']],
    // !important
    ['p-4!', ['p-4!']],
    // variants
    ['hover:bg-red-500', ['hover:bg-red-500']],
    ['dark:bg-black', ['dark:bg-black']],
    ['md:p-8', ['md:p-8']],
    ['md:hover:bg-blue-500', ['md:hover:bg-blue-500']],
    ['bg-blue-500 hover:bg-blue-600 dark:bg-black md:p-8', ['hover:bg-blue-600', 'dark:bg-black']],
  ];

  it.each(idiomatic)('%s', (classes, expected) => {
    const { hinted, plain } = roundTrip(classes);
    for (const c of expected) expect(plain).toContain(c);
    // with the hint the author classes come back as written (in the same order)
    expect(hinted).toEqual(classes.split(' '));
  });

  // cases where only the hint path returns the original classes; without the hint, recompiling to the same result is enough
  const equivalentOnly = [
    'bg-blue-500/50',
    'bg-primary/50',
    'shadow-sm',
    'shadow-md ring-2 ring-blue-500',
    'ring-2',
    'bg-linear-to-r from-blue-500 to-purple-500',
    'bg-gradient-to-r from-blue-500 to-purple-500',
    'rounded-lg border-primary/20',
    'focus-visible:ring-2 hover:underline',
    'opacity-50 hover:opacity-100',
    'w-[13px] h-[7px]',
    'text-[#123456] tracking-[0.2em]',
  ];

  it.each(equivalentOnly)('equivalent: %s', (classes) => {
    const { hinted } = roundTrip(classes);
    expect([...hinted].sort()).toEqual(classes.split(' ').sort());
  });

  it('the hint is discarded when the style was edited', () => {
    const node = nodeFrom('p-4 bg-blue-500', true);
    node.style.padding = '2rem';
    const { classes } = engine.nodeClasses(node);
    expect(classes).not.toContain('p-4');
    expect(classes).toContain('p-8');
    expect(classes).toContain('bg-blue-500');
  });

  it('prefers the Tailwind scale over arbitrary values', () => {
    const node = createNodeFromTag('div', {
      styles: { padding: '16px', width: '13px', 'border-radius': '8px' },
    });
    const { classes } = engine.nodeClasses(node);
    expect(classes).toContain('p-4');
    expect(classes).toContain('w-3.25');
    expect(classes).toContain('rounded-lg');
  });

  it('style with shorthand (padding, border, background, text-decoration) becomes idiomatic classes', () => {
    const node = createNodeFromTag('div', {
      styles: {
        padding: '8px 16px',
        margin: '0 auto',
        border: '1px solid var(--color-primary)',
        background: 'var(--color-primary)',
        'text-decoration': 'none',
        gap: '8px',
      },
    });
    const { classes, rest } = engine.nodeClasses(node);
    expect(rest).toEqual({});
    for (const c of [
      'py-2',
      'px-4',
      'mx-auto',
      'border',
      'border-primary',
      'bg-primary',
      'no-underline',
      'gap-2',
    ])
      expect(classes).toContain(c);
    expect(classes.some((c) => c.startsWith('['))).toBe(false);
    const none = engine.nodeClasses(createNodeFromTag('div', { styles: { border: 'none' } }));
    expect(none.classes).toEqual(['border-none']);
  });

  it('unknown and unsupported classes stay as they are (with the hint)', () => {
    const classes = 'group flex group-hover:bg-red-500 [&_svg]:size-4 foo-bar p-4';
    const node = nodeFrom(classes, true);
    const out = engine.nodeClasses(node).classes;
    for (const c of ['group', 'group-hover:bg-red-500', '[&_svg]:size-4', 'foo-bar', 'flex', 'p-4'])
      expect(out).toContain(c);
    // without the hint only what the style says
    const plain = engine.nodeClasses(nodeFrom(classes, false)).classes;
    expect(plain).toEqual(['flex', 'p-4']);
  });

  it('child classes (space-y) do not stay on the node: the style is already on the children', () => {
    const node = nodeFrom('flex flex-col space-y-2', true);
    expect(engine.nodeClasses(node).classes).toEqual(['flex', 'flex-col']);
  });

  it('classesToStyles separates style, states and children', () => {
    const r = engine.classesToStyles('p-4 hover:bg-red-500 md:hover:p-2 space-y-2');
    expect(r.style.padding).toBe('1rem');
    expect(Object.keys(r.states).sort()).toEqual(['hover', 'md:hover']);
    expect(r.children?.notLast).toBeDefined();
  });

  it('neutralLeading: text-sm only brings font-size when the theme neutralizes line-height', () => {
    const node = createNodeFromTag('div', {
      styles: { 'font-size': '0.875rem', 'line-height': '1.7' },
    });
    const none = engine.nodeClasses(node).classes;
    expect(none.join(' ')).toMatch(/text-sm/);
    const neutral = engine.nodeClasses(node, { neutralLeading: new Set(['sm']) }).classes;
    expect(neutral).toContain('text-sm');
    expect(neutral.some((c) => c.startsWith('leading-'))).toBe(true);
    // without line-height on the node: text-sm alone
    const bare = createNodeFromTag('div', { styles: { 'font-size': '0.875rem' } });
    expect(engine.nodeClasses(bare, { neutralLeading: new Set(['sm']) }).classes).toEqual([
      'text-sm',
    ]);
  });
});

describe('Tailwind cascade is independent of written order', () => {
  it.each([
    ['px-2 p-4', 'p-4 px-2'],
    ['border-b-0 border', 'border border-b-0'],
    ['rounded-t-none rounded-lg', 'rounded-lg rounded-t-none'],
    ['hover:px-8 hover:p-1', 'hover:p-1 hover:px-8'],
  ])('%s == %s', (a, b) => {
    expectSameCss(engine.classesToStyles(a), engine.classesToStyles(b));
  });

  it('the class that comes later in the Tailwind CSS wins', () => {
    expect(engine.classesToStyles('px-2 p-4').style).toMatchObject({
      'padding-inline': '0.5rem',
    });
    expect(engine.classesToStyles('border-b-0 border').style['border-bottom-width']).toBe('0px');
    expect(engine.classesToStyles('rounded-t-none rounded-lg').style).toMatchObject({
      'border-top-left-radius': '0',
    });
    expect(engine.classesToStyles('hover:px-8 hover:p-1').states.hover).toMatchObject({
      'padding-inline': '2rem',
    });
  });
});
