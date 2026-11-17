/**
 * Tokens and themes in real CSS.
 *
 * - `doc.tokens` are the base CSS variables (`:root`), `doc.tokenMeta` holds group and description, and
 *   `doc.themes` lists themes that override tokens inside nodes with `data-theme="<theme>"`.
 * - Resolution follows CSS semantics: a variable is resolved on the element where it is declared.
 *   So a theme's CSS also redeclares the base tokens that depend (directly or
 *   indirectly) on an overridden token: `--surface: var(--gray-900)` follows the dark theme.
 * - The `plan*` functions produce the ops used by the editor and MCP (same undo path).
 */
import { evaluateCss } from './cssEval.js';
import { lexer, parse } from './csstree.js';
import { findNode, walk } from './document.js';
import { themeNamespace } from './export/tailwind.js';
import type { Op, StyleChange } from './ops.js';
import { cssValueProblem, toKebabCase } from './styles.js';
import { THEME_ATTR, THEME_NAME_RE, TOKEN_NAME_RE } from './tags.js';
import type { Document, Node, Theme, TokenMeta } from './types.js';

/* ====================================================================== */
/* Names and groups                                                        */
/* ====================================================================== */

/** `primary` → `--primary`; names already starting with `--` stay as they are. */
export function normalizeTokenName(name: string): string {
  const n = name.trim();
  return n.startsWith('--') || n === '' ? n : `--${n}`;
}

export const TOKEN_GROUPS = [
  { id: 'color', label: 'Colors' },
  { id: 'typography', label: 'Typography' },
  { id: 'spacing', label: 'Spacing' },
  { id: 'radius', label: 'Radius' },
  { id: 'shadow', label: 'Shadow' },
  { id: 'other', label: 'Other' },
] as const;

export type BuiltinTokenGroup = (typeof TOKEN_GROUPS)[number]['id'];

/** English label of a group (free groups keep their own name). */
export function tokenGroupLabel(group: string): string {
  return TOKEN_GROUPS.find((g) => g.id === group)?.label ?? group;
}

const foldGroup = (g: string): string =>
  g.normalize('NFD').replace(/[̀-ͯ]/g, '').trim().toLowerCase();

/** Former Portuguese labels (folded), still accepted when reading stored groups. */
const LEGACY_GROUP_LABELS: Record<string, BuiltinTokenGroup> = {
  cores: 'color',
  tipografia: 'typography',
  espacamento: 'spacing',
  raio: 'radius',
  sombra: 'shadow',
  outros: 'other',
};

/**
 * Canonical group: a free group named after the label (or id) of a built-in group, ignoring
 * case and accents (`Colors`, `colors`, `Cores`), becomes the built-in one, so two
 * groups with the same title never show up in the panel and in `get_tokens`. Others stay as they are.
 */
export function canonicalTokenGroup(group: string): string {
  const f = foldGroup(group);
  return (
    TOKEN_GROUPS.find((g) => g.id === f || foldGroup(g.label) === f)?.id ??
    LEGACY_GROUP_LABELS[f] ??
    group
  );
}

