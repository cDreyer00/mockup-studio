/**
 * Motor Tailwind v4 do Mockup Studio: usa o compilador oficial (`tailwindcss`, JS puro, sem DOM e
 * sem Node) para converter classes em CSS real do nó e o caminho inverso (estilo → classes
 * idiomáticas). Ver `docs/TAILWIND.md`.
 *
 * - `createTailwindEngine(doc)` é assíncrono (carrega o design system do Tailwind com o tema
 *   padrão + os tokens do documento); depois tudo é síncrono e com cache por classe.
 * - Os valores do tema padrão entram inline (`p-4` → `padding: 1rem`, `bg-blue-500` → `oklch(...)`);
 *   os tokens do documento entram como referência (`bg-primary` → `var(--color-primary)`), para
 *   que o nó continue ligado ao token.
 * - As variáveis internas do Tailwind (`--tw-shadow`, `--tw-border-style`...) são resolvidas no
 *   próprio nó (com os `initial-value` do `@property`), então o estilo gravado é CSS comum.
 */
import { __unstable__loadDesignSystem } from 'tailwindcss';
import { evaluateCalc, formatHexColor, parseCssColor } from '../cssEval.js';
import { cssToTailwind, themeNamespace } from '../export/tailwind.js';
import { cssValueProblem, isValidCssPropertyName } from '../styles.js';
import { formatStateKey, sortStateKeys, type StateKeyParts } from '../states.js';
import { themeVariantsCss } from '../tokens.js';
import type { Document, Node } from '../types.js';
import { TAILWIND_THEME_CSS, TAILWIND_VERSION } from './theme.generated.js';

type DesignSystem = Awaited<ReturnType<typeof __unstable__loadDesignSystem>>;
type AstNode = ReturnType<DesignSystem['candidatesToAst']>[number][number];

/** Seletor de `dark:` no Mockup Studio: o tema `dark` do documento (atributo `data-theme`). */
export const DARK_VARIANT_CSS =
  '@custom-variant dark (&:where([data-theme=dark], [data-theme=dark] *));';

export { TAILWIND_VERSION };

/* ====================================================================== */
/* Tipos                                                                    */
/* ====================================================================== */

interface Decl {
  prop: string;
  value: string;
  important: boolean;
}

/** Alvo das declarações: o próprio nó, todos os filhos (`*:`) ou todos menos o último (`space-y`). */
type Target = 'self' | 'children' | 'children-not-last';

/** Classe compilada (sem variantes). */
interface CompiledUtility {
  target: Target;
  decls: Decl[];
  /** Variáveis `--tw-*` definidas pela classe. */
  vars: Record<string, string>;
  /** `initial-value` dos `@property` usados. */
  initials: Record<string, string>;
}

/** Classe do autor já analisada. */
export interface ClassInfo {
  cls: string;
  status: 'applied' | 'unknown' | 'unsupported';
  /** Estado (`''` = estilo base, `hover`, `md:hover`...). */
  state?: string;
  target?: Target;
  utility?: CompiledUtility;
  /** Motivo quando `unsupported`. */
  reason?: string;
  /** Ordem do Tailwind (cascata). */
  order?: bigint;
}

export interface TailwindStyles {
  /** CSS do nó (kebab-case), pronto para `node.style`. */
  style: Record<string, string>;
  /** Estilos por estado (`hover`, `dark`, `md`...), prontos para `node.states`. */
  states: Record<string, Record<string, string>>;
  /** CSS que a classe aplica nos filhos (`*:p-2`, `space-y-2`, `divide-y`). */
  children?: { all?: Record<string, string>; notLast?: Record<string, string> };
  /** Classes Tailwind aplicadas. */
  applied: string[];
  /** Classes que o Tailwind não reconhece (ficam em `node.classes`, sem efeito). */
  unknown: string[];
  /** Classes Tailwind com variante/alvo que o modelo não representa (ficam em `node.classes`). */
  unsupported: { cls: string; reason: string }[];
}

export interface StylesToClassesOptions {
  /**
   * Tamanhos `text-*` cujo `line-height` o tema exportado neutraliza (`--text-sm--line-height:
   * inherit`): nessa exportação `text-sm` só define o `font-size`.
   */
  neutralLeading?: ReadonlySet<string>;
}

