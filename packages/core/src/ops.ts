/**
 * Operações (commands) puras e serializáveis sobre o documento.
 * Cada op tem um inverso exato, calculado em `applyOp` (ver `apply.ts`).
 */
import type {
  ComponentDef,
  ComponentVariant,
  Document,
  FontRef,
  Node,
  NodeOverride,
  Position,
  PropDef,
  PropValue,
  Theme,
  TokenMeta,
  DataSource,
  EffectSpec,
  EmbedSpec,
  Vector,
  VideoSpec,
} from './types.js';

export interface CreateNodeOp {
  type: 'createNode';
  /** Pai do novo nó. Omitido/null quando o nó é um frame raiz (então `pageId` é obrigatório). */
  parentId?: string | null;
  /** Página destino (obrigatório para frames raiz; opcional caso contrário). */
  pageId?: string;
  /** Nó completo, com id já gerado (ids dos descendentes também). */
  node: Node;
  /** Índice de inserção; omitido = ao final. */
  index?: number;
}

export interface DeleteNodesOp {
  type: 'deleteNodes';
  nodeIds: string[];
}

export interface MoveNodesOp {
  type: 'moveNodes';
  nodeIds: string[];
  /** Novo pai; omitido = mantém o pai atual (reordenação). `null` = virar frame raiz em `pageId`. */
  parentId?: string | null;
  pageId?: string;
  /** Índice destino no novo pai; omitido = ao final. */
  index?: number;
}

export interface StyleChange {
  nodeId: string;
  set?: Record<string, string>;
  unset?: string[];
}
export interface UpdateStylesOp {
  type: 'updateStyles';
  /** Forma em lote: uma entrada por nó. */
  changes?: StyleChange[];
  /** Forma simples: os mesmos estilos para vários nós. */
  nodeIds?: string[];
  styles?: Record<string, string>;
  unset?: string[];
}

export interface SetTextOp {
  type: 'setText';
  /** `null` remove o campo `text` do nó. */
  changes: { nodeId: string; text: string | null }[];
}

export interface SetAttrsOp {
  type: 'setAttrs';
  changes: { nodeId: string; set?: Record<string, string>; unset?: string[] }[];
}

export interface RenameNodesOp {
  type: 'renameNodes';
  changes: { nodeId: string; name: string }[];
}

export interface DuplicateNodesOp {
  type: 'duplicateNodes';
  nodeIds: string[];
  /**
   * Mapa oldId → newId para o nó e todos os descendentes. Se omitido, `applyOp` gera os ids
   * e os devolve em `result.idMap`; a op inversa/registrada deve conter o mapa para ser determinística.
   */
  idMap?: Record<string, string>;
}

export interface SetPositionOp {
  type: 'setPosition';
  /** `null` remove o campo `position` do nó. */
  changes: { nodeId: string; position: Position | null }[];
}

export interface CreatePageOp {
  type: 'createPage';
  pageId: string;
  name: string;
  index?: number;
  background?: string;
  /** Frames já existentes da página (usado pelo inverso de deletePage). */
  frames?: Node[];
}

export interface DeletePageOp {
  type: 'deletePage';
  pageId: string;
}

export interface RenamePageOp {
  type: 'renamePage';
  pageId: string;
  name: string;
}

export interface SetTokensOp {
  type: 'setTokens';
  set?: Record<string, string>;
  unset?: string[];
  /** Tema alvo: os valores vão para `overrides` desse tema (que precisa existir) em vez dos tokens base. */
  theme?: string;
}

/** Define (substitui por inteiro) ou remove os metadados (grupo, descrição) de tokens. */
export interface SetTokenMetaOp {
  type: 'setTokenMeta';
  set?: Record<string, TokenMeta>;
  unset?: string[];
}

/** Substitui a lista de temas (criar, remover, renomear, reordenar); nomes únicos. */
export interface SetThemesOp {
  type: 'setThemes';
  themes: Theme[];
}

/** Substitui o sistema de tokens inteiro (tokens base, metadados e temas). Usado por importação e inversos. */
export interface ReplaceTokensOp {
  type: 'replaceTokens';
  tokens: Record<string, string>;
  tokenMeta?: Record<string, TokenMeta>;
  themes?: Theme[];
}

/**
 * Renomeia um token: chave nos tokens base, nos metadados e nos temas, e todas as referências
 * `var(--antigo)` (estilos dos nós, valores de `attrs`, markup de SVG inline, tokens e temas).
 * O destino não pode existir como token nem estar declarado no estilo de algum nó.
 */
export interface RenameTokenOp {
  type: 'renameToken';
  from: string;
  to: string;
}

/** Toggle de `locked`/`hidden`. */
export interface SetNodeFlagsOp {
  type: 'setNodeFlags';
  changes: { nodeId: string; locked?: boolean; hidden?: boolean }[];
}

/** Troca a tag HTML de nós (ex.: `div` → `section`). Tags bloqueadas/inválidas são recusadas. */
export interface SetTagOp {
  type: 'setTag';
  changes: { nodeId: string; tag: string }[];
}

/** Substitui a lista de fontes do documento (usada por `add_font`). */
export interface SetFontsOp {
  type: 'setFonts';
  fonts: FontRef[];
}

/** Troca o `src` de nós image (caminho relativo a `assets/` ou data URL). */
export interface SetSrcOp {
  type: 'setSrc';
  changes: { nodeId: string; src: string }[];
}

