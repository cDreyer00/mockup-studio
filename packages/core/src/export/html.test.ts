import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createDocument, createNode } from '../document.js';
import { parseDocument } from '../schema.js';
import type { Document, Node } from '../types.js';
import { exportHtml } from './html.js';

const landing = parseDocument(
  fs.readFileSync(new URL('../../../../examples/landing.mockup.json', import.meta.url), 'utf8'),
);

/** Documento com um único frame contendo `children`. */
function docWith(children: Node[], frameStyle: Record<string, string> = {}): Document {
  const doc = createDocument('Teste', { id: 'doc_test' });
  const frame = createNode({
    tag: 'div',
    type: 'frame',
    id: 'fr_test0001',
    name: 'Tela',
    style: { width: '400px', height: '300px', ...frameStyle },
    children,
  });
  doc.pages[0].frames.push(frame);
  return doc;
}

describe('exportHtml', () => {
  it('snapshot do exemplo (classes)', () => {
    expect(exportHtml(landing)).toMatchSnapshot();
  });

  it('snapshot do exemplo (inline)', () => {
    expect(exportHtml(landing, { mode: 'inline' })).toMatchSnapshot();
  });

  it('classes por slug do nome, com sufixo -2, -3 em nomes repetidos', () => {
    const html = exportHtml(landing, { nodeIds: ['fr_d3sk1440'] });
    expect(html).toContain('class="desktop-1440"');
    expect(html).toContain('class="navbar"');
    expect(html).toContain('class="titulo"');
    // "Ícone" aparece 3 vezes (um por card): acentos removidos e sufixos
    expect(html).toContain('.icone {');
    expect(html).toContain('.icone-2 {');
    expect(html).toContain('.icone-3 {');
    expect(html).toContain('.card-design-livre {');
  });

  it('nome que já termina em -2 não colide com o sufixo gerado', () => {
    const doc = docWith([
      createNode({ tag: 'div', name: 'Item 2', style: { color: 'red' } }),
      createNode({ tag: 'div', name: 'Item', style: { color: 'blue' } }),
      createNode({ tag: 'div', name: 'Item', style: { color: 'green' } }),
    ]);
    const html = exportHtml(doc, { fragment: true });
    const classes = [...html.matchAll(/class="([^"]+)"/g)].map((m) => m[1]);
    expect(new Set(classes).size).toBe(classes.length);
  });

  it('tokens em :root, reset e @font-face das fontes embutidas', () => {
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

  it('frame raiz: height vira min-height e a posição do canvas não é exportada', () => {
    const doc = docWith([]);
    doc.pages[0].frames[0].position = { x: 500, y: 700 };
    const html = exportHtml(doc);
    expect(html).toContain('width: 400px;');
    expect(html).toContain('min-height: 300px;');
    expect(html).not.toMatch(/\n\s+height: 300px/);
    expect(html).not.toContain('500px');
  });

  it('filhos absolutos usam node.position como left/top; nós ocultos somem', () => {
    const doc = docWith([
      createNode({
        tag: 'div',
        name: 'Badge',
        style: { position: 'absolute' },
        position: { x: 12, y: 34 },
      }),
      createNode({ tag: 'div', name: 'Fantasma', hidden: true }),
    ]);
    const html = exportHtml(doc, { mode: 'inline', fragment: true });
    expect(html).toContain('left: 12px');
    expect(html).toContain('top: 34px');
    expect(html).not.toContain('Fantasma');
    expect(html.match(/<div/g)).toHaveLength(2);
  });

  it('imagens com src relativo a assets/ e data URL intacta; svg inline sanitizado', () => {
    const doc = docWith([
      createNode({ tag: 'img', name: 'Foto', src: 'foto.png', attrs: { alt: 'Uma foto' } }),
      createNode({ tag: 'img', name: 'Pixel', src: 'data:image/png;base64,AAAA' }),
      createNode({
        tag: 'svg',
        name: 'Ícone',
        svg: '<svg viewBox="0 0 8 8" onload="x()"><script>x()</script><path d="M0 0h8v8z"/></svg>',
        style: { width: '24px' },
      }),
    ]);
    const html = exportHtml(doc, { fragment: true });
    expect(html).toContain('<img src="assets/foto.png" alt="Uma foto">');
    expect(html).toContain('src="data:image/png;base64,AAAA"');
    expect(html).toContain('<svg class="icone"');
    expect(html).not.toContain('script');
    expect(html).not.toContain('onload');
  });

  it('fragmento não tem doctype nem head', () => {
    const html = exportHtml(landing, { fragment: true, nodeIds: ['el_dsk00007'] });
    expect(html.startsWith('<style>')).toBe(true);
    expect(html).not.toContain('<!doctype');
    expect(html).not.toContain('<head>');
    expect(html).toContain('<header class="navbar">');
  });

  it('erra para nó ou página inexistente', () => {
    expect(() => exportHtml(landing, { nodeIds: ['nope'] })).toThrow(/não encontrado/);
    expect(() => exportHtml(landing, { pageId: 'nope' })).toThrow(/não encontrada/);
  });

  it('não altera o documento original', () => {
    const before = JSON.stringify(landing);
    exportHtml(landing);
    expect(JSON.stringify(landing)).toBe(before);
  });
});
