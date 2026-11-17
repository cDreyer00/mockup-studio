/**
 * Lógica pura do painel de tokens e do seletor "ligar a token": agrupamento, busca, detecção de
 * `var(--x)`, prévias e montagem de ops. Nada aqui toca o daemon nem o DOM.
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

/** Nome do token quando o valor inteiro é `var(--x)` (ou `var(--x, fallback)`); senão `null`. */
export function varRefName(value: string | undefined | null): string | null {
  if (!value) return null;
  const m = VAR_ONLY.exec(value.trim());
  return m ? m[1]! : null;
}

/** Estilo que referencia o token: `var(--x)`. */
export const varOf = (name: string): string => `var(${name})`;

/* ------------------------------ propriedades → grupos ------------------------------ */

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

/** Tipo de token que combina com a propriedade CSS (`null` = sem seletor de token). */
export function bindKindFor(prop: string): BindKind | null {
  const p = prop.toLowerCase();
  if (COLOR_PROPS.has(p)) return 'color';
  if (/radius$/.test(p)) return 'radius';
  if (/shadow$/.test(p)) return 'shadow';
  if (/^(font-|line-height$|letter-spacing$|word-spacing$)/.test(p)) return 'typography';
  if (SPACING_PROP.test(p)) return 'spacing';
  return null;
}

/** Grupos de token oferecidos primeiro para cada tipo de propriedade. */
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
  color: 'Cores',
  spacing: 'Espaçamento',
  radius: 'Raio',
  typography: 'Tipografia',
  shadow: 'Sombra',
};

/* ------------------------------ agrupamento e busca ------------------------------ */

export interface TokenGroupView {
  id: string;
  label: string;
  tokens: TokenInfo[];
}

/** Filtra por nome, valor (base, de tema ou resolvido) ou descrição, sem diferenciar maiúsculas. */
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

/** Grupos nativos na ordem fixa e, depois, os grupos livres em ordem alfabética. Vazios somem. */
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

/** Tokens do seletor: os dos grupos relevantes primeiro; `all` inclui os demais ao final. */
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

/* ------------------------------ resumo e estados ------------------------------ */

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

/** Problema a mostrar na linha: o do relatório ou a primeira referência quebrada do token. */
export function rowProblem(info: TokenInfo, report: TokenReport): TokenProblem | null {
  const ref = report.broken.find((b) => b.token === info.name);
  // Referência a token inexistente é "quebrada" (vermelho), mesmo que o core a trate como aviso.
  if (ref) {
    return {
      level: 'error',
      message: info.problem?.message ?? `referência quebrada: ${ref.missing}`,
    };
  }
  return info.problem ?? null;
}

/** Valor mostrado e resolvido de um token no contexto de edição (base ou um tema). */
export function shownValue(
  info: TokenInfo,
  theme: string | null,
): { value: string; resolved: string | undefined; overridden: boolean } {
  const override = theme ? info.themes[theme] : undefined;
  const resolved = theme ? (info.resolvedByTheme[theme] ?? info.resolved) : info.resolved;
  return { value: override ?? info.value ?? '', resolved, overridden: override !== undefined };
}

/* ------------------------------ prévias ------------------------------ */

export interface TokenPreview {
  kind: 'color' | 'spacing' | 'radius' | 'shadow' | 'font';
  style: CSSProperties;
}

const COLOR_VALUE =
  /^(#[0-9a-f]{3,8}|(rgb|hsl|hwb|lab|lch|oklab|oklch|color|color-mix)a?\(|[a-z]+$)/i;

/** Prévia simples de um token (amostra de cor, barra, caixa arredondada, sombra, texto). */
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
    // Tamanhos, alturas de linha e espaçamentos de letra não têm amostra; o resto é família.
    if (/^-?[\d.]+[a-z%]*$/i.test(v) || /size|height|spacing|tracking|leading/.test(name))
      return null;
    return { kind: 'font', style: { fontFamily: v } };
  }
  return null;
}

/* ------------------------------ validação ------------------------------ */

/** Erro de nome de token (aceita sem `--`); `null` se válido. */
export function tokenNameError(doc: Document, raw: string, existing?: string): string | null {
  const name = normalizeTokenName(raw);
  if (!name || name === '--') return 'informe um nome';
  if (!TOKEN_NAME_RE.test(name)) return 'use letras, dígitos, "-" e "_"';
  if (name !== existing && tokenNames(doc).includes(name)) return `o token ${name} já existe`;
  // Renomear: recusa destino em tema ou declarado localmente em algum nó (a regra vive no core).
  if (existing && name !== existing) return renameTokenProblem(doc, existing, name);
  return null;
}

/** Erro de nome de tema; `null` se válido. */
export function themeNameError(doc: Document, raw: string, existing?: string): string | null {
  const n = raw.trim();
  if (!n) return 'informe um nome';
  if (!THEME_NAME_RE.test(n)) return 'use letras, dígitos, "-" e "_"';
  if (n !== existing && doc.themes?.some((t) => t.name === n)) return `o tema "${n}" já existe`;
  return null;
}

/** `validateTokenValue` com as variáveis do contexto de edição (base ou tema). */
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

/** Define o valor de um token na base ou, com `theme`, nas sobrescritas do tema. */
export function opSetValue(name: string, value: string, theme?: string | null): Op {
  return { type: 'setTokens', set: { [name]: value.trim() }, ...(theme ? { theme } : {}) };
}

/** Remove a sobrescrita do token no tema (volta a herdar o valor base). */
export function opClearOverride(name: string, theme: string): Op {
  return { type: 'setTokens', unset: [name], theme };
}

/** Metadados novos do token: junta com os atuais; sem grupo nem descrição remove o meta. */
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
  /** Vazio = grupo automático (inferido pelo nome/valor). */
  group?: string;
  description?: string;
}

/** Ops para criar um token (valor base + metadados, se houver). Lança `Error` se inválido. */
export function planCreateToken(doc: Document, input: NewTokenInput): Op[] {
  const err = tokenNameError(doc, input.name);
  if (err) throw new Error(err);
  const name = normalizeTokenName(input.name);
  const value = input.value.trim();
  if (!value) throw new Error('informe um valor');
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

/** Ops para renomear um token (o core atualiza as referências `var()`). Lança `Error` se inválido. */
export function planRenameToken(doc: Document, from: string, rawTo: string): Op[] {
  const err = tokenNameError(doc, rawTo, from);
  if (err) throw new Error(err);
  const to = normalizeTokenName(rawTo);
  return to === from ? [] : [{ type: 'renameToken', from, to }];
}
