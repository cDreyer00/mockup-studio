/**
 * Modelo de documento do Mockup Studio (esquema versão 1).
 *
 * Um documento é um JSON legível (`*.mockup.json`) com páginas; cada página tem
 * frames (nós raiz, que funcionam como artboards/breakpoints) e cada frame tem
 * uma árvore de nós que correspondem a elementos HTML reais com CSS real.
 */

export const DOCUMENT_VERSION = 1 as const;

export type NodeType =
  'frame' | 'element' | 'text' | 'image' | 'svg' | 'effect' | 'video' | 'embed';

/** Valor de parâmetro de efeito/embed: número, texto (cor, opção) ou booleano. */
export type MediaParamValue = number | string | boolean;

/** Efeito visual (shader WebGL ou partículas) de um nó `type: 'effect'` (ver `effects/catalog.ts`). */
export interface EffectSpec {
  /** Tipo do efeito, ex.: `mesh-gradient`, `grain`, `particles` (ver `list_effects`). */
  kind: string;
  /** Parâmetros do efeito; os ausentes usam o padrão do catálogo. */
  params: Record<string, MediaParamValue>;
}

/** Vídeo de um nó `type: 'video'`. */
export interface VideoSpec {
  /** Caminho relativo a `assets/` ou URL http(s). */
  src: string;
  /** Imagem de capa (relativa a `assets/` ou URL http(s)). */
  poster?: string;
  autoplay?: boolean;
  loop?: boolean;
  muted?: boolean;
  controls?: boolean;
  /** Momento (s) mostrado no screenshot quando não há `poster` (padrão 0). */
  time?: number;
}

export type EmbedProvider = 'lottie' | 'rive' | 'youtube' | 'three' | 'iframe';

/** Conteúdo incorporado de um nó `type: 'embed'`. */
export interface EmbedSpec {
  provider: EmbedProvider;
  /** Arquivo local relativo a `assets/` ou URL http(s) (lottie `.json`, rive `.riv`). */
  src?: string;
  /** URL http(s) (youtube, iframe). */
  url?: string;
  /** Código JavaScript da ilha Three.js (corpo de função; ver docs/EMBEDS.md). */
  code?: string;
  /** Opções do provedor (ex.: `autoplay`, `loop`, `artboard`, `stateMachine`, `start`). */
  params?: Record<string, MediaParamValue>;
}

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
  /** Efeito (type 'effect'). */
  effect?: EffectSpec;
  /** Vídeo (type 'video'). */
  video?: VideoSpec;
  /** Embed: Lottie, Rive, YouTube, Three.js ou iframe (type 'embed'). */
  embed?: EmbedSpec;
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
