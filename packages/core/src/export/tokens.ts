/**
 * Importação e exportação do sistema de tokens:
 *
 * - `css`: `:root { --x: ... }` e `[data-theme="<tema>"] { ... }`.
 * - `json`: W3C Design Tokens (DTCG) — grupos aninhados pelos segmentos do nome
 *   (`--color-primary` → `color.primary`), `$value`, `$type`, `$description` e aliases
 *   `{color.primary}`. Grupo e valores por tema vão em `$extensions["mockup-studio"]`.
 * - `tailwind`: `@theme { ... }` (Tailwind v4) com os tokens de namespace de tema, `:root` com os
 *   demais, regras de tema e `@custom-variant` por tema.
 */
import { generate, parse, walk } from '../csstree.js';
import { normalizeTokenNames, TokenMetaSchema } from '../schema.js';
import { cssValueProblem } from '../styles.js';
import { THEME_NAME_RE, TOKEN_NAME_RE } from '../tags.js';
import {
  inferTokenGroup,
  themeRulesCss,
  themeVariantsCss,
  tokenGroup,
  tokenNames,
  tokensCss,
  type TokenSet,
} from '../tokens.js';
import type { Document, Theme, TokenMeta } from '../types.js';
import { themeNamespace } from './tailwind.js';

export type TokenExportFormat = 'css' | 'json' | 'tailwind';

/* ====================================================================== */
/* Exportação                                                              */
/* ====================================================================== */

/** Extensão DTCG com os dados próprios do Mockup Studio. */
export const DTCG_EXTENSION = 'mockup-studio';

const DTCG_TYPE: Record<string, string> = {
  color: 'color',
  spacing: 'dimension',
  radius: 'dimension',
  shadow: 'shadow',
};

const DIMENSION = /^-?(?:\d+\.?\d*|\.\d+)(?:px|rem)$/;

/** `$type` DTCG quando o valor tem a forma simples do tipo (senão, sem `$type`). */
function dtcgType(name: string, group: string, value: string): string | undefined {
  if (/^var\(--[a-zA-Z0-9_-]+\)$/.test(value.trim())) return undefined;
  if (group === 'typography') {
    if (/family|^--font-(?!weight|size|style)/.test(name) && !/^\d+$/.test(value.trim())) {
      return 'fontFamily';
    }
    if (/weight/.test(name) && /^\d+$/.test(value.trim())) return 'fontWeight';
    if (DIMENSION.test(value.trim())) return 'dimension';
    return undefined;
  }
  const t = DTCG_TYPE[group];
  if (t === 'dimension') return DIMENSION.test(value.trim()) ? 'dimension' : undefined;
  if (t === 'shadow') return undefined;
  return t;
}

/** `var(--color-primary)` sozinho vira o alias `{color.primary}`; o resto fica como CSS. */
function toDtcgValue(value: string): string {
  const m = /^var\((--[a-zA-Z0-9_-]+)\)$/.exec(value.trim());
  return m ? `{${m[1]!.slice(2).split('-').join('.')}}` : value;
}

type Json = { [k: string]: unknown };

