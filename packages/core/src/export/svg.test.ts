import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createDocument, createNode } from '../document.js';
import type { LayoutNode } from '../layout.js';
import { parseDocument } from '../schema.js';
import { exportSvg } from './svg.js';

const landing = parseDocument(
  fs.readFileSync(new URL('../../../../examples/landing.mockup.json', import.meta.url), 'utf8'),
);

const box = (
  id: string,
  type: LayoutNode['type'],
  x: number,
  y: number,
  width: number,
  height: number,
  style: LayoutNode['style'] = {},
  extra: Partial<LayoutNode> = {},
): LayoutNode => ({
  id,
  name: id,
  type,
  tag: 'div',
  x,
  y,
  width,
  height,
  style,
  children: [],
  ...extra,
});

/** Documento mínimo com o nó SVG usado no layout à mão. */
function docWithSvgNode(): ReturnType<typeof createDocument> {
  const doc = createDocument('Teste', { id: 'doc_test' });
  doc.pages[0].frames.push(
    createNode({
      tag: 'div',
      type: 'frame',
      id: 'fr_root0001',
      name: 'Raiz',
      children: [
        createNode({
          tag: 'svg',
          id: 'sv_icon0001',
          name: 'Ícone',
          svg: '<svg viewBox="0 0 10 10" onload="x()"><script>x()</script><path d="M0 0h10v10z" fill="currentColor"/></svg>',
        }),
      ],
    }),
  );
  return doc;
}

describe('exportSvg (fallback sem layout)', () => {
  it('snapshot: foreignObject com o HTML inline do Mobile 390', () => {
    expect(exportSvg(landing, { nodeId: 'fr_m0b10390' })).toMatchSnapshot();
  });

  it('usa o tamanho declarado no estilo (padrão 100x100) e mantém height', () => {
    const svg = exportSvg(landing, { nodeId: 'fr_m0b10390' });
    expect(svg).toContain('width="390" height="844" viewBox="0 0 390 844"');
    expect(svg).toContain('<foreignObject');
    expect(svg).toContain('height: 844px');
    expect(svg).not.toContain('min-height');
    const small = exportSvg(landing, { nodeId: 'el_mob00003' });
    expect(small).toContain('width="100" height="100"');
  });

  it('tokens no wrapper, reset e XHTML válido (void tags fechadas)', () => {
    const doc = docWithSvgNode();
    doc.tokens = { '--cor': '#f00' };
    doc.pages[0].frames[0].style = { width: '50px', height: '20px' };
    doc.pages[0].frames[0].children.push(
      createNode({ tag: 'img', name: 'Foto', src: 'a.png' }),
      createNode({ tag: 'br', name: 'Br' }),
    );
    const svg = exportSvg(doc, {
      nodeId: 'fr_root0001',
      resolveImage: () => 'data:image/png;base64,QQ==',
    });
    expect(svg).toContain('style="--cor: #f00"');
    expect(svg).toContain('xmlns="http://www.w3.org/1999/xhtml"');
    expect(svg).toContain('<img src="data:image/png;base64,QQ==" />');
    expect(svg).toContain('<br />');
    expect(svg).toContain('*{box-sizing:border-box;margin:0}');
    expect(svg).not.toContain('onload');
    expect(svg).not.toContain('<script');
  });

  it('erra para nó inexistente', () => {
    expect(() => exportSvg(landing, { nodeId: 'nope' })).toThrow(/não encontrado/);
  });
});

