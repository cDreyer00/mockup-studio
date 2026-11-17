/**
 * Aplicação das classes Tailwind nos nós: import de HTML (`write_html`, colar), `set_classes` e
 * detecção automática de markup Tailwind.
 */
import { walk } from '../document.js';
import type { Op } from '../ops.js';
import { normalizeStyles } from '../styles.js';
import type { Node } from '../types.js';
import type { TailwindEngine, TailwindStyles } from './engine.js';

export interface TailwindReport {
  /** Nós com classes Tailwind aplicadas. */
  nodes: number;
  /** Classes que o Tailwind não reconhece (ficam só em `node.classes`). */
  unknown: string[];
  /** Classes Tailwind sem equivalente no modelo, com o motivo (ficam só em `node.classes`). */
  unsupported: { cls: string; reason: string }[];
}

const BORDER_WIDTH_RE =
  /^border(?:-(?:top|right|bottom|left|inline|block)(?:-start|-end)?)?-width$/;
const BORDER_COLOR_RE =
  /^border(?:-(?:top|right|bottom|left|inline|block)(?:-start|-end)?)?-color$/;

function hasBorderWithoutColor(style: Record<string, string>): boolean {
  const keys = Object.keys(style);
  return (
    keys.some((k) => BORDER_WIDTH_RE.test(k) && !/^0(px)?$/.test(style[k].trim())) &&
    !keys.some((k) => BORDER_COLOR_RE.test(k) || k === 'border')
  );
}

function mergeReport(into: TailwindReport, r: TailwindStyles): void {
  for (const u of r.unknown) if (!into.unknown.includes(u)) into.unknown.push(u);
  for (const u of r.unsupported) {
    if (!into.unsupported.some((x) => x.cls === u.cls)) into.unsupported.push(u);
  }
}

export interface ApplyTailwindOptions {
  /**
   * Cor de borda padrão para nós com largura de borda e sem cor (o shadcn usa
   * `* { border-color: var(--color-border) }`). Ausente: cor atual do texto, como no preflight.
   */
  defaultBorderColor?: string;
}

/**
 * Compila `node.classes` de cada nó da árvore (criada por `htmlToNodes` com `keepClasses`) e
 * aplica em `style`/`states`. O CSS escrito no HTML (`style=""` e regras do `<style>`) vence as
 * classes, como no navegador; classes de filhos (`space-y-2`, `*:p-2`) vão para os filhos, abaixo
 * das classes deles.
 */
export function applyTailwindToNodes(
  nodes: Node[],
  engine: TailwindEngine,
  opts: ApplyTailwindOptions = {},
): TailwindReport {
  const report: TailwindReport = { nodes: 0, unknown: [], unsupported: [] };
  const visit = (node: Node, inherited: Record<string, string>): void => {
    let childAll: Record<string, string> = {};
    let childNotLast: Record<string, string> = {};
    if (node.classes) {
      const r = engine.classesToStyles(node.classes);
      mergeReport(report, r);
      if (r.applied.length > 0) report.nodes++;
      node.style = normalizeStyles({ ...inherited, ...r.style, ...node.style });
      const states: Record<string, Record<string, string>> = {};
      for (const [k, v] of Object.entries(r.states))
        states[k] = { ...v, ...(node.states?.[k] ?? {}) };
      for (const [k, v] of Object.entries(node.states ?? {})) states[k] ??= v;
      if (Object.keys(states).length > 0) node.states = states;
      childAll = r.children?.all ?? {};
      childNotLast = r.children?.notLast ?? {};
    } else if (Object.keys(inherited).length > 0) {
      node.style = normalizeStyles({ ...inherited, ...node.style });
    }
    if (opts.defaultBorderColor && hasBorderWithoutColor(node.style)) {
      node.style = { ...node.style, 'border-color': opts.defaultBorderColor };
    }
    node.children.forEach((child, i) => {
      const last = i === node.children.length - 1;
      visit(child, { ...childAll, ...(last ? {} : childNotLast) });
    });
  };
  for (const n of nodes) visit(n, {});
  return report;
}

