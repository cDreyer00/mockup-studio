/** Importar SVG para o modelo `Vector` e gerar o markup a partir dele. */
import type { Node, Vector, VectorPaint, VectorPath } from '../types.js';

/**
 * Importa markup SVG. Sanitiza (`sanitizeSvg`) e guarda o resultado em `raw`, intacto.
 * `viewBox`: o do `<svg>` (ou `0 0 width height`, ou a caixa dos paths).
 * `paths`: extraídos quando o SVG é simples: só `svg`, `g`, `path`, `rect`, `circle`, `ellipse`,
 * `line`, `polyline`, `polygon`, `title`, `desc` e `defs` contendo apenas `linearGradient`/
 * `radialGradient` com `stop` (usados por `fill`/`stroke` `url(#id)`). Formas viram `d`;
 * `transform` de elementos e grupos é aplicado aos pontos; atributos de apresentação (e `style`
 * inline com as mesmas propriedades) herdados de `svg`/`g` são resolvidos em cada path
 * (`fill` padrão `#000` como no SVG). Qualquer outra coisa (filtros, máscaras, clipPath, `use`,
 * texto, imagem, gradientes com `href`/`gradientTransform`/`userSpaceOnUse` complexos) = `paths: []`.
 * Lança se não houver `<svg>`.
 */
export function svgToVector(markup: string): Vector {
  void markup;
  throw new Error('não implementado');
}

/** O vetor tem paths editáveis? */
export function isVectorEditable(v: Vector): boolean {
  return v.paths.length > 0;
}

/** Markup do vetor: `raw` quando presente (sem edição), senão `generateVectorSvg`. */
export function vectorToSvg(v: Vector): string {
  return v.raw ?? generateVectorSvg(v);
}

/**
 * Gera `<svg xmlns viewBox width="100%" height="100%" ...attrs>` com um `<path>` por item
 * (gradientes em `<defs>` com ids determinísticos). Saída já sanitizada e estável.
 */
export function generateVectorSvg(v: Vector): string {
  void v;
  throw new Error('não implementado');
}

/** `node.vector`, ou o vetor importado de `node.svg` (nós svg sem modelo); `null` se não há markup. */
export function ensureVector(node: Node): Vector | null {
  if (node.vector) return node.vector;
  return node.svg ? svgToVector(node.svg) : null;
}

/** Nova versão do vetor com as mudanças aplicadas e sem `raw` (passa a ser regenerado). */
export function editVector(
  v: Vector,
  patch: Partial<Pick<Vector, 'paths' | 'viewBox' | 'attrs'>>,
): Vector {
  const { raw: _raw, ...rest } = v;
  void _raw;
  return { ...rest, ...patch };
}

/** Mudança de tinta/traço; `null` remove a propriedade do path. */
export interface VectorPaintPatch {
  fill?: VectorPaint | null;
  stroke?: VectorPaint | null;
  strokeWidth?: number | null;
  opacity?: number | null;
  strokeLinecap?: VectorPath['strokeLinecap'] | null;
  strokeLinejoin?: VectorPath['strokeLinejoin'] | null;
  strokeDasharray?: string | null;
  fillRule?: VectorPath['fillRule'] | null;
}

/** Aplica a tinta aos paths `pathIds` (padrão: todos); devolve um vetor editado (sem `raw`). */
export function setVectorPaint(v: Vector, patch: VectorPaintPatch, pathIds?: string[]): Vector {
  void v;
  void patch;
  void pathIds;
  throw new Error('não implementado');
}

/**
 * Converte estilos CSS de tinta (`fill`, `stroke`, `stroke-width`, `stroke-linecap`,
 * `stroke-linejoin`, `stroke-dasharray`, `fill-rule`, `fill-opacity` não) num patch; devolve o
 * patch e os estilos restantes (que são do nó). Usado por `create_shape` e pelo painel.
 */
export function splitPaintStyles(styles: Record<string, string>): {
  paint: VectorPaintPatch;
  rest: Record<string, string>;
} {
  void styles;
  throw new Error('não implementado');
}
