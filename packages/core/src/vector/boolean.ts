/** Operações booleanas entre paths (via `polygon-clipping`; curvas são achatadas). */
import type { VectorPath } from '../types.js';
import type { Matrix } from './path.js';

export type BooleanOp = 'union' | 'subtract' | 'intersect' | 'exclude';

export const BOOLEAN_OPS: readonly BooleanOp[] = ['union', 'subtract', 'intersect', 'exclude'];

export interface BooleanItem {
  d: string;
  /** Leva o path ao espaço comum (padrão: identidade). */
  matrix?: Matrix;
  fillRule?: VectorPath['fillRule'];
}

/**
 * Resultado em path data (espaço comum), subpaths fechados. `subtract` = primeiro menos os demais;
 * `exclude` = xor. Resultado vazio = `''`. Precisa de ao menos 2 itens.
 */
export function booleanPathData(op: BooleanOp, items: BooleanItem[], tolerance = 0.25): string {
  void op;
  void items;
  void tolerance;
  throw new Error('não implementado');
}