/** Classes que aparecem num HTML (`class="..."`). */
export function htmlClasses(html: string): string[] {
  const out = new Set<string>();
  const re = /\bclass\s*=\s*("([^"]*)"|'([^']*)')/gi;
  for (let m = re.exec(html); m; m = re.exec(html)) {
    for (const c of (m[2] ?? m[3] ?? '').split(/\s+/)) if (c) out.add(c);
  }
  return [...out];
}

/** Classes usadas como seletor num CSS (`.hero`, `.card > h3`). */
function cssClassSelectors(css: string): Set<string> {
  const out = new Set<string>();
  const re = /\.(-?[_a-zA-Z][_a-zA-Z0-9-]*)/g;
  const noBlocks = css.replace(/\{[^}]*\}/g, '{}');
  for (let m = re.exec(noBlocks); m; m = re.exec(noBlocks)) out.add(m[1]);
  return out;
}

export interface TailwindDetection {
  /** O HTML parece Tailwind (maioria das classes sem regra no CSS é Tailwind). */
  tailwind: boolean;
  /** Classes Tailwind encontradas. */
  classes: string[];
  /** Total de classes consideradas (sem regra no CSS). */
  total: number;
}

/**
 * Detecta markup Tailwind: há classes que o Tailwind reconhece e elas são ao menos metade das
 * classes que não têm regra no CSS informado (no `<style>` do HTML ou no parâmetro `css`).
 */
export function detectTailwind(html: string, engine: TailwindEngine, css = ''): TailwindDetection {
  const styleBlocks = [...html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)].map((m) => m[1]);
  const defined = cssClassSelectors([css, ...styleBlocks].join('\n'));
  const candidates = htmlClasses(html).filter((c) => !defined.has(c));
  const tw = candidates.filter((c) => engine.isTailwindClass(c));
  return {
    tailwind: tw.length > 0 && tw.length * 2 >= candidates.length,
    classes: tw,
    total: candidates.length,
  };
}

export type SetClassesMode = 'replace' | 'add' | 'remove';

function splitClasses(s: string | undefined): string[] {
  return (s ?? '').split(/\s+/).filter(Boolean);
}

/** Ops que levam `from` até `to` (set do que mudou, unset do que saiu). */
function styleDiff(
  nodeId: string,
  from: Record<string, string>,
  to: Record<string, string>,
): { nodeId: string; set?: Record<string, string>; unset?: string[] } | null {
  const set: Record<string, string> = {};
  const unset: string[] = [];
  for (const [k, v] of Object.entries(to)) if (from[k] !== v) set[k] = v;
  for (const k of Object.keys(from)) if (!(k in to)) unset.push(k);
  if (Object.keys(set).length === 0 && unset.length === 0) return null;
  const change: { nodeId: string; set?: Record<string, string>; unset?: string[] } = { nodeId };
  if (Object.keys(set).length > 0) change.set = set;
  if (unset.length > 0) change.unset = unset;
  return change;
}

/** Propriedades que as classes produzem (base e por estado). */
function producedProps(r: TailwindStyles): { base: Set<string>; states: Map<string, Set<string>> } {
  const states = new Map<string, Set<string>>();
  for (const [k, v] of Object.entries(r.states)) states.set(k, new Set(Object.keys(v)));
  return { base: new Set(Object.keys(r.style)), states };
}

export interface SetClassesPlan {
  ops: Op[];
  report: TailwindReport;
  /** Classes finais por nó. */
  classes: Record<string, string>;
}

/**
 * Planeja `set_classes`: classes → `style`, `states` e `node.classes` dos nós (um undo só).
 *
 * - `replace`: as classes passam a ser todo o estilo do nó (frames raiz mantêm `width`/`height`
 *   se as classes não definirem);
 * - `add`: acrescenta (classes antigas com as mesmas propriedades no mesmo estado saem);
 * - `remove`: tira as classes e as propriedades que só elas produziam.
 */
