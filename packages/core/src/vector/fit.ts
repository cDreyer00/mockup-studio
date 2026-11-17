/** Ajuste do viewBox ao conteúdo, mantendo a escala entre o viewBox e a caixa do nó. */
import type { Vector } from '../types.js';
import type { Box } from './path.js';

/**
 * Recalcula o viewBox como a caixa dos paths (mais `padding`, padrão: metade do maior traço) e
 * devolve a nova caixa do nó em px no pai, com a mesma escala `box.width / viewBox.width` (e
 * altura) de antes, de modo que o desenho fique parado na tela. Paths vazios: devolve igual.
 * O vetor resultante não tem `raw`.
 */
export function fitVectorToContent(
  v: Vector,
  box: Box,
  opts: { padding?: number } = {},
): { vector: Vector; box: Box } {
  void v;
  void box;
  void opts;
  throw new Error('não implementado');
}
