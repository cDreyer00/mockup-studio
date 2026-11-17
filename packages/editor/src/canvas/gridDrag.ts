/**
 * Filhos de um contêiner grid no canvas: arrastar para uma célula, esticar por várias células
 * (alças de span) e o destaque da célula. As contas (`dropPlacement`, `resizeSpan`, `placementDelta`...)
 * são puras; o que toca no DOM/daemon fica em `measureGridWorld`, `planGridMove` e `startSpanDrag`.
 */
import { cellAt, cellRect, gridPlacementStyles, parseGridPlacement, spanFromRect } from '@mockup/core';
import type { GridPlacement, LayoutGrid, Node, Op } from '@mockup/core';
import { create } from 'zustand';
import { daemon } from '../client/daemon';
import { getNode, getParent } from '../model/tree';
import { measureGridTracks } from '../render/measure';
import { useDoc } from '../state/docStore';
import { ui } from '../state/uiStore';
import type { NodePreview } from '../state/uiStore';
import { clientToWorld, findNodeEl, measureWorldRect } from './dom';
import type { Point, Rect } from './geometry';

/** Posição completa de um filho: início (1-based) e extensão, em trilhas. */
export interface CellPlacement {
  column: number;
  row: number;
  columnSpan: number;
  rowSpan: number;
}

export type SpanEdge = 'e' | 's' | 'se';

export interface StyleChange {
  set: Record<string, string>;
  unset: string[];
}

/** Trilhas medidas de um grid, em coordenadas do mundo, e a caixa do contêiner. */
export interface GridWorld {
  grid: LayoutGrid;
  rect: Rect;
}

const clamp = (n: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, n));

/* ------------------------------ contas puras ------------------------------ */

/** Mantém a posição dentro das trilhas existentes (a extensão encolhe e o início recua se preciso). */
export function clampPlacement(grid: LayoutGrid, p: CellPlacement): CellPlacement {
  const nc = Math.max(1, grid.columns.length);
  const nr = Math.max(1, grid.rows.length);
  const columnSpan = clamp(Math.round(p.columnSpan), 1, nc);
  const rowSpan = clamp(Math.round(p.rowSpan), 1, nr);
  return {
    column: clamp(Math.round(p.column), 1, nc - columnSpan + 1),
    row: clamp(Math.round(p.row), 1, nr - rowSpan + 1),
    columnSpan,
    rowSpan,
  };
}

/** Posição ao soltar com o ponteiro em `point` (mundo), mantendo a extensão; `null` fora do grid. */
export function dropPlacement(
  grid: LayoutGrid,
  point: Point,
  span: { columnSpan: number; rowSpan: number },
): CellPlacement | null {
  const cell = cellAt(grid, point.x, point.y);
  if (!cell) return null;
  return clampPlacement(grid, { ...cell, columnSpan: span.columnSpan, rowSpan: span.rowSpan });
}

/**
 * Posição atual de um filho: o que o estilo declara (`grid-column`/`grid-row`) e, no que for automático,
 * a posição renderizada (`rect`, em coordenadas do mundo).
 */
export function currentPlacement(
  grid: LayoutGrid,
  rect: Rect | null,
  style: Record<string, string | undefined>,
): CellPlacement {
  const p = parseGridPlacement(style);
  const fromRect = rect
    ? spanFromRect(grid, { x: rect.x, y: rect.y, width: rect.w, height: rect.h })
    : null;
  return {
    column: p.column ?? fromRect?.column ?? 1,
    row: p.row ?? fromRect?.row ?? 1,
    columnSpan: p.columnSpan ?? (p.column !== undefined ? 1 : (fromRect?.columnSpan ?? 1)),
    rowSpan: p.rowSpan ?? (p.row !== undefined ? 1 : (fromRect?.rowSpan ?? 1)),
  };
}

/** Nova extensão ao arrastar a alça `edge` até `point` (mundo): a borda final encaixa na trilha mais próxima. */
export function resizeSpan(
  grid: LayoutGrid,
  start: CellPlacement,
  edge: SpanEdge,
  point: Point,
): CellPlacement {
  const base = cellRect(grid, start);
  if (!base) return start;
  const width = edge.includes('e') ? point.x - base.x : base.width;
  const height = edge.includes('s') ? point.y - base.y : base.height;
  const res = spanFromRect(grid, { x: base.x, y: base.y, width, height });
  if (!res) return start;
  return clampPlacement(grid, {
    column: start.column,
    row: start.row,
    columnSpan: edge.includes('e') ? res.columnSpan : start.columnSpan,
    rowSpan: edge.includes('s') ? res.rowSpan : start.rowSpan,
  });
}

