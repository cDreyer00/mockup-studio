/**
 * Mockup Studio document model (schema version 1).
 *
 * A document is readable JSON (`*.mockup.json`) with pages; each page has
 * frames (root nodes that work as artboards/breakpoints) and each frame has
 * a tree of nodes that map to real HTML elements with real CSS.
 */

export const DOCUMENT_VERSION = 1 as const;

/**
 * `instance`: instance of a document component (`componentId`); the children are only the
 * slot containers (see `docs/COMPONENTS.md`). Render, export and screenshot use the concrete
 * tree from `expandInstance`.
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

/** Effect/embed parameter value: number, text (color, option) or boolean. */
export type MediaParamValue = number | string | boolean;

/** Visual effect (WebGL shader or particles) of a `type: 'effect'` node (see `effects/catalog.ts`). */
export interface EffectSpec {
  /** Effect type, e.g. `mesh-gradient`, `grain`, `particles` (see `list_effects`). */
  kind: string;
  /** Effect parameters; missing ones use the catalog default. */
  params: Record<string, MediaParamValue>;
}

/** Video of a `type: 'video'` node. */
export interface VideoSpec {
  /** Path relative to `assets/` or an http(s) URL. */
  src: string;
  /** Poster image (relative to `assets/` or an http(s) URL). */
  poster?: string;
  autoplay?: boolean;
  loop?: boolean;
  muted?: boolean;
  controls?: boolean;
  /** Time (s) shown in the screenshot when there is no `poster` (default 0). */
  time?: number;
}

export type EmbedProvider = 'lottie' | 'rive' | 'youtube' | 'three' | 'iframe';

/** Embedded content of a `type: 'embed'` node. */
export interface EmbedSpec {
  provider: EmbedProvider;
  /** Local file relative to `assets/` or an http(s) URL (lottie `.json`, rive `.riv`). */
  src?: string;
  /** URL http(s) (youtube, iframe). */
  url?: string;
  /** JavaScript code of the Three.js island (function body; see docs/EMBEDS.md). */
  code?: string;
  /** Provider options (e.g.: `autoplay`, `loop`, `artboard`, `stateMachine`, `start`). */
  params?: Record<string, MediaParamValue>;
}

export interface Position {
  x: number;
  y: number;
}

export interface Node {
  id: string;
  type: NodeType;
  /** Readable name (layer). */
  name: string;
  /** Tag HTML: div, section, button, img, h1, p, span... */
  tag: string;
  /** HTML attributes (without `style`, without `class`). */
  attrs: Record<string, string>;
  /** CSS properties in kebab-case with real CSS values, e.g. { 'display': 'flex', 'gap': '24px' }. */
  style: Record<string, string>;
  /** Text content (type 'text'). */
  text?: string;
  /** Image: path relative to `assets/` or data URL (type 'image'). */
  src?: string;
  /** Markup SVG inline (type 'svg'). */
  svg?: string;
  /**
   * Editable vector model (type 'svg'). When present, `svg` is the markup generated from it
   * (`vectorToSvg`): `raw` intact until there is an edit, otherwise regenerated from `paths`.
   */
  vector?: Vector;
  /** Effect (type 'effect'). */
  effect?: EffectSpec;
  /** Video (type 'video'). */
  video?: VideoSpec;
  /** Embed: Lottie, Rive, YouTube, Three.js or iframe (type 'embed'). */
  embed?: EmbedSpec;
  children: Node[];
  locked: boolean;
  hidden: boolean;
  /** Position on the canvas (root frames) or x/y of children with `position: absolute`. */
  position?: Position;
  /**
   * Tailwind classes as written (`write_html`, `set_classes`, paste). It is a round-trip
   * hint: render uses `style`/`states`; the Tailwind export reuses the classes that
   * still match the current style. See `docs/TAILWIND.md`.
   */
  classes?: string;
  /**
   * Conditional styles per variant (`hover`, `dark`, `md`, `md:hover`...; see `states.ts`).
   * Absent when empty.
   */
  states?: Record<string, Record<string, string>>;
  /**
   * Component of the instance (`type: 'instance'`). In the expanded tree (`expandInstance`) the concrete
   * root node keeps `componentId` and `props` as an instance marker.
   */
  componentId?: string;
  /** Values of the instance props (only those that differ from the component default). */
  props?: Record<string, PropValue>;
  /**
   * Overrides by node path of the main component: key = ids of the main component's nodes
   * separated by `/` (crossing nested instances), e.g. `el_label01` or `el_btn0001/el_label01`.
   */
  overrides?: Record<string, NodeOverride>;
  /**
   * Repeater (type 'repeater'): data items. The children are the template, repeated once per
   * item, with `{{field}}` bindings resolved in texts, `src` and attributes (see `data.ts`).
   */
  data?: unknown[];
  /** Repeater: data source (for refreshing) and field mapping. */
  dataSource?: DataSource;
}

