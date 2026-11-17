import { fontFaceCss } from '../fonts.js';
import { escapeCssText } from '../html.js';
import { isValidCssPropertyName } from '../styles.js';
import { themeRulesCss, themeVariantsCss } from '../tokens.js';
import type { Document, Node } from '../types.js';
import type { TailwindEngine } from '../tailwind/engine.js';
import {
  cleanTokens,
  escapeHtmlText,
  indentLines,
  renderHtmlTree,
  resolveRoots,
  TAILWIND_BASE_CSS,
  type RootSelection,
} from './common.js';

export interface TailwindExportOptions {
  /** Nós a exportar (padrão: frames da página `pageId` ou da primeira página). */
  nodeIds?: string[];
  pageId?: string;
  title?: string;
  /** `true`: só o markup (sem `<!doctype>`/`<head>`). Padrão `false` (documento completo). */
  fragment?: boolean;
  /**
   * `true` (padrão): o documento completo inclui `<script>` do `@tailwindcss/browser@4` e o tema em
   * `<style type="text/tailwindcss">`. `false` remove o script (o tema continua no `<style>`).
   */
  cdn?: boolean;
  /**
   * Motor Tailwind do documento (`getTailwindEngine(doc)` de `@mockup/core/tailwind`). Com ele as
   * classes saem canonicalizadas, conferidas contra o compilador e reaproveitando `node.classes`;
   * sem ele, o mapeamento estático (`cssToTailwind`).
   */
  tailwind?: TailwindEngine;
}

export interface TailwindMapping {
  /** Classes Tailwind v4 equivalentes. */
  classes: string[];
  /** Propriedades sem classe equivalente (já cobertas por `[prop:valor]` em `classes` quando possível). */
  rest: Record<string, string>;
}

/* ====================================================================== */
/* Utilitários de valor                                                    */
/* ====================================================================== */

/** Divide em tokens no nível superior (fora de parênteses e aspas) por espaço ou vírgula. */
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

/** Prefixos de variável de tema do Tailwind v4 (o mais específico primeiro). */
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

/** Namespace de tema de um token (`--color-primary` → color/`primary`); `null` fora dos namespaces. */
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

/** Nome curto de tema se `value` é `var(--ns-x)` do namespace esperado (e o token existe). */
function themeShort(value: string, want: Namespace, ctx: Ctx): string | null {
  const v = parseVar(value);
  if (!v || v.fallback !== undefined) return null;
  const t = themeNamespace(v.name);
  if (!t || t.ns !== want) return null;
  if (ctx.tokens && !(v.name in ctx.tokens)) return null;
  return t.short;
}

/** Escapa um valor para uso dentro de `[...]`: espaços viram `_`, `_` literal vira `\_`. `null` se inseguro. */
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

/** Lookup que ignora chaves herdadas de `Object.prototype`. */
function own<T>(table: Record<string, T>, key: string): T | undefined {
  return Object.hasOwn(table, key) ? table[key] : undefined;
}

const fmt = (n: number): string => String(Math.round(n * 1000) / 1000);

/** Passo da escala de espaçamento do v4 (`--spacing: 0.25rem`): 4px = 1; aceita meio passo. */
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
  /** Aceita `%` (`full`, `1/2`) e keywords de tamanho. */
  percent?: boolean;
  /** Maior valor em px que ainda usa a escala (acima disso, valor arbitrário). */
  maxScale?: number;
  /** Aceita `auto`. */
  auto?: boolean;
}

/** Sufixo de um valor de espaçamento/tamanho: `4`, `[13px]`, `(--x)`, `full`, `1/2`, tema. */
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

/** `prefix-sufixo`, com sinal negativo movido para a frente (`-mt-2`). */
function withPrefix(prefix: string, suffix: string): string {
  return suffix.startsWith('-') ? `-${prefix}-${suffix.slice(1)}` : `${prefix}-${suffix}`;
}

function spacing(prefix: string, value: string, ctx: Ctx, opts: SpacingOpts = {}): string | null {
  const s = spacingSuffix(value, ctx, opts);
  return s === null ? null : withPrefix(prefix, s);
}

/** Expande 1–4 valores (estilo `margin`/`padding`) em [top, right, bottom, left]. */
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

/** Lados de `padding`/`margin`/`inset`/`border-radius`...: junta lados iguais (`p-4`, `py-5 px-16`). */
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

/* ---------------------------- cores ---------------------------- */

const NAMED_COLOR_PASSTHROUGH = new Set(['transparent', 'white', 'black']);

/** Sufixo de cor: `primary`, `[#6c5ce7]`, `(color:--x)`, `transparent`, `current`. */
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

/* ---------------------------- tabelas de palavras-chave ---------------------------- */

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

/** Tamanhos de `font-size` (px) que têm classe nomeada. */
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

/* ---------------------------- bordas ---------------------------- */

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
  if (style === 'solid') return ''; // padrão (preflight)
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
  // `border: solid red` sem largura: a largura inicial é `medium` (3px); só um `border` explícito vale 1px
  return out.length > 0 ? out : null;
}

/* ---------------------------- raio ---------------------------- */

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

