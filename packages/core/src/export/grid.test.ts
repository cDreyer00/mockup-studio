import { describe, expect, it } from 'vitest';
import { createDocument, createNode } from '../document.js';
import { gridContainerStyles, gridPlacementStyles } from '../grid.js';
import type { Document, Node } from '../types.js';
import { exportHtml } from './html.js';
import { exportReact } from './react.js';
import { cssToTailwind, exportTailwind } from './tailwind.js';

function gridDoc(): Document {
  const kids: Node[] = [
    createNode({
      tag: 'header',
      name: 'Topo',
      style: gridPlacementStyles({ area: 'header' }),
    }),
    createNode({
      tag: 'div',
      name: 'Destaque',
      style: gridPlacementStyles({ column: 2, columnSpan: 3, row: 1 }),
    }),
    createNode({ tag: 'div', name: 'Item', style: gridPlacementStyles({ rowSpan: 2 }) }),
  ];
  const doc = createDocument('Teste', { id: 'doc_test' });
  doc.pages[0].frames.push(
    createNode({
      tag: 'div',
      type: 'frame',
      id: 'fr_test0001',
      name: 'Grade',
      style: {
        width: '600px',
        height: '300px',
        ...gridContainerStyles({
          columns: 3,
          rows: ['100px', '1fr'],
          columnGap: 16,
          rowGap: 8,
          areas: ['header header header', 'side main main'],
          placeItems: 'center',
          autoFlow: 'row dense',
        }),
      },
      children: kids,
    }),
  );
  return doc;
}

describe('exportação de grid: HTML', () => {
  it('usa CSS real de grid, áreas com aspas e posicionamento dos filhos', () => {
    const html = exportHtml(gridDoc(), { mode: 'inline', fragment: true });
    expect(html).toContain('display: grid');
    expect(html).toContain('grid-template-columns: repeat(3, minmax(0, 1fr))');
    expect(html).toContain('grid-template-rows: 100px 1fr');
    expect(html).toContain('column-gap: 16px');
    expect(html).toContain('row-gap: 8px');
    expect(html).toContain(
      'grid-template-areas: &quot;header header header&quot; &quot;side main main&quot;',
    );
    expect(html).toContain('grid-area: header');
    expect(html).toContain('grid-column: 2 / span 3');
    expect(html).toContain('grid-row: span 2');
    expect(html).toContain('place-items: center');
    expect(html).toContain('grid-auto-flow: row dense');
  });

  it('em classes o CSS fica nas regras', () => {
    const html = exportHtml(gridDoc(), { fragment: true });
    expect(html).toContain('grid-template-columns: repeat(3, minmax(0, 1fr));');
    expect(html).toContain('grid-column: 2 / span 3;');
    expect(html).toContain('grid-template-areas: "header header header" "side main main";');
  });
});