/** Tokens no formato W3C Design Tokens (objeto JSON). */
export function tokensToDtcg(doc: Document): Json {
  const root: Json = {};
  for (const name of tokenNames(doc)) {
    const path = name.slice(2).split('-');
    let node = root;
    for (const seg of path.slice(0, -1)) {
      const cur = node[seg];
      if (cur && typeof cur === 'object' && '$value' in (cur as Json)) {
        // Já é um token: vira grupo com o token em `$root`.
        node[seg] = { $root: cur };
      } else if (!cur || typeof cur !== 'object') node[seg] = {};
      node = node[seg] as Json;
    }
    const leafKey = path[path.length - 1]!;
    const value = doc.tokens[name];
    const group = tokenGroup(doc, name);
    const token: Json = {};
    const shown = value ?? '';
    const type = value === undefined ? undefined : dtcgType(name, group, value);
    if (type) token.$type = type;
    token.$value = toDtcgValue(shown);
    const description = doc.tokenMeta?.[name]?.description;
    if (description) token.$description = description;
    const ext: Json = {};
    ext.group = group;
    const themes: Json = {};
    for (const t of doc.themes ?? []) {
      if (name in t.overrides) themes[t.name] = t.overrides[name];
    }
    if (Object.keys(themes).length > 0) ext.themes = themes;
    // Token sem valor base (só em temas): `$value` vazio + marca, para o import não o descartar.
    if (value === undefined && Object.keys(themes).length > 0) ext.themeOnly = true;
    token.$extensions = { [DTCG_EXTENSION]: ext };
    const existing = node[leafKey];
    if (existing && typeof existing === 'object' && !('$value' in (existing as Json))) {
      (existing as Json).$root = token;
    } else node[leafKey] = token;
  }
  if ((doc.themes ?? []).length > 0) {
    root.$extensions = { [DTCG_EXTENSION]: { themes: (doc.themes ?? []).map((t) => t.name) } };
  }
  return root;
}

/** Bloco Tailwind v4: `@theme`, `:root`, regras de tema e variantes `theme-<nome>`. */
export function tailwindTokensCss(doc: Document): string {
  const theme: string[] = [];
  const root: string[] = [];
  for (const [k, v] of Object.entries(doc.tokens)) {
    if (!TOKEN_NAME_RE.test(k) || cssValueProblem(v)) continue;
    (themeNamespace(k) ? theme : root).push(`  ${k}: ${v};`);
  }
  const blocks: string[] = [];
  if (theme.length > 0) blocks.push(`@theme {\n${theme.join('\n')}\n}`);
  if (root.length > 0) blocks.push(`:root {\n${root.join('\n')}\n}`);
  const rules = themeRulesCss(doc);
  if (rules) blocks.push(rules);
  const variants = themeVariantsCss(doc);
  if (variants) blocks.push(variants);
  return blocks.join('\n\n');
}

/** Exporta só o sistema de tokens no formato pedido. */
export function exportTokens(doc: Document, format: TokenExportFormat): string {
  switch (format) {
    case 'css':
      return tokensCss(doc) + '\n';
    case 'json':
      return JSON.stringify(tokensToDtcg(doc), null, 2) + '\n';
    case 'tailwind':
      return tailwindTokensCss(doc) + '\n';
  }
}

/* ====================================================================== */
/* Importação: CSS                                                         */
/* ====================================================================== */

function emptySet(): TokenSet {
  return { tokens: {}, tokenMeta: {}, themes: [], warnings: [] };
}

function themeOf(set: TokenSet, name: string): Theme {
  let t = set.themes.find((x) => x.name === name);
  if (!t) {
    t = { name, overrides: {} };
    set.themes.push(t);
  }
  return t;
}

/**
 * Seletor → destino: `null` = tokens base (`:root`, `html`, `:host`, `*`, `@theme`); string = tema,
 * só para `[data-theme="x"]` / `[data-theme=x]`, `.dark`, `.light` e `.theme-x` (os três últimos
 * com prefixo opcional `:root`/`html`); `undefined` = ignorar (qualquer outra classe ou seletor).
 */
