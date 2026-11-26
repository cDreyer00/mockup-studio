/**
 * Pure, serializable operations (commands) on the document.
 * Each op has an exact inverse, computed in `applyOp` (see `apply.ts`).
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
  NodeAnimation,
  SlideTransition,
  Vector,
  VideoSpec,
} from './types.js';

export interface CreateNodeOp {
  type: 'createNode';
  /** Parent of the new node. Omitted/null when the node is a root frame (then `pageId` is required). */
  parentId?: string | null;
  /** Target page (required for root frames; optional otherwise). */
  pageId?: string;
  /** Complete node, with its id already generated (descendant ids too). */
  node: Node;
  /** Insertion index; omitted = at the end. */
  index?: number;
}

export interface DeleteNodesOp {
  type: 'deleteNodes';
  nodeIds: string[];
}

export interface MoveNodesOp {
  type: 'moveNodes';
  nodeIds: string[];
  /** New parent; omitted = keep the current parent (reorder). `null` = become a root frame in `pageId`. */
  parentId?: string | null;
  pageId?: string;
  /** Target index in the new parent; omitted = at the end. */
  index?: number;
}

export interface StyleChange {
  nodeId: string;
  set?: Record<string, string>;
  unset?: string[];
}
export interface UpdateStylesOp {
  type: 'updateStyles';
  /** Batch form: one entry per node. */
  changes?: StyleChange[];
  /** Simple form: the same styles for several nodes. */
  nodeIds?: string[];
  styles?: Record<string, string>;
  unset?: string[];
}

export interface SetTextOp {
  type: 'setText';
  /** `null` removes the `text` field from the node. */
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
   * Map oldId → newId for the node and all descendants. If omitted, `applyOp` generates the ids
   * and returns them in `result.idMap`; the inverse/recorded op must contain the map to be deterministic.
   */
  idMap?: Record<string, string>;
}

export interface SetPositionOp {
  type: 'setPosition';
  /** `null` removes the `position` field from the node. */
  changes: { nodeId: string; position: Position | null }[];
}

export interface CreatePageOp {
  type: 'createPage';
  pageId: string;
  name: string;
  index?: number;
  background?: string;
  /** Frames already existing in the page (used by the inverse of deletePage). */
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
  /** Target theme: the values go to that theme's `overrides` (which must exist) instead of the base tokens. */
  theme?: string;
}

/** Sets (replaces entirely) or removes token metadata (group, description). */
export interface SetTokenMetaOp {
  type: 'setTokenMeta';
  set?: Record<string, TokenMeta>;
  unset?: string[];
}

/** Replaces the theme list (create, remove, rename, reorder); unique names. */
export interface SetThemesOp {
  type: 'setThemes';
  themes: Theme[];
}

/** Replaces the entire token system (base tokens, metadata and themes). Used by import and inverses. */
export interface ReplaceTokensOp {
  type: 'replaceTokens';
  tokens: Record<string, string>;
  tokenMeta?: Record<string, TokenMeta>;
  themes?: Theme[];
}

/**
 * Renames a token: key in the base tokens, metadata and themes, and all `var(--old)`
 * references (node styles, `attrs` values, inline SVG markup, tokens and themes).
 * The target must not exist as a token nor be declared in the style of any node.
 */
export interface RenameTokenOp {
  type: 'renameToken';
  from: string;
  to: string;
}

/** Toggle `locked`/`hidden`. */
export interface SetNodeFlagsOp {
  type: 'setNodeFlags';
  changes: { nodeId: string; locked?: boolean; hidden?: boolean }[];
}

/** Changes the HTML tag of nodes (e.g. `div` → `section`). Blocked/invalid tags are rejected. */
export interface SetTagOp {
  type: 'setTag';
  changes: { nodeId: string; tag: string }[];
}

/** Replaces the document font list (used by `add_font`). */
export interface SetFontsOp {
  type: 'setFonts';
  fonts: FontRef[];
}

/** Changes the `src` of image nodes (path relative to `assets/` or data URL). */
export interface SetSrcOp {
  type: 'setSrc';
  changes: { nodeId: string; src: string }[];
}

/**
 * Changes the SVG markup of `type: 'svg'` nodes (sanitized as on node creation). `attrs`, when
 * provided, replaces `node.attrs` entirely (used in the undo of `renameToken`, since
 * `setAttrs` on an svg node with markup writes to the root `<svg>` and not to `node.attrs`).
 */
