/** Formas básicas como paths: retângulo, elipse, linha, polígono e estrela. */
import { createNode } from '../document.js';
import { deepClone } from '../clone.js';
import { newNodeId } from '../ids.js';
import type { Node, Vector, VectorPath } from '../types.js';
import { ellipsePathData, rectPathData, serializePathData } from './path.js';
import type { PathCommand } from './path.js';
import { setVectorPaint, vectorToSvg } from './svg.js';
import type { VectorPaintPatch } from './svg.js';

export type ShapeKind = 'rect' | 'ellipse' | 'line' | 'polygon' | 'star';

export const SHAPE_KINDS: readonly ShapeKind[] = ['rect', 'ellipse', 'line', 'polygon', 'star'];

export interface ShapeSpec {
  kind: ShapeKind;
  /** Caixa da forma (> 0; linha aceita 0 em um dos eixos). */
  width: number;
  height: number;
  /** rect: raio dos cantos. */
  cornerRadius?: number;
  /** polygon: número de lados (3 a 64, padrão 3). */
  sides?: number;
  /** star: número de pontas (3 a 64, padrão 5). */
  points?: number;
  /** star: raio interno / externo (0.05 a 0.95, padrão 0.5). */
  innerRatio?: number;
}

const clamp = (n: number, min: number, max: number): number => Math.min(max, Math.max(min, n));

function assertSize(spec: ShapeSpec): void {
  const { width: w, height: h } = spec;
  if (!Number.isFinite(w) || !Number.isFinite(h) || w < 0 || h < 0) {
    throw new Error('Tamanho da forma inválido: largura e altura devem ser números finitos');
  }
  if (spec.kind === 'line' ? w === 0 && h === 0 : w === 0 || h === 0) {
    throw new Error('Tamanho da forma inválido: largura e altura devem ser maiores que 0');
  }
}

/** Vértices de uma poligonal em círculo unitário (começa no topo), ajustados à caixa `w × h`. */
function fitToBox(unit: [number, number][], w: number, h: number): PathCommand[] {
  const xs = unit.map((p) => p[0]);
  const ys = unit.map((p) => p[1]);
  const minX = Math.min(...xs);
  const minY = Math.min(...ys);
  const spanX = Math.max(...xs) - minX || 1;
  const spanY = Math.max(...ys) - minY || 1;
  const cmds: PathCommand[] = unit.map(([x, y], i) => ({
    type: i === 0 ? 'M' : 'L',
    x: ((x - minX) / spanX) * w,
    y: ((y - minY) / spanY) * h,
  }));
  cmds.push({ type: 'Z' });
  return cmds;
}

/** Path data da forma na caixa `0 0 width height` (linha: diagonal de 0,0 a width,height). */
export function shapePathData(spec: ShapeSpec): string {
  assertSize(spec);
  const { width: w, height: h } = spec;
  switch (spec.kind) {
    case 'rect': {
      const r = clamp(spec.cornerRadius ?? 0, 0, Math.min(w, h) / 2);
      return rectPathData(0, 0, w, h, r, r);
    }
    case 'ellipse':
      return ellipsePathData(w / 2, h / 2, w / 2, h / 2);
    case 'line':
      return serializePathData([
        { type: 'M', x: 0, y: 0 },
        { type: 'L', x: w, y: h },
      ]);
    case 'polygon': {
      const n = Math.round(clamp(spec.sides ?? 3, 3, 64));
      const unit: [number, number][] = [];
      for (let i = 0; i < n; i++) {
        const a = -Math.PI / 2 + (2 * Math.PI * i) / n;
        unit.push([Math.cos(a), Math.sin(a)]);
      }
      return serializePathData(fitToBox(unit, w, h));
    }
    case 'star': {
      const n = Math.round(clamp(spec.points ?? 5, 3, 64));
      const ratio = clamp(spec.innerRatio ?? 0.5, 0.05, 0.95);
      const unit: [number, number][] = [];
      for (let i = 0; i < n * 2; i++) {
        const a = -Math.PI / 2 + (Math.PI * i) / n;
        const r = i % 2 === 0 ? 1 : ratio;
        unit.push([r * Math.cos(a), r * Math.sin(a)]);
      }
      return serializePathData(fitToBox(unit, w, h));
    }
  }
}

/**
 * Vetor de uma forma: viewBox `0 0 w h` (linha com folga do traço), um path `p1`.
 * Tinta padrão: formas fechadas `fill: #d9d9d9`, sem traço; linha `stroke: #111111`, largura 2,
 * sem preenchimento. `paint` sobrepõe o padrão.
 *
 * Linha: o viewBox ganha folga de metade do traço (mínimo 0,5) em volta da caixa
 * (`-pad -pad w+2pad h+2pad`), para que o traço e linhas horizontais/verticais não sejam cortados.
 */
export function createShapeVector(spec: ShapeSpec, paint?: VectorPaintPatch): Vector {
  const d = shapePathData(spec);
  const isLine = spec.kind === 'line';
  const strokeWidth = paint?.strokeWidth ?? 2;
  const pad = isLine ? Math.max(strokeWidth / 2, 0.5) : 0;
  const path: VectorPath = isLine
    ? { id: 'p1', d, fill: 'none', stroke: '#111111', strokeWidth: 2 }
    : { id: 'p1', d, fill: '#d9d9d9' };
  const base: Vector = {
    viewBox: { x: -pad, y: -pad, width: spec.width + 2 * pad, height: spec.height + 2 * pad },
    paths: [path],
  };
  return paint ? setVectorPaint(base, paint) : base;
}

/**
 * Nó `svg` (tag `svg`, id `sv_...` novo se `id` ausente) com `vector` e `svg = vectorToSvg(vector)`.
 * `style` é o CSS do nó (ex.: position/left/top/width/height).
 */
export function createVectorNode(
  vector: Vector,
  opts: { name?: string; style?: Record<string, string>; id?: string } = {},
): Node {
  return createNode({
    id: opts.id ?? newNodeId('svg'),
    type: 'svg',
    tag: 'svg',
    name: opts.name ?? 'Vetor',
    style: opts.style ?? {},
    vector: deepClone(vector),
    svg: vectorToSvg(vector),
  });
}