export interface TailwindEngine {
  /** Chave do cache (tokens que entram no `@theme`). */
  readonly key: string;
  /** CSS de entrada do compilador (tema + tokens + variantes). */
  readonly inputCss: string;
  /** Analisa e compila uma lista de classes. */
  classesToStyles(classes: string): TailwindStyles;
  /** Análise por classe (status, estado, alvo). */
  inspect(classes: string): ClassInfo[];
  /** CSS gerado pelo Tailwind para uma classe (`null` se não for classe Tailwind). */
  classCss(cls: string): string | null;
  /** `true` se o Tailwind gera CSS para a classe. */
  isTailwindClass(cls: string): boolean;
  /** Estilo → classes idiomáticas (canonicalizadas e conferidas contra o compilador). */
  stylesToClasses(
    style: Record<string, string>,
    opts?: StylesToClassesOptions,
  ): { classes: string[]; rest: Record<string, string> };
  /**
   * Classes do nó (estilo base + estados com prefixo de variante): reaproveita as classes de
   * `node.classes` que ainda batem com o estilo atual e gera as que faltam.
   */
  nodeClasses(
    node: Node,
    opts?: StylesToClassesOptions,
  ): { classes: string[]; rest: Record<string, string> };
  /** Canonicaliza classes (`p-[16px]` → `p-4`, `mt-2 mb-2` → `my-2`). */
  canonicalize(classes: string[]): string[];
  /** Sugestões para autocomplete (aceita prefixo de variante, ex.: `hover:bg-`). */
  suggest(query: string, limit?: number): string[];
  /** Todas as classes conhecidas (sem valores arbitrários). */
  classList(): string[];
}

/* ====================================================================== */
/* Utilitários de valor                                                     */
/* ====================================================================== */

/** Lê `var(--nome, fallback)` a partir de `start` (índice do `v`). */
function readVar(
  value: string,
  start: number,
): { name: string; fallback?: string; end: number } | null {
  if (!value.startsWith('var(', start)) return null;
  let depth = 0;
  let comma = -1;
  for (let i = start + 3; i < value.length; i++) {
    const ch = value[i];
    if (ch === '(') depth++;
    else if (ch === ')') {
      depth--;
      if (depth === 0) {
        const inner = value.slice(start + 4, i);
        const name = (comma === -1 ? inner : value.slice(start + 4, comma)).trim();
        const fallback = comma === -1 ? undefined : value.slice(comma + 1, i);
        return { name, fallback, end: i + 1 };
      }
    } else if (ch === ',' && depth === 1 && comma === -1) comma = i;
  }
  return null;
}

/**
 * Substitui as `var(--tw-*)` pelo valor no nó (ou o `initial-value`, ou o fallback). Variáveis
 * que não são do Tailwind (tokens do documento) ficam intactas. `null` = declaração inválida
 * (variável sem valor e sem fallback, como no CSS).
 */
function substituteTw(
  value: string,
  vars: Record<string, string>,
  initials: Record<string, string>,
  depth = 0,
): string | null {
  if (depth > 20 || !value.includes('var(--tw-')) return value;
  let out = '';
  let i = 0;
  while (i < value.length) {
    const at = value.indexOf('var(', i);
    if (at === -1) {
      out += value.slice(i);
      break;
    }
    out += value.slice(i, at);
    const v = readVar(value, at);
    if (!v) {
      out += value.slice(at);
      break;
    }
    if (!v.name.startsWith('--tw-')) {
      // Token do documento: mantém, mas resolve `--tw-*` dentro do fallback.
      const fb =
        v.fallback === undefined ? null : substituteTw(v.fallback, vars, initials, depth + 1);
      out += fb === null ? value.slice(at, v.end) : `var(${v.name},${fb})`;
      i = v.end;
      continue;
    }
    let rep: string | null;
    if (Object.hasOwn(vars, v.name)) rep = substituteTw(vars[v.name], vars, initials, depth + 1);
    else if (Object.hasOwn(initials, v.name)) rep = initials[v.name];
    else if (v.fallback !== undefined) rep = substituteTw(v.fallback, vars, initials, depth + 1);
    else rep = null;
    if (rep === null) return null;
    out += rep;
    i = v.end;
  }
  return out;
}