export interface SetSvgOp {
  type: 'setSvg';
  changes: { nodeId: string; svg: string; attrs?: Record<string, string> }[];
}

/**
 * Sets the Tailwind classes written on the node (`node.classes`, round-trip hint). `null` or `''`
 * removes. Does not touch the style: `set_classes` combines this op with `updateStyles` and `setStates`.
 */
export interface SetClassesOp {
  type: 'setClasses';
  changes: { nodeId: string; classes: string | null }[];
}

/**
 * Replaces the node states (`node.states`: `hover`, `dark`, `md`...; see `states.ts`).
 * `null` or `{}` removes all.
 */
export interface SetStatesOp {
  type: 'setStates';
  changes: { nodeId: string; states: Record<string, Record<string, string>> | null }[];
}

/** Document base CSS: `tailwind` (Tailwind v4 preflight) or `default`. */
export interface SetCssBaseOp {
  type: 'setCssBase';
  base: 'default' | 'tailwind';
}

/* ---------------- Components (see docs/COMPONENTS.md and components/ops.ts) ---------------- */

/** Adds a main component to the library (`index` omitted = at the end). */
export interface AddComponentOp {
  type: 'addComponent';
  component: ComponentDef;
  index?: number;
}

/**
 * Removes a main component. Rejected if there are instances (in pages or in other
 * main components), unless `force`: internal, only in the inverse of an `addComponent` done when
 * instances of that id already existed (undo restores the exact previous state). The public entry
 * (`assertPublicOps`: WS `op:apply` and MCP) rejects `force`.
 */
export interface DeleteComponentOp {
  type: 'deleteComponent';
  componentId: string;
  force?: boolean;
}

/** Updates fields of the main component; `null` in `description`/`kit` removes the field. */
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

/** Replaces node `nodeId` with `node` in the same place (new ids validated against the document). */
export interface ReplaceNodeOp {
  type: 'replaceNode';
  nodeId: string;
  node: Node;
}

/** Sets/removes props of instances. */
export interface SetInstancePropsOp {
  type: 'setInstanceProps';
  changes: { nodeId: string; set?: Record<string, PropValue>; unset?: string[] }[];
}

/** Replaces the overrides map of instances (`null` removes all). */
export interface SetInstanceOverridesOp {
  type: 'setInstanceOverrides';
  changes: { nodeId: string; overrides: Record<string, NodeOverride> | null }[];
}

/**
 * Data of repeater nodes: `data` replaces the list (omitted = keep); `source` sets the origin
 * (omitted = keep, `null` = remove).
 */
export interface SetDataOp {
  type: 'setData';
  /** `data: null` clears the list (used by undo when the node had no data). */
  changes: { nodeId: string; data?: unknown[] | null; source?: DataSource | null }[];
}

/**
 * Sets (or removes, with `vector: null`) the vector model of svg nodes. With a vector, `node.svg` becomes
 * `svg` (if provided) or `vectorToSvg(vector)`; the inverse restores vector and markup.
 */
export interface SetVectorOp {
  type: 'setVector';
  changes: { nodeId: string; vector: Vector | null; svg?: string }[];
}

/**
 * Changes the media spec of nodes: `effect` on effect nodes, `video` on video nodes and `embed`
 * on embed nodes (replaces the whole object; the field must match the node type).
 */
export interface SetMediaOp {
  type: 'setMedia';
  changes: { nodeId: string; effect?: EffectSpec; video?: VideoSpec; embed?: EmbedSpec }[];
}

/**
 * Sets the motion of nodes: `animations` replaces the node's whole animation list (`null` or `[]`
 * removes it) and `transition` the slide transition of a root frame (`null` removes it). At least
 * one of the two per change; both are normalized (`normalizeAnimations`, `normalizeTransition`).
 */
export interface SetMotionOp {
  type: 'setMotion';
  changes: {
    nodeId: string;
    animations?: NodeAnimation[] | null;
    transition?: SlideTransition | null;
  }[];
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
  | SetMediaOp
  | SetMotionOp;

export type OpType = Op['type'];

export interface ApplyResult {
  /** New document (the original is not mutated). */
  doc: Document;
  /** Op(s) that exactly undo this op. */
  inverse: Op[];
  /** Extra data, e.g. `{ idMap }` in duplicateNodes, `{ nodeIds }` in createNode. */
  result?: Record<string, unknown>;
}
