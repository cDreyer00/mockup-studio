/** Ajuste do viewBox ao conteúdo, mantendo a escala entre o viewBox e a caixa do nó. */
import type { Vector } from '../types.js';
import { editVector } from './svg.js';
import { pathBounds } from './path.js';
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
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of v.paths) {
    const b = pathBounds(p.d);
    if (b.width === 0 && b.height === 0 && !p.d.trim()) continue;
    minX = Math.min(minX, b.x);
    minY = Math.min(minY, b.y);
    maxX = Math.max(maxX, b.x + b.width);
    maxY = Math.max(maxY, b.y + b.height);
  }
  if (!Number.isFinite(minX)) return { vector: v, box };
  const maxStroke = Math.max(0, ...v.paths.map((p) => p.strokeWidth ?? 0));
  const pad = opts.padding ?? maxStroke / 2;
  const viewBox = {
    x: minX - pad,
    y: minY - pad,
    width: maxX - minX + 2 * pad,
    height: maxY - minY + 2 * pad,
  };
  const sx = v.viewBox.width ? box.width / v.viewBox.width : 1;
  const sy = v.viewBox.height ? box.height / v.viewBox.height : 1;
  return {
    vector: editVector(v, { viewBox }),
    box: {
      x: box.x + (viewBox.x - v.viewBox.x) * sx,
      y: box.y + (viewBox.y - v.viewBox.y) * sy,
      width: viewBox.width * sx,
      height: viewBox.height * sy,
    },
  };
}
