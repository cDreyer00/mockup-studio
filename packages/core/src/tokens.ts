/**
 * Tokens e temas em CSS real.
 *
 * - `doc.tokens` são as variáveis CSS base (`:root`), `doc.tokenMeta` guarda grupo e descrição e
 *   `doc.themes` lista temas que sobrescrevem tokens dentro de nós com `data-theme="<tema>"`.
 * - A resolução segue a semântica do CSS: uma variável é resolvida no elemento onde é declarada.
 *   Por isso o CSS de um tema redeclara também os tokens base que dependem (direta ou
 *   indiretamente) de um token sobrescrito: `--surface: var(--gray-900)` acompanha o tema escuro.
 * - Os `plan*` produzem as ops usadas pelo editor e pelo MCP (mesmo caminho de undo).
 */
import { evaluateCss } from './cssEval.js';
import { lexer, parse } from './csstree.js';
import { findNode, walk } from './document.js';
import type { Op, StyleChange } from './ops.js';
import { cssValueProblem, toKebabCase } from './styles.js';
import { THEME_ATTR, THEME_NAME_RE, TOKEN_NAME_RE } from './tags.js';
import type { Document, Node, Theme, TokenMeta } from './types.js';

/* ====================================================================== */
/* Nomes e grupos                                                          */
/* ====================================================================== */

/** `primary` → `--primary`; nomes já com `--` ficam como estão. */
export function normalizeTokenName(name: string): string {
  const n = name.trim();
  return n.startsWith('--') || n === '' ? n : `--${n}`;
}

export const TOKEN_GROUPS = [
  { id: 'color', label: 'Cores' },
  { id: 'typography', label: 'Tipografia' },
  { id: 'spacing', label: 'Espaçamento' },
  { id: 'radius', label: 'Raio' },
  { id: 'shadow', label: 'Sombra' },
  { id: 'other', label: 'Outros' },
] as const;

export type BuiltinTokenGroup = (typeof TOKEN_GROUPS)[number]['id'];

/** Rótulo em português de um grupo (grupos livres ficam com o próprio nome). */
export function tokenGroupLabel(group: string): string {
  return TOKEN_GROUPS.find((g) => g.id === group)?.label ?? group;
}

