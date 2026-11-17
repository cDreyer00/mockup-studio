import fs from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { createDocument, createNodeFromTag } from '../document.js';
import { parseDocument } from '../schema.js';
import { getTailwindEngine } from '../tailwind/cache.js';
import { createTailwindEngine, type TailwindEngine } from '../tailwind/engine.js';
import type { Document, Node } from '../types.js';
import { exportHtml } from './html.js';
import { exportReact } from './react.js';
import { exportSvg } from './svg.js';
import { exportTailwind, neutralLeadingSizes, tailwindThemeCss } from './tailwind.js';

const landing = parseDocument(
  fs.readFileSync(new URL('../../../../examples/landing.mockup.json', import.meta.url), 'utf8'),
);

function docWith(root: Node, tokens: Record<string, string> = {}): Document {
  const doc = createDocument('States', { id: 'doc_state01' });
  root.id = 'fr_state0001';
  doc.pages[0].frames.push(root);
  Object.assign(doc.tokens, tokens);
  return doc;
}

function button(): Node {
  const btn = createNodeFromTag('button', {
    name: 'Button',
    text: 'Send',
    styles: { 'background-color': '#6c5ce7', padding: '8px 16px', color: '#fff' },
  });
  btn.id = 'el_state0001';
  btn.states = {
    hover: { 'background-color': '#5b4bd6' },
    md: { padding: '12px 24px' },
    dark: { 'background-color': '#222' },
    'md:hover': { 'background-color': '#4a3cc0' },
    disabled: { opacity: '0.5' },
  };
  return btn;
}

function withButton(tokens: Record<string, string> = {}): Document {
  const frame = createNodeFromTag('div', {
    name: 'Screen',
    isRoot: true,
    styles: { width: '800px' },
  });
  frame.children = [button()];
  return docWith(frame, tokens);
}

function textNode(name: string, styles: Record<string, string>): Node {
  const n = createNodeFromTag('p', { name, text: name, styles });
  n.id = `tx_${name.toLowerCase().replace(/\W/g, '').slice(0, 8).padEnd(8, '0')}`;
  return n;
}

function docWithTexts(...texts: Node[]): Document {
  const frame = createNodeFromTag('div', { name: 'Screen', isRoot: true });
  frame.children = texts;
  return docWith(frame);
}

describe('exportTailwind: line-height neutralization', () => {
  it('neutralizes the size used by a node without line-height', () => {
    const doc = docWithTexts(textNode('No lh', { 'font-size': '14px' }));
    expect(neutralLeadingSizes(doc)).toEqual(new Set(['sm']));
    expect(tailwindThemeCss(doc)).toContain('--text-sm--line-height: inherit;');
  });

  it('neutralizes when the line-height differs from the size default', () => {
    const doc = docWithTexts(textNode('Lh 1.7', { 'font-size': '0.875rem', 'line-height': '1.7' }));
    expect(tailwindThemeCss(doc)).toContain('--text-sm--line-height: inherit;');
  });

  it('skips when all nodes have the default line-height (unitless or in px)', () => {
    const doc = docWithTexts(
      textNode('Imported', { 'font-size': '0.875rem', 'line-height': '1.4286' }),
      textNode('In px', { 'font-size': '14px', 'line-height': '20px' }),
      textNode('Large', { 'font-size': '1.125rem', 'line-height': '1.5556' }),
    );
    expect(neutralLeadingSizes(doc).size).toBe(0);
    expect(tailwindThemeCss(doc)).not.toContain('line-height: inherit');
  });

  it('a non-default node neutralizes only its own size', () => {
    const doc = docWithTexts(
      textNode('Default', { 'font-size': '0.875rem', 'line-height': '1.4286' }),
      textNode('Other', { 'font-size': '1.125rem', 'line-height': '1.2' }),
    );
    expect(neutralLeadingSizes(doc)).toEqual(new Set(['lg']));
    const css = tailwindThemeCss(doc);
    expect(css).toContain('--text-lg--line-height: inherit;');
    expect(css).not.toContain('--text-sm--line-height');
  });

  it('unnamed sizes and states with font-size are taken into account', () => {
    const odd = textNode('Odd', { 'font-size': '13px' });
    const withState = textNode('State', { 'font-size': '1rem', 'line-height': '1.5' });
    withState.states = { md: { 'font-size': '1.25rem' } };
    const doc = docWithTexts(odd, withState);
    // md: 1.25rem inherits the base line-height 1.5, which is not xl's default (1.4)
    expect(neutralLeadingSizes(doc)).toEqual(new Set(['xl']));
  });
});