/** Avalia os `calc()` sem `var()` (`calc(0.25rem * 4)` → `1rem`), de dentro para fora. */
export function foldCalc(value: string): string {
  let cur = value;
  for (let guard = 0; guard < 50; guard++) {
    const re = /calc\(([^()]*(?:\([^()]*\)[^()]*)*)\)/gi;
    let changed = false;
    cur = cur.replace(re, (full: string) => {
      if (/var\(/i.test(full)) return full;
      // Só expressões numéricas (números, unidades, operadores, parênteses).
      if (!/^calc\([\s\d.+\-*/()%a-z]*\)$/i.test(full)) return full;
      const r = evaluateCalc(full);
      if (r === null) return full;
      changed = true;
      return r;
    });
    if (!changed) break;
  }
  return cur;
}

/** Remove camadas vazias (`0 0 #0000`) de `box-shadow`. */
function cleanShadow(value: string): string {
  const layers = splitTopComma(value).filter((l) => !/^0 0 #0000$/i.test(l.trim()));
  if (layers.length === 0) return '0 0 #0000';
  return layers.map((l) => l.trim().replace(/\s+/g, ' ')).join(', ');
}

function splitTopComma(value: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let buf = '';
  for (const ch of value) {
    if (ch === '(') depth++;
    else if (ch === ')') depth = Math.max(0, depth - 1);
    if (ch === ',' && depth === 0) {
      out.push(buf);
      buf = '';
    } else buf += ch;
  }
  out.push(buf);
  return out;
}

/** Valor final de uma declaração (substituição, `calc`, espaços, sombra). `null` = descartar. */
function finalizeValue(
  prop: string,
  value: string,
  vars: Record<string, string>,
  initials: Record<string, string>,
): string | null {
  const sub = substituteTw(value, vars, initials);
  if (sub === null) return null;
  let v = foldCalc(sub).replace(/\s+/g, ' ').replace(/\(\s+/g, '(').replace(/\s+\)/g, ')').trim();
  if (prop === 'box-shadow') v = cleanShadow(v);
  if (v === '') return null;
  return v;
}

/** Forma comparável de um valor CSS (rem → px, cores em hex, espaços normalizados). */
export function comparableCss(value: string): string {
  let v = value
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/\s*,\s*/g, ',');
  v = v.replace(/\s*!important$/, ' !important');
  const color = parseCssColor(v);
  if (color) return formatHexColor(color);
  v = v.replace(/(-?\d*\.?\d+)rem\b/g, (_m, n: string) => `${round(parseFloat(n) * 16)}px`);
  v = v.replace(/(-?\d*\.?\d+)(px|%|em|deg|ms|s)?\b/g, (_m, n: string, u?: string) => {
    const num = round(parseFloat(n));
    return num === 0 && (u === 'px' || u === undefined) ? '0' : `${num}${u ?? ''}`;
  });
  return v;
}

const round = (n: number): number => Math.round(n * 1000) / 1000;

/* ====================================================================== */
/* Variantes                                                               */
/* ====================================================================== */

const BP = new Set(['sm', 'md', 'lg', 'xl', '2xl']);
const PSEUDO = new Set(['hover', 'focus', 'focus-visible', 'focus-within', 'active', 'disabled']);

interface VariantNode {
  kind: string;
  root?: string;
}

/** Variantes (do Tailwind, de dentro para fora) → estado do nó, ou o motivo de não suportar. */
function variantsToState(
  variants: readonly VariantNode[],
): { state: string; children: boolean } | { reason: string } {
  const parts: StateKeyParts = {};
  let children = false;
  for (const v of variants) {
    const root = v.kind === 'static' ? (v.root ?? '') : '';
    if (v.kind !== 'static') {
      return { reason: `variante "${v.kind}" não representável (use estados hover, dark, md...)` };
    }
    if (BP.has(root)) {
      if (parts.breakpoint) return { reason: 'dois breakpoints na mesma classe' };
      parts.breakpoint = root as StateKeyParts['breakpoint'];
    } else if (root === 'dark') parts.dark = true;
    else if (PSEUDO.has(root)) {
      if (parts.pseudo) return { reason: 'duas pseudo-classes na mesma classe' };
      parts.pseudo = root as StateKeyParts['pseudo'];
    } else if (root === '*') children = true;
    else return { reason: `variante "${root}:" sem equivalente no modelo (fica só na classe)` };
  }
  if (children && formatStateKey(parts) !== '') {
    return { reason: 'variante "*:" combinada com estado' };
  }
  return { state: formatStateKey(parts), children };
}

/* ====================================================================== */
/* Tema do documento                                                        */
/* ====================================================================== */

/** Tokens do documento que entram no `@theme` do Tailwind (namespaces de tema e `--spacing`). */
export function tailwindThemeTokens(doc: Pick<Document, 'tokens'>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(doc.tokens ?? {})) {
    if (!isValidCssPropertyName(k) || cssValueProblem(v) !== null) continue;
    if (
      themeNamespace(k) ||
      k === '--spacing' ||
      /^--(breakpoint|container)-[a-z0-9-]+$/i.test(k)
    ) {
      out[k] = v;
    }
  }
  return out;
}