function selectorTarget(selector: string): string | null | undefined {
  const s = selector.trim();
  if (/^(?::root|html|:host|\*)$/.test(s)) return null;
  let m = /^(?::root|html)?\[data-theme\s*=\s*["']?([a-zA-Z0-9_-]+)["']?\s*\]$/.exec(s);
  if (m) return m[1]!;
  m = /^(?::root|html)?\.(dark|light)$/.exec(s);
  if (m) return m[1]!;
  m = /^(?::root|html)?\.theme-([a-zA-Z0-9_-]+)$/.exec(s);
  if (m) return m[1]!;
  return undefined;
}

/** Aviso para `url()` remoto (`http:`, `https:` ou `//`); `null` se não houver. */
function remoteUrlWarning(name: string, value: string): string | null {
  const m = /url\(\s*["']?\s*((?:https?:|\/\/)[^"')\s]*)/i.exec(value);
  return m
    ? `${name} usa url() remoto (${m[1]}): o projeto é offline-first e o recurso pode não carregar`
    : null;
}

/** Lê tokens de CSS: `:root {}`, `@theme {}`, `[data-theme="x"] {}`, `.dark {}` e `prefers-color-scheme`. */
export function parseTokensCss(css: string): TokenSet {
  const set = emptySet();
  let ast;
  try {
    ast = parse(css, {
      positions: false,
      parseCustomProperty: false,
      onParseError: (e) => set.warnings.push(`CSS: ${e.message}`),
    });
  } catch (e) {
    throw new Error(`CSS inválido: ${e instanceof Error ? e.message : String(e)}`);
  }
  const put = (target: string | null, name: string, value: string): void => {
    const v = value.trim();
    const problem = cssValueProblem(v);
    if (problem || v === '') {
      set.warnings.push(`${name} descartado: ${problem ?? 'valor vazio'}`);
      return;
    }
    const remote = remoteUrlWarning(name, v);
    if (remote) set.warnings.push(remote);
    if (target === null) set.tokens[name] = v;
    else themeOf(set, target).overrides[name] = v;
  };
  const visitBlock = (block: unknown, target: string | null): void => {
    walk(block as Parameters<typeof walk>[0], {
      visit: 'Declaration',
      enter(decl) {
        if (!decl.property.startsWith('--')) return;
        const value = decl.value.type === 'Raw' ? decl.value.value : generate(decl.value);
        put(target, decl.property, value);
      },
    });
  };
  const handleRule = (rule: { prelude: unknown; block: unknown }, media: string | null): void => {
    const prelude = generate(rule.prelude as Parameters<typeof generate>[0]);
    for (const sel of prelude.split(',')) {
      let target = selectorTarget(sel);
      if (target === null && media) target = media;
      if (target === undefined) {
        set.warnings.push(`Regra ignorada: "${sel.trim()}"`);
        continue;
      }
      if (target !== null && !THEME_NAME_RE.test(target)) {
        set.warnings.push(`Tema com nome inválido ignorado: "${target}"`);
        continue;
      }
      visitBlock(rule.block, target);
    }
  };
  type Children = { toArray(): unknown[] };
  /** Percorre uma lista de nós; desce em `@media (prefers-color-scheme)` e `@layer` (recursivo). */
  const visitNodes = (children: Children | undefined, media: string | null): void => {
    for (const node of children?.toArray() ?? []) {
      const n = node as {
        type: string;
        name?: string;
        prelude?: unknown;
        block?: { children?: Children } | null;
      };
      if (n.type === 'Rule') handleRule(n as { prelude: unknown; block: unknown }, media);
      else if (n.type === 'Atrule' && n.name === 'theme' && n.block) visitBlock(n.block, null);
      else if (n.type === 'Atrule' && n.name === 'layer') {
        // `@layer a, b;` (só ordem) não tem bloco e não é aviso.
        if (n.block) visitNodes(n.block.children, media);
      } else if (n.type === 'Atrule' && n.name === 'media' && n.block) {
        const q = n.prelude ? generate(n.prelude as Parameters<typeof generate>[0]) : '';
        const m = /prefers-color-scheme\s*:\s*(dark|light)/.exec(q);
        if (!m) {
          set.warnings.push(`@media ignorado: "${q}"`);
          continue;
        }
        visitNodes(n.block.children, m[1]!);
      } else if (n.type === 'Atrule') set.warnings.push(`@${n.name ?? ''} ignorado`);
    }
  };
  visitNodes((ast as { children?: Children }).children, null);
  set.tokens = normalizeTokenNames(set.tokens);
  // Redeclarações iguais ao valor base (como as que o export de tema gera para aliases) são redundantes.
  for (const t of set.themes) {
    for (const [k, v] of Object.entries(t.overrides))
      if (set.tokens[k] === v) delete t.overrides[k];
  }
  if (Object.keys(set.tokens).length === 0 && set.themes.length === 0) {
    throw new Error('Nenhum token encontrado no CSS (use :root { --nome: valor; })');
  }
  return set;
}

/* ====================================================================== */
/* Importação: JSON (W3C Design Tokens)                                    */
/* ====================================================================== */

const GROUP_BY_TYPE: Record<string, string> = {
  color: 'color',
  dimension: 'spacing',
  fontFamily: 'typography',
  fontWeight: 'typography',
  fontSize: 'typography',
  lineHeight: 'typography',
  letterSpacing: 'typography',
  typography: 'typography',
  shadow: 'shadow',
  borderRadius: 'radius',
  spacing: 'spacing',
  sizing: 'spacing',
};

/** `{color.primary}` (alias DTCG) → `var(--color-primary)`, também dentro de textos maiores. */
function aliasToVar(value: string): string {
  return value.replace(/\{([a-zA-Z0-9_.$-]+)\}/g, (_, path: string) => {
    const segs = path.split('.').filter((s) => s !== '$root');
    return `var(--${segs.join('-')})`;
  });
}

function num(n: unknown): string {
  return typeof n === 'number' ? String(Math.round(n * 10000) / 10000) : String(n);
}

function dimensionValue(v: unknown): string | null {
  if (typeof v === 'number') return `${num(v)}px`;
  if (typeof v === 'string') return aliasToVar(v);
  if (v && typeof v === 'object' && 'value' in v) {
    const o = v as { value: unknown; unit?: unknown };
    return `${num(o.value)}${typeof o.unit === 'string' ? o.unit : 'px'}`;
  }
  return null;
}

function colorValue(v: unknown): string | null {
  if (typeof v === 'string') return aliasToVar(v);
  if (v && typeof v === 'object') {
    const o = v as { colorSpace?: string; components?: unknown[]; alpha?: number; hex?: string };
    if (typeof o.hex === 'string' && (o.alpha === undefined || o.alpha === 1)) return o.hex;
    if (Array.isArray(o.components)) {
      const comps = o.components.map((c) => (c === 'none' ? 'none' : num(c))).join(' ');
      const alpha = o.alpha !== undefined && o.alpha !== 1 ? ` / ${num(o.alpha)}` : '';
      const space = o.colorSpace ?? 'srgb';
      if (['oklch', 'oklab', 'lab', 'lch', 'hsl', 'hwb'].includes(space)) {
        return `${space}(${comps}${alpha})`;
      }
      return `color(${space} ${comps}${alpha})`;
    }
  }
  return null;
}

function shadowValue(v: unknown): string | null {
  const one = (s: unknown): string | null => {
    if (typeof s === 'string') return aliasToVar(s);
    if (!s || typeof s !== 'object') return null;
    const o = s as Record<string, unknown>;
    const parts = [
      dimensionValue(o.offsetX ?? 0),
      dimensionValue(o.offsetY ?? 0),
      dimensionValue(o.blur ?? 0),
      dimensionValue(o.spread ?? 0),
      colorValue(o.color ?? '#000'),
    ];
    if (parts.some((p) => p === null)) return null;
    return `${o.inset ? 'inset ' : ''}${parts.join(' ')}`;
  };
  if (Array.isArray(v)) {
    const list = v.map(one);
    return list.some((x) => x === null) ? null : list.join(', ');
  }
  return one(v);
}

function fontFamilyValue(v: unknown): string | null {
  const q = (f: string): string => (/^[a-zA-Z-]+$/.test(f) ? f : `"${f.replace(/"/g, '')}"`);
  if (Array.isArray(v)) return v.map((f) => q(String(f))).join(', ');
  if (typeof v === 'string') return aliasToVar(v);
  return null;
}

/** Valor DTCG → CSS. Tokens compostos de tipografia viram vários tokens (`-font-size`...). */
function dtcgToCss(
  type: string | undefined,
  value: unknown,
): string | Record<string, string> | null {
  switch (type) {
    case 'color':
      return colorValue(value);
    case 'dimension':
    case 'fontSize':
    case 'letterSpacing':
    case 'borderRadius':
    case 'spacing':
    case 'sizing':
      return dimensionValue(value);
    case 'duration':
      return typeof value === 'object' && value && 'value' in value
        ? `${num((value as { value: unknown }).value)}${(value as { unit?: string }).unit ?? 'ms'}`
        : typeof value === 'string'
          ? aliasToVar(value)
          : null;
    case 'cubicBezier':
      return Array.isArray(value)
        ? `cubic-bezier(${value.map(num).join(', ')})`
        : aliasToVar(String(value));
    case 'fontFamily':
      return fontFamilyValue(value);
    case 'shadow':
      return shadowValue(value);
    case 'typography': {
      if (!value || typeof value !== 'object')
        return typeof value === 'string' ? aliasToVar(value) : null;
      const o = value as Record<string, unknown>;
      const out: Record<string, string> = {};
      if (o.fontFamily !== undefined) out['font-family'] = fontFamilyValue(o.fontFamily) ?? '';
      if (o.fontSize !== undefined) out['font-size'] = dimensionValue(o.fontSize) ?? '';
      if (o.fontWeight !== undefined) out['font-weight'] = num(o.fontWeight);
      if (o.lineHeight !== undefined)
        out['line-height'] =
          typeof o.lineHeight === 'object'
            ? (dimensionValue(o.lineHeight) ?? '')
            : num(o.lineHeight);
      if (o.letterSpacing !== undefined)
        out['letter-spacing'] = dimensionValue(o.letterSpacing) ?? '';
      return out;
    }
    default:
      if (typeof value === 'string') return aliasToVar(value);
      if (typeof value === 'number') return num(value);
      if (Array.isArray(value)) return value.map((x) => String(x)).join(', ');
      return null;
  }
}

/** Lê tokens no formato W3C Design Tokens (também aceita `value`/`type` sem `$`, como no Tokens Studio). */
export function parseTokensJson(input: string | object): TokenSet {
  let data: unknown = input;
  if (typeof input === 'string') {
    try {
      data = JSON.parse(input);
    } catch (e) {
      throw new Error(`JSON malformado: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error('JSON de tokens deve ser um objeto (formato W3C Design Tokens)');
  }
  const set = emptySet();
  const rootExt = ((data as Json).$extensions as Json | undefined)?.[DTCG_EXTENSION] as
    { themes?: unknown } | undefined;
  if (Array.isArray(rootExt?.themes)) {
    for (const t of rootExt.themes)
      if (typeof t === 'string' && THEME_NAME_RE.test(t)) themeOf(set, t);
  }

  /** Saneia e valida o meta; o que continuar inválido é descartado com aviso (não derruba o import). */
  const cleanMeta = (name: string, meta: TokenMeta): TokenMeta => {
    const out: TokenMeta = {};
    if (meta.group !== undefined) {
      const g = meta.group.trim().slice(0, 64).trim();
      if (g !== '') {
        const r = TokenMetaSchema.safeParse({ group: g });
        if (r.success && r.data.group) out.group = r.data.group;
        else set.warnings.push(`${name}: grupo "${g}" ignorado (caracteres inválidos)`);
      }
    }
    if (meta.description !== undefined) {
      // eslint-disable-next-line no-control-regex
      const d = meta.description.replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, ' ').slice(0, 500);
      if (d.trim() !== '') {
        const r = TokenMetaSchema.safeParse({ description: d });
        if (r.success && r.data.description) out.description = r.data.description;
        else set.warnings.push(`${name}: descrição ignorada (inválida)`);
      }
    }
    return out;
  };

  const putThemes = (name: string, themes: Record<string, unknown>): void => {
    for (const [theme, raw] of Object.entries(themes)) {
      if (!THEME_NAME_RE.test(theme) || typeof raw !== 'string') continue;
      const v = aliasToVar(raw);
      if (cssValueProblem(v)) continue;
      const remote = remoteUrlWarning(name, v);
      if (remote) set.warnings.push(remote);
      themeOf(set, theme).overrides[name] = v;
    }
  };

  /** `themeOnly`: token sem valor base; grava só as sobrescritas de tema (e o meta). */
  const put = (
    name: string,
    value: string,
    meta: TokenMeta,
    themes: Record<string, unknown>,
    themeOnly = false,
  ) => {
    if (!TOKEN_NAME_RE.test(name)) {
      set.warnings.push(`Nome de token inválido ignorado: "${name}"`);
      return;
    }
    if (!themeOnly) {
      const problem = cssValueProblem(value);
      if (problem || value === '') {
        set.warnings.push(`${name} descartado: ${problem ?? 'valor vazio'}`);
        return;
      }
      const remote = remoteUrlWarning(name, value);
      if (remote) set.warnings.push(remote);
      set.tokens[name] = value;
    }
    const clean = cleanMeta(name, meta);
    if (clean.group || clean.description) set.tokenMeta[name] = clean;
    putThemes(name, themes);
  };

  const visit = (node: Json, path: string[], inheritedType: string | undefined): void => {
    const type = typeof node.$type === 'string' ? node.$type : inheritedType;
    const hasValue =
      '$value' in node ||
      ('value' in node && !('$value' in node) && typeof node.value !== 'object') ||
      ('value' in node && 'type' in node);
    if (hasValue) {
      const raw = '$value' in node ? node.$value : node.value;
      const t = type ?? (typeof node.type === 'string' ? node.type : undefined);
      const name = `--${path.filter((s) => s !== '$root').join('-')}`;
      const ext = ((node.$extensions as Json | undefined)?.[DTCG_EXTENSION] ?? {}) as {
        group?: unknown;
        themes?: unknown;
        themeOnly?: unknown;
      };
      const description =
        typeof node.$description === 'string'
          ? node.$description
          : typeof node.description === 'string'
            ? node.description
            : undefined;
      const group = typeof ext.group === 'string' ? ext.group : t ? GROUP_BY_TYPE[t] : undefined;
      const themes =
        ext.themes && typeof ext.themes === 'object' ? (ext.themes as Record<string, unknown>) : {};
      if ((raw === '' || ext.themeOnly === true) && Object.keys(themes).length > 0) {
        // Token só de tema (sem valor base): mantém as sobrescritas e o meta.
        const meta: TokenMeta = {};
        if (group) meta.group = group;
        if (description) meta.description = description;
        put(name, '', meta, themes, true);
        return;
      }
      const css = dtcgToCss(t, raw);
      if (css === null) {
        set.warnings.push(`${name}: valor não suportado (${t ?? 'sem $type'})`);
        return;
      }
      if (typeof css === 'string') {
        const meta: TokenMeta = {};
        if (group && group !== inferTokenGroup(name, css)) meta.group = group;
        if (description) meta.description = description;
        put(name, css, meta, themes);
      } else {
        for (const [suffix, v] of Object.entries(css)) {
          put(`${name}-${suffix}`, v, { group: 'typography' }, {});
        }
      }
      return;
    }
    for (const [k, v] of Object.entries(node)) {
      if (k.startsWith('$') && k !== '$root') continue;
      if (v && typeof v === 'object' && !Array.isArray(v)) visit(v as Json, [...path, k], type);
    }
  };
  visit(data as Json, [], undefined);
  for (const [k, m] of Object.entries(set.tokenMeta)) {
    if (m.group && m.group === inferTokenGroup(k, set.tokens[k])) delete m.group;
    if (!m.group && !m.description) delete set.tokenMeta[k];
  }
  if (
    Object.keys(set.tokens).length === 0 &&
    !set.themes.some((t) => Object.keys(t.overrides).length > 0)
  ) {
    throw new Error(
      'Nenhum token encontrado no JSON (esperado o formato W3C Design Tokens com $value)',
    );
  }
  return set;
}

/** Detecta o formato (JSON se começa com `{`, senão CSS) e importa. */
export function parseTokens(input: string, format?: 'css' | 'json'): TokenSet {
  const f =
    format ?? (/^\s*\{/.test(input) && !/^\s*\{[^"]*\}/.test(input.slice(0, 40)) ? 'json' : 'css');
  if (f === 'json') return parseTokensJson(input);
  return parseTokensCss(input);
}
