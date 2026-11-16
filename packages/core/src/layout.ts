/**
 * Geometria medida de uma subárvore, produzida pela página de render (`measure(nodeId)`) a partir do
 * DOM real (getBoundingClientRect + getComputedStyle). Usada por `get_layout` e pelo exportador SVG.
 *
 * Coordenadas em px CSS, relativas ao canto superior esquerdo do frame raiz que contém o nó
 * (o frame é renderizado em 0,0 e escala 1).
 */
import type { NodeType } from './types.js';

export interface LayoutRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Uma linha de texto renderizada (via `Range.getClientRects`), relativa ao frame. */
export interface LayoutTextLine extends LayoutRect {
  text: string;
  /** Distância do topo da linha até a baseline, em px (aproximação: ascent da fonte). */
  baseline: number;
}

/** Subconjunto do `getComputedStyle` (valores já resolvidos pelo navegador, em kebab-case). */
export interface LayoutStyle {
  'background-color'?: string;
  'background-image'?: string;
  'border-top-width'?: string;
  'border-right-width'?: string;
  'border-bottom-width'?: string;
  'border-left-width'?: string;
  'border-top-color'?: string;
  'border-right-color'?: string;
  'border-bottom-color'?: string;
  'border-left-color'?: string;
  'border-top-style'?: string;
  'border-right-style'?: string;
  'border-bottom-style'?: string;
  'border-left-style'?: string;
  'border-top-left-radius'?: string;
  'border-top-right-radius'?: string;
  'border-bottom-right-radius'?: string;
  'border-bottom-left-radius'?: string;
  'box-shadow'?: string;
  opacity?: string;
  color?: string;
  'font-family'?: string;
  'font-size'?: string;
  'font-weight'?: string;
  'font-style'?: string;
  'line-height'?: string;
  'letter-spacing'?: string;
  'text-align'?: string;
  'text-decoration-line'?: string;
  'text-transform'?: string;
  overflow?: string;
  'object-fit'?: string;
  transform?: string;
  visibility?: string;
  display?: string;
  [key: string]: string | undefined;
}

export interface LayoutNode extends LayoutRect {
  id: string;
  name: string;
  type: NodeType;
  tag: string;
  style: LayoutStyle;
  /** Linhas de texto (nós `text`). */
  lines?: LayoutTextLine[];
  /** `src` original do nó image (relativo a `assets/` ou data URL). */
  src?: string;
  children: LayoutNode[];
}

/** Resultado de `render(...)` na página de render: retângulo do nó pedido e tamanho do frame. */
export interface RenderBox extends LayoutRect {
  frameId: string;
  frameWidth: number;
  frameHeight: number;
}