/** CSS de entrada do compilador para o documento. */
export function tailwindInputCss(doc: Pick<Document, 'tokens' | 'themes'>): string {
  const tokens = tailwindThemeTokens(doc);
  const lines = Object.entries(tokens).map(([k, v]) => `  ${k}: ${v};`);
  const blocks = [TAILWIND_THEME_CSS.replace('@theme default {', '@theme default inline {')];
  if (lines.length > 0) blocks.push(`@theme {\n${lines.join('\n')}\n}`);
  blocks.push(DARK_VARIANT_CSS);
  const variants = themeVariantsCss(doc as Document);
  if (variants) blocks.push(variants);
  blocks.push('@tailwind utilities;');
  return blocks.join('\n');
}

/** Chave de cache: só os tokens que mudam o compilador (e os nomes de tema, pelas variantes). */
export function tailwindEngineKey(doc: Pick<Document, 'tokens' | 'themes'>): string {
  const themes = (doc.themes ?? []).map((t) => t.name).join(',');
  return JSON.stringify([TAILWIND_VERSION, tailwindThemeTokens(doc), themes]);
}

/* ====================================================================== */
/* Engine                                                                   */
/* ====================================================================== */

/** Classes mais usadas: aparecem primeiro no autocomplete. */
const POPULAR = [
  'flex',
  'flex-col',
  'flex-row',
  'flex-wrap',
  'flex-1',
  'grid',
  'grid-cols-2',
  'grid-cols-3',
  'items-center',
  'items-start',
  'items-end',
  'justify-center',
  'justify-between',
  'justify-end',
  'gap-1',
  'gap-2',
  'gap-3',
  'gap-4',
  'gap-6',
  'gap-8',
  'p-2',
  'p-4',
  'p-6',
  'p-8',
  'px-2',
  'px-3',
  'px-4',
  'px-6',
  'py-1',
  'py-2',
  'py-3',
  'py-4',
  'm-0',
  'mx-auto',
  'mt-2',
  'mt-4',
  'mb-2',
  'mb-4',
  'w-full',
  'h-full',
  'w-auto',
  'min-h-screen',
  'max-w-md',
  'max-w-lg',
  'max-w-xl',
  'size-4',
  'text-xs',
  'text-sm',
  'text-base',
  'text-lg',
  'text-xl',
  'text-2xl',
  'text-3xl',
  'text-4xl',
  'font-medium',
  'font-semibold',
  'font-bold',
  'leading-tight',
  'leading-relaxed',
  'tracking-tight',
  'text-center',
  'text-left',
  'text-right',
  'text-white',
  'text-black',
  'text-gray-500',
  'text-gray-600',
  'text-gray-900',
  'bg-white',
  'bg-black',
  'bg-gray-50',
  'bg-gray-100',
  'bg-transparent',
  'border',
  'border-b',
  'border-t',
  'border-gray-200',
  'rounded',
  'rounded-md',
  'rounded-lg',
  'rounded-xl',
  'rounded-full',
  'shadow-sm',
  'shadow',
  'shadow-md',
  'shadow-lg',
  'overflow-hidden',
  'relative',
  'absolute',
  'inset-0',
  'hidden',
  'block',
  'inline-flex',
  'opacity-50',
  'truncate',
  'underline',
  'uppercase',
  'cursor-pointer',
  'transition',
];

export async function createTailwindEngine(
  doc: Pick<Document, 'tokens' | 'themes'>,
): Promise<TailwindEngine> {
  const inputCss = tailwindInputCss(doc);
  // Dois design systems: `canonicalizeCandidates` altera as opções do tema do design system que
  // o executa (os valores deixam de sair inline), então a canonicalização usa uma cópia própria.
  const [ds, canon] = await Promise.all([
    __unstable__loadDesignSystem(inputCss, { base: '/' }),
    __unstable__loadDesignSystem(inputCss, { base: '/' }),
  ]);
  return new Engine(ds, canon, tailwindEngineKey(doc), inputCss, doc.tokens ?? {});
}

class Engine implements TailwindEngine {
  private utilCache = new Map<string, CompiledUtility | null>();
  private infoCache = new Map<string, ClassInfo>();
  private list: string[] | null = null;

  constructor(
    private ds: DesignSystem,
    private canon: DesignSystem,
    readonly key: string,
    readonly inputCss: string,
    private tokens: Record<string, string>,
  ) {}