describe('exportTailwind: states without the engine', () => {
  it('exports node.states as classes with a variant prefix', () => {
    const html = exportTailwind(withButton(), { fragment: true });
    expect(html).toContain('hover:bg-[#5b4bd6]');
    expect(html).toContain('md:py-3');
    expect(html).toContain('md:px-6');
    expect(html).toContain('dark:bg-[#222]');
    expect(html).toContain('md:hover:bg-[#4a3cc0]');
    expect(html).toContain('disabled:opacity-50');
    expect(html).not.toContain('style=');
  });

  it('the theme includes the dark @custom-variant only when some node uses dark', () => {
    const doc = withButton();
    const css = tailwindThemeCss(doc);
    expect(css).toContain(
      '@custom-variant dark (&:where([data-theme=dark], [data-theme=dark] *));',
    );
    expect(css.indexOf('@import')).toBeLessThan(css.indexOf('@custom-variant'));
    delete doc.pages[0].frames[0].children[0].states!.dark;
    expect(tailwindThemeCss(doc)).not.toContain('@custom-variant');
    expect(tailwindThemeCss(landing)).not.toContain('@custom-variant');
  });

  it('the full document includes the @custom-variant in the <style type="text/tailwindcss">', () => {
    const html = exportTailwind(withButton());
    expect(html).toContain('@custom-variant dark');
    expect(html).not.toContain('@import "tailwindcss"');
  });
});

describe('exportHtml: custom breakpoints', () => {
  it('uses the document --breakpoint-* in @media', () => {
    const custom = exportHtml(withButton({ '--breakpoint-md': '900px' }));
    expect(custom).toContain('@media (min-width: 900px)');
    expect(custom).not.toContain('@media (min-width: 768px)');
    expect(exportHtml(withButton({ '--breakpoint-md': '900px' }), { mode: 'inline' })).toContain(
      '@media (min-width: 900px)',
    );
    expect(exportHtml(withButton())).toContain('@media (min-width: 768px)');
  });
});

describe('cssBase', () => {
  it('Tailwind: only the base layer body changes', () => {
    const doc = withButton();
    const normal = tailwindThemeCss(doc);
    expect(normal).toContain('body { font-family:system-ui');
    doc.cssBase = 'tailwind';
    const tw = tailwindThemeCss(doc);
    expect(tw).toContain('body { font-family:-apple-system');
    expect(tw).toContain('line-height:1.5');
    expect(tw).not.toContain('border:0 solid');
  });

  it('HTML: with cssBase tailwind includes the preflight', () => {
    const doc = withButton();
    expect(exportHtml(doc)).not.toContain('border:0 solid');
    doc.cssBase = 'tailwind';
    const html = exportHtml(doc);
    expect(html).toContain('box-sizing:border-box;margin:0;padding:0;border:0 solid');
    expect(html).toContain('h1,h2,h3,h4,h5,h6{font-size:inherit;font-weight:inherit}');
  });

  it('React inline and SVG follow cssBase', () => {
    const doc = withButton();
    doc.cssBase = 'tailwind';
    const r = exportReact(doc, { nodeId: 'fr_state0001', styles: 'inline' });
    expect(r.css).toContain('border:0 solid');
    const svg = exportSvg(doc, { nodeId: 'fr_state0001' });
    expect(svg).toContain('border:0 solid');
  });
});

describe('exportHtml: states', () => {
  it('classes mode: rules per pseudo-class, breakpoint, dark and combinations', () => {
    const html = exportHtml(withButton(), { fragment: true });
    expect(html).toContain('.button:hover {\n    background-color: #5b4bd6;\n  }');
    expect(html).toContain('.button:disabled {\n    opacity: 0.5;\n  }');
    expect(html).toContain(
      '.button:where([data-theme="dark"], [data-theme="dark"] *) {\n    background-color: #222;\n  }',
    );
    expect(html).toContain(
      '@media (min-width: 768px) {\n    .button {\n      padding: 12px 24px;\n    }\n  }',
    );
    expect(html).toContain(
      '@media (min-width: 768px) {\n    .button:hover {\n      background-color: #4a3cc0;\n    }\n  }',
    );
    // the state comes after the base rule of the same node
    expect(html.indexOf('.button {')).toBeLessThan(html.indexOf('.button:hover'));
    expect(html).toMatchSnapshot();
  });

  it('inline mode: base in style and states in <style> with !important', () => {
    const html = exportHtml(withButton(), { fragment: true, mode: 'inline' });
    expect(html).toContain('<button class="button" style="background-color: #6c5ce7;');
    expect(html).toContain('.button:hover {\n    background-color: #5b4bd6 !important;\n  }');
    expect(html).toContain(
      '@media (min-width: 768px) {\n    .button {\n      padding: 12px 24px !important;',
    );
  });

  it('a node with only states (no style) also gets a class', () => {
    const frame = createNodeFromTag('div', { name: 'Screen', isRoot: true });
    const n = createNodeFromTag('a', { name: 'Link', text: 'go' });
    n.id = 'el_state0002';
    n.states = { hover: { 'text-decoration': 'underline' } };
    frame.children = [n];
    const html = exportHtml(docWith(frame), { fragment: true });
    expect(html).toContain('<a class="link">go</a>');
    expect(html).toContain('.link:hover {');
  });

  it('states with unsafe values or invalid keys are not emitted', () => {
    const doc = withButton();
    const node = doc.pages[0].frames[0].children[0];
    node.states!['group-hover'] = { color: 'red' };
    node.states!.focus = { color: 'red; x: y' };
    const html = exportHtml(doc, { fragment: true });
    expect(html).not.toContain('group-hover');
    expect(html).not.toContain('x: y');
    expect(html).not.toContain(':focus');
  });

  it('without states the output does not change (no extra rules)', () => {
    const html = exportHtml(landing);
    expect(html).not.toContain(':hover');
    expect(html).not.toContain('@media');
  });
});