/**
 * Troca o markup SVG de nós `type: 'svg'` (sanitizado como na criação do nó). `attrs`, quando
 * informado, substitui `node.attrs` por inteiro (usado no undo do `renameToken`, já que
 * `setAttrs` em nó svg com markup grava no `<svg>` raiz e não em `node.attrs`).
 */
export interface SetSvgOp {
  type: 'setSvg';
  changes: { nodeId: string; svg: string; attrs?: Record<string, string> }[];
}

/**
 * Define as classes Tailwind escritas no nó (`node.classes`, dica de round-trip). `null` ou `''`
 * remove. Não mexe no estilo: `set_classes` combina esta op com `updateStyles` e `setStates`.
 */
export interface SetClassesOp {
  type: 'setClasses';
  changes: { nodeId: string; classes: string | null }[];
}

/**
 * Substitui os estados do nó (`node.states`: `hover`, `dark`, `md`...; ver `states.ts`).
 * `null` ou `{}` remove todos.
 */
export interface SetStatesOp {
  type: 'setStates';
  changes: { nodeId: string; states: Record<string, Record<string, string>> | null }[];
}

/** CSS base do documento: `tailwind` (preflight do Tailwind v4) ou `default`. */
export interface SetCssBaseOp {
  type: 'setCssBase';
  base: 'default' | 'tailwind';
}

/* ---------------- Componentes (ver docs/COMPONENTES.md e components/ops.ts) ---------------- */

/** Acrescenta um componente principal à biblioteca (`index` omitido = ao final). */
export interface AddComponentOp {
  type: 'addComponent';
  component: ComponentDef;
  index?: number;
}

/**
 * Remove um componente principal. Recusa se houver instâncias (nas páginas ou em outros
 * principais), a menos que `force`: interno, só no inverso de um `addComponent` feito quando já
 * havia instâncias desse id (o desfazer restaura o estado anterior exato). A entrada pública
 * (`assertPublicOps`: WS `op:apply` e MCP) recusa `force`.
 */
export interface DeleteComponentOp {
  type: 'deleteComponent';
  componentId: string;
  force?: boolean;
}

/** Atualiza campos do principal; `null` em `description`/`kit` remove o campo. */
export interface UpdateComponentOp {
  type: 'updateComponent';
  componentId: string;
  name?: string;
  description?: string | null;
  kit?: string | null;
  props?: PropDef[];
  variants?: ComponentVariant[];
  root?: Node;
}

/** Troca o nó `nodeId` por `node` no mesmo lugar (ids novos validados contra o documento). */
export interface ReplaceNodeOp {
  type: 'replaceNode';
  nodeId: string;
  node: Node;
}

/** Define/remove props de instâncias. */
export interface SetInstancePropsOp {
  type: 'setInstanceProps';
  changes: { nodeId: string; set?: Record<string, PropValue>; unset?: string[] }[];
}

/** Substitui o mapa de overrides de instâncias (`null` remove todos). */
export interface SetInstanceOverridesOp {
  type: 'setInstanceOverrides';
  changes: { nodeId: string; overrides: Record<string, NodeOverride> | null }[];
}

/**
 * Dados de nós repeater: `data` substitui a lista (omitido = mantém); `source` define a origem
 * (omitido = mantém, `null` = remove).
 */
export interface SetDataOp {
  type: 'setData';
  /** `data: null` apaga a lista (usado pelo undo quando o nó não tinha dados). */
  changes: { nodeId: string; data?: unknown[] | null; source?: DataSource | null }[];
}

/**
 * Define (ou remove, com `vector: null`) o modelo vetorial de nós svg. Com vetor, `node.svg` passa
 * a ser `svg` (se informado) ou `vectorToSvg(vector)`; o inverso restaura vetor e markup.
 */
export interface SetVectorOp {
  type: 'setVector';
  changes: { nodeId: string; vector: Vector | null; svg?: string }[];
}

/**
 * Troca a especificação de mídia de nós: `effect` em nós effect, `video` em nós video e `embed`
 * em nós embed (substitui o objeto inteiro; o campo precisa casar com o tipo do nó).
 */
export interface SetMediaOp {
  type: 'setMedia';
  changes: { nodeId: string; effect?: EffectSpec; video?: VideoSpec; embed?: EmbedSpec }[];
}

export type Op =
  | CreateNodeOp
  | DeleteNodesOp
  | MoveNodesOp
  | UpdateStylesOp
  | SetTextOp
  | SetAttrsOp
  | RenameNodesOp
  | DuplicateNodesOp
  | SetPositionOp
  | CreatePageOp
  | DeletePageOp
  | RenamePageOp
  | SetTokensOp
  | SetTokenMetaOp
  | SetThemesOp
  | ReplaceTokensOp
  | RenameTokenOp
  | SetNodeFlagsOp
  | SetTagOp
  | SetFontsOp
  | SetSrcOp
  | SetSvgOp
  | SetClassesOp
  | SetStatesOp
  | SetCssBaseOp
  | AddComponentOp
  | DeleteComponentOp
  | UpdateComponentOp
  | ReplaceNodeOp
  | SetInstancePropsOp
  | SetInstanceOverridesOp
  | SetDataOp
  | SetVectorOp
  | SetMediaOp;

export type OpType = Op['type'];

export interface ApplyResult {
  /** Novo documento (o original não é mutado). */
  doc: Document;
  /** Op(s) que desfazem exatamente esta op. */
  inverse: Op[];
  /** Dados extras, ex. `{ idMap }` em duplicateNodes, `{ nodeIds }` em createNode. */
  result?: Record<string, unknown>;
}