describe('exportSvg (com layout medido)', () => {
  it('cabeçalho com width/height/viewBox do nó raiz e coordenadas relativas a ele', () => {
    const root = box('fr_root0001', 'frame', 100, 50, 200, 120, {
      'background-color': 'rgb(15, 17, 21)',
    });
    root.children.push(
      box('a', 'element', 110, 60, 40, 30, { 'background-color': 'rgb(255, 0, 0)' }),
    );
    const svg = exportSvg(docWithSvgNode(), { nodeId: 'fr_root0001', layout: root });
    expect(svg).toContain('width="200" height="120" viewBox="0 0 200 120"');
    expect(svg).toContain('<rect x="0" y="0" width="200" height="120" fill="rgb(15,17,21)"/>');
    expect(svg).toContain('<rect x="10" y="10" width="40" height="30" fill="rgb(255,0,0)"/>');
  });

  it('rect com raio igual (rx), raios diferentes (path) e fill-opacity para rgba', () => {
    const root = box('fr_root0001', 'frame', 0, 0, 200, 200);
    root.children.push(
      box('a', 'element', 0, 0, 100, 40, {
        'background-color': 'rgba(0, 0, 0, 0.5)',
        'border-top-left-radius': '8px',
        'border-top-right-radius': '8px',
        'border-bottom-right-radius': '8px',
        'border-bottom-left-radius': '8px',
      }),
      box('b', 'element', 0, 50, 100, 40, {
        'background-color': 'rgb(0, 128, 0)',
        'border-top-left-radius': '12px',
        'border-top-right-radius': '12px',
        'border-bottom-right-radius': '0px',
        'border-bottom-left-radius': '0px',
      }),
    );
    const svg = exportSvg(docWithSvgNode(), { nodeId: 'fr_root0001', layout: root });
    expect(svg).toContain(
      '<rect x="0" y="0" width="100" height="40" rx="8" fill="rgb(0,0,0)" fill-opacity="0.5"/>',
    );
    expect(svg).toMatch(
      /<path d="M12,50 H88 A12,12 0 0 1 100,62 V90 H0 V62 A12,12 0 0 1 12,50 Z" fill="rgb\(0,128,0\)"\/>/,
    );
  });

  it('gradiente linear vira <linearGradient> e preenche o rect', () => {
    const root = box('fr_root0001', 'frame', 0, 0, 100, 100, {
      'background-image': 'linear-gradient(90deg, rgb(255, 0, 0), rgba(0, 0, 255, 0.5) 80%)',
    });
    const svg = exportSvg(docWithSvgNode(), { nodeId: 'fr_root0001', layout: root });
    expect(svg).toContain(
      '<linearGradient id="grad1" gradientUnits="userSpaceOnUse" x1="0" y1="50" x2="100" y2="50">',
    );
    expect(svg).toContain('<stop offset="0" stop-color="rgb(255,0,0)"/>');
    expect(svg).toContain('<stop offset="0.8" stop-color="rgb(0,0,255)" stop-opacity="0.5"/>');
    expect(svg).toContain('fill="url(#grad1)"');
  });

  it('gradiente não suportado é ignorado sem quebrar', () => {
    const root = box('fr_root0001', 'frame', 0, 0, 100, 100, {
      'background-image': 'radial-gradient(red, blue)',
    });
    const svg = exportSvg(docWithSvgNode(), { nodeId: 'fr_root0001', layout: root });
    expect(svg).not.toContain('Gradient');
  });

  it('borda uniforme vira stroke recuado de meia largura', () => {
    const root = box('fr_root0001', 'frame', 0, 0, 100, 60);
    root.children.push(
      box('a', 'element', 10, 10, 80, 40, {
        'border-top-width': '4px',
        'border-right-width': '4px',
        'border-bottom-width': '4px',
        'border-left-width': '4px',
        'border-top-color': 'rgb(255, 255, 255)',
        'border-right-color': 'rgb(255, 255, 255)',
        'border-bottom-color': 'rgb(255, 255, 255)',
        'border-left-color': 'rgb(255, 255, 255)',
        'border-top-style': 'solid',
        'border-right-style': 'solid',
        'border-bottom-style': 'solid',
        'border-left-style': 'solid',
        'border-top-left-radius': '10px',
        'border-top-right-radius': '10px',
        'border-bottom-right-radius': '10px',
        'border-bottom-left-radius': '10px',
      }),
    );
    const svg = exportSvg(docWithSvgNode(), { nodeId: 'fr_root0001', layout: root });
    expect(svg).toContain(
      '<rect x="12" y="12" width="76" height="36" rx="8" fill="none" stroke="rgb(255,255,255)" stroke-width="4"/>',
    );
  });

  it('borda só em um lado vira faixa preenchida', () => {
    const root = box('fr_root0001', 'frame', 0, 0, 100, 60);
    root.children.push(
      box('a', 'element', 0, 0, 100, 60, {
        'border-bottom-width': '2px',
        'border-bottom-color': 'rgb(0, 0, 0)',
        'border-bottom-style': 'solid',
        'border-top-width': '0px',
        'border-left-width': '0px',
        'border-right-width': '0px',
      }),
    );
    const svg = exportSvg(docWithSvgNode(), { nodeId: 'fr_root0001', layout: root });
    expect(svg).toContain('<rect x="0" y="58" width="100" height="2" fill="rgb(0,0,0)"/>');
  });

  it('box-shadow vira filter com feDropShadow aplicado ao fundo', () => {
    const root = box('fr_root0001', 'frame', 0, 0, 100, 60);
    root.children.push(
      box('a', 'element', 10, 10, 50, 30, {
        'background-color': 'rgb(255, 255, 255)',
        'box-shadow': 'rgba(0, 0, 0, 0.2) 0px 2px 8px 0px',
      }),
    );
    const svg = exportSvg(docWithSvgNode(), { nodeId: 'fr_root0001', layout: root });
    expect(svg).toContain('<filter id="shadow1"');
    expect(svg).toContain(
      '<feDropShadow dx="0" dy="2" stdDeviation="4" flood-color="rgb(0,0,0)" flood-opacity="0.2"/>',
    );
    expect(svg).toContain('filter="url(#shadow1)"');
  });

  it('texto: um <text> por linha em x, y + baseline, com fonte e cor', () => {
    const root = box('fr_root0001', 'frame', 0, 0, 200, 100);
    root.children.push(
      box(
        't',
        'text',
        10,
        20,
        120,
        40,
        {
          color: 'rgb(232, 232, 238)',
          'font-family': '"Inter", system-ui, sans-serif',
          'font-size': '16px',
          'font-weight': '700',
          'font-style': 'italic',
          'letter-spacing': '1px',
          'text-decoration-line': 'underline',
          'text-transform': 'uppercase',
        },
        {
          lines: [
            { text: 'Olá & <mundo>', x: 10, y: 20, width: 100, height: 20, baseline: 15 },
            { text: 'segunda linha', x: 10, y: 40, width: 100, height: 20, baseline: 15 },
          ],
        },
      ),
    );
    const svg = exportSvg(docWithSvgNode(), { nodeId: 'fr_root0001', layout: root });
    const texts = svg.match(/<text [^>]*>[^<]*<\/text>/g) ?? [];
    expect(texts).toHaveLength(2);
    expect(texts[0]).toContain('x="10" y="35"');
    expect(texts[1]).toContain('x="10" y="55"');
    expect(texts[0]).toContain('font-family="&quot;Inter&quot;, system-ui, sans-serif"');
    expect(texts[0]).toContain('font-size="16"');
    expect(texts[0]).toContain('font-weight="700"');
    expect(texts[0]).toContain('font-style="italic"');
    expect(texts[0]).toContain('letter-spacing="1"');
    expect(texts[0]).toContain('text-decoration="underline"');
    expect(texts[0]).toContain('fill="rgb(232,232,238)"');
    expect(texts[0]).toContain('>OLÁ &amp; &lt;MUNDO&gt;</text>');
    expect(texts[1]).toContain('>SEGUNDA LINHA</text>');
  });

  it('imagem com resolveImage e preserveAspectRatio conforme object-fit', () => {
    const root = box('fr_root0001', 'frame', 0, 0, 200, 100);
    const img = (id: string, fit?: string): LayoutNode =>
      box(id, 'image', 0, 0, 50, 50, fit ? { 'object-fit': fit } : {}, {
        tag: 'img',
        src: 'foto.png',
      });
    root.children.push(img('a', 'cover'), img('b', 'contain'), img('c'));
    const svg = exportSvg(docWithSvgNode(), {
      nodeId: 'fr_root0001',
      layout: root,
      resolveImage: (src) => (src === 'foto.png' ? 'data:image/png;base64,AAAA' : undefined),
    });
    const images = svg.match(/<image [^>]*\/>/g) ?? [];
    expect(images).toHaveLength(3);
    expect(images[0]).toContain('href="data:image/png;base64,AAAA"');
    expect(images[0]).toContain('preserveAspectRatio="xMidYMid slice"');
    expect(images[1]).toContain('preserveAspectRatio="xMidYMid meet"');
    expect(images[2]).toContain('preserveAspectRatio="none"');
    // sem resolveImage o src original é mantido
    const raw = exportSvg(docWithSvgNode(), { nodeId: 'fr_root0001', layout: root });
    expect(raw).toContain('href="foto.png"');
  });

  it('overflow hidden vira clipPath (com raio) aplicado aos filhos', () => {
    const root = box('fr_root0001', 'frame', 0, 0, 100, 100);
    const card = box('card', 'element', 10, 10, 60, 60, {
      overflow: 'hidden',
      'border-top-left-radius': '6px',
      'border-top-right-radius': '6px',
      'border-bottom-right-radius': '6px',
      'border-bottom-left-radius': '6px',
    });
    card.children.push(
      box('in', 'element', 0, 0, 200, 200, { 'background-color': 'rgb(1, 2, 3)' }),
    );
    root.children.push(card);
    const svg = exportSvg(docWithSvgNode(), { nodeId: 'fr_root0001', layout: root });
    expect(svg).toContain(
      '<clipPath id="clip1"><rect x="10" y="10" width="60" height="60" rx="6"/></clipPath>',
    );
    expect(svg).toContain('<g clip-path="url(#clip1)">');
    expect(svg.indexOf('<g clip-path')).toBeLessThan(svg.indexOf('fill="rgb(1,2,3)"'));
  });

  it('opacity vira <g opacity>; invisíveis são ignorados', () => {
    const root = box('fr_root0001', 'frame', 0, 0, 100, 100);
    root.children.push(
      box('a', 'element', 0, 0, 10, 10, { 'background-color': 'rgb(1, 1, 1)', opacity: '0.5' }),
      box('b', 'element', 0, 0, 10, 10, { 'background-color': 'rgb(2, 2, 2)', opacity: '0' }),
      box('c', 'element', 0, 0, 10, 10, { 'background-color': 'rgb(3, 3, 3)', display: 'none' }),
      box('d', 'element', 0, 0, 10, 10, {
        'background-color': 'rgb(4, 4, 4)',
        visibility: 'hidden',
      }),
    );
    const svg = exportSvg(docWithSvgNode(), { nodeId: 'fr_root0001', layout: root });
    expect(svg).toContain('<g opacity="0.5">');
    expect(svg).toContain('rgb(1,1,1)');
    expect(svg).not.toContain('rgb(2,2,2)');
    expect(svg).not.toContain('rgb(3,3,3)');
    expect(svg).not.toContain('rgb(4,4,4)');
  });

  it('nós svg viram <svg> aninhado com markup sanitizado', () => {
    const root = box('fr_root0001', 'frame', 0, 0, 100, 100);
    root.children.push(
      box('sv_icon0001', 'svg', 20, 30, 24, 24, { color: 'rgb(255, 0, 0)' }, { tag: 'svg' }),
    );
    const svg = exportSvg(docWithSvgNode(), { nodeId: 'fr_root0001', layout: root });
    expect(svg).toMatch(/<svg [^>]*x="20"[^>]*y="30"[^>]*width="24"[^>]*height="24"/);
    expect(svg).toContain('viewBox="0 0 10 10"');
    expect(svg).toContain('color="rgb(255,0,0)"');
    expect(svg).toContain('<path d="M0 0h10v10z" fill="currentColor"/>');
    expect(svg).not.toContain('script');
    expect(svg).not.toContain('onload');
  });

  it('fontes embutidas viram @font-face com data URL quando resolveImage resolve o arquivo', () => {
    const doc = docWithSvgNode();
    doc.fonts = [
      {
        family: 'Inter',
        source: 'file',
        files: ['fonts/a.woff2', 'fonts/b.woff2'],
        weights: [400, 700],
      },
    ];
    const root = box('fr_root0001', 'frame', 0, 0, 10, 10);
    const svg = exportSvg(doc, {
      nodeId: 'fr_root0001',
      layout: root,
      resolveImage: (f) => (f === 'fonts/b.woff2' ? 'data:font/woff2;base64,Zm9v' : undefined),
    });
    expect(svg).toContain(
      '<style>@font-face{font-family:"Inter";src:url("data:font/woff2;base64,Zm9v")',
    );
    expect(svg).toContain('font-weight:700');
    expect(svg).not.toContain('fonts/a.woff2');
  });

  it('o nó raiz do exemplo, escapando XML em atributos', () => {
    const root = box('fr_root0001', 'frame', 0, 0, 10, 10, { 'background-color': 'rgb(0, 0, 0)' });
    const svg = exportSvg(docWithSvgNode(), { nodeId: 'fr_root0001', layout: root });
    expect(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg"')).toBe(true);
    expect(svg.trimEnd().endsWith('</svg>')).toBe(true);
  });
});
