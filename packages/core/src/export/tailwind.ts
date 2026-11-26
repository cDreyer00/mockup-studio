import { expandDocument } from '../components/expand.js';
import { fontFaceCss } from '../fonts.js';
import { escapeCssText } from '../html.js';
import { isValidCssPropertyName } from '../styles.js';
import { DARK_VARIANT_CSS, formatStateKey, parseStateKey, sortStateKeys } from '../states.js';
import { themeRulesCss, themeVariantsCss } from '../tokens.js';
import type { Document, Node } from '../types.js';
import type { TailwindEngine } from '../tailwind/engine.js';
import { mediaScripts, newMediaCollector } from './media.js';
import { MotionCollector, buildRuntimeScript } from './motion.js';
import {
  cleanTokens,
  escapeHtmlText,
  indentLines,
  renderHtmlTree,
  resolveRoots,
  tailwindBaseCssFor,
  usesDarkState,
  type RootSelection,
} from './common.js';

export interface TailwindExportOptions {
  /** Nodes to export (default: frames of page `pageId` or of the first page). */
  nodeIds?: string[];
  pageId?: string;
  title?: string;
  /** `true`: markup only (no `<!doctype>`/`<head>`). Default `false` (full document). */
  fragment?: boolean;
  /**
   * `true` (default): the full document includes the `@tailwindcss/browser@4` `<script>` and the theme in
   * `<style type="text/tailwindcss">`. `false` removes the script (the theme stays in the `<style>`).
   */
  cdn?: boolean;
  /**
   * Document Tailwind engine (`getTailwindEngine(doc)` from `@mockup/core/tailwind`). With it the
   * classes come out canonicalized, checked against the compiler and reusing `node.classes`;
   * without it, the static mapping (`cssToTailwind`).
   */
  tailwind?: TailwindEngine;
  /** Reads a file from `assets/`: embeds Lottie animation JSON of up to 512 KB in the HTML. */
  readAsset?: (ref: string) => string | Uint8Array | undefined;
}

export interface TailwindMapping {
  /** Equivalent Tailwind v4 classes. */
  classes: string[];
  /** Props with no equivalent class (already covered by `[prop:value]` in `classes` when possible). */
  rest: Record<string, string>;
}

/* ====================================================================== */
/* Value utilities                                                        */
/* ====================================================================== */

/** Splits into top-level tokens (outside parentheses and quotes) by space or comma. */
function splitTop(value: string, sep: 'space' | 'comma'): string[] {
  const out: string[] = [];
  let buf = '';
  let depth = 0;
  let quote = '';
  const isSep = (ch: string): boolean => (sep === 'comma' ? ch === ',' : /\s/.test(ch));
  for (const ch of value) {
    if (quote) {
      if (ch === quote) quote = '';
    } else if (ch === '"' || ch === "'") quote = ch;
    else if (ch === '(') depth++;
    else if (ch === ')') depth = Math.max(0, depth - 1);
    else if (depth === 0 && isSep(ch)) {
      if (buf.trim()) out.push(buf.trim());
      buf = '';
      continue;
    }
    buf += ch;
  }
  if (buf.trim()) out.push(buf.trim());
  return out;
}

interface Ctx {
  tokens?: Record<string, string>;
}

interface VarRef {
  name: string;
  fallback?: string;
}

function parseVar(value: string): VarRef | null {
  const m = /^var\(\s*(--[a-zA-Z0-9_-]+)\s*(?:,\s*([\s\S]+))?\)$/.exec(value.trim());
  if (!m) return null;
  return { name: m[1], fallback: m[2]?.trim() };
}

type Namespace =
  'color' | 'font' | 'text' | 'weight' | 'radius' | 'shadow' | 'spacing' | 'leading' | 'tracking';

/** Tailwind v4 theme variable prefixes (most specific first). */
const NAMESPACES: [string, Namespace][] = [
  ['--font-weight-', 'weight'],
  ['--color-', 'color'],
  ['--font-', 'font'],
  ['--text-', 'text'],
  ['--radius-', 'radius'],
  ['--shadow-', 'shadow'],
  ['--spacing-', 'spacing'],
  ['--leading-', 'leading'],
  ['--tracking-', 'tracking'],
];

const SHORT_NAME_RE = /^[a-zA-Z0-9]+(?:-[a-zA-Z0-9]+)*$/;

/** Theme namespace of a token (`--color-primary` → color/`primary`); `null` outside the namespaces. */
export function themeNamespace(name: string): { ns: Namespace; short: string } | null {
  for (const [prefix, ns] of NAMESPACES) {
    if (name.startsWith(prefix)) {
      const short = name.slice(prefix.length);
      if (SHORT_NAME_RE.test(short)) return { ns, short };
      return null;
    }
  }
  return null;
}

/** Short theme name if `value` is `var(--ns-x)` of the expected namespace (and the token exists). */
function themeShort(value: string, want: Namespace, ctx: Ctx): string | null {
  const v = parseVar(value);
  if (!v || v.fallback !== undefined) return null;
  const t = themeNamespace(v.name);
  if (!t || t.ns !== want) return null;
  if (ctx.tokens && !(v.name in ctx.tokens)) return null;
  return t.short;
}

