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
export type NodeType = 'frame' | 'element' | 'text' | 'image' | 'svg' | 'instance';

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
