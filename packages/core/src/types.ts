/**
 * Modelo de documento do Mockup Studio (esquema versão 1).
 *
 * Um documento é um JSON legível (`*.mockup.json`) com páginas; cada página tem
 * frames (nós raiz, que funcionam como artboards/breakpoints) e cada frame tem
 * uma árvore de nós que correspondem a elementos HTML reais com CSS real.
 */

export const DOCUMENT_VERSION = 1 as const;

export type NodeType = 'frame' | 'element' | 'text' | 'image' | 'svg' | 'repeater';

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
   * Repetidor (type 'repeater'): itens de dados. Os filhos são o template, repetido uma vez por
   * item, com bindings `{{campo}}` resolvidos em textos, `src` e atributos (ver `data.ts`).
   */
  data?: unknown[];
  /** Repetidor: origem dos dados (para atualizar) e mapeamento de campos. */
  dataSource?: DataSource;
}

/** Origem dos dados de um repetidor. */
export interface DataSource {
  /** `inline`: dados colados/editados; `json`/`csv`: arquivo local; `url`: HTTP(S) (JSON ou CSV). */
  kind: 'inline' | 'json' | 'csv' | 'url';
  /** Caminho absoluto do arquivo (`json`/`csv`). */
  path?: string;
  /** URL http(s) (`url`). */
  url?: string;
  /** Caminho até a lista dentro do JSON, ex.: `data.items`. */
  select?: string;
  /** Campo do template → caminho no item, ex.: `{ "nome": "user.fullName" }`. */
  mapping?: Record<string, string>;
  /** Máximo de itens lidos da origem. */
  limit?: number;
  /** Quando os dados foram lidos da origem (ISO 8601). */
  fetchedAt?: string;
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