/** Retângulo (mundo) da célula/extensão; `null` se fora do grid. */
export function placementRect(grid: LayoutGrid, p: CellPlacement): Rect | null {
  const r = cellRect(grid, p);
  return r ? { x: r.x, y: r.y, w: r.width, h: r.height } : null;
}

/** Estilos `grid-column`/`grid-row` de uma posição completa (extensão 1 vira só a linha). */
export function placementStyles(p: CellPlacement): Record<string, string> {
  return gridPlacementStyles(p);
}

const PLACEMENT_PROPS = [
  'grid-column',
  'grid-row',
  'grid-area',
  'grid-column-start',
  'grid-column-end',
  'grid-row-start',
  'grid-row-end',
];

/**
 * Alteração de estilo para mudar a posição do filho: `patch` troca só os campos presentes (`null` limpa
 * o campo, voltando ao automático). Remove `grid-area` e as formas longas que conflitariam.
 */
export function placementDelta(
  style: Record<string, string | undefined>,
  patch: { [K in keyof Omit<GridPlacement, 'area'>]?: number | null },
): StyleChange {
  const cur = parseGridPlacement(style);
  const merged: GridPlacement = {};
  for (const k of ['column', 'row', 'columnSpan', 'rowSpan'] as const) {
    const v = k in patch ? patch[k] : cur[k];
    if (v !== undefined && v !== null) merged[k] = v;
  }
  // Extensão 1 sem início explícito é o padrão do navegador: não precisa de declaração
  if (merged.column === undefined && merged.columnSpan === 1) delete merged.columnSpan;
  if (merged.row === undefined && merged.rowSpan === 1) delete merged.rowSpan;
  const set = gridPlacementStyles(merged);
  const unset = PLACEMENT_PROPS.filter((p) => style[p] !== undefined && set[p] === undefined);
  return { set, unset };
}

/** O delta muda alguma coisa em relação ao estilo atual? */
export function deltaChangesStyle(
  style: Record<string, string | undefined>,
  d: StyleChange,
): boolean {
  return (
    d.unset.length > 0 || Object.entries(d.set).some(([k, v]) => (style[k] ?? '').trim() !== v)
  );
}

/* ------------------------------ DOM ------------------------------ */

/** Trilhas medidas do nó (se for grid) em coordenadas do mundo, lendo o `getComputedStyle` do elemento. */
export function measureGridWorld(root: HTMLElement, id: string): GridWorld | null {
  const el = findNodeEl(root, id);
  const rect = measureWorldRect(root, id);
  if (!el || !rect) return null;
  const cs = getComputedStyle(el);
  const grid = measureGridTracks(
    {
      display: cs.display,
      gridTemplateColumns: cs.gridTemplateColumns,
      gridTemplateRows: cs.gridTemplateRows,
      columnGap: cs.columnGap,
      rowGap: cs.rowGap,
      borderLeftWidth: cs.borderLeftWidth,
      borderTopWidth: cs.borderTopWidth,
      paddingLeft: cs.paddingLeft,
      paddingTop: cs.paddingTop,
    },
    { x: rect.x, y: rect.y, width: rect.w, height: rect.h },
  );
  return grid ? { grid, rect } : null;
}

/** Destaque transitório da célula (mundo) durante o arrasto de um filho ou de uma alça. */
export const useGridFx = create<{ cell: Rect | null }>(() => ({ cell: null }));

const setCell = (cell: Rect | null): void => {
  const cur = useGridFx.getState().cell;
  if (cur === cell) return;
  if (cur && cell && cur.x === cell.x && cur.y === cell.y && cur.w === cell.w && cur.h === cell.h)
    return;
  useGridFx.setState({ cell });
};

export interface GridMovePlan {
  update(ev: PointerEvent): void;
  commit(cancelled: boolean): Promise<void>;
}

/**
 * Arrasto de filhos de um grid: destaca a célula sob o ponteiro e, ao soltar, grava `grid-column`/`grid-row`
 * (mantendo a extensão de cada um) em vez de reordenar.
 */
