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
  const doc = createDocument('Teste', { id: 'doc_test' });
  doc.pages[0].frames.push(
    createNode({
      tag: 'div',
      type: 'frame',
      id: 'fr_test0001',
      name: 'Minha Tela',
      style: { width: '400px', height: '300px', ...frameStyle },
      children,
    }),
  );
  return doc;
}

/* ---------------- compilação com tsc strict (como num template Vite React TS) ---------------- */

const reactTypes = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../../node_modules/@types/react',
);

/** Diagnósticos de `tsc --strict --noUnusedLocals` para um arquivo TSX. */
function compile(code: string): string[] {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mockup-react-'));
  try {
    const file = path.join(dir, 'Componente.tsx');
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
  it('o compilador de teste detecta erros (sanidade)', () => {
    expect(compile('export const a: number = "x";').length).toBeGreaterThan(0);
    expect(compile('const sobra = 1; export {};').length).toBeGreaterThan(0);
    expect(compile('export const a = <div foo="1" />;').length).toBeGreaterThan(0);
  });

  it('snapshot do Desktop 1440 com Tailwind', () => {
    expect(exportReact(landing, { nodeId: 'fr_d3sk1440' })).toMatchSnapshot();
  });

  it('snapshot do Desktop 1440 com estilos inline', () => {
    expect(exportReact(landing, { nodeId: 'fr_d3sk1440', styles: 'inline' })).toMatchSnapshot();
  });

  it('nome PascalCase do nó, ou componentName; export nomeado e default', () => {
    const a = exportReact(landing, { nodeId: 'fr_d3sk1440' });
    expect(a.componentName).toBe('Desktop1440');
    expect(a.code).toContain('export function Desktop1440() {');
    expect(a.code).toContain('export default Desktop1440;');
    const b = exportReact(landing, { nodeId: 'fr_d3sk1440', componentName: 'Landing' });
    expect(b.componentName).toBe('Landing');
    expect(b.code).toContain('export function Landing() {');
  });

  it('tailwind devolve o tema em css; inline traz reset e @font-face', () => {
    const tw = exportReact(landing, { nodeId: 'fr_d3sk1440' });
    expect(tw.css).toContain('@import "tailwindcss";');
    expect(tw.css).toContain('--color-primary: #6c5ce7;');
    const inline = exportReact(landing, { nodeId: 'fr_d3sk1440', styles: 'inline' });
    expect(inline.css).toContain('box-sizing:border-box');
  });

  it('assetsBase vale também para o @font-face do tema tailwind e do css inline', () => {
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
    const padrao = exportReact(doc, { nodeId: 'fr_d3sk1440' });
    expect(padrao.css).toContain('src:url("assets/fonts/i.woff2")');
  });

  it('inline: style camelCase como string com unidade e tokens no elemento raiz', () => {
    const { code } = exportReact(landing, { nodeId: 'fr_d3sk1440', styles: 'inline' });
    expect(code).toContain("backgroundColor: 'var(--color-bg)'");
    expect(code).toContain("minHeight: '900px'");
    expect(code).toContain("'--color-bg': '#0f1115'");
    expect(code).toContain("'--radius': '12px'");
    expect(code).toContain('as CSSProperties');
    expect(code).toContain("import type { CSSProperties } from 'react';");
    // tokens só no raiz
    expect(code.match(/'--color-bg'/g)).toHaveLength(1);
  });

  describe('repetições', () => {
    it('os cards do exemplo viram array + map', () => {
      const { code } = exportReact(landing, { nodeId: 'fr_d3sk1440' });
      expect(code).toContain('const cardItems = [');
      expect(code).toContain("icone: '🎨'");
      expect(code).toContain("tituloDoCard: 'Rápido'");
      expect(code).toContain('textoDoCard:');
      expect(code).toContain('{cardItems.map((item, index) => (');
      expect(code).toContain('key={index}');
      expect(code).toContain('{item.tituloDoCard}');
      // um único <h3>, no template
      expect(code.match(/<h3/g)).toHaveLength(1);
    });

    it('irmãos com nomes de camada diferentes usam campos text1, text2', () => {
      const { code } = exportReact(landing, { nodeId: 'el_dsk00005' });
      expect(code).toContain('const linksItems = [');
      expect(code).toContain("{ text1: 'Produto' }");
      expect(code).toContain('<a key={index}');
    });

    it('extractRepeats: false mantém os irmãos expandidos', () => {
      const { code } = exportReact(landing, { nodeId: 'fr_d3sk1440', extractRepeats: false });
      expect(code).not.toContain('.map(');
      expect(code.match(/<h3/g)).toHaveLength(3);
    });

    it('irmãos com estruturas diferentes não são extraídos', () => {
      const doc = docWith([
        createNode({ tag: 'p', text: 'a', name: 'A', style: { color: 'red' } }),
        createNode({ tag: 'p', text: 'b', name: 'B', style: { color: 'blue' } }),
      ]);
      expect(exportReact(doc, { nodeId: 'fr_test0001' }).code).not.toContain('.map(');
    });

    it('irmãos idênticos (sem nada que varie) não são extraídos', () => {
      const doc = docWith([
        createNode({ tag: 'p', text: 'igual', name: 'A' }),
        createNode({ tag: 'p', text: 'igual', name: 'A' }),
      ]);
      expect(exportReact(doc, { nodeId: 'fr_test0001' }).code).not.toContain('.map(');
    });

    it('imagens e links variam por src, alt e href', () => {
      const mk = (n: number): Node =>
        createNode({
          tag: 'a',
          name: 'Item',
          attrs: { href: `/p/${n}` },
          children: [
            createNode({ tag: 'img', name: 'Foto', src: `f${n}.png`, attrs: { alt: `Foto ${n}` } }),
          ],
        });
      const doc = docWith([mk(1), mk(2), mk(3)]);
      const { code } = exportReact(doc, { nodeId: 'fr_test0001' });
      expect(code).toContain("fotoSrc: 'assets/f1.png'");
      expect(code).toContain("fotoAlt: 'Foto 2'");
      expect(code).toContain('href={item.');
      expect(code).toContain('src={item.fotoSrc}');
      expect(compile(code)).toEqual([]);
    });
  });

  describe('texto', () => {
    const textOf = (text: string, style: Record<string, string> = {}): string =>
      exportReact(docWith([createNode({ tag: 'p', name: 'P', text, style })]), {
        nodeId: 'fr_test0001',
      }).code;

    it('escapa chaves, sinais de menor/maior e e comercial', () => {
      const code = textOf('a {b} <c> & d');
      expect(code).toContain("a {'{'}b{'}'} {'<'}c{'>'} &amp; d");
      expect(compile(code)).toEqual([]);
    });

    it('quebra de linha com white-space pre-wrap vira {"\\n"}', () => {
      const code = textOf('linha 1\nlinha 2', { 'white-space': 'pre-wrap' });
      expect(code).toContain('linha 1');
      expect(code).toContain("{'\\n'}");
      expect(code).not.toContain('<br />');
      expect(compile(code)).toEqual([]);
    });

    it('quebra de linha sem white-space vira <br />', () => {
      const code = textOf('linha 1\nlinha 2');
      expect(code).toContain('<br />');
      expect(compile(code)).toEqual([]);
    });

    it('espaços nas bordas viram expressão para o JSX não os engolir', () => {
      const code = textOf(' olá ');
      expect(code).toContain("{' olá '}");
    });
  });

  describe('atributos', () => {
    it('class/for/booleanos/aria/data/href', () => {
      const doc = docWith([
        createNode({
          tag: 'label',
          name: 'Rótulo',
          text: 'Nome',
          attrs: { for: 'nome', 'data-x': '1' },
        }),
        createNode({
          tag: 'input',
          name: 'Campo',
          attrs: {
            id: 'nome',
            type: 'text',
            disabled: '',
            readonly: '',
            maxlength: '10',
            tabindex: '0',
            'aria-label': 'Nome',
            value: 'x',
            onclick: 'alert(1)',
            foo: 'bar',
          },
        }),
        createNode({
          tag: 'a',
          name: 'Link',
          text: 'ir',
          attrs: { href: 'https://example.com', target: '_blank', 'aria-label': 'Ir' },
        }),
        createNode({ tag: 'a', name: 'Mal', text: 'x', attrs: { href: 'javascript:alert(1)' } }),
        createNode({ tag: 'br', name: 'Quebra' }),
      ]);
      const { code } = exportReact(doc, { nodeId: 'fr_test0001' });
      expect(code).toContain('htmlFor="nome"');
      expect(code).toContain('data-x="1"');
      expect(code).toContain('disabled');
      expect(code).toContain('readOnly');
      expect(code).toContain('maxLength={10}');
      expect(code).toContain('tabIndex={0}');
      expect(code).toContain('aria-label="Nome"');
      expect(code).toContain('defaultValue="x"');
      expect(code).toContain('href="https://example.com"');
      expect(code).toContain('<br />');
      expect(code).not.toContain('onclick');
      expect(code).not.toContain('javascript:');
      expect(code).not.toContain('foo=');
      expect(code).not.toContain('class=');
      expect(compile(code)).toEqual([]);
    });

    it('imagens: src relativo a assets/, assetsBase e alt', () => {
      const doc = docWith([
        createNode({ tag: 'img', name: 'Foto', src: 'foto.png', attrs: { alt: 'Descrição' } }),
        createNode({ tag: 'img', name: 'Pixel', src: 'data:image/png;base64,AAAA' }),
      ]);
      const a = exportReact(doc, { nodeId: 'fr_test0001' }).code;
      expect(a).toContain('src="assets/foto.png"');
      expect(a).toContain('alt="Descrição"');
      expect(a).toContain('src="data:image/png;base64,AAAA"');
      expect(a).toContain('alt=""');
      const b = exportReact(doc, { nodeId: 'fr_test0001', assetsBase: '/img/' }).code;
      expect(b).toContain('src="/img/foto.png"');
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
      '<text x="1" y="2">Olá &amp; {tchau}</text>',
      '</g></svg>',
    ].join('');

    it('converte atributos para camelCase e style string para objeto', () => {
      const doc = docWith([
        createNode({ tag: 'svg', name: 'Ícone', svg, style: { width: '24px', height: '24px' } }),
      ]);
      const { code } = exportReact(doc, { nodeId: 'fr_test0001', styles: 'inline' });
      expect(code).toContain('strokeWidth="2"');
      expect(code).toContain('strokeLinecap="round"');
      expect(code).toContain('fillRule="evenodd"');
      expect(code).toContain('stopColor="#fff"');
      expect(code).toContain('xlinkHref="#g"');
      expect(code).toContain('xmlnsXlink=');
      expect(code).toContain('className="p"');
      expect(code).toContain("style={{ fill: 'url(#g)', strokeWidth: '1' }}");
      expect(code).toContain('<linearGradient id="g">');
      expect(code).toContain("Olá &amp; {'{'}tchau{'}'}");
      // class/style do <svg> raiz vêm do nó, não do markup
      expect(code).not.toContain('className="ic"');
      expect(code).toContain("width: '24px'");
      expect(compile(code)).toEqual([]);
    });

    it('remove elementos e atributos fora da lista de permissão', () => {
      const doc = docWith([
        createNode({
          tag: 'svg',
          name: 'Mal',
          svg: '<svg viewBox="0 0 1 1" onload="x()"><script>x()</script><path d="M0 0"/></svg>',
        }),
      ]);
      const { code } = exportReact(doc, { nodeId: 'fr_test0001' });
      expect(code).not.toContain('script');
      expect(code).not.toContain('onLoad');
      expect(code).toContain('<path d="M0 0" />');
    });

    it('com tailwind o svg raiz recebe className', () => {
      const doc = docWith([
        createNode({ tag: 'svg', name: 'Ícone', svg, style: { width: '24px', height: '24px' } }),
      ]);
      const { code } = exportReact(doc, { nodeId: 'fr_test0001' });
      expect(code).toContain('className="size-6"');
      expect(compile(code)).toEqual([]);
    });
  });

  describe('compila com tsc strict', () => {
    it.each(['fr_d3sk1440', 'fr_m0b10390', 'fr_c4rds800'])('%s com tailwind', (id) => {
      expect(compile(exportReact(landing, { nodeId: id }).code)).toEqual([]);
    });
    it.each(['fr_d3sk1440', 'fr_m0b10390', 'fr_c4rds800'])('%s com estilos inline', (id) => {
      expect(compile(exportReact(landing, { nodeId: id, styles: 'inline' }).code)).toEqual([]);
    });
    it('sem extrair repetições', () => {
      expect(
        compile(exportReact(landing, { nodeId: 'fr_d3sk1440', extractRepeats: false }).code),
      ).toEqual([]);
    });
    it('nó interno (não frame) e nome com acentos/dígitos', () => {
      const r = exportReact(landing, { nodeId: 'el_dsk00026' });
      expect(r.componentName).toBe('Cards');
      expect(compile(r.code)).toEqual([]);
      const d = docWith([]);
      d.pages[0].frames[0].name = '3 Ações & Mais';
      const e = exportReact(d, { nodeId: 'fr_test0001' });
      expect(e.componentName).toBe('Component3AcoesMais');
      expect(compile(e.code)).toEqual([]);
    });
  });

  it('erra para nó inexistente', () => {
    expect(() => exportReact(landing, { nodeId: 'nope' })).toThrow(/não encontrado/);
  });
});