/* ---------------------------- tamanhos ---------------------------- */

/** Sufixo de `width`/`height` (compartilhado com `size-*`). */
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
  // `min-w-auto`/`max-w-auto` não existem em todas as versões: usa valor arbitrário
  if (s === 'auto') return [`${prefix}-[auto]`];
  return [`${prefix}-${s}`];
}

/* ---------------------------- sombras, opacidade, grid, flex ---------------------------- */

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
  const m = /^repeat\(\s*(\d+)\s*,\s*(?:1fr|minmax\(\s*0(?:px)?\s*,\s*1fr\s*\))\s*\)$/.exec(v);
  if (m) return [`grid-${kind}-${m[1]}`];
  const a = arb(v);
  return a === null ? null : [`grid-${kind}-[${a}]`];
}

function gridSpan(kind: 'col' | 'row', value: string): string[] | null {
  const v = value.trim();
  let m = /^span\s+(\d+)(?:\s*\/\s*span\s+\d+)?$/.exec(v);
  if (m) return [`${kind}-span-${m[1]}`];
  if (/^1\s*\/\s*-1$/.test(v)) return [`${kind}-span-full`];
  m = /^(\d+)$/.exec(v);
  if (m) return [`${kind}-${m[1]}`];
  const a = arb(v);
  return a === null ? null : [`${kind}-[${a}]`];
}

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
/* Mapa principal                                                          */
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
    // ordem CSS: tl, tr, br, bl
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

/** Sufixo `!` do Tailwind v4 para `!important`. */
function applyImportant(classes: string[], important: boolean): string[] {
  return important ? classes.map((c) => `${c}!`) : classes;
}

/** Converte um objeto de estilo CSS (kebab-case) em classes Tailwind v4. */
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

  // width + height iguais viram `size-*`
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
/* Tema                                                                    */
/* ====================================================================== */

function collectFontSizes(nodes: Node[], into: Set<string>): void {
  for (const n of nodes) {
    const fs = n.style['font-size'];
    if (fs) {
      const named = namedFontSize(fs);
      if (named) into.add(named);
    }
    collectFontSizes(n.children, into);
  }
}

/**
 * CSS de tema do Tailwind v4 para o documento: `@import "tailwindcss";`, `@theme { ... }` com os
 * tokens que caem num namespace de tema (`--color-*`, `--font-*`, `--radius-*`...), `:root { ... }`
 * com os demais e `@font-face` das fontes embutidas (`assets/<arquivo>`).
 *
 * Os tamanhos `text-*` usados no documento têm o `line-height` padrão do Tailwind neutralizado
 * (`--text-sm--line-height: inherit`), para que a altura de linha continue a do documento.
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
  const sizes = new Set<string>();
  for (const page of doc.pages) collectFontSizes(page.frames, sizes);
  for (const s of Object.values(FONT_SIZES)) {
    if (sizes.has(s)) theme.push(`  --text-${s}--line-height: inherit;`);
  }
  const blocks: string[] = [];
  if (opts.import !== false) blocks.push('@import "tailwindcss";');
  if (theme.length > 0) blocks.push(`@theme {\n${theme.join('\n')}\n}`);
  if (root.length > 0) blocks.push(`:root {\n${root.join('\n')}\n}`);
  const themeRules = themeRulesCss(doc);
  if (themeRules) blocks.push(themeRules);
  const variants = themeVariantsCss(doc);
  if (variants) blocks.push(variants);
  blocks.push(TAILWIND_BASE_CSS);
  const assetsBase = opts.assetsBase ?? 'assets/';
  const faces = fontFaceCss(doc, (f) => `${assetsBase}${f}`, 'swap');
  if (faces) blocks.push(faces);
  return escapeCssText(blocks.join('\n\n')) + '\n';
}

/** Classe e `style` (para o que não tem classe) de um nó, no formato do renderizador de HTML. */
export function tailwindAttrs(
  node: Node,
  tokens: Record<string, string>,
): { cls?: string; style?: string } {
  const { classes, rest } = cssToTailwind(node.style, { tokens });
  const restEntries = Object.entries(rest);
  return {
    cls: classes.length > 0 ? classes.join(' ') : undefined,
    style:
      restEntries.length > 0 ? restEntries.map(([k, v]) => `${k}: ${v}`).join('; ') : undefined,
  };
}

/** HTML com `class` Tailwind v4 (documento completo ou fragmento). */
export function exportTailwind(doc: Document, options: TailwindExportOptions = {}): string {
  const selection: RootSelection = { pageId: options.pageId, nodeIds: options.nodeIds };
  const roots = resolveRoots(doc, selection);
  const tokens = cleanTokens(doc.tokens);
  const markup = renderHtmlTree(roots, { styleOf: (node) => tailwindAttrs(node, tokens) });
  if (options.fragment) return markup + '\n';

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
  return [
    '<!doctype html>',
    '<html lang="pt-BR">',
    '<head>',
    ...head,
    '</head>',
    '<body>',
    indentLines(markup, 1),
    '</body>',
    '</html>',
    '',
  ].join('\n');
}