export function planSetClasses(
  nodes: { node: Node; root: boolean }[],
  classes: string,
  engine: TailwindEngine,
  mode: SetClassesMode = 'replace',
): SetClassesPlan {
  const report: TailwindReport = { nodes: 0, unknown: [], unsupported: [] };
  const styleChanges: NonNullable<ReturnType<typeof styleDiff>>[] = [];
  const statesChanges: { nodeId: string; states: Record<string, Record<string, string>> | null }[] =
    [];
  const classChanges: { nodeId: string; classes: string | null }[] = [];
  const finalClasses: Record<string, string> = {};
  const given = splitClasses(classes);

  for (const { node, root } of nodes) {
    const old = splitClasses(node.classes);
    let next: string[];
    let style: Record<string, string>;
    let states: Record<string, Record<string, string>>;
    const add = engine.classesToStyles(given.join(' '));
    mergeReport(report, add);

    if (mode === 'replace') {
      next = given;
      style = { ...add.style };
      states = { ...add.states };
      if (root) {
        for (const k of ['width', 'height', 'min-height'] as const) {
          if (style[k] === undefined && node.style[k] !== undefined) style[k] = node.style[k];
        }
      }
    } else if (mode === 'add') {
      const newProps = producedProps(add);
      const infos = engine.inspect(old.join(' '));
      const dropped = new Set<string>();
      for (const i of infos) {
        if (i.status !== 'applied' || i.target !== 'self') continue;
        const one = engine.classesToStyles(i.cls);
        const props = Object.keys(i.state === '' ? one.style : (one.states[i.state!] ?? {}));
        const set = i.state === '' ? newProps.base : newProps.states.get(i.state!);
        if (set && props.length > 0 && props.every((p) => set.has(p))) dropped.add(i.cls);
      }
      next = [...old.filter((c) => !dropped.has(c) && !given.includes(c)), ...given];
      style = { ...node.style, ...add.style };
      states = { ...(node.states ?? {}) };
      for (const [k, v] of Object.entries(add.states)) states[k] = { ...(states[k] ?? {}), ...v };
    } else {
      next = old.filter((c) => !given.includes(c));
      const removed = engine.classesToStyles(old.filter((c) => given.includes(c)).join(' '));
      const remaining = engine.classesToStyles(next.join(' '));
      style = { ...node.style };
      for (const p of Object.keys(removed.style)) {
        if (remaining.style[p] !== undefined) style[p] = remaining.style[p];
        else delete style[p];
      }
      states = {};
      for (const [k, v] of Object.entries(node.states ?? {})) {
        const st = { ...v };
        for (const p of Object.keys(removed.states[k] ?? {})) {
          const keep = remaining.states[k]?.[p];
          if (keep !== undefined) st[p] = keep;
          else delete st[p];
        }
        if (Object.keys(st).length > 0) states[k] = st;
      }
    }

    if (add.applied.length > 0) report.nodes++;
    const sd = styleDiff(node.id, node.style, normalizeStyles(style));
    if (sd) styleChanges.push(sd);
    if (JSON.stringify(states) !== JSON.stringify(node.states ?? {})) {
      statesChanges.push({ nodeId: node.id, states: Object.keys(states).length ? states : null });
    }
    const joined = next.join(' ');
    if (joined !== (node.classes ?? ''))
      classChanges.push({ nodeId: node.id, classes: joined || null });
    finalClasses[node.id] = joined;

    // Classes de filhos (`space-y-2`, `*:p-2`): ao acrescentar ou trocar, valem para os filhos.
    if (mode !== 'remove' && add.children) {
      node.children.forEach((child, i) => {
        const last = i === node.children.length - 1;
        const extra = {
          ...(add.children!.all ?? {}),
          ...(last ? {} : (add.children!.notLast ?? {})),
        };
        const cd = styleDiff(child.id, child.style, { ...child.style, ...extra });
        if (cd) styleChanges.push(cd);
      });
    }
  }
  const ops: Op[] = [];
  if (styleChanges.length > 0) ops.push({ type: 'updateStyles', changes: styleChanges });
  if (statesChanges.length > 0) ops.push({ type: 'setStates', changes: statesChanges });
  if (classChanges.length > 0) ops.push({ type: 'setClasses', changes: classChanges });
  return { ops, report, classes: finalClasses };
}

/** Nós da árvore que têm classes Tailwind (para relatórios). */
export function nodesWithClasses(root: Node | Node[]): Node[] {
  const out: Node[] = [];
  walk(root, (n) => {
    if (n.classes) out.push(n);
  });
  return out;
}