export function planGridMove(
  root: HTMLElement,
  parent: Node,
  nodes: readonly Node[],
): GridMovePlan | null {
  const gw = measureGridWorld(root, parent.id);
  if (!gw || nodes.length === 0) return null;
  const items = nodes.map((node) => ({
    node,
    span: currentPlacement(gw.grid, measureWorldRect(root, node.id), node.style),
  }));
  let target: { items: { node: Node; place: CellPlacement }[] } | null = null;
  let shown: Record<string, NodePreview> = {};
  return {
    update(ev: PointerEvent): void {
      const point = clientToWorld(root, ev.clientX, ev.clientY);
      const first = items[0]!.span;
      const lead = dropPlacement(gw.grid, point, first);
      if (!lead) {
        target = null;
        setCell(null);
        ui.setPreview(
          (shown = Object.fromEntries(nodes.map((n) => [n.id, { style: { opacity: '0.45' } }]))),
        );
        return;
      }
      const placed = items.map((it) => ({
        node: it.node,
        place: clampPlacement(gw.grid, { ...it.span, column: lead.column, row: lead.row }),
      }));
      target = { items: placed };
      setCell(placementRect(gw.grid, lead));
      shown = Object.fromEntries(
        placed.map((p) => [
          p.node.id,
          { style: { opacity: '0.6', ...placementStyles(p.place) } },
        ]),
      );
      ui.setPreview(shown);
    },
    async commit(cancelled: boolean): Promise<void> {
      setCell(null);
      const cur = useDoc.getState().doc;
      const changes: { nodeId: string; set?: Record<string, string>; unset?: string[] }[] = [];
      if (!cancelled && target && cur) {
        for (const { node, place } of target.items) {
          const live = getNode(cur, node.id);
          if (!live) continue;
          const d = placementDelta(live.style, place);
          if (!deltaChangesStyle(live.style, d)) continue;
          changes.push({
            nodeId: node.id,
            ...(Object.keys(d.set).length ? { set: d.set } : {}),
            ...(d.unset.length ? { unset: d.unset } : {}),
          });
        }
      }
      if (changes.length) await daemon.applySafe([{ type: 'updateStyles', changes }] as Op[]);
      ui.releasePreview(shown);
    },
  };
}

/**
 * Gesto das alças de span: arrasta a borda direita/inferior da célula do filho e ajusta
 * `grid-column`/`grid-row` com prévia ao vivo; Esc cancela.
 */
export function startSpanDrag(root: HTMLElement, childId: string, edge: SpanEdge): void {
  const doc = useDoc.getState().doc;
  const child = doc ? getNode(doc, childId) : undefined;
  const parent = doc && child ? getParent(doc, childId) : null;
  if (!child || !parent) return;
  const gw = measureGridWorld(root, parent.id);
  if (!gw) return;
  const start = currentPlacement(gw.grid, measureWorldRect(root, childId), child.style);
  let cur = start;
  let shown: Record<string, NodePreview> = {};
  const toPoint = (ev: PointerEvent): Point => clientToWorld(root, ev.clientX, ev.clientY);
  const onMove = (ev: PointerEvent): void => {
    cur = resizeSpan(gw.grid, start, edge, toPoint(ev));
    setCell(placementRect(gw.grid, cur));
    ui.setPreview((shown = { [childId]: { style: placementStyles(cur) } }));
  };
  const stop = (): void => {
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    window.removeEventListener('pointercancel', onCancel);
    window.removeEventListener('keydown', onKey, true);
    setCell(null);
  };
  const finish = async (cancelled: boolean): Promise<void> => {
    stop();
    const live = useDoc.getState().doc;
    const node = live ? getNode(live, childId) : undefined;
    if (!cancelled && node && (cur.columnSpan !== start.columnSpan || cur.rowSpan !== start.rowSpan)) {
      const d = placementDelta(node.style, cur);
      if (deltaChangesStyle(node.style, d)) {
        await daemon.applySafe([
          {
            type: 'updateStyles',
            changes: [
              {
                nodeId: childId,
                ...(Object.keys(d.set).length ? { set: d.set } : {}),
                ...(d.unset.length ? { unset: d.unset } : {}),
              },
            ],
          },
        ] as Op[]);
      }
    }
    ui.releasePreview(shown);
  };
  const onUp = (): void => void finish(false);
  const onCancel = (): void => void finish(true);
  const onKey = (e: KeyboardEvent): void => {
    if (e.key !== 'Escape') return;
    e.preventDefault();
    e.stopPropagation();
    void finish(true);
  };
  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp);
  window.addEventListener('pointercancel', onCancel);
  window.addEventListener('keydown', onKey, true);
  ui.hover(null);
}
