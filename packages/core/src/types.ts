/**
 * Modelo de documento do Mockup Studio (esquema versão 1).
 *
 * Um documento é um JSON legível (`*.mockup.json`) com páginas; cada página tem
 * frames (nós raiz, que funcionam como artboards/breakpoints) e cada frame tem
 * uma árvore de nós que correspondem a elementos HTML reais com CSS real.
 */

export const DOCUMENT_VERSION = 1 as const;

export type NodeType = 'frame' | 'element' | 'text' | 'image' | 'svg';

export interface Position {
  x: number;
  y: number;
}

export interface Node {
  id: string;
  type: NodeType;
  /** Nome legível (camada). */
  name: string;
  /** Tag HTML: div, section, button, img, h1, p, span... */
  tag: string;
  /** Atributos HTML (sem `style`, sem `class`). */
  attrs: Record<string, string>;
  /** Propriedades CSS em kebab-case com valores CSS reais, ex. { 'display': 'flex', 'gap': '24px' }. */
  style: Record<string, string>;
  /** Conteúdo textual (type 'text'). */
  text?: string;
  /** Imagem: caminho relativo em `assets/` ou data URL (type 'image'). */
  src?: string;
  /** Markup SVG inline (type 'svg'). */
  svg?: string;
  /**
   * Modelo vetorial editável (type 'svg'). Quando presente, `svg` é o markup gerado a partir dele
   * (`vectorToSvg`): `raw` intacto enquanto não houver edição, senão regenerado dos `paths`.
   */
  vector?: Vector;
  children: Node[];
  locked: boolean;
  hidden: boolean;
  /** Posição no canvas (frames raiz) ou x/y de filhos com `position: absolute`. */
  position?: Position;
}

export interface Page {
  id: string;
  name: string;
  /** Nós raiz da página (frames). */
  frames: Node[];
  /** Cor/fundo do canvas da página (valor CSS). */
  background: string;
}

export interface FontRef {
  family: string;
  source?: 'local' | 'file' | 'google';
  /** Arquivos de fonte relativos a `assets/` (ex.: `fonts/inter-400.woff2`). */
  files?: string[];
  /** Peso de cada arquivo (paralelo a `files`) ou o intervalo coberto. */
  weights?: number[];
  /** Estilo de cada arquivo (`normal` | `italic`), paralelo a `files`. */
  styles?: string[];
}

export interface DocumentMeta {
  createdAt: string;
  updatedAt: string;
  [key: string]: unknown;
}

export interface Document {
  version: typeof DOCUMENT_VERSION;
  id: string;
  name: string;
  pages: Page[];
  /** Variáveis CSS do documento, ex. { '--color-primary': '#6c5ce7' }. */
  tokens: Record<string, string>;
  fonts: FontRef[];
  meta: DocumentMeta;
}

/** Localização de um nó dentro do documento. */
export interface NodePath {
  node: Node;
  page: Page;
  /** Pai imediato; `null` quando o nó é um frame raiz da página. */
  parent: Node | null;
  /** Índice do nó em `parent.children` (ou em `page.frames` quando raiz). */
  index: number;
  /** Cadeia de ancestrais, do frame raiz até o pai imediato (vazia para frames raiz). */
  ancestors: Node[];
}

/* -------------------------------------------------------------------------------- vetores */

/** Retângulo do viewBox de um vetor (unidades do SVG). */
export interface VectorViewBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface VectorGradientStop {
  /** 0 a 1. */
  offset: number;
  /** Cor CSS. */
  color: string;
  /** 0 a 1 (padrão 1). */
  opacity?: number;
}

/** Gradiente de preenchimento/traço. Coordenadas em fração da caixa do path (objectBoundingBox). */
export interface VectorGradient {
  type: 'linear' | 'radial';
  stops: VectorGradientStop[];
  /** Linear: início e fim (padrão 0,0 → 1,0). */
  x1?: number;
  y1?: number;
  x2?: number;
  y2?: number;
  /** Radial: centro e raio (padrão 0.5, 0.5, 0.5). */
  cx?: number;
  cy?: number;
  r?: number;
}

/** Tinta: cor CSS (`#111`, `none`, `currentColor`, `var(--x)`) ou gradiente. */
export type VectorPaint = string | VectorGradient;

/** Um `<path>` editável, com estilos já resolvidos (sem herança de `<g>`/`<svg>`). */
export interface VectorPath {
  /** Id estável dentro do vetor (ex.: `p1`). */
  id: string;
  /** Path data SVG (`M 0 0 L 10 0 Z`). */
  d: string;
  fill?: VectorPaint;
  stroke?: VectorPaint;
  strokeWidth?: number;
  /** 0 a 1. */
  opacity?: number;
  strokeLinecap?: 'butt' | 'round' | 'square';
  strokeLinejoin?: 'miter' | 'round' | 'bevel';
  /** Ex.: `4 2`. */
  strokeDasharray?: string;
  fillRule?: 'nonzero' | 'evenodd';
}

export interface Vector {
  viewBox: VectorViewBox;
  /** Paths editáveis. Vazio quando o SVG importado não é simples (só `raw` vale). */
  paths: VectorPath[];
  /** Markup original (sanitizado), preservado intacto até a primeira edição dos paths. */
  raw?: string;
  /** Atributos extras do `<svg>` raiz mantidos na regeneração (ex.: `preserveAspectRatio`). */
  attrs?: Record<string, string>;
}
