import { describe, expect, it } from 'vitest';
import { createDocument, createNode } from '../document.js';
import { scopeSvgIds } from '../svg.js';
import { generateVectorSvg } from '../vector/svg.js';
import type { Node, Vector } from '../types.js';
import { exportHtml } from './html.js';
import type { LayoutNode } from '../layout.js';
import { exportReact } from './react.js';
import { exportSvg } from './svg.js';

const grad = (color: string): Vector => ({
  viewBox: { x: 0, y: 0, width: 10, height: 10 },
  paths: [
    {
      id: 'p1',
      d: 'M0 0H10V10Z',
      fill: {
        type: 'linear',
        stops: [
          { offset: 0, color },
          { offset: 1, color: '#000' },
        ],
      },
    },
  ],
});

function svgNode(id: string, v: Vector): Node {
  return createNode({
    id,
    tag: 'svg',
    type: 'svg',
    name: id,
    svg: generateVectorSvg(v),
    vector: v,
  });
}

function docWith(children: Node[]) {
  const doc = createDocument('Teste', { id: 'doc_test' });
  doc.pages[0].frames.push(
    createNode({ id: 'fr_test0001', tag: 'div', type: 'frame', name: 'Tela', children }),
  );
  return doc;
}

describe('scopeSvgIds', () => {
  it('prefixa ids e reescreve url(#), href e xlink:href', () => {
    const out = scopeSvgIds(
      '<svg><defs><linearGradient id="a"/><linearGradient id="ab"/></defs><path fill="url(#a)" stroke="url(&quot;#ab&quot;)"/><use href="#a"/><use xlink:href="#ab"/><a href="#zzz"/></svg>',
      'n1',
    );
    expect(out).toContain('id="n1-a"');
    expect(out).toContain('id="n1-ab"');
    expect(out).toContain('fill="url(#n1-a)"');
    expect(out).toContain('stroke="url(#n1-ab)"');
    expect(out).toContain('<use href="#n1-a"/>');
    expect(out).toContain('xlink:href="#n1-ab"');
    expect(out).toContain('href="#zzz"');
  });

  it('sem ids devolve igual', () => {
    const m = '<svg><path d="M0 0"/></svg>';
    expect(scopeSvgIds(m, 'x')).toBe(m);
  });
});

describe('ids de gradiente em svgs exportados juntos', () => {
  const doc = docWith([svgNode('sv_aaaaaaaa', grad('#f00')), svgNode('sv_bbbbbbbb', grad('#0f0'))]);

  const check = (text: string): void => {
    const ids = [...text.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]!);
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
    const refs = [...text.matchAll(/url\(#([^)]+)\)/g)].map((m) => m[1]!);
    expect(refs).toHaveLength(2);
    for (const r of refs) expect(ids).toContain(r);
  };

  it('html', () => {
    check(exportHtml(doc));
  });

  it('react', () => {
    check(exportReact(doc, { nodeId: 'fr_test0001', styles: 'inline' }).code);
  });
});

describe('ids de gradiente no export svg', () => {
  const doc = docWith([svgNode('sv_aaaaaaaa', grad('#f00')), svgNode('sv_bbbbbbbb', grad('#0f0'))]);
  const lay = (
    id: string,
    type: 'frame' | 'svg',
    x: number,
    children: LayoutNode[] = [],
  ): LayoutNode => ({
    id,
    name: id,
    type,
    tag: type === 'svg' ? 'svg' : 'div',
    x,
    y: 0,
    width: type === 'svg' ? 50 : 200,
    height: type === 'svg' ? 50 : 100,
    style: {},
    children,
  });
  const layout = lay('fr_test0001', 'frame', 0, [
    lay('sv_aaaaaaaa', 'svg', 0),
    lay('sv_bbbbbbbb', 'svg', 60),
  ]);

  const check = (text: string): void => {
    const ids = [...text.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]!);
    expect(ids.length).toBeGreaterThanOrEqual(2);
    expect(new Set(ids).size).toBe(ids.length);
    for (const m of text.matchAll(/url\(#([^)]+)\)/g)) expect(ids).toContain(m[1]!);
  };

  it('fallback (sem layout)', () => {
    check(exportSvg(doc, { nodeId: 'fr_test0001' }));
  });

  // Falha conhecida (QA fase 7): o export com layout embute cada svg sem prefixar os ids; dois vetores
  // com gradiente ficam com o mesmo `id="g-p1-fill"` e o segundo é pintado com o gradiente do primeiro.
  // Remova o `.fails` quando corrigido.
  it.fails('com layout (render): ids únicos entre vetores', () => {
    check(exportSvg(doc, { nodeId: 'fr_test0001', layout }));
  });
});
