/**
 * Pure logic of the tokens panel and the "bind to token" picker: grouping, search, detection of
 * `var(--x)`, previews and op building. Nothing here touches the daemon or the DOM.
 */
import type { CSSProperties } from 'react';
import {
  THEME_NAME_RE,
  TOKEN_GROUPS,
  TOKEN_NAME_RE,
  inferTokenGroup,
  normalizeTokenName,
  renameTokenProblem,
  resolvedTokens,
  tokenGroup,
  tokenGroupLabel,
  tokenNames,
  validateTokenValue,
} from '@mockup/core';
import type { Document, Op, TokenInfo, TokenMeta, TokenProblem, TokenReport } from '@mockup/core';

/* ------------------------------ var(--x) ------------------------------ */

const VAR_ONLY = /^var\(\s*(--[a-zA-Z0-9_-]+)\s*(?:,[^()]*)?\)$/;

/** Token name when the whole value is `var(--x)` (or `var(--x, fallback)`); otherwise `null`. */
export function varRefName(value: string | undefined | null): string | null {
  if (!value) return null;
  const m = VAR_ONLY.exec(value.trim());
  return m ? m[1]! : null;
}

/** Style that references the token: `var(--x)`. */
export const varOf = (name: string): string => `var(${name})`;

/* ------------------------------ properties → groups ------------------------------ */

export type BindKind = 'color' | 'spacing' | 'radius' | 'typography' | 'shadow';

const COLOR_PROPS = new Set([
  'color',
  'background',
  'background-color',
  'border-color',
  'outline-color',
  'fill',
  'stroke',
  'caret-color',
  'text-decoration-color',
]);

const SPACING_PROP =
  /^(gap|row-gap|column-gap|padding|margin|width|height|top|left|right|bottom|inset|flex-basis)(-|$)|^(min|max)-(width|height)$/;

/** Token type that matches the CSS property (`null` = no token picker). */
export function bindKindFor(prop: string): BindKind | null {
  const p = prop.toLowerCase();
  if (COLOR_PROPS.has(p)) return 'color';
  if (/radius$/.test(p)) return 'radius';
  if (/shadow$/.test(p)) return 'shadow';
  if (/^(font-|line-height$|letter-spacing$|word-spacing$)/.test(p)) return 'typography';
  if (SPACING_PROP.test(p)) return 'spacing';
  return null;
}

/** Token groups offered first for each property type. */
export function groupsForKind(kind: BindKind): string[] {
  switch (kind) {
    case 'color':
      return ['color'];
    case 'radius':
      return ['radius', 'spacing'];
    case 'spacing':
      return ['spacing'];
    case 'shadow':
      return ['shadow'];
    default:
      return ['typography'];
  }
}

export const KIND_LABELS: Record<BindKind, string> = {
  color: 'Colors',
  spacing: 'Spacing',
  radius: 'Radius',
  typography: 'Typography',
  shadow: 'Shadow',
};

/* ------------------------------ grouping and search ------------------------------ */

export interface TokenGroupView {
  id: string;
  label: string;
  tokens: TokenInfo[];
}

/** Filters by name, value (base, theme or resolved) or description, case-insensitively. */
export function filterTokens(tokens: readonly TokenInfo[], query: string): TokenInfo[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...tokens];
  return tokens.filter((t) => {
    const hay = [
      t.name,
      t.value ?? '',
      t.resolved ?? '',
      t.description ?? '',
      ...Object.values(t.themes),
    ];
    return hay.some((s) => s.toLowerCase().includes(q));
  });
}

/** Built-in groups in fixed order and then the free groups in alphabetical order. Empty ones are omitted. */
export function groupTokens(tokens: readonly TokenInfo[], query = ''): TokenGroupView[] {
  const list = filterTokens(tokens, query);
  const byGroup = new Map<string, TokenInfo[]>();
  for (const t of list) {
    const g = t.group || 'other';
    const arr = byGroup.get(g);
    if (arr) arr.push(t);
    else byGroup.set(g, [t]);
  }
  const builtin = new Set<string>(TOKEN_GROUPS.map((g) => g.id));
  const out: TokenGroupView[] = [];
  for (const g of TOKEN_GROUPS) {
    const items = byGroup.get(g.id);
    if (items) out.push({ id: g.id, label: g.label, tokens: items });
  }
  const free = [...byGroup.keys()]
    .filter((k) => !builtin.has(k))
    .sort((a, b) => a.localeCompare(b));
  for (const id of free) out.push({ id, label: tokenGroupLabel(id), tokens: byGroup.get(id)! });
  return out;
}