  /* ---------- compilação ---------- */

  private compileUtility(utility: string): CompiledUtility | null {
    const cached = this.utilCache.get(utility);
    if (cached !== undefined) return cached;
    let result: CompiledUtility | null = null;
    try {
      const ast = this.ds.candidatesToAst([utility])[0] ?? [];
      result = this.readAst(ast);
    } catch {
      result = null;
    }
    this.utilCache.set(utility, result);
    return result;
  }

  private readAst(ast: AstNode[]): CompiledUtility | null {
    const initials: Record<string, string> = {};
    let rule: { selector: string; nodes: AstNode[] } | null = null;
    let extraRules = 0;
    for (const n of ast) {
      if (n.kind === 'at-rule' && n.name === '@property') {
        const init = n.nodes.find(
          (d): d is Extract<AstNode, { kind: 'declaration' }> =>
            d.kind === 'declaration' && d.property === 'initial-value',
        );
        if (init?.value !== undefined) initials[n.params.trim()] = init.value;
      } else if (n.kind === 'rule') {
        if (rule) extraRules++;
        else rule = n;
      } else if (n.kind === 'at-rule' && n.name !== '@keyframes') {
        extraRules++;
      }
    }
    if (!rule || extraRules > 0) return null;
    const target = selectorTarget(rule.selector);
    if (!target) return null;
    const decls: Decl[] = [];
    const vars: Record<string, string> = {};
    const visit = (nodes: AstNode[]): void => {
      for (const d of nodes) {
        if (d.kind === 'declaration' && d.value !== undefined) {
          if (d.property.startsWith('--tw-')) vars[d.property] = d.value;
          else decls.push({ prop: d.property, value: d.value, important: d.important });
        } else if (d.kind === 'at-rule' && d.name === '@supports') {
          // O Chromium do app suporta as features testadas (ex.: gradiente `in oklab`).
          visit(d.nodes);
        }
      }
    };
    visit(rule.nodes);
    if (decls.length === 0 && Object.keys(vars).length === 0) return null;
    return { target, decls, vars, initials };
  }

  private info(cls: string): ClassInfo {
    const cached = this.infoCache.get(cls);
    if (cached) return cached;
    const info = this.analyze(cls);
    this.infoCache.set(cls, info);
    return info;
  }

  private analyze(cls: string): ClassInfo {
    let candidates: ReturnType<DesignSystem['parseCandidate']>;
    try {
      candidates = this.ds.parseCandidate(cls);
    } catch {
      return { cls, status: 'unknown' };
    }
    for (const cand of candidates) {
      const bare = this.ds.printCandidate({ ...cand, variants: [] } as typeof cand);
      const utility = this.compileUtility(bare);
      if (!utility) {
        // Classe Tailwind válida mas cujo CSS o modelo não representa (::placeholder, @media...).
        const css = this.classCss(cls);
        if (css)
          return { cls, status: 'unsupported', reason: 'seletor ou regra sem equivalente no nó' };
        continue;
      }
      const mapped = variantsToState(cand.variants as readonly VariantNode[]);
      if ('reason' in mapped) return { cls, status: 'unsupported', reason: mapped.reason };
      let target = utility.target;
      if (mapped.children) {
        if (target !== 'self')
          return { cls, status: 'unsupported', reason: '"*:" em classe de filhos' };
        target = 'children';
      }
      if (target !== 'self' && mapped.state !== '') {
        return { cls, status: 'unsupported', reason: 'classe de filhos com estado' };
      }
      const order = this.ds.getClassOrder([cls])[0]?.[1] ?? null;
      return {
        cls,
        status: 'applied',
        state: mapped.state,
        target,
        utility,
        order: order ?? undefined,
      };
    }
    return { cls, status: 'unknown' };
  }

  inspect(classes: string): ClassInfo[] {
    const seen = new Set<string>();
    const out: ClassInfo[] = [];
    for (const cls of classes.split(/\s+/)) {
      if (!cls || seen.has(cls)) continue;
      seen.add(cls);
      out.push(this.info(cls));
    }
    return out;
  }

  classCss(cls: string): string | null {
    try {
      return this.ds.candidatesToCss([cls])[0] ?? null;
    } catch {
      return null;
    }
  }

  isTailwindClass(cls: string): boolean {
    return this.info(cls).status !== 'unknown';
  }

  /* ---------- classes → estilos ---------- */

