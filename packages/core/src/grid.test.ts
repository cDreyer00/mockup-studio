import { describe, expect, it } from 'vitest';
import { createNode } from './document.js';
import {
  cellAt,
  cellRect,
  equalTracks,
  formatGridTracks,
  gridAreaNames,
  gridContainerStyles,
  gridPlacementStyles,
  isGridContainer,
  layoutTracks,
  parseGridAreas,
  parseGridPlacement,
  parseTrack,
  parseTrackList,
  resolveTrackSizes,
  serializeGridAreas,
  serializeTrackList,
  spanFromRect,
  trackCount,
  validateGridAreas,
} from './grid.js';
import type { LayoutGrid } from './layout.js';
import { getTreeSummary } from './summary.js';

const kinds = (v: string): string[] => parseTrackList(v).map((t) => t.kind);

describe('parseTrack / parseTrackList', () => {
  it('classifica cada tipo de trilha', () => {
    expect(parseTrack('1fr')).toMatchObject({ kind: 'fr', value: '1fr', amount: 1 });
    expect(parseTrack('2.5fr')).toMatchObject({ kind: 'fr', amount: 2.5 });
    expect(parseTrack('200px')).toMatchObject({ kind: 'px', value: '200px', amount: 200 });
    expect(parseTrack('0')).toMatchObject({ kind: 'px', value: '0' });
    expect(parseTrack('50%')).toMatchObject({ kind: 'percent', amount: 50 });
    expect(parseTrack('AUTO').kind).toBe('auto');
    expect(parseTrack('min-content').kind).toBe('min-content');
    expect(parseTrack('max-content').kind).toBe('max-content');
    expect(parseTrack('fit-content(200px)')).toMatchObject({
      kind: 'fit-content',
      value: 'fit-content(200px)',
    });
    expect(parseTrack('minmax(120px,1fr)')).toEqual({
      kind: 'minmax',
      value: 'minmax(120px, 1fr)',
      min: '120px',
      max: '1fr',
    });
    expect(parseTrack('10rem').kind).toBe('other');
    expect(parseTrack('calc(100% - 20px)').kind).toBe('other');
  });

  it('lista simples, vazia e none', () => {
    expect(kinds('200px 1fr auto')).toEqual(['px', 'fr', 'auto']);
    expect(parseTrackList('none')).toEqual([]);
    expect(parseTrackList('')).toEqual([]);
    expect(parseTrackList(undefined)).toEqual([]);
  });

  it('expande repeat(n, ...) inclusive com várias trilhas e minmax', () => {
    expect(parseTrackList('repeat(3, 1fr)').map((t) => t.value)).toEqual(['1fr', '1fr', '1fr']);
    expect(parseTrackList('repeat(2, 100px 1fr) auto').map((t) => t.value)).toEqual([
      '100px',
      '1fr',
      '100px',
      '1fr',
      'auto',
    ]);
    const t = parseTrackList('repeat(2, minmax(0, 1fr))');
    expect(t).toHaveLength(2);
    expect(t[0]).toMatchObject({ kind: 'minmax', min: '0', max: '1fr' });
  });

  it('repeat(auto-fill/auto-fit) vira uma trilha other preservada', () => {
    const t = parseTrackList('repeat(auto-fill, minmax(120px, 1fr))');
    expect(t).toEqual([{ kind: 'other', value: 'repeat(auto-fill, minmax(120px, 1fr))' }]);
    expect(kinds('100px repeat(auto-fit, 200px)')).toEqual(['px', 'other']);
    expect(kinds('subgrid')).toEqual(['other']);
  });

  it('descarta nomes de linha e protege contra repeat enorme', () => {
    expect(kinds('[a] 1fr [b] 2fr [c]')).toEqual(['fr', 'fr']);
    expect(kinds('repeat(100000, 1fr)')).toEqual(['other']);
  });
});