/** Data source of a repeater. */
export interface DataSource {
  /** `inline`: pasted/edited data; `json`/`csv`: local file; `url`: HTTP(S) (JSON or CSV). */
  kind: 'inline' | 'json' | 'csv' | 'url';
  /** Absolute path of the file (`json`/`csv`). */
  path?: string;
  /** URL http(s) (`url`). */
  url?: string;
  /** Path to the list inside the JSON, e.g.: `data.items`. */
  select?: string;
  /** Template field → path in the item, e.g.: `{ "name": "user.fullName" }`. */
  mapping?: Record<string, string>;
  /** Maximum items read from the source. */
  limit?: number;
  /** When the data was read from the source (ISO 8601). */
  fetchedAt?: string;
}

/* ---------------- Components ---------------- */

export type PropType = 'string' | 'number' | 'boolean' | 'enum' | 'color' | 'slot';
export type PropValue = string | number | boolean;

/** Prop of a component. Strings/numbers/colors enter via `{{name}}`; slots via `data-slot`. */
export interface PropDef {
  name: string;
  type: PropType;
  /** Default value (absent for `slot`). */
  default?: PropValue;
  /** `enum` options. */
  options?: string[];
  description?: string;
}

/** Override of a node in the component tree (in a variant or an instance). */
export interface NodeOverride {
  /** Styles merged over the main component's. */
  style?: Record<string, string>;
  /** Style properties removed from the main component. */
  unsetStyle?: string[];
  text?: string;
  /** Attributes merged over the main component's. */
  attrs?: Record<string, string>;
  hidden?: boolean;
  classes?: string;
  /** States merged per variant (`hover`, `dark`...). */
  states?: Record<string, Record<string, string>>;
  src?: string;
  svg?: string;
  /** Props of an instance nested in the main component. */
  props?: Record<string, PropValue>;
  /** Vector model (svg node only); the markup comes from `svg` or is generated from the vector. */
  vector?: Vector;
  /** Whole effect (effect node only; replaces the main component's). */
  effect?: EffectSpec;
  /** Whole video (video node only). */
  video?: VideoSpec;
  /** Whole embed (embed node only). */
  embed?: EmbedSpec;
  /** Repeater items (repeater node only; replace the main component's). */
  data?: unknown[];
  /** Repeater data source (repeater node only). */
  dataSource?: DataSource;
}

/** Variant: when the props match `when`, applies `overrides` (key `''` = root node). */
export interface ComponentVariant {
  when: Record<string, PropValue>;
  overrides: Record<string, NodeOverride>;
}

/** Main component (document library). */
export interface ComponentDef {
  /** Id `cp_xxxxxxxx`. */
  id: string;
  name: string;
  description?: string;
  /** Source kit (`shadcn-like`), when imported from a kit. */
  kit?: string;
  props: PropDef[];
  /** Main component tree; ids unique across the whole document (pages and components). */
  root: Node;
  variants: ComponentVariant[];
}

export interface Page {
  id: string;
  name: string;
  /** Root nodes of the page (frames). */
  frames: Node[];
  /** Page canvas color/background (CSS value). */
  background: string;
}

