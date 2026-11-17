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
  children: Node[];
  locked: boolean;
  hidden: boolean;
  /** Posição no canvas (frames raiz) ou x/y de filhos com `position: absolute`. */
  position?: Position;
  /**
   * Classes Tailwind como foram escritas (`write_html`, `set_classes`, colar). É uma dica de
   * round-trip: o render usa `style`/`states`; a exportação Tailwind reaproveita as classes que
   * ainda batem com o estilo atual. Ver `docs/TAILWIND.md`.
   */
  classes?: string;
  /**
   * Estilos condicionais por variante (`hover`, `dark`, `md`, `md:hover`...; ver `states.ts`).
   * Ausente quando vazio.
   */
  states?: Record<string, Record<string, string>>;
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

/** Metadados de um token: grupo (cores, tipografia...) e descrição. Ver `tokens.ts`. */
export interface TokenMeta {
  /** Grupo do token: `color`, `typography`, `spacing`, `radius`, `shadow`, `other` ou um nome livre. Ausente = inferido pelo nome/valor. */
  group?: string;
  description?: string;
}

/**
 * Tema: sobrescreve valores de tokens dentro de nós com `data-theme="<name>"` (CSS real:
 * `[data-theme="dark"] { --color-bg: #0b0b0b }`). Os tokens base valem fora de qualquer tema.
 */
export interface Theme {
  name: string;
  overrides: Record<string, string>;
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
  /** Grupo/descrição por token (chave = nome do token). Ausente quando vazio. */
  tokenMeta?: Record<string, TokenMeta>;
  /** Temas do documento, na ordem de exibição. Ausente quando vazio. */
  themes?: Theme[];
  fonts: FontRef[];
  /**
   * CSS base do documento: ausente (padrão do Mockup Studio) ou `tailwind` (acrescenta o preflight
   * do Tailwind v4 no canvas, no render e no código exportado).
   */
  cssBase?: 'tailwind';
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