const COLOR_FN = /^(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color|color-mix|light-dark)\(/i;
const HEX = /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
const LENGTH = /^-?(?:\d+\.?\d*|\.\d+)(?:px|rem|em|%|vw|vh|vmin|vmax|ch|ex|svh|dvh|lvh)$/i;

/** Grupo inferido pelo prefixo do nome e, sem prefixo conhecido, pelo valor. */
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

/** Grupo efetivo: o de `tokenMeta` ou o inferido. */
export function tokenGroup(doc: Document, name: string): string {
  return doc.tokenMeta?.[name]?.group ?? inferTokenGroup(name, doc.tokens[name]);
}

/** Todos os nomes de token definidos (base e temas), na ordem dos tokens base e depois dos temas. */
export function tokenNames(doc: Document): string[] {
  const names = new Set(Object.keys(doc.tokens));
  for (const t of doc.themes ?? []) for (const k of Object.keys(t.overrides)) names.add(k);
  return [...names];
}

/* ====================================================================== */
/* Referências var()                                                       */
/* ====================================================================== */

export interface VarRef {
  name: string;
  fallback?: string;
}

/** Fim da chamada que abre em `start` (índice do `(`), respeitando aninhamento e aspas; -1 se aberta. */
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

/** Referências `var(--x[, fallback])` do valor, inclusive as que estão dentro de fallbacks. */
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

/** Nomes referenciados por `var()` no valor (sem repetição). */
export function referencedTokens(value: string): string[] {
  return [...new Set(findVarRefs(value).map((r) => r.name))];
}

/** Troca `var(--from` por `var(--to` (só o nome exato). */
export function replaceVarRefs(value: string, from: string, to: string): string {
  if (!value.includes(from)) return value;
  const re = new RegExp(`var\\(\\s*${from.replace(/[-]/g, '\\-')}(?=\\s*[,)])`, 'g');
  return value.replace(re, `var(${to}`);
}

/**
 * Substitui as `var()` do valor usando `lookup` (que devolve o valor já resolvido ou `undefined`).
 * Sem valor e sem fallback, a referência fica no texto (o CSS a trataria como inválida).
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

/**
 * Variáveis resolvidas num elemento: `declared` (custom properties do próprio elemento) vê as
 * outras declarações do mesmo elemento e herda o resto de `inherited`. Ciclos ficam sem valor,
 * como no CSS.
 */
export function resolveScope(
  inherited: Record<string, string>,
  declared: Record<string, string>,
): Record<string, string> {
  const out: Record<string, string> = { ...inherited };
  const done = new Map<string, string | undefined>();
  const visiting = new Set<string>();
  const get = (name: string): string | undefined => {
    if (!(name in declared)) return inherited[name];
    if (done.has(name)) return done.get(name);
    if (visiting.has(name)) return undefined;
    visiting.add(name);
    const r = substituteVars(declared[name]!, get);
    visiting.delete(name);
    // Referência ausente fica no texto (`var(--x)`), para o problema aparecer no valor resolvido.
    done.set(name, r.value);
    return r.value;
  };
  for (const name of Object.keys(declared)) {
    const v = get(name);
    if (v === undefined) delete out[name];
    else out[name] = v;
  }
  return out;
}

/* ====================================================================== */
/* Temas                                                                   */
/* ====================================================================== */

export function findTheme(doc: Document, name: string): Theme | undefined {
  return doc.themes?.find((t) => t.name === name);
}

/** Tema declarado no nó (`data-theme`), se existir no documento. */
export function nodeTheme(doc: Document, node: Node): string | undefined {
  const t = node.attrs[THEME_ATTR];
  return t !== undefined && findTheme(doc, t) ? t : undefined;
}

/** Tema efetivo de um nó: o do próprio nó ou do ancestral mais próximo com `data-theme`. */
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
 * Declarações do seletor `[data-theme="<tema>"]`: as sobrescritas do tema e os tokens base que
 * dependem delas (redeclarados com o valor base, para serem resolvidos dentro do tema).
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

/** Variáveis resolvidas no `:root` e, com `theme`, dentro de `[data-theme="<tema>"]`. */
export function resolvedTokens(doc: Document, theme?: string): Record<string, string> {
  const root = resolveScope({}, doc.tokens);
  return theme ? resolveScope(root, themeDeclarations(doc, theme)) : root;
}

/** Valor resolvido (var, calc, color-mix) de um token, no tema indicado. */
export function resolveTokenValue(doc: Document, name: string, theme?: string): string | undefined {
  const v = resolvedTokens(doc, theme)[normalizeTokenName(name)];
  return v === undefined ? undefined : evaluateCss(v);
}

/** Variáveis vistas por um nó: tokens, temas (`data-theme`) e custom properties dos ancestrais. */
export function scopeVarsFor(
  doc: Document,
  nodeId: string,
  opts: { theme?: string } = {},
): Record<string, string> {
  const path = findNode(doc, nodeId);
  if (!path) throw new Error(`Nó "${nodeId}" não encontrado`);
  let vars = resolveScope({}, doc.tokens);
  if (opts.theme && findTheme(doc, opts.theme)) {
    vars = resolveScope(vars, themeDeclarations(doc, opts.theme));
  }
  for (const n of [...path.ancestors, path.node]) {
    const declared: Record<string, string> = {};
    const t = nodeTheme(doc, n);
    if (t) Object.assign(declared, themeDeclarations(doc, t));
    for (const [k, v] of Object.entries(n.style)) if (k.startsWith('--')) declared[k] = v;
    if (Object.keys(declared).length > 0) vars = resolveScope(vars, declared);
  }
  return vars;
}

/** Resolve `var()` com as variáveis dadas e avalia `calc()`/`color-mix()` quando possível. */
export function resolveCssValue(value: string, vars: Record<string, string>): string {
  return evaluateCss(substituteVars(value, (n) => vars[n]).value);
}

/* ====================================================================== */
/* Validação (css-tree)                                                    */
/* ====================================================================== */

export interface TokenProblem {
  /** `error`: valor recusado/quebrado; `warning`: aceito, mas suspeito (tipo não bate, referência ausente). */
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
    else if (c === ')' && --depth < 0) return 'parêntese ")" sem abertura';
  }
  if (quote) return 'aspas não fechadas';
  if (depth > 0) return 'parênteses não fechados';
  return null;
}

/** Propriedade CSS usada para conferir o tipo do valor de um grupo. */
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

/** Palavras do tipo esperado por grupo, para as mensagens. */
const GROUP_NOUN: Record<string, string> = {
  color: 'uma cor',
  shadow: 'uma sombra (box-shadow)',
  radius: 'um raio (comprimento ou %)',
  spacing: 'um comprimento',
};

/**
 * Valida o valor de um token com css-tree: sintaxe (parênteses, aspas, valor que escapa da
 * declaração) e, depois de resolver as `var()`, o tipo esperado pelo grupo (cor, sombra...).
 * `vars` são as variáveis já resolvidas (padrão: os tokens do documento).
 */