describe('serializeTrackList', () => {
  it('recompacta repetições iguais', () => {
    expect(serializeTrackList(parseTrackList('1fr 1fr 1fr'))).toBe('repeat(3, 1fr)');
    expect(serializeTrackList(parseTrackList('repeat(3, minmax(0, 1fr))'))).toBe(
      'repeat(3, minmax(0, 1fr))',
    );
    expect(serializeTrackList(parseTrackList('100px 1fr 1fr 1fr 200px'))).toBe(
      '100px repeat(3, 1fr) 200px',
    );
    expect(serializeTrackList(parseTrackList('1fr 2fr 1fr'))).toBe('1fr 2fr 1fr');
  });

  it('aceita strings, números e objetos; lista vazia vira none', () => {
    expect(serializeTrackList(['200px', 'minmax(120px,1fr)', 300, parseTrack('auto')])).toBe(
      '200px minmax(120px, 1fr) 300px auto',
    );
    expect(serializeTrackList([])).toBe('none');
  });

  it('não compacta o repeat(auto-fill) preservado', () => {
    const t = parseTrackList('repeat(auto-fill, 100px)');
    expect(serializeTrackList([...t, ...t])).toBe(
      'repeat(auto-fill, 100px) repeat(auto-fill, 100px)',
    );
  });

  it('ida e volta mantém as trilhas', () => {
    for (const v of ['200px 1fr', 'repeat(4, 1fr) auto', 'minmax(100px, 2fr) 30% min-content']) {
      const a = parseTrackList(v);
      expect(parseTrackList(serializeTrackList(a))).toEqual(a);
    }
  });

  it('equalTracks', () => {
    expect(equalTracks(3)).toBe('repeat(3, minmax(0, 1fr))');
    expect(equalTracks(0)).toBe('repeat(1, minmax(0, 1fr))');
  });
});

describe('áreas nomeadas', () => {
  it('valida e serializa', () => {
    expect(serializeGridAreas(['header header', 'side  main'])).toBe('"header header" "side main"');
    expect(serializeGridAreas(['a .', '. b'])).toBe('"a ." ". b"');
  });

  it('rejeita linhas de tamanhos diferentes, nomes inválidos e áreas não retangulares', () => {
    expect(() => validateGridAreas([])).toThrow(/ao menos uma linha/);
    expect(() => validateGridAreas(['a b', 'a'])).toThrow(/mesmo número de células/);
    expect(() => validateGridAreas(['a 1b'])).toThrow(/Nome de área inválido/);
    expect(() => validateGridAreas(['a b', 'b a'])).toThrow(/não forma um retângulo/);
    expect(() => validateGridAreas(['a b a'])).toThrow(/"a" não forma um retângulo/);
    expect(() => validateGridAreas(['a a', 'a .'])).toThrow(/"a"/);
  });

  it('parse e nomes', () => {
    expect(parseGridAreas('"header header" "side main"')).toEqual(['header header', 'side main']);
    expect(parseGridAreas('none')).toEqual([]);
    expect(gridAreaNames('"header header" "side main" ". main"')).toEqual([
      'header',
      'side',
      'main',
    ]);
  });
});

describe('gridContainerStyles', () => {
  it('número vira repeat(n, minmax(0, 1fr))', () => {
    expect(gridContainerStyles({ columns: 3 })).toEqual({
      display: 'grid',
      'grid-template-columns': 'repeat(3, minmax(0, 1fr))',
    });
  });

  it('string CSS é mantida, lista de trilhas é normalizada', () => {
    expect(gridContainerStyles({ columns: '200px 1fr' })['grid-template-columns']).toBe(
      '200px 1fr',
    );
    expect(
      gridContainerStyles({ columns: ['200px', '1fr', 'minmax(120px,1fr)'], rows: [100, 'auto'] }),
    ).toMatchObject({
      'grid-template-columns': '200px 1fr minmax(120px, 1fr)',
      'grid-template-rows': '100px auto',
    });
    expect(gridContainerStyles({ columns: ['1fr', '1fr'] })['grid-template-columns']).toBe(
      'repeat(2, 1fr)',
    );
  });

  it('gaps: gap sozinho, gap + específicos, só específicos', () => {
    expect(gridContainerStyles({ columns: 2, gap: 16 }).gap).toBe('16px');
    const both = gridContainerStyles({ columns: 2, gap: 16, columnGap: 24 });
    expect(both).toMatchObject({ 'column-gap': '24px', 'row-gap': '16px' });
    expect(both.gap).toBeUndefined();
    const only = gridContainerStyles({ columns: 2, rowGap: '8px' });
    expect(only['row-gap']).toBe('8px');
    expect(only['column-gap']).toBeUndefined();
  });

  it('áreas, place-items e auto-flow', () => {
    expect(
      gridContainerStyles({
        columns: 2,
        areas: ['a b'],
        placeItems: 'center',
        autoFlow: 'row dense',
      }),
    ).toMatchObject({
      'grid-template-areas': '"a b"',
      'place-items': 'center',
      'grid-auto-flow': 'row dense',
    });
    expect(() => gridContainerStyles({ columns: 2, areas: ['a b', 'a'] })).toThrow();
  });

  it('valida columns', () => {
    expect(() => gridContainerStyles({ columns: 0 })).toThrow(/>= 1/);
    expect(() => gridContainerStyles({ columns: '  ' })).toThrow(/vazio/);
    expect(() => gridContainerStyles({ columns: [] })).toThrow(/ao menos uma trilha/);
  });
});