/** Picker tokens: those of the relevant groups first; `all` includes the rest at the end. */
export function pickerTokens(
  tokens: readonly TokenInfo[],
  groups: readonly string[],
  all: boolean,
  query: string,
): TokenInfo[] {
  const rank = (t: TokenInfo): number => {
    const i = groups.indexOf(t.group);
    return i === -1 ? groups.length : i;
  };
  const sorted = filterTokens(tokens, query).sort((a, b) => rank(a) - rank(b));
  return all ? sorted : sorted.filter((t) => rank(t) < groups.length);
}

/* ------------------------------ summary and states ------------------------------ */

export interface TokenSummary {
  tokens: number;
  themes: number;
  unused: number;
  broken: number;
}

export function summarizeTokens(report: TokenReport): TokenSummary {
  return {
    tokens: report.tokens.length,
    themes: report.themes.length,
    unused: report.unused.length,
    broken: report.tokens.filter((t) => rowProblem(t, report)?.level === 'error').length,
  };
}

export function isUnused(info: TokenInfo, report: TokenReport): boolean {
  return report.unused.includes(info.name);
}

/** Problem to show on the row: the report's or the token's first broken reference. */
export function rowProblem(info: TokenInfo, report: TokenReport): TokenProblem | null {
  const ref = report.broken.find((b) => b.token === info.name);
  // A reference to a nonexistent token is "broken" (red), even if the core treats it as a warning.
  if (ref) {
    return {
      level: 'error',
      message: info.problem?.message ?? `broken reference: ${ref.missing}`,
    };
  }
  return info.problem ?? null;
}

/** Shown and resolved value of a token in the editing context (base or a theme). */
export function shownValue(
  info: TokenInfo,
  theme: string | null,
): { value: string; resolved: string | undefined; overridden: boolean } {
  const override = theme ? info.themes[theme] : undefined;
  const resolved = theme ? (info.resolvedByTheme[theme] ?? info.resolved) : info.resolved;
  return { value: override ?? info.value ?? '', resolved, overridden: override !== undefined };
}

/* ------------------------------ previews ------------------------------ */

export interface TokenPreview {
  kind: 'color' | 'spacing' | 'radius' | 'shadow' | 'font';
  style: CSSProperties;
}