  classesToStyles(classes: string): TailwindStyles {
    const infos = this.inspect(classes);
    const applied = infos.filter((i) => i.status === 'applied');
    const result: TailwindStyles = {
      style: {},
      states: {},
      applied: applied.map((i) => i.cls),
      unknown: infos.filter((i) => i.status === 'unknown').map((i) => i.cls),
      unsupported: infos
        .filter((i) => i.status === 'unsupported')
        .map((i) => ({ cls: i.cls, reason: i.reason ?? '' })),
    };
    const byOrder = (a: ClassInfo, b: ClassInfo): number => {
      const x = a.order ?? 0n;
      const y = b.order ?? 0n;
      return x < y ? -1 : x > y ? 1 : 0;
    };
    const groups = new Map<string, ClassInfo[]>();
    for (const i of applied) {
      const key = i.target === 'self' ? `self|${i.state}` : i.target!;
      const g = groups.get(key) ?? [];
      g.push(i);
      groups.set(key, g);
    }
    for (const g of groups.values()) g.sort(byOrder);

    const base = groups.get('self|') ?? [];
    const baseBucket = bucketOf(base);
    result.style = resolveBucket(baseBucket);
    const stateKeys = [...groups.keys()]
      .filter((k) => k.startsWith('self|') && k !== 'self|')
      .map((k) => k.slice(5));
    for (const state of sortStateKeys(stateKeys)) {
      const own = bucketOf(groups.get(`self|${state}`)!);
      const merged: Bucket = {
        decls: { ...baseBucket.decls, ...own.decls },
        vars: { ...baseBucket.vars, ...own.vars },
        initials: { ...baseBucket.initials, ...own.initials },
      };
      const resolved = resolveBucket(merged);
      const delta: Record<string, string> = {};
      for (const [p, v] of Object.entries(resolved)) {
        if (Object.hasOwn(own.decls, p) || result.style[p] !== v) delta[p] = v;
      }
      if (Object.keys(delta).length > 0) result.states[state] = delta;
    }
    const all = groups.get('children');
    const notLast = groups.get('children-not-last');
    if (all || notLast) {
      result.children = {};
      if (all) result.children.all = resolveBucket(bucketOf(all));
      if (notLast) result.children.notLast = resolveBucket(bucketOf(notLast));
    }
    return result;
  }

  /* ---------- estilos → classes ---------- */

  canonicalize(classes: string[]): string[] {
    if (classes.length === 0) return [];
    try {
      return this.canon.canonicalizeCandidates(classes, { rem: 16, collapse: true });
    } catch {
      return classes;
    }
  }

  /**
   * Propriedades que a classe afeta: as próprias declarações e as declarações das classes vizinhas
   * (`peers`, mesmo estado) que usam, direta ou indiretamente, as variáveis `--tw-*` que ela define
   * (ex.: `from-red-500` afeta o `background-image` de `bg-linear-to-r`).
   */
  private propsOf(info: ClassInfo, peers: ClassInfo[]): string[] {
    const u = info.utility;
    if (!u) return [];
    const props = new Set(u.decls.map((d) => d.prop));
    const touched = new Set(Object.keys(u.vars));
    if (touched.size === 0) return [...props];
    const refs = (value: string): boolean => [...touched].some((v) => value.includes(v));
    const varRaw: [string, string][] = [];
    for (const p of peers) for (const e of Object.entries(p.utility?.vars ?? {})) varRaw.push(e);
    for (let changed = true; changed;) {
      changed = false;
      for (const [name, value] of varRaw) {
        if (!touched.has(name) && refs(value)) {
          touched.add(name);
          changed = true;
        }
      }
    }
    for (const p of peers)
      for (const d of p.utility?.decls ?? []) if (refs(d.value)) props.add(d.prop);
    return [...props];
  }

  /** Estilo que um conjunto de classes (sem variantes) produz, com a neutralização de `text-*`. */
  private produced(classes: string[], opts: StylesToClassesOptions): Record<string, string> {
    const r = this.classesToStyles(classes.join(' '));
    const style = { ...r.style };
    if (opts.neutralLeading?.size) {
      for (const cls of classes) {
        const m = /^text-([a-z0-9]+)$/.exec(cls);
        if (m && opts.neutralLeading.has(m[1]) && !classes.some((c) => c.startsWith('leading-'))) {
          delete style['line-height'];
        }
      }
    }
    return style;
  }