describe('posicionamento', () => {
  it('gera grid-column/grid-row', () => {
    expect(gridPlacementStyles({ column: 2, row: 1 })).toEqual({
      'grid-column': '2',
      'grid-row': '1',
    });
    expect(gridPlacementStyles({ column: 2, columnSpan: 2, row: 1, rowSpan: 3 })).toEqual({
      'grid-column': '2 / span 2',
      'grid-row': '1 / span 3',
    });
    expect(gridPlacementStyles({ columnSpan: 2 })).toEqual({ 'grid-column': 'span 2' });
    expect(gridPlacementStyles({ column: 1, columnSpan: 1 })).toEqual({ 'grid-column': '1' });
  });

  it('grid-area tem prioridade e valida o nome', () => {
    expect(gridPlacementStyles({ area: 'header', column: 3 })).toEqual({ 'grid-area': 'header' });
    expect(() => gridPlacementStyles({ area: '9x' })).toThrow(/inválido/);
  });

  it('valida inteiros 1-based', () => {
    expect(() => gridPlacementStyles({ column: 0 })).toThrow(/>= 1/);
    expect(() => gridPlacementStyles({ row: 1.5 })).toThrow(/>= 1/);
    expect(() => gridPlacementStyles({ columnSpan: -1 })).toThrow();
  });

  it('parseGridPlacement lê as formas comuns', () => {
    expect(parseGridPlacement({ 'grid-column': '2 / span 3', 'grid-row': '1' })).toEqual({
      column: 2,
      columnSpan: 3,
      row: 1,
    });
    expect(parseGridPlacement({ 'grid-column': 'span 2' })).toEqual({ columnSpan: 2 });
    expect(parseGridPlacement({ 'grid-column': '2 / 5' })).toEqual({ column: 2, columnSpan: 3 });
    expect(parseGridPlacement({ 'grid-column': '1 / -1' })).toEqual({ column: 1 });
    expect(parseGridPlacement({ 'grid-area': 'header' })).toEqual({ area: 'header' });
    expect(parseGridPlacement({ 'grid-area': '1 / 2 / 3 / 4' })).toEqual({
      row: 1,
      column: 2,
      rowSpan: 2,
      columnSpan: 2,
    });
    expect(
      parseGridPlacement({
        'grid-column-start': '3',
        'grid-column-end': 'span 2',
        'grid-row-start': '2',
      }),
    ).toEqual({ column: 3, columnSpan: 2, row: 2 });
    expect(parseGridPlacement({})).toEqual({});
    expect(parseGridPlacement({ 'grid-column': 'auto' })).toEqual({});
  });

  it('ida e volta com gridPlacementStyles', () => {
    const p = { column: 3, columnSpan: 2, row: 2, rowSpan: 2 };
    expect(parseGridPlacement(gridPlacementStyles(p))).toEqual(p);
  });
});

describe('isGridContainer / trackCount', () => {
  it('reconhece grid e inline-grid', () => {
    expect(isGridContainer({ display: 'grid' })).toBe(true);
    expect(isGridContainer({ display: ' Inline-Grid ' })).toBe(true);
    expect(isGridContainer({ display: 'flex' })).toBe(false);
    expect(isGridContainer({})).toBe(false);
  });

  it('conta trilhas', () => {
    const s = { 'grid-template-columns': 'repeat(3, 1fr)', 'grid-template-rows': '100px auto' };
    expect(trackCount(s, 'columns')).toBe(3);
    expect(trackCount(s, 'rows')).toBe(2);
    expect(trackCount({}, 'columns')).toBe(0);
  });
});

describe('resolveTrackSizes', () => {
  const sizes = (v: string, avail: number, gap = 0): number[] =>
    resolveTrackSizes(parseTrackList(v), avail, gap);

  it('px, % e fr dividem o espaço', () => {
    expect(sizes('200px 1fr', 600)).toEqual([200, 400]);
    expect(sizes('1fr 2fr', 300)).toEqual([100, 200]);
    expect(sizes('50% 1fr', 400)).toEqual([200, 200]);
    expect(sizes('repeat(3, 1fr)', 320, 10)).toEqual([100, 100, 100]);
  });

  it('auto e *-content contam como 1fr; minmax respeita o piso', () => {
    expect(sizes('100px auto', 300)).toEqual([100, 200]);
    expect(sizes('auto min-content max-content', 90)).toEqual([30, 30, 30]);
    expect(sizes('minmax(150px, 1fr) 1fr', 200)).toEqual([150, 50]);
    expect(sizes('minmax(100px, 300px) 1fr', 600)).toEqual([300, 300]);
  });

  it('soma de fr menor que 1 distribui só essa fração; sem espaço dá 0', () => {
    expect(sizes('0.5fr 0.25fr', 400)).toEqual([200, 100]);
    expect(sizes('1fr 1fr', 0)).toEqual([0, 0]);
    expect(sizes('', 100)).toEqual([]);
  });
});