describe('exportReact and exportSvg: states', () => {
  it('React tailwind without the engine puts the variants in className', () => {
    const { code } = exportReact(withButton(), { nodeId: 'fr_state0001' });
    expect(code).toContain('hover:bg-[#5b4bd6]');
    expect(code).toContain('md:hover:bg-[#4a3cc0]');
  });

  it('React inline does not export states (style={{}} has no variants)', () => {
    const { code } = exportReact(withButton(), { nodeId: 'fr_state0001', styles: 'inline' });
    expect(code).not.toContain('hover');
    expect(code).not.toContain('5b4bd6');
  });

  it('nodes with different states are not extracted as a repetition', () => {
    const frame = createNodeFromTag('ul', { name: 'List', isRoot: true });
    const mk = (i: number, hover: string): Node => {
      const li = createNodeFromTag('li', {
        name: 'Item',
        text: `Item ${i}`,
        styles: { color: 'red' },
      });
      li.id = `el_item000${i}`;
      li.states = { hover: { color: hover } };
      return li;
    };
    frame.children = [mk(1, 'blue'), mk(2, 'green'), mk(3, 'green')];
    const { code } = exportReact(docWith(frame), { nodeId: 'fr_state0001' });
    expect(code).toContain('hover:text-[color:blue]');
    expect(code).toContain('hover:text-[color:green]');
  });

  it('SVG ignores the states', () => {
    const svg = exportSvg(withButton(), { nodeId: 'fr_state0001' });
    expect(svg).not.toContain('5b4bd6');
    expect(svg).not.toContain(':hover');
  });
});

describe('exportTailwind with the engine', () => {
  let engine: TailwindEngine;
  beforeAll(async () => {
    engine = await createTailwindEngine(landing);
    // canonicalization warm-up (~1 s) outside the tests' timing; the token-less documents
    // below share the cached engine
    engine.warmup();
    (await getTailwindEngine(withButton())).warmup();
  }, 30000);

  it('landing example: snapshot with the engine', () => {
    const html = exportTailwind(landing, { tailwind: engine });
    expect(html).toMatchSnapshot();
  });

  it('with the engine the classes are canonicalized and the variants come from the state', async () => {
    const doc = withButton();
    const e = await getTailwindEngine(doc);
    const html = exportTailwind(doc, { tailwind: e, fragment: true });
    expect(html).toContain('hover:bg-[#5b4bd6]');
    expect(html).toContain('md:hover:bg-[#4a3cc0]');
    expect(html).toContain('dark:bg-[#222]');
    expect(html).toContain('py-2');
    expect(html).toContain('px-4');
    expect(html).toContain('text-white');
  });

  it('neutralizes the line-height in the theme and keeps the node leading in the markup', async () => {
    const doc = docWithTexts(
      textNode('Default', { 'font-size': '0.875rem', 'line-height': '1.4286' }),
      textNode('Other', { 'font-size': '0.875rem', 'line-height': '1.7' }),
      textNode('No lh', { 'font-size': '0.875rem' }),
    );
    const e = await getTailwindEngine(doc);
    const html = exportTailwind(doc, { tailwind: e });
    expect(html).toContain('--text-sm--line-height: inherit;');
    const body = html.slice(html.indexOf('<body>'));
    const lines = body.split('\n');
    const dflt = lines.find((l) => l.includes('>Default<'))!;
    // the node with the Tailwind default needs an explicit leading, since the theme neutralizes text-sm
    expect(dflt).toMatch(/text-sm/);
    expect(dflt).toMatch(/leading-/);
    const noLh = lines.find((l) => l.includes('>No lh<'))!;
    expect(noLh).toMatch(/text-sm/);
    expect(noLh).not.toMatch(/leading-/);
  });

  it('React with the engine uses the engine classes', async () => {
    const doc = withButton();
    const e = await getTailwindEngine(doc);
    const { code, css } = exportReact(doc, { nodeId: 'fr_state0001', tailwind: e });
    expect(code).toContain('hover:bg-[#5b4bd6]');
    expect(css).toContain('@custom-variant dark');
  });
});