export interface FontRef {
  family: string;
  source?: 'local' | 'file' | 'google';
  /** Font files relative to `assets/` (e.g.: `fonts/inter-400.woff2`). */
  files?: string[];
  /** Weight of each file (parallel to `files`) or the range covered. */
  weights?: number[];
  /** Style of each file (`normal` | `italic`), parallel to `files`. */
  styles?: string[];
}

/** Token metadata: group (colors, typography...) and description. See `tokens.ts`. */
export interface TokenMeta {
  /** Token group: `color`, `typography`, `spacing`, `radius`, `shadow`, `other` or a free name. Absent = inferred from the name/value. */
  group?: string;
  description?: string;
}

/**
 * Theme: overrides token values inside nodes with `data-theme="<name>"` (real CSS:
 * `[data-theme="dark"] { --color-bg: #0b0b0b }`). Base tokens apply outside any theme.
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
  /** Document CSS variables, e.g. { '--color-primary': '#6c5ce7' }. */
  tokens: Record<string, string>;
  /** Group/description per token (key = token name). Absent when empty. */
  tokenMeta?: Record<string, TokenMeta>;
  /** Document themes, in display order. Absent when empty. */
  themes?: Theme[];
  fonts: FontRef[];
  /**
   * Document base CSS: absent (Mockup Studio default) or `tailwind` (adds the Tailwind v4
   * preflight on the canvas, in the render and in the exported code).
   */
  cssBase?: 'tailwind';
  /** Document component library. Absent when empty (old files). */
  components?: ComponentDef[];
  meta: DocumentMeta;
}

/** Location of a node inside the document. */
export interface NodePath {
  node: Node;
  page: Page;
  /** Immediate parent; `null` when the node is a root frame of the page. */
  parent: Node | null;
  /** Index of the node in `parent.children` (or in `page.frames` when root). */
  index: number;
  /** Ancestor chain, from the root frame to the immediate parent (empty for root frames). */
  ancestors: Node[];
}

/* -------------------------------------------------------------------------------- vectors */

/** viewBox rectangle of a vector (SVG units). */
export interface VectorViewBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface VectorGradientStop {
  /** 0 to 1. */
  offset: number;
  /** CSS color. */
  color: string;
  /** 0 to 1 (default 1). */
  opacity?: number;
}

/** Fill/stroke gradient. Coordinates as a fraction of the path box (objectBoundingBox). */
export interface VectorGradient {
  type: 'linear' | 'radial';
  stops: VectorGradientStop[];
  /** Linear: start and end (default 0,0 → 1,0). */
  x1?: number;
  y1?: number;
  x2?: number;
  y2?: number;
  /** Radial: center and radius (default 0.5, 0.5, 0.5). */
  cx?: number;
  cy?: number;
  r?: number;
}

/** Paint: CSS color (`#111`, `none`, `currentColor`, `var(--x)`) or gradient. */
export type VectorPaint = string | VectorGradient;

/** An editable `<path>`, with already-resolved styles (no inheritance from `<g>`/`<svg>`). */
export interface VectorPath {
  /** Stable id within the vector (e.g.: `p1`). */
  id: string;
  /** Path data SVG (`M 0 0 L 10 0 Z`). */
  d: string;
  fill?: VectorPaint;
  stroke?: VectorPaint;
  strokeWidth?: number;
  /** 0 to 1. */
  opacity?: number;
  strokeLinecap?: 'butt' | 'round' | 'square';
  strokeLinejoin?: 'miter' | 'round' | 'bevel';
  /** E.g.: `4 2`. */
  strokeDasharray?: string;
  fillRule?: 'nonzero' | 'evenodd';
}

export interface Vector {
  viewBox: VectorViewBox;
  /** Editable paths. Empty when the imported SVG is not simple (only `raw` applies). */
  paths: VectorPath[];
  /** Original markup (sanitized), preserved intact until the first edit of the paths. */
  raw?: string;
  /** Extra attributes of the root `<svg>` kept on regeneration (e.g.: `preserveAspectRatio`). */
  attrs?: Record<string, string>;
}