  stylesToClasses(
    style: Record<string, string>,
    opts: StylesToClassesOptions = {},
  ): { classes: string[]; rest: Record<string, string> } {
    const mapped = cssToTailwind(style, { tokens: this.tokens });
    const target: Record<string, string> = {};
    for (const [k, v] of Object.entries(style)) if (!Object.hasOwn(mapped.rest, k)) target[k] = v;
    let classes = this.canonicalize(mapped.classes);
    if (!this.matches(classes, target, opts)) {
      if (this.matches(mapped.classes, target, opts)) classes = mapped.classes;
      else classes = this.repair(classes, target, opts);
    }
    return { classes: this.dropRedundant(classes, target, opts), rest: mapped.rest };
  }

  /** As classes produzem exatamente `target` (mesmas propriedades e valores comparáveis)? */
  private matches(
    classes: string[],
    target: Record<string, string>,
    opts: StylesToClassesOptions,
  ): boolean {
    return this.mismatched(classes, target, opts).size === 0;
  }

  private mismatched(
    classes: string[],
    target: Record<string, string>,
    opts: StylesToClassesOptions,
  ): Set<string> {
    const got = this.produced(classes, opts);
    const bad = new Set<string>();
    for (const p of new Set([...Object.keys(target), ...Object.keys(got)])) {
      const a = target[p];
      const b = got[p];
      if (a === undefined || b === undefined || comparableCss(a) !== comparableCss(b)) bad.add(p);
    }
    // Classes que o Tailwind não reconhece não produzem nada: também são problema.
    for (const c of classes) if (this.info(c).status !== 'applied') bad.add(`?${c}`);
    return bad;
  }

  /** Remove classes que não fazem falta (ex.: `border-solid` junto de `border`). */
  private dropRedundant(
    classes: string[],
    target: Record<string, string>,
    opts: StylesToClassesOptions,
  ): string[] {
    if (classes.length < 2 || !this.matches(classes, target, opts)) return classes;
    let cur = classes;
    for (const c of classes) {
      const without = cur.filter((x) => x !== c);
      if (without.length > 0 && this.matches(without, target, opts)) cur = without;
    }
    return cur;
  }

  /** Troca por `[prop:valor]` as classes que não reproduzem o estilo. */
  private repair(
    classes: string[],
    target: Record<string, string>,
    opts: StylesToClassesOptions,
  ): string[] {
    const bad = this.mismatched(classes, target, opts);
    const kept: string[] = [];
    const lost = new Set<string>();
    const peers = classes.map((c) => this.info(c));
    for (const info of peers) {
      const c = info.cls;
      const props = this.propsOf(info, peers);
      if (info.status !== 'applied' || props.some((p) => bad.has(p))) {
        for (const p of props) lost.add(p);
        continue;
      }
      kept.push(c);
    }
    for (const p of bad) if (!p.startsWith('?')) lost.add(p);
    const out = [...kept];
    for (const p of lost) {
      const v = target[p];
      if (v === undefined) continue;
      const a = arbitrary(p, v);
      if (a) out.push(a);
    }
    return out;
  }

  nodeClasses(
    node: Node,
    opts: StylesToClassesOptions = {},
  ): { classes: string[]; rest: Record<string, string> } {
    const buckets: [string, Record<string, string>][] = [['', node.style]];
    for (const k of sortStateKeys(Object.keys(node.states ?? {})))
      buckets.push([k, node.states![k]]);
    const hint = node.classes ? this.inspect(node.classes) : [];
    const expected = node.classes ? this.classesToStyles(node.classes) : null;
    const out: string[] = [];
    const rest: Record<string, string> = {};

    // Classes que o modelo não representa (ou que não são Tailwind) seguem como estão.
    // As de filhos (`space-y-2`, `*:p-2`) não: o estilo já está nos filhos.
    const keepVerbatim = new Set(hint.filter((i) => i.status !== 'applied').map((i) => i.cls));

    const keptByState = new Map<string, Set<string>>();
    for (const [state, current] of buckets) {
      const exp =
        state === ''
          ? (expected?.style ?? {})
          : { ...(expected?.style ?? {}), ...(expected?.states[state] ?? {}) };
      const cur = state === '' ? current : { ...node.style, ...current };
      const covered = new Set<string>();
      const kept = new Set<string>();
      const peers = hint.filter(
        (i) =>
          i.status === 'applied' && i.target === 'self' && (i.state === state || i.state === ''),
      );
      for (const info of hint) {
        if (info.status !== 'applied' || info.target !== 'self' || info.state !== state) continue;
        const props = this.propsOf(info, peers);
        const ok =
          props.length > 0 &&
          props.every(
            (p) =>
              cur[p] !== undefined &&
              exp[p] !== undefined &&
              comparableCss(cur[p]) === comparableCss(exp[p]),
          );
        if (ok) {
          kept.add(info.cls);
          for (const p of props) if (Object.hasOwn(current, p) || state === '') covered.add(p);
        }
      }
      keptByState.set(state, kept);
      const remaining: Record<string, string> = {};
      for (const [p, v] of Object.entries(current)) if (!covered.has(p)) remaining[p] = v;
      const gen = Object.keys(remaining).length
        ? this.stylesToClasses(remaining, opts)
        : { classes: [], rest: {} };
      const prefix = state ? `${state}:` : '';
      const generated = gen.classes.map((c) => prefix + c);
      if (state === '') Object.assign(rest, gen.rest);
      for (const c of generated) if (!kept.has(c)) kept.add(c);
    }

    // Ordem: as classes do autor na ordem original, depois as geradas.
    const all = new Set<string>();
    for (const info of hint) {
      if (keepVerbatim.has(info.cls) || keptByState.get(info.state ?? '')?.has(info.cls)) {
        all.add(info.cls);
      }
    }
    for (const kept of keptByState.values()) for (const c of kept) all.add(c);
    out.push(...all);
    return { classes: out, rest };
  }