export function validateTokenValue(
  name: string,
  value: string,
  opts: { group?: string; vars?: Record<string, string> } = {},
): TokenProblem | null {
  const unsafe = cssValueProblem(value);
  if (unsafe) return { level: 'error', message: unsafe };
  if (value.trim() === '') return { level: 'error', message: 'valor vazio' };
  const bal = balanceProblem(value);
  if (bal) return { level: 'error', message: bal };
  let ast;
  try {
    ast = parse(value, { context: 'value' });
  } catch (e) {
    return { level: 'error', message: `CSS inválido: ${e instanceof Error ? e.message : e}` };
  }
  void ast;
  const vars = opts.vars ?? {};
  const sub = substituteVars(value, (n) => vars[n]);
  if (sub.missing.length > 0) {
    return {
      level: 'warning',
      message: `referência a token inexistente: ${[...new Set(sub.missing)].join(', ')}`,
    };
  }
  const group = opts.group ?? inferTokenGroup(name, value);
  const prop = typeCheckProperty(name, group);
  if (!prop) return null;
  try {
    const resolved = parse(sub.value, { context: 'value' });
    const m = lexer.matchProperty(prop, resolved);
    if (m.error) {
      const noun = GROUP_NOUN[group] ?? `um valor válido para ${prop}`;
      return { level: 'warning', message: `o valor não parece ${noun}` };
    }
  } catch {
    return { level: 'warning', message: 'não foi possível conferir o tipo do valor' };
  }
  return null;
}

/* ====================================================================== */
/* Uso e problemas                                                         */
/* ====================================================================== */

export interface TokenUsage {
  /** Nós que referenciam o token em algum estilo. */
  nodeIds: string[];
  /** Tokens (base ou de tema) cujo valor referencia este. */
  tokens: string[];
}

export interface BrokenRef {
  /** Nó (estilo) ou token/tema onde está a referência quebrada. */
  nodeId?: string;
  token?: string;
  theme?: string;
  property?: string;
  /** Variável referenciada que não existe (e sem fallback). */
  missing: string;
}

export interface TokenInfo {
  name: string;
  value: string | undefined;
  group: string;
  description?: string;
  /** Valor resolvido no `:root` (var, calc e color-mix avaliados). */
  resolved?: string;
  /** Valor por tema (só os temas que sobrescrevem este token). */
  themes: Record<string, string>;
  /** Valor resolvido por tema (todos os temas). */
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

/** Ids dos nós com `data-theme` igual ao tema. */
export function nodesWithTheme(doc: Document, theme: string): string[] {
  const out: string[] = [];
  walk(doc, (n) => {
    if (n.attrs[THEME_ATTR] === theme) out.push(n.id);
  });
  return out;
}

/** Relatório completo: tokens com grupo, valores resolvidos, uso, não usados e referências quebradas. */
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
  // Custom properties declaradas nos estilos valem para o nó e os descendentes.
  const visit = (node: Node, scope: Set<string>): void => {
    const local = new Set(scope);
    for (const k of Object.keys(node.style)) if (k.startsWith('--')) local.add(k);
    for (const [prop, v] of Object.entries(node.style)) {
      checkValue(v, { nodeId: node.id, property: prop }, local);
    }
    for (const c of node.children) visit(c, local);
  };
  for (const page of doc.pages) for (const f of page.frames) visit(f, defined);

  const root = resolvedTokens(doc);
  const byTheme = new Map((doc.themes ?? []).map((t) => [t.name, resolvedTokens(doc, t.name)]));
  const tokens: TokenInfo[] = names.map((name) => {
    const value = doc.tokens[name];
    const group = tokenGroup(doc, name);
    const themes: Record<string, string> = {};
    const resolvedByTheme: Record<string, string> = {};
    for (const t of doc.themes ?? []) {
      if (name in t.overrides) themes[t.name] = t.overrides[name]!;
      const r = byTheme.get(t.name)?.[name];
      if (r !== undefined) resolvedByTheme[t.name] = evaluateCss(r);
    }
    const info: TokenInfo = {
      name,
      value,
      group,
      themes,
      resolvedByTheme,
      usage: usage.get(name)!,
    };
    const description = doc.tokenMeta?.[name]?.description;
    if (description) info.description = description;
    if (root[name] !== undefined) info.resolved = evaluateCss(root[name]);
    const problem =
      value !== undefined
        ? validateTokenValue(name, value, { group, vars: root })
        : Object.entries(themes)
            .map(([t, v]) => validateTokenValue(name, v, { group, vars: byTheme.get(t) }))
            .find((p) => p !== null);
    if (problem) info.problem = problem;
    return info;
  });

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
/* CSS de temas                                                            */
/* ====================================================================== */

function safeEntries(map: Record<string, string>): [string, string][] {
  return Object.entries(map).filter(([k, v]) => TOKEN_NAME_RE.test(k) && !cssValueProblem(v));
}

/** Seletor de um tema, ex.: `[data-theme="dark"]` (o nome já é restrito por `THEME_NAME_RE`). */
export function themeSelector(theme: string): string {
  return `[${THEME_ATTR}="${theme}"]`;
}

/**
 * Regras `[data-theme="<tema>"] { ... }` de todos os temas. `scope` prefixa o seletor (o canvas usa
 * `.cv-world `, para não vazar na interface).
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
 * `@custom-variant theme-<nome>` para cada tema (e `dark` quando existe um tema `dark`), para usar
 * `theme-dark:bg-...` / `dark:bg-...` no Tailwind v4.
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

/** `:root { tokens }` seguido das regras dos temas. */
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
/* Planejadores de ops (editor e MCP)                                      */
/* ====================================================================== */

function fail(message: string): never {
  throw new Error(message);
}

function requireThemeName(doc: Document, name: string): Theme {
  const t = findTheme(doc, name);
  if (!t) {
    const list = (doc.themes ?? []).map((x) => x.name).join(', ') || 'nenhum';
    fail(`Tema "${name}" não encontrado (temas: ${list})`);
  }
  return t;
}

function checkThemeName(name: string): void {
  if (!THEME_NAME_RE.test(name)) {
    fail(
      `Nome de tema inválido: "${name}" (letras, dígitos, "-" e "_", começando por letra ou dígito)`,
    );
  }
}

/** Remove tokens da base, dos metadados e de todos os temas (as referências ficam quebradas). */
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
  if (ops.length === 0) fail(`Token não encontrado: ${list.join(', ')}`);
  return ops;
}