const COLOR_VALUE =
  /^(#[0-9a-f]{3,8}|(rgb|hsl|hwb|lab|lch|oklab|oklch|color|color-mix)a?\(|[a-z]+$)/i;

/** Simple preview of a token (color swatch, bar, rounded box, shadow, text). */
export function previewFor(
  group: string,
  name: string,
  resolved: string | undefined,
): TokenPreview | null {
  const v = resolved?.trim();
  if (!v || /var\(/.test(v)) return null;
  if (group === 'color') {
    return COLOR_VALUE.test(v) ? { kind: 'color', style: { background: v } } : null;
  }
  if (group === 'spacing') {
    const px = /^(-?[\d.]+)(px|rem|em)$/.exec(v);
    if (!px) return null;
    const n = Number(px[1]) * (px[2] === 'px' ? 1 : 16);
    return { kind: 'spacing', style: { width: Math.max(1, Math.min(24, n)) } };
  }
  if (group === 'radius') return { kind: 'radius', style: { borderRadius: v } };
  if (group === 'shadow') return { kind: 'shadow', style: { boxShadow: v } };
  if (group === 'typography') {
    if (/weight/.test(name)) return { kind: 'font', style: { fontWeight: v } };
    // Sizes, line heights and letter spacings have no swatch; the rest is a family.
    if (/^-?[\d.]+[a-z%]*$/i.test(v) || /size|height|spacing|tracking|leading/.test(name))
      return null;
    return { kind: 'font', style: { fontFamily: v } };
  }
  return null;
}

/* ------------------------------ validation ------------------------------ */

/** Token name error (accepts without `--`); `null` if valid. */
export function tokenNameError(doc: Document, raw: string, existing?: string): string | null {
  const name = normalizeTokenName(raw);
  if (!name || name === '--') return 'enter a name';
  if (!TOKEN_NAME_RE.test(name)) return 'use letters, digits, "-" and "_"';
  if (name !== existing && tokenNames(doc).includes(name))
    return `the token ${name} already exists`;
  // Renaming: rejects a target that is in a theme or declared locally on some node (the rule lives in the core).
  if (existing && name !== existing) return renameTokenProblem(doc, existing, name);
  return null;
}

/** Theme name error; `null` if valid. */
export function themeNameError(doc: Document, raw: string, existing?: string): string | null {
  const n = raw.trim();
  if (!n) return 'enter a name';
  if (!THEME_NAME_RE.test(n)) return 'use letters, digits, "-" and "_"';
  if (n !== existing && doc.themes?.some((t) => t.name === n))
    return `the theme "${n}" already exists`;
  return null;
}

/** `validateTokenValue` with the variables of the editing context (base or theme). */
export function validateEdit(
  doc: Document,
  name: string,
  value: string,
  opts: { group?: string; theme?: string | null } = {},
): TokenProblem | null {
  const vars = resolvedTokens(doc, opts.theme ?? undefined);
  return validateTokenValue(name, value.trim(), {
    group: opts.group ?? tokenGroup(doc, name),
    vars,
  });
}

/* ------------------------------ ops ------------------------------ */

/** Sets a token's value in the base or, with `theme`, in the theme's overrides. */
export function opSetValue(name: string, value: string, theme?: string | null): Op {
  return { type: 'setTokens', set: { [name]: value.trim() }, ...(theme ? { theme } : {}) };
}

/** Removes the token's override in the theme (goes back to inheriting the base value). */
export function opClearOverride(name: string, theme: string): Op {
  return { type: 'setTokens', unset: [name], theme };
}

/** New token metadata: merges with the current one; with no group or description it removes the meta. */
export function opSetMeta(doc: Document, name: string, patch: Partial<TokenMeta>): Op | null {
  const had = !!doc.tokenMeta && name in doc.tokenMeta;
  const next: TokenMeta = { ...doc.tokenMeta?.[name], ...patch };
  if (!next.group) delete next.group;
  if (!next.description) delete next.description;
  if (Object.keys(next).length === 0) return had ? { type: 'setTokenMeta', unset: [name] } : null;
  return { type: 'setTokenMeta', set: { [name]: next } };
}

export interface NewTokenInput {
  name: string;
  value: string;
  /** Empty = automatic group (inferred from the name/value). */
  group?: string;
  description?: string;
}

/** Ops to create a token (base value + metadata, if any). Throws `Error` if invalid. */
export function planCreateToken(doc: Document, input: NewTokenInput): Op[] {
  const err = tokenNameError(doc, input.name);
  if (err) throw new Error(err);
  const name = normalizeTokenName(input.name);
  const value = input.value.trim();
  if (!value) throw new Error('enter a value');
  const problem = validateTokenValue(name, value, {
    group: input.group || inferTokenGroup(name, value),
    vars: resolvedTokens(doc),
  });
  if (problem?.level === 'error') throw new Error(problem.message);
  const ops: Op[] = [{ type: 'setTokens', set: { [name]: value } }];
  const meta: TokenMeta = {};
  if (input.group) meta.group = input.group.trim();
  if (input.description?.trim()) meta.description = input.description.trim();
  if (Object.keys(meta).length > 0) ops.push({ type: 'setTokenMeta', set: { [name]: meta } });
  return ops;
}

/** Ops to rename a token (the core updates the `var()` references). Throws `Error` if invalid. */
export function planRenameToken(doc: Document, from: string, rawTo: string): Op[] {
  const err = tokenNameError(doc, rawTo, from);
  if (err) throw new Error(err);
  const to = normalizeTokenName(rawTo);
  return to === from ? [] : [{ type: 'renameToken', from, to }];
}