describe('células', () => {
  const grid: LayoutGrid = {
    columns: layoutTracks([100, 100, 100], 10, 20),
    rows: layoutTracks([50, 50], 10, 5),
    columnGap: 10,
    rowGap: 10,
  };

  it('layoutTracks calcula início e tamanho', () => {
    expect(grid.columns).toEqual([
      { start: 20, size: 100 },
      { start: 130, size: 100 },
      { start: 240, size: 100 },
    ]);
  });

  it('cellAt acha a célula, trata gaps e devolve null fora', () => {
    expect(cellAt(grid, 25, 10)).toEqual({ column: 1, row: 1 });
    expect(cellAt(grid, 339, 114)).toEqual({ column: 3, row: 2 });
    expect(cellAt(grid, 122, 10)).toEqual({ column: 1, row: 1 }); // gap: trilha mais próxima
    expect(cellAt(grid, 128, 62)).toEqual({ column: 2, row: 2 });
    expect(cellAt(grid, 10, 10)).toBeNull();
    expect(cellAt(grid, 200, 500)).toBeNull();
    expect(cellAt({ ...grid, columns: [] }, 25, 10)).toBeNull();
  });

  it('spanFromRect encaixa as bordas nas trilhas', () => {
    expect(spanFromRect(grid, { x: 22, y: 6, width: 98, height: 48 })).toEqual({
      column: 1,
      row: 1,
      columnSpan: 1,
      rowSpan: 1,
    });
    expect(spanFromRect(grid, { x: 130, y: 5, width: 210, height: 110 })).toEqual({
      column: 2,
      row: 1,
      columnSpan: 2,
      rowSpan: 2,
    });
    expect(spanFromRect({ ...grid, rows: [] }, { x: 0, y: 0, width: 1, height: 1 })).toBeNull();
  });

  it('spanFromRect nunca devolve span menor que 1 (retângulo invertido)', () => {
    const s = spanFromRect(grid, { x: 240, y: 5, width: -200, height: 10 });
    expect(s?.columnSpan).toBe(1);
  });

  it('cellRect devolve o retângulo da célula/extensão e limita ao grid', () => {
    expect(cellRect(grid, { column: 2, row: 1, columnSpan: 2, rowSpan: 1 })).toEqual({
      x: 130,
      y: 5,
      width: 210,
      height: 50,
    });
    expect(cellRect(grid, { column: 3, row: 1, columnSpan: 5, rowSpan: 1 })?.width).toBe(100);
    expect(cellRect(grid, { column: 4, row: 1, columnSpan: 1, rowSpan: 1 })).toBeNull();
  });

  it('formatGridTracks é compacto', () => {
    expect(formatGridTracks(grid)).toBe(
      'grid cols 20+100,130+100,240+100 rows 5+50,65+50 gap 10/10',
    );
    expect(formatGridTracks({ columns: [], rows: [], columnGap: 0, rowGap: 0 })).toBe(
      'grid cols - rows - gap 0/0',
    );
  });
});

describe('resumo da árvore', () => {
  it('contêiner grid e filhos com célula', () => {
    const child = createNode({
      tag: 'div',
      id: 'el_child001',
      name: 'Item',
      style: { 'grid-column': '2 / span 2', 'grid-row': '1' },
    });
    const text = createNode({
      tag: 'p',
      id: 'tx_child001',
      name: 'Texto',
      type: 'text',
      text: 'oi',
      style: { 'grid-area': 'main' },
    });
    const box = createNode({
      tag: 'div',
      id: 'el_box00001',
      name: 'Grade',
      style: {
        display: 'grid',
        'grid-template-columns': 'repeat(3, minmax(0, 1fr))',
        'grid-template-rows': '100px 1fr',
        gap: '16px',
      },
      children: [child, text],
    });
    const out = getTreeSummary(box, 2).split('\n');
    expect(out[0]).toContain('grid 3x2 gap:16');
    expect(out[1]).toContain('cell:2/1 span:2x1');
    expect(out[2]).toContain('area:main');
  });

  it('só um eixo, sem trilhas e gaps separados', () => {
    const mk = (style: Record<string, string>) =>
      getTreeSummary(createNode({ tag: 'div', id: 'el_x0000001', name: 'G', style }), 0);
    expect(mk({ display: 'grid', 'grid-template-columns': '1fr 1fr' })).toContain('grid 2col');
    expect(mk({ display: 'grid' })).toMatch(/ grid( |$)/);
    expect(mk({ display: 'grid', 'column-gap': '8px', 'row-gap': '4px' })).toContain(
      'gap-x:8 gap-y:4',
    );
    expect(mk({ 'grid-column': 'span 2' })).toContain('span:2x1');
  });
});