/** Liga a propriedade CSS dos nós ao token: `{ [property]: 'var(--token)' }`. */
export function planApplyToken(
  doc: Document,
  nodeIds: string[],
  property: string,
  token: string,
): Op[] {
  const name = normalizeTokenName(token);
  if (!tokenNames(doc).includes(name)) {
    fail(`Token "${name}" não existe; crie com set_tokens antes de aplicar`);
  }
  const prop = toKebabCase(property.trim());
  if (!prop) fail('Propriedade vazia');
  for (const id of nodeIds) if (!findNode(doc, id)) fail(`Nó "${id}" não encontrado`);
  const changes: StyleChange[] = nodeIds.map((nodeId) => ({
    nodeId,
    set: { [prop]: `var(${name})` },
  }));
  return [{ type: 'updateStyles', changes }];
}

/** Cria um tema (opcionalmente copiando as sobrescritas de outro). */
export function planCreateTheme(
  doc: Document,
  name: string,
  opts: { overrides?: Record<string, string>; copyFrom?: string } = {},
): Op[] {
  const n = name.trim();
  checkThemeName(n);
  if (findTheme(doc, n)) fail(`Já existe um tema "${n}"`);
  const base = opts.copyFrom ? { ...requireThemeName(doc, opts.copyFrom).overrides } : {};
  for (const [k, v] of Object.entries(opts.overrides ?? {})) base[normalizeTokenName(k)] = v;
  const themes = [...(doc.themes ?? []), { name: n, overrides: base }];
  return [{ type: 'setThemes', themes }];
}

/** Remove o tema e tira o `data-theme` dos nós que o usavam. */
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

/** Renomeia o tema e atualiza o `data-theme` dos nós. */
export function planRenameTheme(doc: Document, from: string, to: string): Op[] {
  requireThemeName(doc, from);
  const n = to.trim();
  checkThemeName(n);
  if (n === from) fail('O nome novo é igual ao atual');
  if (findTheme(doc, n)) fail(`Já existe um tema "${n}"`);
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

/** Define (ou, com `null`, remove) o tema dos nós (normalmente frames). */
export function planSetFrameTheme(doc: Document, nodeIds: string[], theme: string | null): Op[] {
  if (theme !== null) requireThemeName(doc, theme);
  for (const id of nodeIds) if (!findNode(doc, id)) fail(`Nó "${id}" não encontrado`);
  return [
    {
      type: 'setAttrs',
      changes: nodeIds.map((nodeId) =>
        theme === null ? { nodeId, unset: [THEME_ATTR] } : { nodeId, set: { [THEME_ATTR]: theme } },
      ),
    },
  ];
}

/** Sistema de tokens importado (CSS ou JSON). */
export interface TokenSet {
  tokens: Record<string, string>;
  tokenMeta: Record<string, TokenMeta>;
  themes: Theme[];
  /** Avisos de importação (regras ignoradas, valores descartados...). */
  warnings: string[];
}

/**
 * Ops para importar um conjunto de tokens. `merge` (padrão) mantém o que existe e sobrescreve os
 * nomes repetidos (temas são mesclados por nome); `replace` troca o sistema inteiro.
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
