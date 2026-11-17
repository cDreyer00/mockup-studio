/** Formas básicas como paths: retângulo, elipse, linha, polígono e estrela. */
import type { Node, Vector } from '../types.js';
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

/** Path data da forma na caixa `0 0 width height` (linha: diagonal de 0,0 a width,height). */
export function shapePathData(spec: ShapeSpec): string {
  void spec;
  throw new Error('não implementado');
}

/**
 * Vetor de uma forma: viewBox `0 0 w h` (linha com folga do traço), um path `p1`.
 * Tinta padrão: formas fechadas `fill: #d9d9d9`, sem traço; linha `stroke: #111111`, largura 2,
 * sem preenchimento. `paint` sobrepõe o padrão.
 */
export function createShapeVector(spec: ShapeSpec, paint?: VectorPaintPatch): Vector {
  void spec;
  void paint;
  throw new Error('não implementado');
}

/**
 * Nó `svg` (tag `svg`, id `sv_...` novo se `id` ausente) com `vector` e `svg = vectorToSvg(vector)`.
 * `style` é o CSS do nó (ex.: position/left/top/width/height).
 */
export function createVectorNode(
  vector: Vector,
  opts: { name?: string; style?: Record<string, string>; id?: string } = {},
): Node {
  void vector;
  void opts;
  throw new Error('não implementado');
}