describe('exportação de grid: Tailwind', () => {
  it.each<[string, Record<string, string>, string[]]>([
    ['colunas iguais', { 'grid-template-columns': 'repeat(3, minmax(0, 1fr))' }, ['grid-cols-3']],
    [
      'colunas iguais sem espaços',
      { 'grid-template-columns': 'repeat(4,minmax(0,1fr))' },
      ['grid-cols-4'],
    ],
    [
      'repeat com 1fr não é grid-cols-N',
      { 'grid-template-columns': 'repeat(3, 1fr)' },
      ['grid-cols-[repeat(3,1fr)]'],
    ],
    ['colunas arbitrárias', { 'grid-template-columns': '200px 1fr' }, ['grid-cols-[200px_1fr]']],
    [
      'minmax',
      { 'grid-template-columns': 'minmax(120px, 1fr) 2fr' },
      ['grid-cols-[minmax(120px,1fr)_2fr]'],
    ],
    ['linhas', { 'grid-template-rows': 'repeat(2, minmax(0, 1fr))' }, ['grid-rows-2']],
    ['sem trilhas', { 'grid-template-columns': 'none' }, ['grid-cols-none']],
    ['col-span', { 'grid-column': 'span 3' }, ['col-span-3']],
    ['col fixo', { 'grid-column': '2' }, ['col-2']],
    ['coluna inteira', { 'grid-column': '1 / -1' }, ['col-span-full']],
    ['início e span', { 'grid-column': '2 / span 3' }, ['col-[2/span_3]']],
    ['row-span', { 'grid-row': 'span 2' }, ['row-span-2']],
    ['row início e span', { 'grid-row': '1 / span 2' }, ['row-[1/span_2]']],
    ['col-start', { 'grid-column-start': '3' }, ['col-start-3']],
    ['row-end', { 'grid-row-end': 'auto' }, ['row-end-auto']],
    ['gap x/y', { 'column-gap': '16px', 'row-gap': '8px' }, ['gap-x-4', 'gap-y-2']],
    ['gap duplo', { gap: '8px 16px' }, ['gap-y-2', 'gap-x-4']],
    ['place-items', { 'place-items': 'center' }, ['place-items-center']],
    ['justify-items', { 'justify-items': 'start' }, ['justify-items-start']],
    ['fluxo', { 'grid-auto-flow': 'column' }, ['grid-flow-col']],
    ['fluxo denso', { 'grid-auto-flow': 'row dense' }, ['grid-flow-row-dense']],
    ['auto-rows', { 'grid-auto-rows': 'min-content' }, ['auto-rows-min']],
    ['auto-rows arbitrário', { 'grid-auto-rows': '120px' }, ['auto-rows-[120px]']],
    ['auto-cols fr', { 'grid-auto-columns': 'minmax(0, 1fr)' }, ['auto-cols-fr']],
    [
      'áreas',
      { 'grid-template-areas': '"header header" "side main"' },
      ['[grid-template-areas:"header_header"_"side_main"]'],
    ],
    ['área', { 'grid-area': 'header' }, ['[grid-area:header]']],
  ])('%s', (_name, style, expected) => {
    const { classes, rest } = cssToTailwind(style);
    expect(classes).toEqual(expected);
    expect(rest).toEqual({});
  });

  it('exporta o documento com classes de grid', () => {
    const html = exportTailwind(gridDoc(), { fragment: true });
    expect(html).toContain('grid-cols-3');
    expect(html).toContain('grid-rows-[100px_1fr]');
    expect(html).toContain('gap-x-4');
    expect(html).toContain('gap-y-2');
    expect(html).toContain('col-[2/span_3]');
    expect(html).toContain('row-span-2');
    expect(html).toContain('place-items-center');
    expect(html).toContain('grid-flow-row-dense');
    expect(html).toContain('[grid-area:header]');
    expect(html).toContain('[grid-template-areas:');
  });
});

describe('exportação de grid: React', () => {
  it('Tailwind: className com as classes de grid', () => {
    const { code } = exportReact(gridDoc(), { nodeId: 'fr_test0001', extractRepeats: false });
    expect(code).toContain('grid-cols-3');
    expect(code).toContain('col-[2/span_3]');
    expect(code).toContain('row-span-2');
    expect(code).toContain('[grid-area:header]');
  });

  it('inline: style com as propriedades de grid', () => {
    const { code } = exportReact(gridDoc(), {
      nodeId: 'fr_test0001',
      styles: 'inline',
      extractRepeats: false,
    });
    expect(code).toContain("display: 'grid'");
    expect(code).toContain("gridTemplateColumns: 'repeat(3, minmax(0, 1fr))'");
    expect(code).toContain("gridTemplateRows: '100px 1fr'");
    expect(code).toContain('gridTemplateAreas: \'"header header header" "side main main"\'');
    expect(code).toContain("gridColumn: '2 / span 3'");
    expect(code).toContain("gridArea: 'header'");
    expect(code).toContain("columnGap: '16px'");
  });
});