const COLOR_FN = /^(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color|color-mix|light-dark)\(/i;
const HEX = /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
const LENGTH = /^-?(?:\d+\.?\d*|\.\d+)(?:px|rem|em|%|vw|vh|vmin|vmax|ch|ex|svh|dvh|lvh)$/i;

/** Group inferred from the name prefix and, without a known prefix, from the value. */
export function inferTokenGroup(name: string, value?: string): BuiltinTokenGroup {
  const n = name.replace(/^--/, '').toLowerCase();
  if (/^(?:colou?rs?|bg|background|fg|foreground|surface|border-color|accent|brand)(?:-|$)/.test(n))
    return 'color';
  if (/^(?:shadows?|elevation|drop-shadow|inset-shadow)(?:-|$)/.test(n)) return 'shadow';
  if (/^(?:radius|radii|rounded|corner)(?:-|$)/.test(n)) return 'radius';
  if (
    /^(?:font|fonts|text|leading|tracking|line-height|letter-spacing|typography|type)(?:-|$)/.test(
      n,
    )
  )
    return 'typography';
  if (/^(?:space|spacing|spacer|gap|size|sizes|padding|margin|inset|container)(?:-|$)/.test(n))
    return 'spacing';
  const v = (value ?? '').trim();
  if (v) {
    if (HEX.test(v) || COLOR_FN.test(v) || NAMED_BASIC.has(v.toLowerCase())) return 'color';
    if (/\d(?:px|rem|em)\s+-?\d/.test(v) && /(?:#|rgba?\(|hsla?\(|oklch\()/i.test(v))
      return 'shadow';
    if (LENGTH.test(v)) return 'spacing';
  }
  return 'other';
}

const NAMED_BASIC = new Set([
  'black',
  'white',
  'red',
  'green',
  'blue',
  'yellow',
  'orange',
  'purple',
  'gray',
  'grey',
  'transparent',
]);

/** Effective group: the one in `tokenMeta` or the inferred one. */
export function tokenGroup(doc: Document, name: string): string {
  const g = doc.tokenMeta?.[name]?.group;
  return g !== undefined ? canonicalTokenGroup(g) : inferTokenGroup(name, doc.tokens[name]);
}

/** All defined token names (base and themes), base tokens first and then themes. */
export function tokenNames(doc: Document): string[] {
  const names = new Set(Object.keys(doc.tokens));
  for (const t of doc.themes ?? []) for (const k of Object.keys(t.overrides)) names.add(k);
  return [...names];
}

/* ====================================================================== */
/* var() references                                                        */
/* ====================================================================== */

export interface VarRef {
  name: string;
  fallback?: string;
}

/** End of the call that opens at `start` (index of the `(`), respecting nesting and quotes; -1 if unclosed. */
function closeParen(value: string, open: number): number {
  let depth = 0;
  let quote: string | null = null;
  for (let j = open; j < value.length; j++) {
    const c = value[j]!;
    if (quote) {
      if (c === '\\') j++;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") quote = c;
    else if (c === '(') depth++;
    else if (c === ')' && --depth === 0) return j;
  }
  return -1;
}

/** `var(--x[, fallback])` references in the value, including those inside fallbacks. */
export function findVarRefs(value: string): VarRef[] {
  const out: VarRef[] = [];
  const re = /var\(/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(value))) {
    const open = m.index + 3;
    const end = closeParen(value, open);
    if (end === -1) break;
    const inner = value.slice(open + 1, end);
    const comma = inner.indexOf(',');
    const name = (comma === -1 ? inner : inner.slice(0, comma)).trim();
    if (name.startsWith('--')) {
      out.push(comma === -1 ? { name } : { name, fallback: inner.slice(comma + 1).trim() });
    }
  }
  return out;
}

/** Names referenced by `var()` in the value (deduplicated). */
export function referencedTokens(value: string): string[] {
  return [...new Set(findVarRefs(value).map((r) => r.name))];
}

/**
 * Replaces `var(--from` with `var(--to` (exact name only). The `var(` function matches
 * case-insensitively (as in CSS; the `i` flag won't do, since it would make the name insensitive too) and the
 * original spelling is preserved; the variable name is case-sensitive.
 */
export function replaceVarRefs(value: string, from: string, to: string): string {
  if (!value.includes(from)) return value;
  const re = new RegExp(`([vV][aA][rR]\\()\\s*${from.replace(/[-]/g, '\\-')}(?=\\s*[,)])`, 'g');
  return value.replace(re, (_m, open: string) => `${open}${to}`);
}

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&');

/** Tailwind utility roots that accept a color. */
const COLOR_ROOTS =
  'bg|text|border(?:-[xytblrse])?|ring|ring-offset|outline|fill|stroke|from|via|to|shadow|inset-shadow|drop-shadow|decoration|accent|caret|divide|placeholder';

/** Utility roots of each theme namespace (`null`: any root, the spacing case). */
const NS_ROOTS: Record<string, string> = {
  color: COLOR_ROOTS,
  radius: 'rounded(?:-(?:[xytblrse]|[st][se]|[be][se]))?',
  shadow: 'shadow|inset-shadow',
  font: 'font',
  weight: 'font',
  text: 'text',
  leading: 'leading',
  tracking: 'tracking',
  spacing: '[a-z][a-z0-9]*(?:-[a-z][a-z0-9]*)*',
};

/** Splits the class into variants and base at the `:` outside `[]` and `()`. */
function splitVariants(cls: string): { variants: string; base: string } {
  let depth = 0;
  let cut = -1;
  for (let i = 0; i < cls.length; i++) {
    const c = cls[i]!;
    if (c === '[' || c === '(') depth++;
    else if (c === ']' || c === ')') depth = Math.max(0, depth - 1);
    else if (c === ':' && depth === 0) cut = i;
  }
  return { variants: cls.slice(0, cut + 1), base: cls.slice(cut + 1) };
}

/**
 * Rewrites, in a list of Tailwind classes (`node.classes`), the references to the token `from`:
 * arbitrary forms (`bg-[var(--from)]`, `bg-(--from)`), always; and utilities with the short
 * theme name (`bg-brand`, `hover:bg-brand/90`, `!-mt-gutter`), only when `from` and `to` are in the same
 * theme namespace. Returns the new text and how many classes changed.
 */
export function renameTokenInClasses(
  classes: string,
  from: string,
  to: string,
): { classes: string; changed: number } {
  const a = themeNamespace(from);
  const b = themeNamespace(to);
  const short =
    a && b && a.ns === b.ns
      ? new RegExp(`^(!?)(-?)(${NS_ROOTS[a.ns]})-${escapeRe(a.short)}(/[^\\s]+)?(!?)$`)
      : null;
  const parenRe = new RegExp(`(\\((?:[a-z-]+:)?)${escapeRe(from)}(?=[),])`, 'g');
  let changed = 0;
  const out = classes
    .split(/(\s+)/)
    .map((tok) => {
      if (!tok || /^\s+$/.test(tok)) return tok;
      let next = replaceVarRefs(tok, from, to).replace(parenRe, `$1${to}`);
      if (short) {
        const { variants, base } = splitVariants(next);
        const m = short.exec(base);
        if (m) next = `${variants}${m[1]}${m[2]}${m[3]}-${b!.short}${m[4] ?? ''}${m[5]}`;
      }
      if (next !== tok) changed++;
      return next;
    })
    .join('');
  return { classes: out, changed };
}

/**
 * Problem that prevents renaming `from` to `to` (ready-made message) or `null` if it can.
 * Rejects an invalid name, an equal name, a missing source, a destination already defined (base or theme) and a destination
 * already declared as a custom property in some node's style (the rename would lose one of the values).
 */
export function renameTokenProblem(doc: Document, from: string, to: string): string | null {
  const a = normalizeTokenName(from);
  const b = normalizeTokenName(to);
  if (!TOKEN_NAME_RE.test(b)) return `Invalid token name: "${b}" (use the --name format)`;
  if (a === b) return 'The new name is the same as the current one';
  const defined = (name: string): boolean =>
    name in doc.tokens || (doc.themes ?? []).some((t) => name in t.overrides);
  if (!defined(a)) return `Token "${a}" not found`;
  if (defined(b)) return `Token "${b}" already exists`;
  let local: Node | undefined;
  walk(doc, (n) => {
    if (!local && b in n.style) local = n;
  });
  if (local) {
    return `Variable "${b}" is already declared in the style of node "${local.name}" (${local.id}); rename or remove it first`;
  }
  return null;
}

/**
 * Replaces the `var()` calls in the value using `lookup` (which returns the already resolved value or `undefined`).
 * Without a value and without a fallback, the reference stays in the text (CSS would treat it as invalid).
 */
export function substituteVars(
  value: string,
  lookup: (name: string) => string | undefined,
): { value: string; missing: string[] } {
  const missing: string[] = [];
  const run = (v: string, level: number): string => {
    if (level > 32 || !/var\(/i.test(v)) return v;
    let out = '';
    let i = 0;
    const re = /var\(/gi;
    let m: RegExpExecArray | null;
    while ((m = re.exec(v))) {
      const open = m.index + 3;
      const end = closeParen(v, open);
      if (end === -1) break;
      out += v.slice(i, m.index);
      const inner = v.slice(open + 1, end);
      const comma = inner.indexOf(',');
      const name = (comma === -1 ? inner : inner.slice(0, comma)).trim();
      const found = lookup(name);
      if (found !== undefined) out += found;
      else if (comma !== -1) out += run(inner.slice(comma + 1).trim(), level + 1);
      else {
        missing.push(name);
        out += v.slice(m.index, end + 1);
      }
      i = end + 1;
      re.lastIndex = i;
    }
    return out + v.slice(i);
  };
  return { value: run(value, 0), missing };
}

/** Variables of a scope and those that ended up invalid (no value), with the reason. */
export interface ScopeResolution {
  vars: Record<string, string>;
  /**
   * Variables declared in the scope that ended up invalid: name → references that were missing
   * (nonexistent or also invalid, without a fallback). Cycles appear as `[]`.
   */
  invalid: Record<string, string[]>;
}

/**
 * Variables resolved on an element: `declared` (the element's own custom properties) sees the
 * other declarations of the same element and inherits the rest from `inherited`. As in CSS, a variable
 * with a cycle or with a `var()` to a nonexistent variable (without a fallback) has no value (invalid at the
 * time of calculation), and whoever references it with a fallback starts using the fallback.
 */
export function resolveScopeDetailed(
  inherited: Record<string, string>,
  declared: Record<string, string>,
): ScopeResolution {
  const out: Record<string, string> = { ...inherited };
  const invalid: Record<string, string[]> = {};
  const done = new Map<string, string | undefined>();
  const stack: string[] = [];
  const poisoned = new Set<string>();
  const get = (name: string): string | undefined => {
    if (!(name in declared)) return inherited[name];
    if (done.has(name)) return done.get(name);
    const at = stack.indexOf(name);
    if (at !== -1) {
      // Cycle: all variables in the loop become invalid (no value).
      for (const n of stack.slice(at)) poisoned.add(n);
      return undefined;
    }
    stack.push(name);
    const r = substituteVars(declared[name]!, get);
    stack.pop();
    let result: string | undefined = r.value;
    if (poisoned.has(name)) {
      result = undefined;
      invalid[name] = [];
    } else if (r.missing.length > 0) {
      result = undefined;
      invalid[name] = [...new Set(r.missing)];
    }
    done.set(name, result);
    return result;
  };
  for (const name of Object.keys(declared)) {
    const v = get(name);
    if (v === undefined) delete out[name];
    else out[name] = v;
  }
  return { vars: out, invalid };
}

/** {@link resolveScopeDetailed} with just the variables. */
export function resolveScope(
  inherited: Record<string, string>,
  declared: Record<string, string>,
): Record<string, string> {
  return resolveScopeDetailed(inherited, declared).vars;
}

/* ====================================================================== */
/* Themes                                                                  */
/* ====================================================================== */

export function findTheme(doc: Document, name: string): Theme | undefined {
  return doc.themes?.find((t) => t.name === name);
}

/** Theme declared on the node (`data-theme`), if it exists in the document. */
export function nodeTheme(doc: Document, node: Node): string | undefined {
  const t = node.attrs[THEME_ATTR];
  return t !== undefined && findTheme(doc, t) ? t : undefined;
}

/** Effective theme of a node: the node's own or the nearest ancestor's with `data-theme`. */
export function effectiveTheme(doc: Document, nodeId: string): string | undefined {
  const path = findNode(doc, nodeId);
  if (!path) return undefined;
  for (const n of [path.node, ...[...path.ancestors].reverse()]) {
    const t = nodeTheme(doc, n);
    if (t) return t;
  }
  return undefined;
}

/**
 * Declarations of the `[data-theme="<theme>"]` selector: the theme's overrides and the base tokens that
 * depend on them (redeclared with the base value, so they resolve inside the theme).
 */
export function themeDeclarations(doc: Document, themeName: string): Record<string, string> {
  const theme = findTheme(doc, themeName);
  if (!theme) return {};
  const changed = new Set(Object.keys(theme.overrides));
  let grew = true;
  while (grew) {
    grew = false;
    for (const [k, v] of Object.entries(doc.tokens)) {
      if (changed.has(k)) continue;
      if (referencedTokens(v).some((r) => changed.has(r))) {
        changed.add(k);
        grew = true;
      }
    }
  }
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(doc.tokens)) {
    if (changed.has(k) && !(k in theme.overrides)) out[k] = v;
  }
  return { ...out, ...theme.overrides };
}

/** Variables resolved in `:root` and, with `theme`, inside `[data-theme="<theme>"]`. */
export function resolvedTokens(doc: Document, theme?: string): Record<string, string> {
  return resolvedTokensDetailed(doc, theme).vars;
}

/** {@link resolvedTokens} with the variables that ended up invalid (missing reference or cycle). */
export function resolvedTokensDetailed(doc: Document, theme?: string): ScopeResolution {
  const root = resolveScopeDetailed({}, doc.tokens);
  if (!theme) return root;
  const decl = themeDeclarations(doc, theme);
  const t = resolveScopeDetailed(root.vars, decl);
  const invalid = { ...root.invalid };
  // Redeclared in the theme: the theme's values apply (including when they get a value again).
  for (const k of Object.keys(decl)) delete invalid[k];
  return { vars: t.vars, invalid: { ...invalid, ...t.invalid } };
}

/** Resolved value (var, calc, color-mix) of a token, in the given theme. */
export function resolveTokenValue(doc: Document, name: string, theme?: string): string | undefined {
  const v = resolvedTokens(doc, theme)[normalizeTokenName(name)];
  return v === undefined ? undefined : evaluateCss(v);
}

/**
 * Variables seen by each node on the path to `nodeId` (ancestors first, the node last):
 * base tokens, themes (`data-theme`) and declared custom properties. `theme` forces a theme on
 * the node itself (as if it had `data-theme="<theme>"`, in place of whatever it has).
 */
export function scopeChainFor(
  doc: Document,
  nodeId: string,
  opts: { theme?: string } = {},
): { node: Node; vars: Record<string, string> }[] {
  const path = findNode(doc, nodeId);
  if (!path) throw new Error(`Node "${nodeId}" not found`);
  const forced = opts.theme && findTheme(doc, opts.theme) ? opts.theme : undefined;
  let vars = resolveScope({}, doc.tokens);
  const chain: { node: Node; vars: Record<string, string> }[] = [];
  for (const n of [...path.ancestors, path.node]) {
    const declared: Record<string, string> = {};
    const t = n === path.node && forced ? forced : nodeTheme(doc, n);
    if (t) Object.assign(declared, themeDeclarations(doc, t));
    for (const [k, v] of Object.entries(n.style)) if (k.startsWith('--')) declared[k] = v;
    if (Object.keys(declared).length > 0) vars = resolveScope(vars, declared);
    chain.push({ node: n, vars });
  }
  return chain;
}

/**
 * Variables seen by a node: tokens, themes (`data-theme`) and the ancestors' custom properties.
 * `theme` forces a theme on the node itself (see {@link scopeChainFor}).
 */
export function scopeVarsFor(
  doc: Document,
  nodeId: string,
  opts: { theme?: string } = {},
): Record<string, string> {
  return scopeChainFor(doc, nodeId, opts).at(-1)!.vars;
}

const escapeXml = (v: string): string =>
  v
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');

/**
 * Replaces the `var(--x[, fallback])` calls in SVG markup with the values from `vars` (escaped for XML). Used
 * for the SVG that comes out of the document DOM (`<img>` via data URI in render, standalone SVG), where the document's
 * custom properties don't reach. Variables declared inside the SVG itself stay
 * intact (the inner declaration applies there); without a value and without a fallback, the `var()` stays as is.
 */
export function inlineSvgVars(svg: string, vars: Record<string, string>): string {
  if (!/var\(/i.test(svg)) return svg;
  const local = new Set<string>();
  for (const m of svg.matchAll(/(?<![\w-])(--[\w-]+)\s*:/g)) local.add(m[1]!);
  const lookup = (n: string): string | undefined =>
    vars[n] === undefined ? undefined : escapeXml(vars[n]);
  let out = '';
  let i = 0;
  const re = /var\(\s*(--[\w-]+)/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(svg))) {
    const end = closeParen(svg, m.index + 3);
    if (end === -1) break;
    const whole = svg.slice(m.index, end + 1);
    out += svg.slice(i, m.index) + (local.has(m[1]!) ? whole : substituteVars(whole, lookup).value);
    i = end + 1;
    re.lastIndex = i;
  }
  return out + svg.slice(i);
}

/** Resolves `var()` with the given variables and evaluates `calc()`/`color-mix()` when possible. */
export function resolveCssValue(value: string, vars: Record<string, string>): string {
  return evaluateCss(substituteVars(value, (n) => vars[n]).value);
}

/* ====================================================================== */
/* Validation (css-tree)                                                   */
/* ====================================================================== */

export interface TokenProblem {
  /** `error`: rejected/broken value; `warning`: accepted but suspicious (type mismatch, missing reference). */
  level: 'error' | 'warning';
  message: string;
}

function balanceProblem(value: string): string | null {
  let depth = 0;
  let quote: string | null = null;
  for (let i = 0; i < value.length; i++) {
    const c = value[i]!;
    if (quote) {
      if (c === '\\') i++;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") quote = c;
    else if (c === '(') depth++;
    else if (c === ')' && --depth < 0) return 'unmatched ")"';
  }
  if (quote) return 'unclosed quotes';
  if (depth > 0) return 'unclosed parentheses';
  return null;
}

/** CSS property used to check the value type of a group. */
function typeCheckProperty(name: string, group: string): string | null {
  const n = name.toLowerCase();
  switch (group) {
    case 'color':
      return 'color';
    case 'shadow':
      return 'box-shadow';
    case 'radius':
      return 'border-top-left-radius';
    case 'spacing':
      return 'margin-top';
    case 'typography':
      if (/family/.test(n)) return 'font-family';
      if (/weight/.test(n)) return 'font-weight';
      if (/leading|line-height/.test(n)) return 'line-height';
      if (/tracking|letter/.test(n)) return 'letter-spacing';
      if (/size|^--text-/.test(n)) return 'font-size';
      return null;
    default:
      return null;
  }
}

/** Words for the expected type of each group, for messages. */
const GROUP_NOUN: Record<string, string> = {
  color: 'a color',
  shadow: 'a shadow (box-shadow)',
  radius: 'a radius (length or %)',
  spacing: 'a length',
};

/**
 * Validates a token's value with css-tree: syntax (parentheses, quotes, a value that escapes the
 * declaration) and, after resolving the `var()` calls, the type expected by the group (color, shadow...).
 * `vars` are the already resolved variables (default: the document's tokens).
 */
export function validateTokenValue(
  name: string,
  value: string,
  opts: {
    group?: string;
    vars?: Record<string, string>;
    /** Invalid variables of the scope (from {@link resolvedTokensDetailed}), for the message. */
    invalid?: Record<string, string[]>;
  } = {},
): TokenProblem | null {
  const unsafe = cssValueProblem(value);
  if (unsafe) return { level: 'error', message: unsafe };
  if (value.trim() === '') return { level: 'error', message: 'empty value' };
  const bal = balanceProblem(value);
  if (bal) return { level: 'error', message: bal };
  let ast;
  try {
    ast = parse(value, { context: 'value' });
  } catch (e) {
    return { level: 'error', message: `Invalid CSS: ${e instanceof Error ? e.message : e}` };
  }
  void ast;
  const vars = opts.vars ?? {};
  const sub = substituteVars(value, (n) => vars[n]);
  if (sub.missing.length > 0) {
    const names = [...new Set(sub.missing)];
    const broken = names.filter((n) => opts.invalid && n in opts.invalid);
    const absent = names.filter((n) => !broken.includes(n));
    const parts: string[] = [];
    if (absent.length > 0) parts.push(`reference to nonexistent token: ${absent.join(', ')}`);
    if (broken.length > 0) {
      const why = (n: string): string => {
        const m = opts.invalid![n]!;
        return m.length > 0 ? `${n} (→ ${m.join(', ')})` : `${n} (cycle)`;
      };
      parts.push(`reference to token without a valid value: ${broken.map(why).join(', ')}`);
    }
    return { level: 'warning', message: parts.join('; ') };
  }
  const group = canonicalTokenGroup(opts.group ?? inferTokenGroup(name, value));
  const prop = typeCheckProperty(name, group);
  if (!prop) return null;
  try {
    const resolved = parse(sub.value, { context: 'value' });
    const m = lexer.matchProperty(prop, resolved);
    if (m.error) {
      const noun = GROUP_NOUN[group] ?? `a valid value for ${prop}`;
      return { level: 'warning', message: `the value doesn't look like ${noun}` };
    }
  } catch {
    return { level: 'warning', message: 'could not check the value type' };
  }
  return null;
}

/* ====================================================================== */
/* Usage and problems                                                      */
/* ====================================================================== */

export interface TokenUsage {
  /** Nodes that reference the token in some style. */
  nodeIds: string[];
  /** Tokens (base or theme) whose value references this one. */
  tokens: string[];
}

export interface BrokenRef {
  /** Node (style) or token/theme where the broken reference is. */
  nodeId?: string;
  token?: string;
  theme?: string;
  property?: string;
  /** Referenced variable that does not exist (and has no fallback). */
  missing: string;
}

export interface TokenInfo {
  name: string;
  value: string | undefined;
  group: string;
  description?: string;
  /** Value resolved in `:root` (var, calc and color-mix evaluated). */
  resolved?: string;
  /** Value per theme (only the themes that override this token). */
  themes: Record<string, string>;
  /** Value resolved per theme (all themes). */
  resolvedByTheme: Record<string, string>;
  usage: TokenUsage;
  problem?: TokenProblem;
}

export interface TokenReport {
  tokens: TokenInfo[];
  themes: { name: string; overrides: number; frames: string[] }[];
  unused: string[];
  broken: BrokenRef[];
}

/** Ids of the nodes whose `data-theme` equals the theme. */
export function nodesWithTheme(doc: Document, theme: string): string[] {
  const out: string[] = [];
  walk(doc, (n) => {
    if (n.attrs[THEME_ATTR] === theme) out.push(n.id);
  });
  return out;
}

type TokenInfoBase = Omit<TokenInfo, 'usage'>;

/**
 * Part of the report that depends only on tokens, metadata and themes (resolution and validation with
 * css-tree, the expensive part). Cached by the serialization of those three fields (cheap compared to
 * validation and immune to in-place mutation): dragging or editing nodes doesn't redo this calculation.
 */
const INFO_CACHE_SIZE = 8;
const infoCache = new Map<string, TokenInfoBase[]>();

function tokenInfosFor(doc: Document): TokenInfoBase[] {
  const key = JSON.stringify([doc.tokens, doc.tokenMeta ?? null, doc.themes ?? null]);
  const hit = infoCache.get(key);
  if (hit) {
    infoCache.delete(key);
    infoCache.set(key, hit);
    return hit;
  }
  const infos = computeTokenInfos(doc);
  infoCache.set(key, infos);
  if (infoCache.size > INFO_CACHE_SIZE) infoCache.delete(infoCache.keys().next().value!);
  return infos;
}

function computeTokenInfos(doc: Document): TokenInfoBase[] {
  const rootRes = resolvedTokensDetailed(doc);
  const root = rootRes.vars;
  const themeRes = new Map(
    (doc.themes ?? []).map((t) => [t.name, resolvedTokensDetailed(doc, t.name)]),
  );
  const byTheme = new Map([...themeRes].map(([k, r]) => [k, r.vars]));
  return tokenNames(doc).map((name) => {
    const value = doc.tokens[name];
    const group = tokenGroup(doc, name);
    const themes: Record<string, string> = {};
    const resolvedByTheme: Record<string, string> = {};
    for (const t of doc.themes ?? []) {
      if (name in t.overrides) themes[t.name] = t.overrides[name]!;
      const r = byTheme.get(t.name)?.[name];
      if (r !== undefined) resolvedByTheme[t.name] = evaluateCss(r);
    }
    const info: Omit<TokenInfo, 'usage'> = {
      name,
      value,
      group,
      themes,
      resolvedByTheme,
    };
    const description = doc.tokenMeta?.[name]?.description;
    if (description) info.description = description;
    if (root[name] !== undefined) info.resolved = evaluateCss(root[name]);
    const problem =
      value !== undefined
        ? validateTokenValue(name, value, { group, vars: root, invalid: rootRes.invalid })
        : Object.entries(themes)
            .map(([t, v]) =>
              validateTokenValue(name, v, {
                group,
                vars: byTheme.get(t),
                invalid: themeRes.get(t)?.invalid,
              }),
            )
            .find((p) => p !== null);
    if (problem) info.problem = problem;
    return info;
  });
}

/** Full report: tokens with group, resolved values, usage, unused ones and broken references. */
export function getTokenReport(doc: Document): TokenReport {
  const names = tokenNames(doc);
  const usage = new Map<string, TokenUsage>(names.map((n) => [n, { nodeIds: [], tokens: [] }]));
  const defined = new Set(names);
  const broken: BrokenRef[] = [];

  const checkValue = (value: string, ctx: Omit<BrokenRef, 'missing'>, local: Set<string>) => {
    for (const ref of findVarRefs(value)) {
      const u = usage.get(ref.name);
      if (u) {
        if (ctx.nodeId && !u.nodeIds.includes(ctx.nodeId)) u.nodeIds.push(ctx.nodeId);
        const who = ctx.token;
        if (who && who !== ref.name && !u.tokens.includes(who)) u.tokens.push(who);
      } else if (!local.has(ref.name) && ref.fallback === undefined) {
        broken.push({ ...ctx, missing: ref.name });
      }
    }
  };

  for (const [k, v] of Object.entries(doc.tokens)) checkValue(v, { token: k }, defined);
  for (const t of doc.themes ?? []) {
    for (const [k, v] of Object.entries(t.overrides)) {
      checkValue(v, { token: k, theme: t.name }, defined);
    }
  }
  // Custom properties declared in styles apply to the node and its descendants.
  const visit = (node: Node, scope: Set<string>): void => {
    const local = new Set(scope);
    for (const k of Object.keys(node.style)) if (k.startsWith('--')) local.add(k);
    for (const [prop, v] of Object.entries(node.style)) {
      checkValue(v, { nodeId: node.id, property: prop }, local);
    }
    // Attribute values (e.g. `fill="var(--x)"`) and inline SVG markup also use var().
    for (const [attr, v] of Object.entries(node.attrs ?? {})) {
      checkValue(v, { nodeId: node.id, property: `attr:${attr}` }, local);
    }
    if (node.svg) checkValue(node.svg, { nodeId: node.id, property: 'svg' }, local);
    // States (hover, dark, md...): custom properties declared in a state apply only to it.
    for (const [key, st] of Object.entries(node.states ?? {})) {
      const stLocal = new Set(local);
      for (const k of Object.keys(st)) if (k.startsWith('--')) stLocal.add(k);
      for (const [prop, v] of Object.entries(st)) {
        checkValue(v, { nodeId: node.id, property: `state:${key}:${prop}` }, stLocal);
      }
    }
    for (const c of node.children) visit(c, local);
  };
  for (const page of doc.pages) for (const f of page.frames) visit(f, defined);

  const tokens: TokenInfo[] = tokenInfosFor(doc).map((info) => ({
    ...info,
    usage: usage.get(info.name)!,
  }));

  const unused = tokens
    .filter((t) => t.usage.nodeIds.length === 0 && t.usage.tokens.length === 0)
    .map((t) => t.name);
  const themes = (doc.themes ?? []).map((t) => ({
    name: t.name,
    overrides: Object.keys(t.overrides).length,
    frames: nodesWithTheme(doc, t.name),
  }));
  return { tokens, themes, unused, broken };
}

/* ====================================================================== */
/* Theme CSS                                                               */
/* ====================================================================== */

function safeEntries(map: Record<string, string>): [string, string][] {
  return Object.entries(map).filter(([k, v]) => TOKEN_NAME_RE.test(k) && !cssValueProblem(v));
}

/** Selector of a theme, e.g. `[data-theme="dark"]` (the name is already restricted by `THEME_NAME_RE`). */
export function themeSelector(theme: string): string {
  return `[${THEME_ATTR}="${theme}"]`;
}

/**
 * Rules `[data-theme="<theme>"] { ... }` for all themes. `scope` prefixes the selector (the canvas uses
 * `.cv-world `, so it doesn't leak into the interface).
 */
export function themeRulesCss(
  doc: Document,
  opts: { scope?: string; indent?: string } = {},
): string {
  const indent = opts.indent ?? '';
  const blocks: string[] = [];
  for (const t of doc.themes ?? []) {
    if (!THEME_NAME_RE.test(t.name)) continue;
    const decl = safeEntries(themeDeclarations(doc, t.name));
    if (decl.length === 0) continue;
    blocks.push(
      `${indent}${opts.scope ?? ''}${themeSelector(t.name)} {\n${decl.map(([k, v]) => `${indent}  ${k}: ${v};`).join('\n')}\n${indent}}`,
    );
  }
  return blocks.join('\n');
}

/**
 * `@custom-variant theme-<name>` for each theme (and `dark` when a `dark` theme exists), to use
 * `theme-dark:bg-...` / `dark:bg-...` in Tailwind v4.
 */
export function themeVariantsCss(doc: Document): string {
  const out: string[] = [];
  for (const t of doc.themes ?? []) {
    if (!THEME_NAME_RE.test(t.name)) continue;
    const sel = themeSelector(t.name);
    const body = `(&:where(${sel}, ${sel} *))`;
    out.push(`@custom-variant theme-${t.name} ${body};`);
    if (t.name === 'dark') out.push(`@custom-variant dark ${body};`);
  }
  return out.join('\n');
}

/** `:root { tokens }` followed by the theme rules. */
export function tokensCss(doc: Document, opts: { indent?: string } = {}): string {
  const indent = opts.indent ?? '';
  const base = safeEntries(doc.tokens);
  const parts: string[] = [];
  if (base.length > 0) {
    parts.push(
      `${indent}:root {\n${base.map(([k, v]) => `${indent}  ${k}: ${v};`).join('\n')}\n${indent}}`,
    );
  }
  const themes = themeRulesCss(doc, { indent });
  if (themes) parts.push(themes);
  return parts.join('\n');
}

/* ====================================================================== */
/* Op planners (editor and MCP)                                            */
/* ====================================================================== */

function fail(message: string): never {
  throw new Error(message);
}

function requireThemeName(doc: Document, name: string): Theme {
  const t = findTheme(doc, name);
  if (!t) {
    const list = (doc.themes ?? []).map((x) => x.name).join(', ') || 'none';
    fail(`Theme "${name}" not found (themes: ${list})`);
  }
  return t;
}

function checkThemeName(name: string): void {
  if (!THEME_NAME_RE.test(name)) {
    fail(
      `Invalid theme name: "${name}" (letters, digits, "-" and "_", starting with a letter or digit)`,
    );
  }
}

/** Removes tokens from the base, the metadata and all themes (references are left broken). */
export function planDeleteTokens(doc: Document, names: string[]): Op[] {
  const list = [...new Set(names.map(normalizeTokenName))];
  const ops: Op[] = [];
  const base = list.filter((n) => n in doc.tokens);
  if (base.length > 0) ops.push({ type: 'setTokens', unset: base });
  const meta = list.filter((n) => doc.tokenMeta && n in doc.tokenMeta);
  if (meta.length > 0) ops.push({ type: 'setTokenMeta', unset: meta });
  for (const t of doc.themes ?? []) {
    const own = list.filter((n) => n in t.overrides);
    if (own.length > 0) ops.push({ type: 'setTokens', theme: t.name, unset: own });
  }
  if (ops.length === 0) fail(`Token not found: ${list.join(', ')}`);
  return ops;
}

/** Binds the nodes' CSS property to the token: `{ [property]: 'var(--token)' }`. */
export function planApplyToken(
  doc: Document,
  nodeIds: string[],
  property: string,
  token: string,
): Op[] {
  const name = normalizeTokenName(token);
  if (!tokenNames(doc).includes(name)) {
    fail(`Token "${name}" doesn't exist; create it with set_tokens before applying`);
  }
  const prop = toKebabCase(property.trim());
  if (!prop) fail('Empty property');
  for (const id of nodeIds) if (!findNode(doc, id)) fail(`Node "${id}" not found`);
  const changes: StyleChange[] = nodeIds.map((nodeId) => ({
    nodeId,
    set: { [prop]: `var(${name})` },
  }));
  return [{ type: 'updateStyles', changes }];
}

/** Creates a theme (optionally copying the overrides of another). */
export function planCreateTheme(
  doc: Document,
  name: string,
  opts: { overrides?: Record<string, string>; copyFrom?: string } = {},
): Op[] {
  const n = name.trim();
  checkThemeName(n);
  if (findTheme(doc, n)) fail(`Theme "${n}" already exists`);
  const base = opts.copyFrom ? { ...requireThemeName(doc, opts.copyFrom).overrides } : {};
  for (const [k, v] of Object.entries(opts.overrides ?? {})) base[normalizeTokenName(k)] = v;
  const themes = [...(doc.themes ?? []), { name: n, overrides: base }];
  return [{ type: 'setThemes', themes }];
}

/** Removes the theme and strips `data-theme` from the nodes that used it. */
export function planDeleteTheme(doc: Document, name: string): Op[] {
  requireThemeName(doc, name);
  const ops: Op[] = [
    { type: 'setThemes', themes: (doc.themes ?? []).filter((t) => t.name !== name) },
  ];
  const nodes = nodesWithTheme(doc, name);
  if (nodes.length > 0) {
    ops.push({
      type: 'setAttrs',
      changes: nodes.map((nodeId) => ({ nodeId, unset: [THEME_ATTR] })),
    });
  }
  return ops;
}

/** Renames the theme and updates the nodes' `data-theme`. */
export function planRenameTheme(doc: Document, from: string, to: string): Op[] {
  requireThemeName(doc, from);
  const n = to.trim();
  checkThemeName(n);
  if (n === from) fail('The new name is the same as the current one');
  if (findTheme(doc, n)) fail(`Theme "${n}" already exists`);
  const themes = (doc.themes ?? []).map((t) => (t.name === from ? { ...t, name: n } : t));
  const ops: Op[] = [{ type: 'setThemes', themes }];
  const nodes = nodesWithTheme(doc, from);
  if (nodes.length > 0) {
    ops.push({
      type: 'setAttrs',
      changes: nodes.map((nodeId) => ({ nodeId, set: { [THEME_ATTR]: n } })),
    });
  }
  return ops;
}

/** Sets (or, with `null`, removes) the theme of nodes (usually frames). */
export function planSetFrameTheme(doc: Document, nodeIds: string[], theme: string | null): Op[] {
  if (theme !== null) requireThemeName(doc, theme);
  for (const id of nodeIds) if (!findNode(doc, id)) fail(`Node "${id}" not found`);
  return [
    {
      type: 'setAttrs',
      changes: nodeIds.map((nodeId) =>
        theme === null ? { nodeId, unset: [THEME_ATTR] } : { nodeId, set: { [THEME_ATTR]: theme } },
      ),
    },
  ];
}

/** Token system imported (CSS or JSON). */
export interface TokenSet {
  tokens: Record<string, string>;
  tokenMeta: Record<string, TokenMeta>;
  themes: Theme[];
  /** Import warnings (ignored rules, discarded values...). */
  warnings: string[];
}

/**
 * Ops to import a set of tokens. `merge` (default) keeps what exists and overwrites
 * repeated names (themes are merged by name); `replace` swaps the whole system.
 */
export function planImportTokens(
  doc: Document,
  set: TokenSet,
  mode: 'merge' | 'replace' = 'merge',
): Op[] {
  if (mode === 'replace') {
    return [
      { type: 'replaceTokens', tokens: set.tokens, tokenMeta: set.tokenMeta, themes: set.themes },
    ];
  }
  const themes: Theme[] = (doc.themes ?? []).map((t) => ({
    name: t.name,
    overrides: { ...t.overrides },
  }));
  for (const t of set.themes) {
    const cur = themes.find((x) => x.name === t.name);
    if (cur) Object.assign(cur.overrides, t.overrides);
    else themes.push({ name: t.name, overrides: { ...t.overrides } });
  }
  return [
    {
      type: 'replaceTokens',
      tokens: { ...doc.tokens, ...set.tokens },
      tokenMeta: { ...(doc.tokenMeta ?? {}), ...set.tokenMeta },
      themes,
    },
  ];
}