  /* ---------- autocomplete ---------- */

  classList(): string[] {
    if (!this.list) {
      const names: string[] = [];
      for (const [name] of this.ds.getClassList()) names.push(name);
      this.list = names;
    }
    return this.list;
  }

  suggest(query: string, limit = 30): string[] {
    const q = query.trim();
    const cut = q.lastIndexOf(':');
    const prefix = cut === -1 ? '' : q.slice(0, cut + 1);
    const term = cut === -1 ? q : q.slice(cut + 1);
    const out: string[] = [];
    const seen = new Set<string>();
    const add = (c: string): void => {
      if (out.length < limit && !seen.has(c)) {
        seen.add(c);
        out.push(prefix + c);
      }
    };
    for (const c of POPULAR) if (c.startsWith(term)) add(c);
    const list = this.classList();
    for (const c of list) if (c.startsWith(term) && !c.startsWith('-')) add(c);
    if (term) for (const c of list) if (c.includes(term)) add(c);
    return out;
  }
}

/* ====================================================================== */
/* Buckets                                                                  */
/* ====================================================================== */

interface Bucket {
  decls: Record<string, Decl>;
  vars: Record<string, string>;
  initials: Record<string, string>;
}

function bucketOf(infos: ClassInfo[]): Bucket {
  const b: Bucket = { decls: {}, vars: {}, initials: {} };
  for (const i of infos) {
    const u = i.utility!;
    Object.assign(b.initials, u.initials);
    Object.assign(b.vars, u.vars);
    for (const d of u.decls) {
      const prev = b.decls[d.prop];
      // `!important` vence declarações comuns, como na cascata.
      if (prev && prev.important && !d.important) continue;
      // Mantém a ordem de inserção da cascata: reinsere no fim.
      delete b.decls[d.prop];
      b.decls[d.prop] = d;
    }
  }
  return b;
}

function resolveBucket(b: Bucket): Record<string, string> {
  const out: Record<string, string> = {};
  for (const d of Object.values(b.decls)) {
    const v = finalizeValue(d.prop, d.value, b.vars, b.initials);
    if (v === null) continue;
    out[d.prop] = d.important ? `${v} !important` : v;
  }
  return out;
}

/** Alvo de um seletor gerado para a classe sem variantes; `null` se não representável. */
function selectorTarget(selector: string): Target | null {
  const plain = selector.replace(/\\./g, 'x');
  if (/^\.[^\s>+~:[\]()*,]+$/.test(plain)) return 'self';
  if (/^:where\(\.[^\s>]+ > :not\(:last-child\)\)$/.test(plain)) return 'children-not-last';
  return null;
}

/** `[prop:valor]` seguro (espaços viram `_`); `null` se o valor não cabe numa classe. */
function arbitrary(prop: string, value: string): string | null {
  let v = value.trim();
  const important = /\s*!important$/.test(v);
  if (important) v = v.replace(/\s*!important$/, '');
  if (!isValidCssPropertyName(prop) || v === '' || /[{};<>`\n\r"]/.test(v)) return null;
  const esc = v
    .replace(/\s*,\s*/g, ',')
    .replace(/_/g, '\\_')
    .replace(/\s+/g, '_');
  return `[${prop}:${esc}]${important ? '!' : ''}`;
}
