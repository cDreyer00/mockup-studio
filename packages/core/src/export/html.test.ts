import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createDocument, createNode } from '../document.js';
import { parseDocument } from '../schema.js';
import type { Document, Node } from '../types.js';
import { exportHtml } from './html.js';

const landing = parseDocument(
  fs.readFileSync(new URL('../../../../examples/landing.mockup.json', import.meta.url), 'utf8'),
);

/** Document with a single frame containing `children`. */
function docWith(children: Node[], frameStyle: Record<string, string> = {}): Document {
  const doc = createDocument('Test', { id: 'doc_test' });
  const frame = createNode({
    tag: 'div',
    type: 'frame',
    id: 'fr_test0001',
    name: 'Screen',
    style: { width: '400px', height: '300px', ...frameStyle },
    children,
  });
  doc.pages[0].frames.push(frame);
  return doc;
}

describe('exportHtml', () => {
  it('example snapshot (classes)', () => {
    expect(exportHtml(landing)).toMatchSnapshot();
  });

  it('example snapshot (inline)', () => {
    expect(exportHtml(landing, { mode: 'inline' })).toMatchSnapshot();
  });

  it('classes from the name slug, with -2, -3 suffixes for repeated names', () => {
    const html = exportHtml(landing, { nodeIds: ['fr_d3sk1440'] });
    expect(html).toContain('class="desktop-1440"');
    expect(html).toContain('class="navbar"');
    expect(html).toContain('class="title"');
    // "Icon" appears 3 times (one per card): suffixes added
    expect(html).toContain('.icon {');
    expect(html).toContain('.icon-2 {');
    expect(html).toContain('.icon-3 {');
    expect(html).toContain('.card-free-design {');
  });

  it('a name already ending in -2 does not collide with the generated suffix', () => {
    const doc = docWith([
      createNode({ tag: 'div', name: 'Item 2', style: { color: 'red' } }),
      createNode({ tag: 'div', name: 'Item', style: { color: 'blue' } }),
      createNode({ tag: 'div', name: 'Item', style: { color: 'green' } }),
    ]);
    const html = exportHtml(doc, { fragment: true });
    const classes = [...html.matchAll(/class="([^"]+)"/g)].map((m) => m[1]);
    expect(new Set(classes).size).toBe(classes.length);
  });

  it('tokens in :root, reset and @font-face for embedded fonts', () => {
    const doc = docWith([]);
    doc.tokens = { '--color-primary': '#6c5ce7' };
    doc.fonts = [
      { family: 'Inter', source: 'file', files: ['fonts/inter-400.woff2'], weights: [400] },
      { family: 'Arial', source: 'local' },
    ];
    const html = exportHtml(doc);
    expect(html).toContain(':root {\n    --color-primary: #6c5ce7;\n  }');
    expect(html).toContain('*,*::before,*::after{box-sizing:border-box;margin:0}');
    expect(html).toContain('url("assets/fonts/inter-400.woff2")');
    expect(html).not.toContain('Arial');
  });

  it('root frame: height becomes min-height and the canvas position is not exported', () => {
    const doc = docWith([]);
    doc.pages[0].frames[0].position = { x: 500, y: 700 };
    const html = exportHtml(doc);
    expect(html).toContain('width: 400px;');
    expect(html).toContain('min-height: 300px;');
    expect(html).not.toMatch(/\n\s+height: 300px/);
    expect(html).not.toContain('500px');
  });

  it('direct child with height:100% becomes min-height of the frame height (does not collapse outside the canvas)', () => {
    const doc = docWith([
      createNode({
        tag: 'div',
        name: 'Wrapper',
        style: { display: 'flex', width: '100%', height: '100%' },
      }),
    ]);
    const html = exportHtml(doc);
    expect(html).toMatch(/\.wrapper \{[^}]*min-height: 300px;/);
    expect(html).not.toMatch(/\.wrapper \{[^}]*\n\s+height: 100%/);
  });

  it('child height:100% is kept when the frame has padding (different usable height)', () => {
    const doc = docWith([createNode({ tag: 'div', name: 'Wrapper', style: { height: '100%' } })], {
      padding: '16px',
    });
    const html = exportHtml(doc);
    expect(html).toMatch(/\.wrapper \{[^}]*height: 100%;/);
  });

  it('absolute children use node.position as left/top; hidden nodes disappear', () => {
    const doc = docWith([
      createNode({
        tag: 'div',
        name: 'Badge',
        style: { position: 'absolute' },
        position: { x: 12, y: 34 },
      }),
      createNode({ tag: 'div', name: 'Ghost', hidden: true }),
    ]);
    const html = exportHtml(doc, { mode: 'inline', fragment: true });
    expect(html).toContain('left: 12px');
    expect(html).toContain('top: 34px');
    expect(html).not.toContain('Ghost');
    expect(html.match(/<div/g)).toHaveLength(2);
  });

  it('images with src relative to assets/ and intact data URL; sanitized inline svg', () => {
    const doc = docWith([
      createNode({ tag: 'img', name: 'Photo', src: 'photo.png', attrs: { alt: 'A photo' } }),
      createNode({ tag: 'img', name: 'Pixel', src: 'data:image/png;base64,AAAA' }),
      createNode({
        tag: 'svg',
        name: 'Icon',
        svg: '<svg viewBox="0 0 8 8" onload="x()"><script>x()</script><path d="M0 0h8v8z"/></svg>',
        style: { width: '24px' },
      }),
    ]);
    const html = exportHtml(doc, { fragment: true });
    expect(html).toContain('<img src="assets/photo.png" alt="A photo">');
    expect(html).toContain('src="data:image/png;base64,AAAA"');
    expect(html).toContain('<svg class="icon"');
    expect(html).not.toContain('script');
    expect(html).not.toContain('onload');
  });

  it('fragment has no doctype or head', () => {
    const html = exportHtml(landing, { fragment: true, nodeIds: ['el_dsk00007'] });
    expect(html.startsWith('<style>')).toBe(true);
    expect(html).not.toContain('<!doctype');
    expect(html).not.toContain('<head>');
    expect(html).toContain('<header class="navbar">');
  });

  it('throws for a nonexistent node or page', () => {
    expect(() => exportHtml(landing, { nodeIds: ['nope'] })).toThrow(/not found/);
    expect(() => exportHtml(landing, { pageId: 'nope' })).toThrow(/not found/);
  });

  it('does not change the original document', () => {
    const before = JSON.stringify(landing);
    exportHtml(landing);
    expect(JSON.stringify(landing)).toBe(before);
  });
});
