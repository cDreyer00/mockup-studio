/**
 * Modelo de documento do Mockup Studio (esquema versão 1).
 *
 * Um documento é um JSON legível (`*.mockup.json`) com páginas; cada página tem
 * frames (nós raiz, que funcionam como artboards/breakpoints) e cada frame tem
 * uma árvore de nós que correspondem a elementos HTML reais com CSS real.
 */

export const DOCUMENT_VERSION = 1 as const;

/**
 * `instance`: instância de um componente do documento (`componentId`); os filhos são só os
 * contêineres de slot (ver `docs/COMPONENTES.md`). Render, export e screenshot usam a árvore
 * concreta de `expandInstance`.
 */
export type NodeType =
  | 'frame'
  | 'element'
  | 'text'
  | 'image'
  | 'svg'
  | 'instance'
  | 'repeater'
  | 'effect'
  | 'video'
  | 'embed';

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
  /**
   * Modelo vetorial editável (type 'svg'). Quando presente, `svg` é o markup gerado a partir dele
   * (`vectorToSvg`): `raw` intacto enquanto não houver edição, senão regenerado dos `paths`.
   */
  vector?: Vector;
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
  /**
   * Componente da instância (`type: 'instance'`). Na árvore expandida (`expandInstance`) o nó raiz
   * concreto mantém `componentId` e `props` como marcador de instância.
   */
  componentId?: string;
  /** Valores das props da instância (só as que diferem do padrão do componente). */
  props?: Record<string, PropValue>;
  /**
   * Sobrescritas por caminho de nó do componente principal: chave = ids dos nós do principal
   * separados por `/` (atravessando instâncias aninhadas), ex. `el_label01` ou `el_btn0001/el_label01`.
   */
  overrides?: Record<string, NodeOverride>;
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

/* ---------------- Componentes ---------------- */

export type PropType = 'string' | 'number' | 'boolean' | 'enum' | 'color' | 'slot';
export type PropValue = string | number | boolean;

/** Propriedade de um componente. Strings/números/cores entram por `{{nome}}`; slots por `data-slot`. */
export interface PropDef {
  name: string;
  type: PropType;
  /** Valor padrão (ausente em `slot`). */
  default?: PropValue;
  /** Opções de `enum`. */
  options?: string[];
  description?: string;
}

/** Sobrescrita de um nó da árvore do componente (numa variante ou numa instância). */
export interface NodeOverride {
  /** Estilos mesclados sobre o do principal. */
  style?: Record<string, string>;
  /** Propriedades de estilo removidas do principal. */
  unsetStyle?: string[];
  text?: string;
  /** Atributos mesclados sobre os do principal. */
  attrs?: Record<string, string>;
  hidden?: boolean;
  classes?: string;
  /** Estados mesclados por variante (`hover`, `dark`...). */
  states?: Record<string, Record<string, string>>;
  src?: string;
  svg?: string;
  /** Props de uma instância aninhada no principal. */
  props?: Record<string, PropValue>;
  /** Modelo vetorial (só nó svg); o markup vem de `svg` ou é gerado do vetor. */
  vector?: Vector;
  /** Efeito inteiro (só nó effect; substitui o do principal). */
  effect?: EffectSpec;
  /** Vídeo inteiro (só nó video). */
  video?: VideoSpec;
  /** Embed inteiro (só nó embed). */
  embed?: EmbedSpec;
  /** Itens do repetidor (só nó repeater; substituem os do principal). */
  data?: unknown[];
  /** Origem dos dados do repetidor (só nó repeater). */
  dataSource?: DataSource;
}

/** Variante: quando as props batem com `when`, aplica `overrides` (chave `''` = nó raiz). */
export interface ComponentVariant {
  when: Record<string, PropValue>;
  overrides: Record<string, NodeOverride>;
}

/** Componente principal (biblioteca do documento). */
export interface ComponentDef {
  /** Id `cp_xxxxxxxx`. */
  id: string;
  name: string;
  description?: string;
  /** Kit de origem (`shadcn-like`), quando importado de um kit. */
  kit?: string;
  props: PropDef[];
  /** Árvore do principal; ids únicos no documento inteiro (páginas e componentes). */
  root: Node;
  variants: ComponentVariant[];
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
  /** Biblioteca de componentes do documento. Ausente quando vazia (arquivos antigos). */
  components?: ComponentDef[];
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
