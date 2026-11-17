import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { createDocument, createNode } from '../document.js';
import { parseDocument } from '../schema.js';
import type { Document, Node } from '../types.js';
import { exportReact } from './react.js';

const landing = parseDocument(
  fs.readFileSync(new URL('../../../../examples/landing.mockup.json', import.meta.url), 'utf8'),
);

function docWith(children: Node[], frameStyle: Record<string, string> = {}): Document {
  const doc = createDocument('Test', { id: 'doc_test' });
  doc.pages[0].frames.push(
    createNode({
      tag: 'div',
      type: 'frame',
      id: 'fr_test0001',
      name: 'My Screen',
      style: { width: '400px', height: '300px', ...frameStyle },
      children,
    }),
  );
  return doc;
}

/* ---------------- compilation with strict tsc (as in a Vite React TS template) ---------------- */

const reactTypes = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../../node_modules/@types/react',
);

/** Diagnostics from `tsc --strict --noUnusedLocals` for a TSX file. */
function compile(code: string): string[] {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mockup-react-'));
  try {
    const file = path.join(dir, 'Component.tsx');
    fs.writeFileSync(file, code);
    const program = ts.createProgram([file], {
      strict: true,
      noUnusedLocals: true,
      noUnusedParameters: true,
      noEmit: true,
      jsx: ts.JsxEmit.ReactJSX,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      target: ts.ScriptTarget.ES2022,
      lib: ['lib.es2022.d.ts', 'lib.dom.d.ts'],
      verbatimModuleSyntax: true,
      skipLibCheck: true,
      types: [],
      baseUrl: dir,
      paths: {
        react: [path.join(reactTypes, 'index.d.ts')],
        'react/jsx-runtime': [path.join(reactTypes, 'jsx-runtime.d.ts')],
      },
    });
    return ts
      .getPreEmitDiagnostics(program)
      .map((d) => ts.flattenDiagnosticMessageText(d.messageText, '\n'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

describe('exportReact', () => {
  it('the test compiler detects errors (sanity check)', () => {
    expect(compile('export const a: number = "x";').length).toBeGreaterThan(0);
    expect(compile('const unused = 1; export {};').length).toBeGreaterThan(0);
    expect(compile('export const a = <div foo="1" />;').length).toBeGreaterThan(0);
    // three cold tsc programs with lib.dom: under the whole suite in parallel it exceeds 5 s
  }, 30_000);

  it('Desktop 1440 snapshot with Tailwind', () => {
    expect(exportReact(landing, { nodeId: 'fr_d3sk1440' })).toMatchSnapshot();
  });

  it('Desktop 1440 snapshot with inline styles', () => {
    expect(exportReact(landing, { nodeId: 'fr_d3sk1440', styles: 'inline' })).toMatchSnapshot();
  });

  it('PascalCase node name, or componentName; named and default export', () => {
    const a = exportReact(landing, { nodeId: 'fr_d3sk1440' });
    expect(a.componentName).toBe('Desktop1440');
    expect(a.code).toContain('export function Desktop1440() {');
    expect(a.code).toContain('export default Desktop1440;');
    const b = exportReact(landing, { nodeId: 'fr_d3sk1440', componentName: 'Landing' });
    expect(b.componentName).toBe('Landing');
    expect(b.code).toContain('export function Landing() {');
  });

  it('tailwind returns the theme in css; inline brings reset and @font-face', () => {
    const tw = exportReact(landing, { nodeId: 'fr_d3sk1440' });
    expect(tw.css).toContain('@import "tailwindcss";');
    expect(tw.css).toContain('--color-primary: #6c5ce7;');
    const inline = exportReact(landing, { nodeId: 'fr_d3sk1440', styles: 'inline' });
    expect(inline.css).toContain('box-sizing:border-box');
  });

  it('assetsBase also applies to the @font-face of the tailwind theme and the inline css', () => {
    const doc = structuredClone(landing);
    doc.fonts = [{ family: 'Inter', source: 'file', files: ['fonts/i.woff2'], weights: [400] }];
    const tw = exportReact(doc, { nodeId: 'fr_d3sk1440', assetsBase: '/assets/' });
    expect(tw.css).toContain('src:url("/assets/fonts/i.woff2")');
    const inline = exportReact(doc, {
      nodeId: 'fr_d3sk1440',
      styles: 'inline',
      assetsBase: '/assets/',
    });
    expect(inline.css).toContain('src:url("/assets/fonts/i.woff2")');
    const defaults = exportReact(doc, { nodeId: 'fr_d3sk1440' });
    expect(defaults.css).toContain('src:url("assets/fonts/i.woff2")');
  });

  it('inline: camelCase style as a string with unit and tokens on the root element', () => {
    const { code } = exportReact(landing, { nodeId: 'fr_d3sk1440', styles: 'inline' });
    expect(code).toContain("backgroundColor: 'var(--color-bg)'");
    expect(code).toContain("minHeight: '900px'");
    expect(code).toContain("'--color-bg': '#0f1115'");
    expect(code).toContain("'--radius': '12px'");
    expect(code).toContain('as CSSProperties');
    expect(code).toContain("import type { CSSProperties } from 'react';");
    // tokens only on the root
    expect(code.match(/'--color-bg'/g)).toHaveLength(1);
  });

  describe('repeats', () => {
    it('the example cards become array + map', () => {
      const { code } = exportReact(landing, { nodeId: 'fr_d3sk1440' });
      expect(code).toContain('const cardItems = [');
      expect(code).toContain("icon: '🎨'");
      expect(code).toContain("cardTitle: 'Fast'");
      expect(code).toContain('cardText:');
      expect(code).toContain('{cardItems.map((item, index) => (');
      expect(code).toContain('key={index}');
      expect(code).toContain('{item.cardTitle}');
      // a single <h3>, in the template
      expect(code.match(/<h3/g)).toHaveLength(1);
    });

    it('siblings with different layer names use text1, text2 fields', () => {
      const { code } = exportReact(landing, { nodeId: 'el_dsk00005' });
      expect(code).toContain('const linksItems = [');
      expect(code).toContain("{ text1: 'Product' }");
      expect(code).toContain('<a key={index}');
    });

    it('extractRepeats: false keeps siblings expanded', () => {
      const { code } = exportReact(landing, { nodeId: 'fr_d3sk1440', extractRepeats: false });
      expect(code).not.toContain('.map(');
      expect(code.match(/<h3/g)).toHaveLength(3);
    });

    it('siblings with different structures are not extracted', () => {
      const doc = docWith([
        createNode({ tag: 'p', text: 'a', name: 'A', style: { color: 'red' } }),
        createNode({ tag: 'p', text: 'b', name: 'B', style: { color: 'blue' } }),
      ]);
      expect(exportReact(doc, { nodeId: 'fr_test0001' }).code).not.toContain('.map(');
    });

    it('identical siblings (with nothing varying) are not extracted', () => {
      const doc = docWith([
        createNode({ tag: 'p', text: 'same', name: 'A' }),
        createNode({ tag: 'p', text: 'same', name: 'A' }),
      ]);
      expect(exportReact(doc, { nodeId: 'fr_test0001' }).code).not.toContain('.map(');
    });

    it('images and links vary by src, alt and href', () => {
      const mk = (n: number): Node =>
        createNode({
          tag: 'a',
          name: 'Item',
          attrs: { href: `/p/${n}` },
          children: [
            createNode({
              tag: 'img',
              name: 'Photo',
              src: `f${n}.png`,
              attrs: { alt: `Photo ${n}` },
            }),
          ],
        });
      const doc = docWith([mk(1), mk(2), mk(3)]);
      const { code } = exportReact(doc, { nodeId: 'fr_test0001' });
      expect(code).toContain("photoSrc: 'assets/f1.png'");
      expect(code).toContain("photoAlt: 'Photo 2'");
      expect(code).toContain('href={item.');
      expect(code).toContain('src={item.photoSrc}');
      expect(compile(code)).toEqual([]);
    });
  });

  describe('text', () => {
    const textOf = (text: string, style: Record<string, string> = {}): string =>
      exportReact(docWith([createNode({ tag: 'p', name: 'P', text, style })]), {
        nodeId: 'fr_test0001',
      }).code;

    it('escapes braces, angle brackets and ampersand', () => {
      const code = textOf('a {b} <c> & d');
      expect(code).toContain("a {'{'}b{'}'} {'<'}c{'>'} &amp; d");
      expect(compile(code)).toEqual([]);
    });

    it('line break with white-space pre-wrap becomes {"\\n"}', () => {
      const code = textOf('line 1\nline 2', { 'white-space': 'pre-wrap' });
      expect(code).toContain('line 1');
      expect(code).toContain("{'\\n'}");
      expect(code).not.toContain('<br />');
      expect(compile(code)).toEqual([]);
    });

    it('line break without white-space becomes <br />', () => {
      const code = textOf('line 1\nline 2');
      expect(code).toContain('<br />');
      expect(compile(code)).toEqual([]);
    });

    it('edge spaces become an expression so JSX does not swallow them', () => {
      const code = textOf(' hi ');
      expect(code).toContain("{' hi '}");
    });
  });

  describe('attributes', () => {
    it('class/for/booleans/aria/data/href', () => {
      const doc = docWith([
        createNode({
          tag: 'label',
          name: 'Label',
          text: 'Name',
          attrs: { for: 'name', 'data-x': '1' },
        }),
        createNode({
          tag: 'input',
          name: 'Field',
          attrs: {
            id: 'name',
            type: 'text',
            disabled: '',
            readonly: '',
            maxlength: '10',
            tabindex: '0',
            'aria-label': 'Name',
            value: 'x',
            onclick: 'alert(1)',
            foo: 'bar',
          },
        }),
        createNode({
          tag: 'a',
          name: 'Link',
          text: 'go',
          attrs: { href: 'https://example.com', target: '_blank', 'aria-label': 'Go' },
        }),
        createNode({ tag: 'a', name: 'Bad', text: 'x', attrs: { href: 'javascript:alert(1)' } }),
        createNode({ tag: 'br', name: 'Break' }),
      ]);
      const { code } = exportReact(doc, { nodeId: 'fr_test0001' });
      expect(code).toContain('htmlFor="name"');
      expect(code).toContain('data-x="1"');
      expect(code).toContain('disabled');
      expect(code).toContain('readOnly');
      expect(code).toContain('maxLength={10}');
      expect(code).toContain('tabIndex={0}');
      expect(code).toContain('aria-label="Name"');
      expect(code).toContain('defaultValue="x"');
      expect(code).toContain('href="https://example.com"');
      expect(code).toContain('<br />');
      expect(code).not.toContain('onclick');
      expect(code).not.toContain('javascript:');
      expect(code).not.toContain('foo=');
      expect(code).not.toContain('class=');
      expect(compile(code)).toEqual([]);
    });

    it('images: src relative to assets/, assetsBase and alt', () => {
      const doc = docWith([
        createNode({ tag: 'img', name: 'Photo', src: 'photo.png', attrs: { alt: 'Description' } }),
        createNode({ tag: 'img', name: 'Pixel', src: 'data:image/png;base64,AAAA' }),
      ]);
      const a = exportReact(doc, { nodeId: 'fr_test0001' }).code;
      expect(a).toContain('src="assets/photo.png"');
      expect(a).toContain('alt="Description"');
      expect(a).toContain('src="data:image/png;base64,AAAA"');
      expect(a).toContain('alt=""');
      const b = exportReact(doc, { nodeId: 'fr_test0001', assetsBase: '/img/' }).code;
      expect(b).toContain('src="/img/photo.png"');
      expect(compile(a)).toEqual([]);
    });
  });

  describe('SVG → JSX', () => {
    const svg = [
      '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 24 24" class="ic" style="color: red; stroke-width: 2">',
      '<defs><linearGradient id="g"><stop offset="0" stop-color="#fff"/></linearGradient></defs>',
      '<g fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" fill-rule="evenodd">',
      '<path d="M5 12h14" class="p"/>',
      '<use xlink:href="#g"/>',
      '<circle cx="12" cy="12" r="3" style="fill: url(#g); stroke-width: 1"/>',
      '<text x="1" y="2">Hello &amp; {bye}</text>',
      '</g></svg>',
    ].join('');

    it('converts attributes to camelCase and a style string to an object', () => {
      const doc = docWith([
        createNode({ tag: 'svg', name: 'Icon', svg, style: { width: '24px', height: '24px' } }),
      ]);
      const { code } = exportReact(doc, { nodeId: 'fr_test0001', styles: 'inline' });
      const id = doc.pages[0].frames[0].children[0].id;
      expect(code).toContain('strokeWidth="2"');
      expect(code).toContain('strokeLinecap="round"');
      expect(code).toContain('fillRule="evenodd"');
      expect(code).toContain('stopColor="#fff"');
      expect(code).toContain(`xlinkHref="#${id}-g"`);
      expect(code).toContain('xmlnsXlink=');
      expect(code).toContain('className="p"');
      expect(code).toContain(`style={{ fill: 'url(#${id}-g)', strokeWidth: '1' }}`);
      expect(code).toContain(`<linearGradient id="${id}-g">`);
      expect(code).toContain("Hello &amp; {'{'}bye{'}'}");
      // class/style of the root <svg> come from the node, not from the markup
      expect(code).not.toContain('className="ic"');
      expect(code).toContain("width: '24px'");
      expect(compile(code)).toEqual([]);
    });

    it('removes elements and attributes outside the allowlist', () => {
      const doc = docWith([
        createNode({
          tag: 'svg',
          name: 'Bad',
          svg: '<svg viewBox="0 0 1 1" onload="x()"><script>x()</script><path d="M0 0"/></svg>',
        }),
      ]);
      const { code } = exportReact(doc, { nodeId: 'fr_test0001' });
      expect(code).not.toContain('script');
      expect(code).not.toContain('onLoad');
      expect(code).toContain('<path d="M0 0" />');
    });

    it('with tailwind the root svg gets className', () => {
      const doc = docWith([
        createNode({ tag: 'svg', name: 'Icon', svg, style: { width: '24px', height: '24px' } }),
      ]);
      const { code } = exportReact(doc, { nodeId: 'fr_test0001' });
      expect(code).toContain('className="size-6"');
      expect(compile(code)).toEqual([]);
    });
  });

  describe('compiles with strict tsc', () => {
    it.each(['fr_d3sk1440', 'fr_m0b10390', 'fr_c4rds800'])('%s with tailwind', (id) => {
      expect(compile(exportReact(landing, { nodeId: id }).code)).toEqual([]);
    });
    it.each(['fr_d3sk1440', 'fr_m0b10390', 'fr_c4rds800'])('%s with inline styles', (id) => {
      expect(compile(exportReact(landing, { nodeId: id, styles: 'inline' }).code)).toEqual([]);
    });
    it('without extracting repeats', () => {
      expect(
        compile(exportReact(landing, { nodeId: 'fr_d3sk1440', extractRepeats: false }).code),
      ).toEqual([]);
    });
    it('inner node (not a frame) and a name with accents/digits', () => {
      const r = exportReact(landing, { nodeId: 'el_dsk00026' });
      expect(r.componentName).toBe('Cards');
      expect(compile(r.code)).toEqual([]);
      const d = docWith([]);
      d.pages[0].frames[0].name = '3 Café & More';
      const e = exportReact(d, { nodeId: 'fr_test0001' });
      expect(e.componentName).toBe('Component3CafeMore');
      expect(compile(e.code)).toEqual([]);
    });
  });

  it('throws for a nonexistent node', () => {
    expect(() => exportReact(landing, { nodeId: 'nope' })).toThrow(/not found/);
  });
});