/** Escapes a value for use inside `[...]`: spaces become `_`, a literal `_` becomes `\_`. `null` if unsafe. */
function arb(value: string): string | null {
  const v = value.trim().replace(/\s*,\s*/g, ',');
  if (v === '' || /[{};<>`\n\r]/.test(v)) return null;
  return v.replace(/_/g, '\\_').replace(/\s+/g, '_');
}

/** `12px`/`0.5rem`/`0` → px. */
function toPx(value: string): number | null {
  const m = /^(-?(?:\d+\.?\d*|\.\d+))(px|rem)?$/.exec(value.trim());
  if (!m) return null;
  const n = parseFloat(m[1]);
  if (m[2] === 'rem') return n * 16;
  if (m[2] === 'px' || n === 0) return n;
  return null;
}

/** Lookup that ignores keys inherited from `Object.prototype`. */
function own<T>(table: Record<string, T>, key: string): T | undefined {
  return Object.hasOwn(table, key) ? table[key] : undefined;
}

const fmt = (n: number): string => String(Math.round(n * 1000) / 1000);

/** Step of the v4 spacing scale (`--spacing: 0.25rem`): 4px = 1; accepts half steps. */
function scaleStep(px: number): string | null {
  if (px === 0) return '0';
  if (px === 1) return 'px';
  if (px > 0 && px % 2 === 0) return fmt(px / 4);
  return null;
}

const FRACTIONS: [number, string][] = [
  [1 / 2, '1/2'],
  [1 / 3, '1/3'],
  [2 / 3, '2/3'],
  [1 / 4, '1/4'],
  [3 / 4, '3/4'],
  [1 / 5, '1/5'],
  [2 / 5, '2/5'],
  [3 / 5, '3/5'],
  [4 / 5, '4/5'],
  [1 / 6, '1/6'],
  [5 / 6, '5/6'],
];

interface SpacingOpts {
  /** Accepts `%` (`full`, `1/2`) and size keywords. */
  percent?: boolean;
  /** Largest px value that still uses the scale (above that, an arbitrary value). */
  maxScale?: number;
  /** Accepts `auto`. */
  auto?: boolean;
}

/** Suffix of a spacing/size value: `4`, `[13px]`, `(--x)`, `full`, `1/2`, theme. */
function spacingSuffix(value: string, ctx: Ctx, opts: SpacingOpts = {}): string | null {
  const v = value.trim();
  if (v === 'auto') return opts.auto ? 'auto' : null;
  const px = toPx(v);
  if (px !== null) {
    const max = opts.maxScale ?? Infinity;
    const step = Math.abs(px) <= max ? scaleStep(Math.abs(px)) : null;
    const sign = px < 0 ? '-' : '';
    if (step !== null) return sign + step;
    const a = arb(v);
    return a === null ? null : `[${a}]`;
  }
  if (opts.percent) {
    const pm = /^(-?\d+(?:\.\d+)?)%$/.exec(v);
    if (pm) {
      const pct = parseFloat(pm[1]);
      if (pct === 100) return 'full';
      for (const [f, label] of FRACTIONS) if (Math.abs(pct - f * 100) < 0.01) return label;
    }
  }
  const t = themeShort(v, 'spacing', ctx);
  if (t) return t;
  const ref = parseVar(v);
  if (ref && ref.fallback === undefined) return `(${ref.name})`;
  const a = arb(v);
  return a === null ? null : `[${a}]`;
}

/** `prefix-suffix`, with the negative sign moved to the front (`-mt-2`). */
function withPrefix(prefix: string, suffix: string): string {
  return suffix.startsWith('-') ? `-${prefix}-${suffix.slice(1)}` : `${prefix}-${suffix}`;
}

function spacing(prefix: string, value: string, ctx: Ctx, opts: SpacingOpts = {}): string | null {
  const s = spacingSuffix(value, ctx, opts);
  return s === null ? null : withPrefix(prefix, s);
}

/** Expands 1–4 values (`margin`/`padding` style) into [top, right, bottom, left]. */
function expandSides(values: string[]): [string, string, string, string] | null {
  const [a, b, c, d] = values;
  switch (values.length) {
    case 1:
      return [a, a, a, a];
    case 2:
      return [a, b, a, b];
    case 3:
      return [a, b, c, b];
    case 4:
      return [a, b, c, d];
    default:
      return null;
  }
}

/** Sides of `padding`/`margin`/`inset`/`border-radius`...: merges equal sides (`p-4`, `py-5 px-16`). */
function sides(
  base: string,
  value: string,
  ctx: Ctx,
  opts: SpacingOpts,
  names: { x: string; y: string; t: string; r: string; b: string; l: string },
): string[] | null {
  const vals = expandSides(splitTop(value, 'space'));
  if (!vals) return null;
  const [t, r, b, l] = vals;
  const one = (prefix: string, v: string): string | null => spacing(prefix, v, ctx, opts);
  const out: (string | null)[] = [];
  if (t === r && r === b && b === l) out.push(one(base, t));
  else {
    if (t === b) out.push(one(names.y, t));
    else out.push(one(names.t, t), one(names.b, b));
    if (r === l) out.push(one(names.x, r));
    else out.push(one(names.r, r), one(names.l, l));
  }
  return out.some((c) => c === null) ? null : (out as string[]);
}

const PAD_NAMES = { x: 'px', y: 'py', t: 'pt', r: 'pr', b: 'pb', l: 'pl' };
const MAR_NAMES = { x: 'mx', y: 'my', t: 'mt', r: 'mr', b: 'mb', l: 'ml' };
const INSET_NAMES = {
  x: 'inset-x',
  y: 'inset-y',
  t: 'top',
  r: 'right',
  b: 'bottom',
  l: 'left',
};

/* ---------------------------- colors --------------------------- */

const NAMED_COLOR_PASSTHROUGH = new Set(['transparent', 'white', 'black']);

/** Color suffix: `primary`, `[#6c5ce7]`, `(color:--x)`, `transparent`, `current`. */
function colorSuffix(value: string, ctx: Ctx): string | null {
  const v = value.trim();
  const lower = v.toLowerCase();
  if (NAMED_COLOR_PASSTHROUGH.has(lower)) return lower;
  if (lower === 'currentcolor') return 'current';
  const theme = themeShort(v, 'color', ctx);
  if (theme) return theme;
  const ref = parseVar(v);
  if (ref) {
    if (ref.fallback === undefined) return `(color:${ref.name})`;
    const a = arb(v);
    return a === null ? null : `[color:${a}]`;
  }
  if (['#fff', '#ffffff', '#ffff', '#ffffffff'].includes(lower)) return 'white';
  if (['#000', '#000000', '#000f', '#000000ff'].includes(lower)) return 'black';
  if (/^#[0-9a-f]{3,8}$/i.test(v)) return `[${lower}]`;
  if (/^(rgb|rgba|hsl|hsla|hwb|lab|lch|oklab|oklch|color|color-mix)\(/i.test(v)) {
    const a = arb(v);
    return a === null ? null : `[${a}]`;
  }
  if (/^[a-z]+$/i.test(v) && !['inherit', 'initial', 'unset', 'revert'].includes(lower)) {
    return `[color:${lower}]`;
  }
  return null;
}

const colorClass = (prefix: string, value: string, ctx: Ctx): string[] | null => {
  const s = colorSuffix(value, ctx);
  return s === null ? null : [`${prefix}-${s}`];
};

/* ---------------------------- keyword tables ---------------------------- */

const same = (prefix: string, values: string[]): Record<string, string> =>
  Object.fromEntries(values.map((v) => [v, `${prefix}${v}`]));

const KEYWORDS: Record<string, Record<string, string>> = {
  display: {
    block: 'block',
    'inline-block': 'inline-block',
    inline: 'inline',
    flex: 'flex',
    'inline-flex': 'inline-flex',
    grid: 'grid',
    'inline-grid': 'inline-grid',
    contents: 'contents',
    none: 'hidden',
    'flow-root': 'flow-root',
    table: 'table',
    'list-item': 'list-item',
  },
  'flex-direction': {
    row: 'flex-row',
    'row-reverse': 'flex-row-reverse',
    column: 'flex-col',
    'column-reverse': 'flex-col-reverse',
  },
  'flex-wrap': { wrap: 'flex-wrap', nowrap: 'flex-nowrap', 'wrap-reverse': 'flex-wrap-reverse' },
  'align-items': {
    'flex-start': 'items-start',
    start: 'items-start',
    'flex-end': 'items-end',
    end: 'items-end',
    center: 'items-center',
    baseline: 'items-baseline',
    stretch: 'items-stretch',
  },
  'align-self': {
    auto: 'self-auto',
    'flex-start': 'self-start',
    start: 'self-start',
    'flex-end': 'self-end',
    end: 'self-end',
    center: 'self-center',
    stretch: 'self-stretch',
    baseline: 'self-baseline',
  },
  'align-content': {
    normal: 'content-normal',
    center: 'content-center',
    'flex-start': 'content-start',
    start: 'content-start',
    'flex-end': 'content-end',
    end: 'content-end',
    'space-between': 'content-between',
    'space-around': 'content-around',
    'space-evenly': 'content-evenly',
    stretch: 'content-stretch',
    baseline: 'content-baseline',
  },
  'justify-content': {
    normal: 'justify-normal',
    'flex-start': 'justify-start',
    start: 'justify-start',
    'flex-end': 'justify-end',
    end: 'justify-end',
    center: 'justify-center',
    'space-between': 'justify-between',
    'space-around': 'justify-around',
    'space-evenly': 'justify-evenly',
    stretch: 'justify-stretch',
  },
  'justify-items': same('justify-items-', ['start', 'end', 'center', 'stretch']),
  'place-items': same('place-items-', ['start', 'end', 'center', 'stretch', 'baseline']),
  'place-content': {
    ...same('place-content-', ['start', 'end', 'center', 'stretch', 'baseline']),
    'space-between': 'place-content-between',
    'space-around': 'place-content-around',
    'space-evenly': 'place-content-evenly',
  },
  'place-self': same('place-self-', ['auto', 'start', 'end', 'center', 'stretch']),
  'justify-self': same('justify-self-', ['auto', 'start', 'end', 'center', 'stretch']),
  'text-align': same('text-', ['left', 'center', 'right', 'justify', 'start', 'end']),
  'text-transform': {
    uppercase: 'uppercase',
    lowercase: 'lowercase',
    capitalize: 'capitalize',
    none: 'normal-case',
  },
  'font-style': { italic: 'italic', normal: 'not-italic' },
  'white-space': {
    normal: 'whitespace-normal',
    nowrap: 'whitespace-nowrap',
    pre: 'whitespace-pre',
    'pre-line': 'whitespace-pre-line',
    'pre-wrap': 'whitespace-pre-wrap',
    'break-spaces': 'whitespace-break-spaces',
  },
  'text-overflow': { ellipsis: 'text-ellipsis', clip: 'text-clip' },
  'text-wrap': {
    wrap: 'text-wrap',
    nowrap: 'text-nowrap',
    balance: 'text-balance',
    pretty: 'text-pretty',
  },
  position: same('', ['static', 'relative', 'absolute', 'fixed', 'sticky']),
  visibility: { hidden: 'invisible', visible: 'visible', collapse: 'collapse' },
  cursor: same('cursor-', [
    'auto',
    'default',
    'pointer',
    'wait',
    'text',
    'move',
    'help',
    'not-allowed',
    'none',
    'grab',
    'grabbing',
    'crosshair',
    'progress',
    'context-menu',
    'cell',
    'copy',
    'alias',
    'no-drop',
    'all-scroll',
    'col-resize',
    'row-resize',
    'zoom-in',
    'zoom-out',
  ]),
  'object-fit': same('object-', ['contain', 'cover', 'fill', 'none', 'scale-down']),
  'pointer-events': same('pointer-events-', ['none', 'auto']),
  'user-select': same('select-', ['none', 'text', 'all', 'auto']),
  'box-sizing': { 'border-box': 'box-border', 'content-box': 'box-content' },
  'word-break': { normal: 'break-normal', 'break-all': 'break-all', 'keep-all': 'break-keep' },
  'overflow-wrap': {
    normal: 'wrap-normal',
    'break-word': 'wrap-break-word',
    anywhere: 'wrap-anywhere',
  },
  'vertical-align': {
    baseline: 'align-baseline',
    top: 'align-top',
    middle: 'align-middle',
    bottom: 'align-bottom',
    'text-top': 'align-text-top',
    'text-bottom': 'align-text-bottom',
    sub: 'align-sub',
    super: 'align-super',
  },
  overflow: same('overflow-', ['auto', 'hidden', 'clip', 'visible', 'scroll']),
  'overflow-x': same('overflow-x-', ['auto', 'hidden', 'clip', 'visible', 'scroll']),
  'overflow-y': same('overflow-y-', ['auto', 'hidden', 'clip', 'visible', 'scroll']),
  'background-size': { cover: 'bg-cover', contain: 'bg-contain', auto: 'bg-auto' },
  'background-repeat': {
    repeat: 'bg-repeat',
    'no-repeat': 'bg-no-repeat',
    'repeat-x': 'bg-repeat-x',
    'repeat-y': 'bg-repeat-y',
    round: 'bg-repeat-round',
    space: 'bg-repeat-space',
  },
  'background-position': same('bg-', ['center', 'top', 'bottom', 'left', 'right']),
  'background-clip': {
    text: 'bg-clip-text',
    'border-box': 'bg-clip-border',
    'padding-box': 'bg-clip-padding',
    'content-box': 'bg-clip-content',
  },
  float: same('float-', ['left', 'right', 'none']),
  'list-style-type': { none: 'list-none', disc: 'list-disc', decimal: 'list-decimal' },
  'list-style': { none: 'list-none' },
  'text-decoration-line': {
    underline: 'underline',
    overline: 'overline',
    'line-through': 'line-through',
    none: 'no-underline',
  },
  'text-decoration': {
    underline: 'underline',
    overline: 'overline',
    'line-through': 'line-through',
    none: 'no-underline',
  },
  'text-decoration-style': same('decoration-', ['solid', 'double', 'dotted', 'dashed', 'wavy']),
  resize: { none: 'resize-none', both: 'resize', vertical: 'resize-y', horizontal: 'resize-x' },
  'table-layout': { fixed: 'table-fixed', auto: 'table-auto' },
  'border-collapse': { collapse: 'border-collapse', separate: 'border-separate' },
  isolation: { isolate: 'isolate', auto: 'isolation-auto' },
  'border-style': same('border-', ['solid', 'dashed', 'dotted', 'double', 'none', 'hidden']),
  'outline-style': {
    none: 'outline-none',
    solid: 'outline-solid',
    dashed: 'outline-dashed',
    dotted: 'outline-dotted',
    double: 'outline-double',
  },
};

/* ---------------------------- tipografia ---------------------------- */

const FONT_SIZES: Record<number, string> = {
  12: 'xs',
  14: 'sm',
  16: 'base',
  18: 'lg',
  20: 'xl',
  24: '2xl',
  30: '3xl',
  36: '4xl',
  48: '5xl',
  60: '6xl',
  72: '7xl',
  96: '8xl',
  128: '9xl',
};

/** `font-size` sizes (px) that have a named class. */
export function namedFontSize(value: string): string | null {
  const px = toPx(value);
  return px !== null && FONT_SIZES[px] ? FONT_SIZES[px] : null;
}

const FONT_WEIGHTS: Record<string, string> = {
  '100': 'thin',
  '200': 'extralight',
  '300': 'light',
  '400': 'normal',
  '500': 'medium',
  '600': 'semibold',
  '700': 'bold',
  '800': 'extrabold',
  '900': 'black',
  normal: 'normal',
  bold: 'bold',
};

const LEADINGS: Record<string, string> = {
  '1': 'none',
  '1.25': 'tight',
  '1.375': 'snug',
  '1.5': 'normal',
  '1.625': 'relaxed',
  '2': 'loose',
};

const TRACKINGS: Record<string, string> = {
  '-0.05em': 'tighter',
  '-0.025em': 'tight',
  '0': 'normal',
  '0em': 'normal',
  normal: 'normal',
  '0.025em': 'wide',
  '0.05em': 'wider',
  '0.1em': 'widest',
};

const MAX_WIDTHS: Record<number, string> = {
  256: '3xs',
  288: '2xs',
  320: 'xs',
  384: 'sm',
  448: 'md',
  512: 'lg',
  576: 'xl',
  672: '2xl',
  768: '3xl',
  896: '4xl',
  1024: '5xl',
  1152: '6xl',
  1280: '7xl',
};

const RADII: Record<number, string> = {
  2: 'xs',
  4: 'sm',
  6: 'md',
  8: 'lg',
  12: 'xl',
  16: '2xl',
  24: '3xl',
  32: '4xl',
};

function fontSizeClass(value: string, ctx: Ctx): string[] | null {
  const named = namedFontSize(value);
  if (named) return [`text-${named}`];
  const theme = themeShort(value, 'text', ctx);
  if (theme) return [`text-${theme}`];
  const ref = parseVar(value);
  if (ref && ref.fallback === undefined) return [`text-(length:${ref.name})`];
  const a = arb(value);
  return a === null ? null : [`text-[${a}]`];
}

function fontWeightClass(value: string, ctx: Ctx): string[] | null {
  const w = own(FONT_WEIGHTS, value.trim());
  if (w) return [`font-${w}`];
  const theme = themeShort(value, 'weight', ctx);
  if (theme) return [`font-${theme}`];
  const ref = parseVar(value);
  if (ref && ref.fallback === undefined) return [`font-(weight:${ref.name})`];
  if (/^\d+$/.test(value.trim())) return [`font-[${value.trim()}]`];
  return null;
}

function fontFamilyClass(value: string, ctx: Ctx): string[] | null {
  const theme = themeShort(value, 'font', ctx);
  if (theme) return [`font-${theme}`];
  const ref = parseVar(value);
  if (ref && ref.fallback === undefined) return [`font-(family-name:${ref.name})`];
  const a = arb(value);
  return a === null ? null : [`font-[family-name:${a}]`];
}

function lineHeightClass(value: string, ctx: Ctx): string[] | null {
  const v = value.trim();
  const named = own(LEADINGS, v);
  if (named) return [`leading-${named}`];
  const theme = themeShort(v, 'leading', ctx);
  if (theme) return [`leading-${theme}`];
  const px = toPx(v);
  if (px !== null && px > 0 && px <= 40 && px % 4 === 0) return [`leading-${px / 4}`];
  const ref = parseVar(v);
  if (ref && ref.fallback === undefined) return [`leading-(${ref.name})`];
  const a = arb(v);
  return a === null ? null : [`leading-[${a}]`];
}

function letterSpacingClass(value: string, ctx: Ctx): string[] | null {
  const v = value.trim();
  const named = own(TRACKINGS, v);
  if (named) return [`tracking-${named}`];
  const theme = themeShort(v, 'tracking', ctx);
  if (theme) return [`tracking-${theme}`];
  const ref = parseVar(v);
  if (ref && ref.fallback === undefined) return [`tracking-(${ref.name})`];
  const a = arb(v);
  return a === null ? null : [`tracking-[${a}]`];
}

/* ---------------------------- borders ---------------------------- */

const BORDER_STYLES = new Set([
  'none',
  'solid',
  'dashed',
  'dotted',
  'double',
  'groove',
  'ridge',
  'inset',
  'outset',
  'hidden',
]);

type Side = '' | 't' | 'r' | 'b' | 'l' | 'x' | 'y';

function borderWidthClass(side: Side, value: string, _ctx?: Ctx): string | null {
  const base = side ? `border-${side}` : 'border';
  const v = value.trim();
  if (v === 'thin') return base;
  const px = toPx(v);
  if (px !== null) {
    if (px === 1) return base;
    if ([0, 2, 4, 8].includes(px)) return `${base}-${px}`;
    return `${base}-[${fmt(px)}px]`;
  }
  const ref = parseVar(v);
  if (ref && ref.fallback === undefined) return `${base}-(length:${ref.name})`;
  const a = arb(v === 'medium' ? '3px' : v === 'thick' ? '5px' : v);
  return a === null ? null : `${base}-[${a}]`;
}

function borderStyleClass(side: Side, style: string): string | null {
  if (side === '') {
    return own(KEYWORDS['border-style'], style) ?? null;
  }
  if (style === 'solid') return ''; // default (preflight)
  const prop = { t: 'top', r: 'right', b: 'bottom', l: 'left', x: '', y: '' }[side];
  return prop ? `[border-${prop}-style:${style}]` : null;
}

function borderColorClass(side: Side, value: string, ctx: Ctx): string | null {
  const s = colorSuffix(value, ctx);
  if (s === null) return null;
  return side ? `border-${side}-${s}` : `border-${s}`;
}

function borderShorthand(side: Side, value: string, ctx: Ctx): string[] | null {
  const v = value.trim();
  if (v === 'none' || v === '0')
    return side ? [`border-${side}-0`] : [v === '0' ? 'border-0' : 'border-none'];
  const out: string[] = [];
  for (const tok of splitTop(v, 'space')) {
    let c: string | null;
    if (BORDER_STYLES.has(tok)) c = borderStyleClass(side, tok);
    else if (toPx(tok) !== null || ['thin', 'medium', 'thick'].includes(tok)) {
      c = borderWidthClass(side, tok, ctx);
    } else c = borderColorClass(side, tok, ctx);
    if (c === null) return null;
    if (c !== '') out.push(c);
  }
  // `border: solid red` without a width: the initial width is `medium` (3px); only an explicit `border` is 1px
  return out.length > 0 ? out : null;
}

/* ---------------------------- radius -------------------------- */

function radiusSuffix(value: string, ctx: Ctx): string | null {
  const v = value.trim();
  const px = toPx(v);
  if (px !== null) {
    if (px === 0) return 'none';
    if (px >= 9999) return 'full';
    if (RADII[px]) return RADII[px];
    return `[${fmt(px)}px]`;
  }
  const theme = themeShort(v, 'radius', ctx);
  if (theme) return theme;
  const ref = parseVar(v);
  if (ref && ref.fallback === undefined) return `(${ref.name})`;
  const a = arb(v);
  return a === null ? null : `[${a}]`;
}

function radiusClasses(corner: string, value: string, ctx: Ctx): string[] | null {
  const prefix = corner ? `rounded-${corner}` : 'rounded';
  const s = radiusSuffix(value, ctx);
  return s === null ? null : [`${prefix}-${s}`];
}

/* ---------------------------- sizes ---------------------------- */

/** Suffix of `width`/`height` (shared with `size-*`). */
function sizeSuffix(axis: 'w' | 'h', value: string, ctx: Ctx): string | null {
  const v = value.trim();
  const special: Record<string, string> = {
    'fit-content': 'fit',
    'min-content': 'min',
    'max-content': 'max',
    '100%': 'full',
  };
  if (own(special, v)) return special[v];
  if (axis === 'w' && v === '100vw') return 'screen';
  if (axis === 'h' && v === '100vh') return 'screen';
  if (axis === 'h' && v === '100dvh') return 'dvh';
  if (axis === 'h' && v === '100svh') return 'svh';
  return spacingSuffix(v, ctx, { percent: true, maxScale: 384, auto: true });
}

function minMaxSize(prefix: string, axis: 'w' | 'h', value: string, ctx: Ctx): string[] | null {
  const v = value.trim();
  const isMax = prefix.startsWith('max');
  if (v === 'none') return isMax ? [`${prefix}-none`] : null;
  if (v === '0') return [`${prefix}-0`];
  if (isMax && axis === 'w') {
    const px = toPx(v);
    if (px !== null && MAX_WIDTHS[px]) return [`${prefix}-${MAX_WIDTHS[px]}`];
    if (px !== null) {
      const a = arb(v);
      return a === null ? null : [`${prefix}-[${a}]`];
    }
  }
  const s = sizeSuffix(axis, v, ctx);
  if (s === null) return null;
  // `min-w-auto`/`max-w-auto` do not exist in all versions: uses an arbitrary value
  if (s === 'auto') return [`${prefix}-[auto]`];
  return [`${prefix}-${s}`];
}

/* ---------------------------- shadows, opacity, grid, flex ---------------------------- */

function shadowClass(value: string, ctx: Ctx): string[] | null {
  const v = value.trim();
  if (v === 'none') return ['shadow-none'];
  const theme = themeShort(v, 'shadow', ctx);
  if (theme) return [`shadow-${theme}`];
  const ref = parseVar(v);
  if (ref && ref.fallback === undefined) return [`shadow-(${ref.name})`];
  const a = arb(v);
  return a === null ? null : [`shadow-[${a}]`];
}

function opacityClass(value: string): string[] | null {
  const v = value.trim();
  const m = /^(\d*\.?\d+)(%?)$/.exec(v);
  if (!m) {
    const a = arb(v);
    return a === null ? null : [`opacity-[${a}]`];
  }
  const n = parseFloat(m[1]);
  const pct = m[2] ? n : n * 100;
  if (Number.isInteger(Math.round(pct * 1000) / 1000) && pct >= 0 && pct <= 100) {
    return [`opacity-${Math.round(pct)}`];
  }
  return [`opacity-[${v}]`];
}

function gridTemplate(kind: 'cols' | 'rows', value: string): string[] | null {
  const v = value.trim();
  if (v === 'none') return [`grid-${kind}-none`];
  if (v === 'subgrid') return [`grid-${kind}-subgrid`];
  // Tailwind `grid-cols-N` is `repeat(N, minmax(0, 1fr))`; `repeat(N, 1fr)` (auto minimum) is something else
  const m = /^repeat\(\s*(\d+)\s*,\s*minmax\(\s*0(?:px)?\s*,\s*1fr\s*\)\s*\)$/.exec(v);
  if (m) return [`grid-${kind}-${m[1]}`];
  const a = arb(v);
  return a === null ? null : [`grid-${kind}-[${a}]`];
}

/** `grid-column`/`grid-row`: `span N` → `col-span-N`, `N` → `col-N`, anything else becomes `col-[2/span_3]`. */
function gridSpan(kind: 'col' | 'row', value: string): string[] | null {
  const v = value.trim();
  let m = /^span\s+(\d+)$/.exec(v);
  if (m) return [`${kind}-span-${m[1]}`];
  if (/^1\s*\/\s*-1$/.test(v)) return [`${kind}-span-full`];
  if (v === 'auto') return [`${kind}-auto`];
  m = /^(\d+)$/.exec(v);
  if (m) return [`${kind}-${m[1]}`];
  const a = arb(v.replace(/\s*\/\s*/g, '/'));
  return a === null ? null : [`${kind}-[${a}]`];
}

/** `grid-column-start`/`end` (and row): `col-start-2`, `col-end-auto`, `row-start-[span_2]`. */
function gridLine(prefix: string, value: string): string[] | null {
  const v = value.trim();
  if (v === 'auto' || /^-?\d+$/.test(v)) return [withPrefix(prefix, v)];
  const a = arb(v);
  return a === null ? null : [`${prefix}-[${a}]`];
}

const AUTO_TRACK_KEYWORDS: Record<string, string> = {
  auto: 'auto',
  'min-content': 'min',
  'max-content': 'max',
};

/** `grid-auto-rows`/`grid-auto-columns` → `auto-rows-*`/`auto-cols-*`. */
function gridAuto(kind: 'rows' | 'cols', value: string): string[] | null {
  const v = value.trim();
  const kw = own(AUTO_TRACK_KEYWORDS, v);
  if (kw) return [`auto-${kind}-${kw}`];
  if (/^minmax\(\s*0(?:px)?\s*,\s*1fr\s*\)$/.test(v)) return [`auto-${kind}-fr`];
  const a = arb(v);
  return a === null ? null : [`auto-${kind}-[${a}]`];
}

const GRID_FLOW: Record<string, string> = {
  row: 'grid-flow-row',
  column: 'grid-flow-col',
  dense: 'grid-flow-dense',
  'row dense': 'grid-flow-row-dense',
  'column dense': 'grid-flow-col-dense',
};

function flexShorthand(value: string): string[] | null {
  const v = value.trim().replace(/\s+/g, ' ');
  if (v === '1' || v === '1 1 0%' || v === '1 1 0' || v === '1 1 0px') return ['flex-1'];
  if (v === 'auto' || v === '1 1 auto') return ['flex-auto'];
  if (v === 'none' || v === '0 0 auto') return ['flex-none'];
  if (v === 'initial' || v === '0 1 auto') return ['flex-initial'];
  const a = arb(v);
  return a === null ? null : [`flex-[${a}]`];
}

function growShrink(kind: 'grow' | 'shrink', value: string): string[] | null {
  const v = value.trim();
  if (v === '1') return [kind];
  if (/^\d+$/.test(v)) return [`${kind}-${v}`];
  return null;
}

function gapClasses(value: string, ctx: Ctx): string[] | null {
  const vals = splitTop(value, 'space');
  if (vals.length === 1) {
    const c = spacing('gap', vals[0], ctx);
    return c === null ? null : [c];
  }
  if (vals.length === 2) {
    const y = spacing('gap-y', vals[0], ctx);
    const x = spacing('gap-x', vals[1], ctx);
    if (y === null || x === null) return null;
    return vals[0] === vals[1] ? [spacing('gap', vals[0], ctx) as string] : [y, x];
  }
  return null;
}

function backgroundShorthand(value: string, ctx: Ctx): string[] | null {
  const v = value.trim();
  if (/(gradient|url)\(/i.test(v)) {
    const a = arb(v);
    return a === null ? null : [`bg-[${a}]`];
  }
  return colorClass('bg', v, ctx);
}

function aspectRatio(value: string): string[] | null {
  const v = value.trim().replace(/\s*\/\s*/g, ' / ');
  if (v === '1' || v === '1 / 1') return ['aspect-square'];
  if (v === '16 / 9') return ['aspect-video'];
  if (v === 'auto') return ['aspect-auto'];
  const a = arb(v.replace(/ \/ /g, '/'));
  return a === null ? null : [`aspect-[${a}]`];
}

function zIndex(value: string): string[] | null {
  const v = value.trim();
  if (v === 'auto') return ['z-auto'];
  if (/^\d+$/.test(v)) return [[0, 10, 20, 30, 40, 50].includes(+v) ? `z-${v}` : `z-[${v}]`];
  if (/^-\d+$/.test(v)) return [`z-[${v}]`];
  return null;
}

/* ====================================================================== */
/* Main map                                                                */
/* ====================================================================== */

type Handler = (value: string, ctx: Ctx) => string[] | null;

const single =
  (fn: (value: string, ctx: Ctx) => string | null): Handler =>
  (v, ctx) => {
    const c = fn(v, ctx);
    return c === null ? null : [c];
  };

const HANDLERS: Record<string, Handler> = {
  padding: (v, ctx) => sides('p', v, ctx, {}, PAD_NAMES),
  'padding-top': single((v, c) => spacing('pt', v, c)),
  'padding-right': single((v, c) => spacing('pr', v, c)),
  'padding-bottom': single((v, c) => spacing('pb', v, c)),
  'padding-left': single((v, c) => spacing('pl', v, c)),
  'padding-inline': single((v, c) => spacing('px', v, c)),
  'padding-block': single((v, c) => spacing('py', v, c)),
  margin: (v, ctx) => sides('m', v, ctx, { auto: true }, MAR_NAMES),
  'margin-top': single((v, c) => spacing('mt', v, c, { auto: true })),
  'margin-right': single((v, c) => spacing('mr', v, c, { auto: true })),
  'margin-bottom': single((v, c) => spacing('mb', v, c, { auto: true })),
  'margin-left': single((v, c) => spacing('ml', v, c, { auto: true })),
  'margin-inline': single((v, c) => spacing('mx', v, c, { auto: true })),
  'margin-block': single((v, c) => spacing('my', v, c, { auto: true })),
  gap: gapClasses,
  'row-gap': single((v, c) => spacing('gap-y', v, c)),
  'column-gap': single((v, c) => spacing('gap-x', v, c)),
  width: single((v, c) => {
    const s = sizeSuffix('w', v, c);
    return s === null ? null : `w-${s}`;
  }),
  height: single((v, c) => {
    const s = sizeSuffix('h', v, c);
    return s === null ? null : `h-${s}`;
  }),
  'min-width': (v, c) => minMaxSize('min-w', 'w', v, c),
  'max-width': (v, c) => minMaxSize('max-w', 'w', v, c),
  'min-height': (v, c) => minMaxSize('min-h', 'h', v, c),
  'max-height': (v, c) => minMaxSize('max-h', 'h', v, c),
  inset: (v, ctx) => sides('inset', v, ctx, { percent: true, auto: true }, INSET_NAMES),
  top: single((v, c) => spacing('top', v, c, { percent: true, auto: true })),
  right: single((v, c) => spacing('right', v, c, { percent: true, auto: true })),
  bottom: single((v, c) => spacing('bottom', v, c, { percent: true, auto: true })),
  left: single((v, c) => spacing('left', v, c, { percent: true, auto: true })),
  'z-index': (v) => zIndex(v),
  flex: (v) => flexShorthand(v),
  'flex-grow': (v) => growShrink('grow', v),
  'flex-shrink': (v) => growShrink('shrink', v),
  'flex-basis': single((v, c) => spacing('basis', v, c, { percent: true, auto: true })),
  'grid-template-columns': (v) => gridTemplate('cols', v),
  'grid-template-rows': (v) => gridTemplate('rows', v),
  'grid-column': (v) => gridSpan('col', v),
  'grid-row': (v) => gridSpan('row', v),
  'grid-column-start': (v) => gridLine('col-start', v),
  'grid-column-end': (v) => gridLine('col-end', v),
  'grid-row-start': (v) => gridLine('row-start', v),
  'grid-row-end': (v) => gridLine('row-end', v),
  'grid-auto-rows': (v) => gridAuto('rows', v),
  'grid-auto-columns': (v) => gridAuto('cols', v),
  'grid-auto-flow': (v) => {
    const k = own(GRID_FLOW, v.trim().toLowerCase().replace(/\s+/g, ' '));
    if (k) return [k];
    const a = arb(v);
    return a === null ? null : [`[grid-auto-flow:${a}]`];
  },
  'aspect-ratio': (v) => aspectRatio(v),
  'font-size': fontSizeClass,
  'font-weight': fontWeightClass,
  'font-family': fontFamilyClass,
  'line-height': lineHeightClass,
  'letter-spacing': letterSpacingClass,
  color: (v, c) => colorClass('text', v, c),
  'background-color': (v, c) => colorClass('bg', v, c),
  background: backgroundShorthand,
  'background-image': (v) => {
    if (v.trim() === 'none') return ['bg-none'];
    const a = arb(v);
    return a === null ? null : [`bg-[${a}]`];
  },
  fill: (v, c) => colorClass('fill', v, c),
  stroke: (v, c) => colorClass('stroke', v, c),
  'outline-color': (v, c) => colorClass('outline', v, c),
  'border-color': (v, c) => {
    const vals = splitTop(v, 'space');
    return vals.length === 1 ? single((x, cc) => borderColorClass('', x, cc))(v, c) : null;
  },
  border: (v, c) => borderShorthand('', v, c),
  'border-top': (v, c) => borderShorthand('t', v, c),
  'border-right': (v, c) => borderShorthand('r', v, c),
  'border-bottom': (v, c) => borderShorthand('b', v, c),
  'border-left': (v, c) => borderShorthand('l', v, c),
  'border-width': (v, c) => {
    const vals = splitTop(v, 'space');
    return vals.length === 1 ? single((x, cc) => borderWidthClass('', x, cc))(v, c) : null;
  },
  'border-top-width': single((v, c) => borderWidthClass('t', v, c)),
  'border-right-width': single((v, c) => borderWidthClass('r', v, c)),
  'border-bottom-width': single((v, c) => borderWidthClass('b', v, c)),
  'border-left-width': single((v, c) => borderWidthClass('l', v, c)),
  'border-top-color': single((v, c) => borderColorClass('t', v, c)),
  'border-right-color': single((v, c) => borderColorClass('r', v, c)),
  'border-bottom-color': single((v, c) => borderColorClass('b', v, c)),
  'border-left-color': single((v, c) => borderColorClass('l', v, c)),
  'border-radius': (v, ctx) => {
    const vals = splitTop(v, 'space');
    if (vals.length === 1) return radiusClasses('', v, ctx);
    if (v.includes('/')) return null;
    const exp = expandSides(vals);
    if (!exp) return null;
    // CSS order: tl, tr, br, bl
    const [tl, tr, br, bl] = exp;
    const out: string[] = [];
    for (const [corner, val] of [
      ['tl', tl],
      ['tr', tr],
      ['br', br],
      ['bl', bl],
    ] as const) {
      const c = radiusClasses(corner, val, ctx);
      if (!c) return null;
      out.push(...c);
    }
    return out;
  },
  'border-top-left-radius': (v, c) => radiusClasses('tl', v, c),
  'border-top-right-radius': (v, c) => radiusClasses('tr', v, c),
  'border-bottom-right-radius': (v, c) => radiusClasses('br', v, c),
  'border-bottom-left-radius': (v, c) => radiusClasses('bl', v, c),
  'box-shadow': shadowClass,
  opacity: (v) => opacityClass(v),
};

/** Tailwind v4 `!` suffix for `!important`. */
function applyImportant(classes: string[], important: boolean): string[] {
  return important ? classes.map((c) => `${c}!`) : classes;
}

/** Converts a CSS style object (kebab-case) into Tailwind v4 classes. */
export function cssToTailwind(
  style: Record<string, string>,
  opts: { tokens?: Record<string, string> } = {},
): TailwindMapping {
  const ctx: Ctx = { tokens: opts.tokens };
  const classes: string[] = [];
  const rest: Record<string, string> = {};
  const consumed = new Set<string>();
  const push = (list: string[]): void => {
    for (const c of list) if (c !== '' && !classes.includes(c)) classes.push(c);
  };

  // equal width + height become `size-*`
  if (style.width !== undefined && style.height !== undefined) {
    const w = sizeSuffix('w', style.width.replace(/\s*!important\s*$/, ''), ctx);
    const h = sizeSuffix('h', style.height.replace(/\s*!important\s*$/, ''), ctx);
    const imp = (s: string): boolean => /!important\s*$/.test(s);
    if (w !== null && w === h && w !== 'screen' && imp(style.width) === imp(style.height)) {
      push(applyImportant([`size-${w}`], imp(style.width)));
      consumed.add('width').add('height');
    }
  }

  for (const [key, raw] of Object.entries(style)) {
    if (consumed.has(key)) continue;
    let value = raw.trim();
    if (value === '') continue;
    const important = /\s*!important\s*$/.test(value);
    if (important) value = value.replace(/\s*!important\s*$/, '').trim();

    let mapped: string[] | null = null;
    const kw = Object.hasOwn(KEYWORDS, key) ? own(KEYWORDS[key], value.toLowerCase()) : undefined;
    if (kw) mapped = [kw];
    else if (Object.hasOwn(HANDLERS, key) && !/^(inherit|initial|unset|revert)$/i.test(value)) {
      mapped = HANDLERS[key](value, ctx);
    }
    if (mapped === null) {
      const a = isValidCssPropertyName(key) ? arb(value) : null;
      if (a === null) {
        rest[key] = raw;
        continue;
      }
      mapped = [`[${key}:${a}]`];
    }
    push(applyImportant(mapped, important));
  }
  return { classes, rest };
}

/* ====================================================================== */
/* Theme                                                                   */
/* ====================================================================== */

/** Tailwind v4 default `line-height` per size (ratio over `font-size`) and the equivalent px. */
const DEFAULT_LEADING: Record<string, { ratio: number; px?: number }> = {
  xs: { ratio: 1 / 0.75, px: 16 },
  sm: { ratio: 1.25 / 0.875, px: 20 },
  base: { ratio: 1.5, px: 24 },
  lg: { ratio: 1.75 / 1.125, px: 28 },
  xl: { ratio: 1.75 / 1.25, px: 28 },
  '2xl': { ratio: 2 / 1.5, px: 32 },
  '3xl': { ratio: 2.25 / 1.875, px: 36 },
  '4xl': { ratio: 2.5 / 2.25, px: 40 },
  '5xl': { ratio: 1 },
  '6xl': { ratio: 1 },
  '7xl': { ratio: 1 },
  '8xl': { ratio: 1 },
  '9xl': { ratio: 1 },
};

/** Is the node `line-height` exactly what Tailwind would apply with `text-<size>`? */
function hasDefaultLeading(size: string, lineHeight: string | undefined): boolean {
  if (lineHeight === undefined) return false;
  const def = own(DEFAULT_LEADING, size);
  if (!def) return false;
  const v = lineHeight.trim();
  if (/^\d*\.?\d+$/.test(v)) return Math.abs(parseFloat(v) - def.ratio) < 0.002;
  const px = toPx(v);
  return px !== null && def.px !== undefined && Math.abs(px - def.px) < 0.01;
}

function collectNeutralSizes(nodes: Node[], into: Set<string>): void {
  const visit = (style: Record<string, string>, fallbackLh: string | undefined): void => {
    const fs = style['font-size'];
    if (!fs) return;
    const named = namedFontSize(fs);
    if (named && !hasDefaultLeading(named, style['line-height'] ?? fallbackLh)) into.add(named);
  };
  for (const n of nodes) {
    visit(n.style, undefined);
    for (const st of Object.values(n.states ?? {})) visit(st, n.style['line-height']);
    collectNeutralSizes(n.children, into);
  }
}

/**
 * `text-*` sizes that the exported theme needs to neutralize (`--text-X--line-height: inherit`): those
 * used by some node whose `line-height` is not the Tailwind default for that size (or that does not
 * have a `line-height`). Nodes coming from Tailwind (`font-size: 0.875rem` + `line-height: 1.4286`) do not need it.
 */
export function neutralLeadingSizes(doc: Document): Set<string> {
  const sizes = new Set<string>();
  for (const page of doc.pages) collectNeutralSizes(page.frames, sizes);
  return sizes;
}

function usesDark(doc: Document): boolean {
  return doc.pages.some((p) => p.frames.some(usesDarkState));
}

/**
 * Tailwind v4 theme CSS for the document: `@import "tailwindcss";`, the `@custom-variant dark`
 * (when some node has a `dark` state), `@theme { ... }` with the tokens that fall in a theme
 * namespace (`--color-*`, `--font-*`, `--radius-*`...), `:root { ... }` with the rest and `@font-face` for the
 * embedded fonts (`assets/<file>`).
 *
 * `text-*` sizes used by nodes without the Tailwind default `line-height` have their line height
 * neutralized (`--text-sm--line-height: inherit`), so it stays the document's.
 */
export function tailwindThemeCss(
  doc: Document,
  opts: { import?: boolean; assetsBase?: string } = {},
): string {
  const tokens = cleanTokens(doc.tokens);
  const theme: string[] = [];
  const root: string[] = [];
  for (const [k, v] of Object.entries(tokens)) {
    (themeNamespace(k) ? theme : root).push(`  ${k}: ${v};`);
  }
  const sizes = neutralLeadingSizes(doc);
  for (const s of Object.values(FONT_SIZES)) {
    if (sizes.has(s)) theme.push(`  --text-${s}--line-height: inherit;`);
  }
  const blocks: string[] = [];
  if (opts.import !== false) blocks.push('@import "tailwindcss";');
  if (usesDark(doc)) blocks.push(DARK_VARIANT_CSS);
  if (theme.length > 0) blocks.push(`@theme {\n${theme.join('\n')}\n}`);
  if (root.length > 0) blocks.push(`:root {\n${root.join('\n')}\n}`);
  const themeRules = themeRulesCss(doc);
  if (themeRules) blocks.push(themeRules);
  const variants = themeVariantsCss(doc);
  if (variants) blocks.push(variants);
  blocks.push(tailwindBaseCssFor(doc));
  const assetsBase = opts.assetsBase ?? 'assets/';
  const faces = fontFaceCss(doc, (f) => `${assetsBase}${f}`, 'swap');
  if (faces) blocks.push(faces);
  return escapeCssText(blocks.join('\n\n')) + '\n';
}

export interface TailwindAttrOptions {
  engine?: TailwindEngine;
  /** `text-*` sizes with the `line-height` neutralized in the theme (see `neutralLeadingSizes`). */
  neutralLeading?: ReadonlySet<string>;
}

/** Variant classes of a node without the engine: `hover:`, `md:`, `dark:`, `md:hover:`... */
function stateClasses(node: Node, tokens: Record<string, string>): string[] {
  const out: string[] = [];
  for (const key of sortStateKeys(Object.keys(node.states ?? {}))) {
    const parts = parseStateKey(key);
    if (!parts) continue;
    const prefix = formatStateKey(parts);
    // the state only brings what changes: what has no class (`rest`) does not fit in `style=""` and is dropped
    for (const c of cssToTailwind(node.states![key], { tokens }).classes)
      out.push(`${prefix}:${c}`);
  }
  return out;
}

/** Classes (with variants) of a node and what did not become a class (`rest`, goes to `style`). */
export function tailwindNodeParts(
  node: Node,
  tokens: Record<string, string>,
  opts: TailwindAttrOptions = {},
): TailwindMapping {
  let classes: string[];
  let rest: Record<string, string>;
  const { engine, neutralLeading } = opts;
  if (engine) {
    ({ classes, rest } = engine.nodeClasses(node, { neutralLeading }));
    // `text-sm` reused from `node.classes` cannot bring the default `line-height` if the theme neutralizes it
    const lh = node.style['line-height'];
    if (lh && neutralLeading?.size && !classes.some((c) => /^leading-|^text-[a-z0-9]+\//.test(c))) {
      if (classes.some((c) => /^text-[a-z0-9]+$/.test(c) && neutralLeading.has(c.slice(5)))) {
        classes = [...classes, ...engine.stylesToClasses({ 'line-height': lh }, {}).classes];
      }
    }
  } else {
    ({ classes, rest } = cssToTailwind(node.style, { tokens }));
    classes = [...classes, ...stateClasses(node, tokens)];
  }
  return { classes, rest };
}

/** Class and `style` (for what has no class) of a node, in the HTML renderer format. */
export function tailwindAttrs(
  node: Node,
  tokens: Record<string, string>,
  opts: TailwindAttrOptions = {},
): { cls?: string; style?: string } {
  const { classes, rest } = tailwindNodeParts(node, tokens, opts);
  const restEntries = Object.entries(rest);
  return {
    cls: classes.length > 0 ? classes.join(' ') : undefined,
    style:
      restEntries.length > 0 ? restEntries.map(([k, v]) => `${k}: ${v}`).join('; ') : undefined,
  };
}

/** HTML with Tailwind v4 `class` (full document or fragment). */
export function exportTailwind(source: Document, options: TailwindExportOptions = {}): string {
  // expanded component instances (same as the canvas); accepts virtual ids
  const doc = expandDocument(source);
  const selection: RootSelection = { pageId: options.pageId, nodeIds: options.nodeIds };
  const roots = resolveRoots(doc, selection);
  const tokens = cleanTokens(doc.tokens);
  const neutralLeading = neutralLeadingSizes(doc);
  const media = newMediaCollector();
  const motion = new MotionCollector();
  const markup = renderHtmlTree(roots, {
    styleOf: (node) => tailwindAttrs(node, tokens, { engine: options.tailwind, neutralLeading }),
    media,
    motion,
    readAsset: options.readAsset,
  });
  const scripts = [mediaScripts(media), motion.hasBuilds ? buildRuntimeScript() : '']
    .filter(Boolean)
    .join('\n');
  // motion CSS (plain CSS: classes cannot express `@keyframes`) goes in its own `<style>`
  const motionCss = escapeCssText(motion.css());
  // media nodes: the scripts (effects runtime, CDNs) also go in the fragment, right after the markup
  if (options.fragment) {
    const style = motionCss ? `<style>\n${motionCss}\n</style>\n` : '';
    return style + markup + '\n' + (scripts ? scripts + '\n' : '');
  }

  const head = [
    '  <meta charset="utf-8">',
    '  <meta name="viewport" content="width=device-width, initial-scale=1">',
    `  <title>${escapeHtmlText(options.title ?? doc.name)}</title>`,
  ];
  if (options.cdn !== false) {
    head.push('  <script src="https://cdn.jsdelivr.net/npm/@tailwindcss/browser@4"></script>');
  }
  const theme = tailwindThemeCss(doc, { import: false }).trim();
  if (theme) {
    head.push('  <style type="text/tailwindcss">', indentLines(theme, 1), '  </style>');
  }
  if (motionCss) head.push('  <style>', indentLines(motionCss, 1), '  </style>');
  return [
    '<!doctype html>',
    '<html lang="en">',
    '<head>',
    ...head,
    '</head>',
    '<body>',
    indentLines(markup, 1),
    ...(scripts ? [scripts] : []),
    '</body>',
    '</html>',
    '',
  ].join('\n');
}
