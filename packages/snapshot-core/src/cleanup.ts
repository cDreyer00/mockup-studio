/**
 * Post-import simplification (pure, no DOM and no Node): computes the ops that clean up an imported
 * frame. Used by the MCP tool `cleanup_imported` and by the editor button (same logic).
 *
 * Conservative rules: when in doubt, the node stays as it is. Each step is simulated with the core's
 * `applyOp` on a document reduced to the subtree, so the ops come out consistent in sequence (ids and indexes).
 */
import { applyOp, findNode } from '@mockup/core';
import type { Document, Node, Op } from '@mockup/core';

export interface CleanupOptions {
  /** Removes empty wrappers (no children, no text and no visual style). Default true. */
  removeEmpty?: boolean;
  /** Unwraps wrappers with no visual style that have a single child. Default true. */
  unwrap?: boolean;
  /**
   * Fluid sizes: a `width` in px equal to the parent's content width becomes auto/fill and a `height`
   * in px on nodes with content becomes `min-height` (the content may grow). Default true.
   */
  fluid?: boolean;
}

export interface CleanupPlan {
  /** Ops in application order (a single history entry). */
  ops: Op[];
  removed: number;
  unwrapped: number;
  /** Size properties converted. */
  fluid: number;
}

/** Container tags "with no visual meaning of their own" (candidates for removal/unwrapping). */
const GENERIC_TAGS = new Set([
  'div',
  'span',
  'section',
  'article',
  'header',
  'footer',
  'nav',
  'main',
  'aside',
  'figure',
  'figcaption',
  'li',
  'ul',
  'ol',
]);

/** Replaced elements/controls: the automatic size is not equivalent to the declared px. */
const REPLACED_TAGS = new Set([
  'img',
  'svg',
  'video',
  'canvas',
  'iframe',
  'object',
  'embed',
  'audio',
  'input',
  'textarea',
  'select',
  'button',
  'meter',
  'progress',
  'table',
]);

/** Inline-by-default tags: `width`/`height` do not apply to them without an explicit `display`. */
const INLINE_TAGS = new Set([
  'span',
  'a',
  'em',
  'strong',
  'b',
  'i',
  'u',
  'small',
  'code',
  'label',
  'abbr',
  'sub',
  'sup',
  'mark',
  'cite',
  'q',
  's',
  'time',
]);

const BORDER_STYLES = new Set([
  'solid',
  'dashed',
  'dotted',
  'double',
  'groove',
  'ridge',
  'inset',
  'outset',
]);

const EMPTY_VALUES = new Set(['', '0', '0px', '0%', 'none', 'auto', 'initial', 'unset', 'normal']);

const norm = (v: string | undefined): string => (v ?? '').trim().toLowerCase();

function hasText(n: Node): boolean {
  return typeof n.text === 'string' && n.text.trim() !== '';
}

/** Number in px of a value like `24px` or `24`; `null` for other units/expressions. */
function px(v: string | undefined): number | null {
  const m = /^(-?\d*\.?\d+)(px)?$/.exec(norm(v));
  return m ? parseFloat(m[1]!) : null;
}

/** Size value that takes up space (anything other than auto/0/none; expressions count). */
function sizePositive(v: string | undefined): boolean {
  return !EMPTY_VALUES.has(norm(v));
}

function isZeroToken(t: string): boolean {
  return /^[+-]?0*\.?0+(px|em|rem|%)?$/.test(t);
}

/** `0`, `0 0`, `0px 0px 0px 0px`... (and `auto` does not count as zero). */
function allZero(v: string | undefined): boolean {
  const tokens = norm(v).split(/\s+/).filter(Boolean);
  return tokens.length === 0 || tokens.every(isZeroToken);
}

function borderVisible(prop: string, value: string): boolean {
  const v = norm(value);
  if (/(^|-)(style|color|radius|image|collapse|spacing)(-|$)/.test(prop.replace(/^border-?/, '')))
    return false;
  const tokens = v.split(/\s+/).filter(Boolean);
  if (/(^|-)width$/.test(prop)) return !tokens.every(isZeroToken);
  if (tokens.includes('none') || tokens.includes('hidden')) return false;
  if (!tokens.some((t) => BORDER_STYLES.has(t))) return false;
  const length = tokens.find((t) => /^[+-]?\d*\.?\d+(px|em|rem)?$/.test(t));
  return length === undefined || !isZeroToken(length);
}

/** Does the node have a style that gives it visual presence or takes up space (even without content)? */
function hasPresence(n: Node): boolean {
  for (const [rawKey, value] of Object.entries(n.style)) {
    const k = rawKey.toLowerCase();
    const v = norm(value);
    if (k === 'width' || k === 'height' || k.startsWith('min-') || k === 'flex-basis') {
      if (sizePositive(value)) return true;
    } else if (k === 'flex-grow') {
      if (parseFloat(v) > 0) return true;
    } else if (k === 'flex') {
      if (v !== 'none' && !/^0(\s|$)/.test(v) && v !== 'initial') return true;
    } else if (k === 'aspect-ratio') {
      if (v !== 'auto') return true;
    } else if (k.startsWith('padding') || k.startsWith('margin')) {
      if (!allZero(value)) return true;
    } else if (k.startsWith('background')) {
      if (
        !['none', 'transparent', 'initial', 'unset', '', 'rgba(0,0,0,0)'].includes(
          v.replace(/\s/g, ''),
        )
      )
        return true;
    } else if (k.startsWith('border')) {
      if (borderVisible(k, value)) return true;
    } else if (k === 'box-shadow') {
      if (v !== 'none' && v !== '') return true;
    } else if (k.startsWith('outline')) {
      if (!['none', '0', '0px', 'hidden', 'initial', ''].includes(v)) return true;
    }
  }
  return false;
}

function isGeneric(n: Node): boolean {
  return n.type === 'element' && GENERIC_TAGS.has(n.tag) && !n.locked;
}

/** Subtree as a minimal document (the root becomes a page's frame): simulates the ops without cloning everything. */
function subDocument(doc: Document, root: Node): Document {
  return {
    ...doc,
    pages: [{ id: 'cleanup', name: 'cleanup', background: '#fff', frames: [root] }],
    tokens: {},
    fonts: [],
  };
}

function preOrder(root: Node, visit: (n: Node, parent: Node | null) => void): void {
  const go = (n: Node, parent: Node | null): void => {
    visit(n, parent);
    for (const c of n.children) go(c, n);
  };
  go(root, null);
}

/* ---------------- removeEmpty ---------------- */

function planRemoveEmpty(root: Node): { ids: string[]; removed: number } {
  const removed = new Set<string>();
  const topmost: string[] = [];
  const visit = (n: Node, isRoot: boolean): boolean => {
    const childrenGone = n.children.map((c) => visit(c, false));
    if (isRoot) return false;
    const allGone = childrenGone.every(Boolean);
    const gone = isGeneric(n) && !hasText(n) && allGone && !hasPresence(n);
    if (gone) removed.add(n.id);
    return gone;
  };
  visit(root, true);
  const collect = (n: Node, parentGone: boolean): void => {
    const gone = removed.has(n.id);
    if (gone && !parentGone) topmost.push(n.id);
    for (const c of n.children) collect(c, gone || parentGone);
  };
  collect(root, false);
  return { ids: topmost, removed: removed.size };
}

/* ---------------- unwrap ---------------- */

const NEUTRAL_KEYS_OK = new Set(['box-sizing']);

function isNeutralWrapper(w: Node, child: Node): boolean {
  if (!isGeneric(w) || w.hidden || hasText(w) || w.children.length !== 1) return false;
  if (Object.keys(w.attrs).some((a) => !a.startsWith('data-'))) return false;
  for (const [rawKey, value] of Object.entries(w.style)) {
    const k = rawKey.toLowerCase();
    const v = norm(value);
    if (NEUTRAL_KEYS_OK.has(k)) continue;
    if (k === 'display') {
      if (v !== 'block' && v !== '') return false;
    } else if (k === 'position') {
      if (v !== 'static' && v !== '') return false;
    } else if (k === 'margin' || k.startsWith('margin-')) {
      if (!allZero(value)) return false;
    } else if (k === 'width' || k === 'height') {
      if (v !== 'auto' && v !== '' && v !== norm(child.style[k])) return false;
    } else {
      return false;
    }
  }
  return true;
}

function planUnwrap(simRoot: Node, ops: Op[], sim: { doc: Document }): number {
  const candidates: string[] = [];
  preOrder(simRoot, (n, parent) => {
    if (parent && n.children.length === 1 && isNeutralWrapper(n, n.children[0]!))
      candidates.push(n.id);
  });
  let count = 0;
  for (const id of candidates) {
    const p = findNode(sim.doc, id);
    if (!p || !p.parent || p.node.children.length !== 1) continue;
    const child = p.node.children[0]!;
    const move: Op = {
      type: 'moveNodes',
      nodeIds: [child.id],
      parentId: p.parent.id,
      index: p.index,
    };
    const del: Op = { type: 'deleteNodes', nodeIds: [id] };
    try {
      sim.doc = applyOp(applyOp(sim.doc, move).doc, del).doc;
    } catch {
      continue;
    }
    ops.push(move, del);
    count++;
  }
  return count;
}

/* ---------------- fluid ---------------- */

/** Horizontal sum (left + right) of `padding`/`border-width` in px; `null` if it cannot be computed. */
function horizontalPx(s: Record<string, string>, base: 'padding' | 'border'): number | null {
  const edge = (side: 'left' | 'right'): number | null => {
    const long = base === 'padding' ? `padding-${side}` : `border-${side}-width`;
    if (s[long] !== undefined) return px(s[long]);
    if (base === 'padding' && s.padding !== undefined) {
      const t = norm(s.padding).split(/\s+/);
      const pick = t.length === 1 ? t[0] : t.length === 2 ? t[1] : side === 'right' ? t[1] : t[3];
      return px(pick);
    }
    if (base === 'border') {
      const w = s['border-width'];
      if (w !== undefined) {
        const t = norm(w).split(/\s+/);
        const pick = t.length === 1 ? t[0] : t.length === 2 ? t[1] : side === 'right' ? t[1] : t[3];
        return px(pick);
      }
      const short = s[`border-${side}`] ?? s.border;
      if (short === undefined) return 0;
      const tokens = norm(short).split(/\s+/);
      if (
        tokens.includes('none') ||
        tokens.includes('hidden') ||
        !tokens.some((t) => BORDER_STYLES.has(t))
      )
        return 0;
      const len = tokens.find((t) => /^[+-]?\d*\.?\d+(px)?$/.test(t));
      return len === undefined ? null : px(len);
    }
    return 0;
  };
  const l = edge('left');
  const r = edge('right');
  return l === null || r === null ? null : l + r;
}

/** Parent content width in px (`null` if it cannot be computed from the style alone). */
function contentWidth(p: Node): number | null {
  const w = px(p.style.width);
  if (w === null) return null;
  if (norm(p.style['box-sizing']) === 'content-box') return w;
  const pad = horizontalPx(p.style, 'padding');
  const bor = horizontalPx(p.style, 'border');
  return pad === null || bor === null ? null : w - pad - bor;
}

type ParentFlow = 'block' | 'column-stretch' | 'column-other' | null;

function parentFlow(p: Node): ParentFlow {
  const d = norm(p.style.display);
  if (d === 'flex' || d === 'inline-flex') {
    if (!norm(p.style['flex-direction']).startsWith('column')) return null;
    if (norm(p.style['flex-wrap']).startsWith('wrap')) return null;
    const a = norm(p.style['align-items']);
    return a === '' || a === 'normal' || a === 'stretch' ? 'column-stretch' : 'column-other';
  }
  if (d === 'block' || d === 'flow-root') return 'block';
  if (d === '' && !INLINE_TAGS.has(p.tag) && !REPLACED_TAGS.has(p.tag)) return 'block';
  return null;
}

function isInlineLike(n: Node): boolean {
  const d = norm(n.style.display);
  if (d === '') return INLINE_TAGS.has(n.tag);
  return d === 'inline' || d.startsWith('inline-') || d === 'contents' || d === 'none';
}

function planFluid(simRoot: Node): {
  changes: { nodeId: string; set?: Record<string, string>; unset?: string[] }[];
  count: number;
} {
  const changes: { nodeId: string; set?: Record<string, string>; unset?: string[] }[] = [];
  let count = 0;
  preOrder(simRoot, (n, parent) => {
    if (!parent) return;
    const set: Record<string, string> = {};
    const unset: string[] = [];
    const pos = norm(n.style.position);
    const out = pos === 'absolute' || pos === 'fixed';

    const w = px(n.style.width);
    if (
      w !== null &&
      !out &&
      !REPLACED_TAGS.has(n.tag) &&
      !isInlineLike(n) &&
      norm(n.style.float) === ''
    ) {
      const flow = parentFlow(parent);
      const cw = flow ? contentWidth(parent) : null;
      const selfAlign = norm(n.style['align-self']);
      if (
        flow &&
        cw !== null &&
        Math.abs(w - cw) <= 0.5 &&
        norm(n.style['box-sizing']) !== 'content-box' &&
        horizontalMargin(n.style) === 0 &&
        (flow !== 'column-other' ||
          selfAlign === '' ||
          selfAlign === 'auto' ||
          selfAlign === 'stretch')
      ) {
        unset.push('width');
        if (flow === 'column-other' && selfAlign !== 'stretch') set['align-self'] = 'stretch';
        count++;
      }
    }

    const h = px(n.style.height);
    if (
      h !== null &&
      (n.children.length > 0 || hasText(n)) &&
      !REPLACED_TAGS.has(n.tag) &&
      !isInlineLike(n) &&
      ['', 'visible'].includes(norm(n.style.overflow)) &&
      ['', 'visible'].includes(norm(n.style['overflow-x'])) &&
      ['', 'visible'].includes(norm(n.style['overflow-y'])) &&
      !('-webkit-line-clamp' in n.style) &&
      !('line-clamp' in n.style) &&
      norm(n.style['aspect-ratio']) === ''
    ) {
      // The capture already omits heights equivalent to auto: the px left over is visual. It becomes `min-height`
      // (same size, but the content may grow) instead of vanishing and shrinking the section.
      unset.push('height');
      const minH = px(n.style['min-height']);
      if (minH === null || minH < h) set['min-height'] = n.style.height!;
      count++;
    }

    if (unset.length > 0 || Object.keys(set).length > 0) {
      changes.push({
        nodeId: n.id,
        ...(Object.keys(set).length ? { set } : {}),
        ...(unset.length ? { unset } : {}),
      });
    }
  });
  return { changes, count };
}

function horizontalMargin(s: Record<string, string>): number {
  // 0 when the side margins are zero/absent; 1 when a margin exists (or `auto`).
  for (const k of ['margin', 'margin-left', 'margin-right']) {
    if (s[k] === undefined) continue;
    if (k === 'margin') {
      const t = norm(s[k]).split(/\s+/);
      const sides = t.length === 1 ? [t[0]] : t.length === 2 ? [t[1], t[1]] : [t[1], t[3] ?? t[1]];
      if (!sides.every((x) => x !== undefined && isZeroToken(x))) return 1;
    } else if (!allZero(s[k])) return 1;
  }
  return 0;
}

/** Computes the cleanup of the subtree of `nodeId` (the node itself is never removed). */
export function planCleanup(doc: Document, nodeId: string, opts: CleanupOptions = {}): CleanupPlan {
  const found = findNode(doc, nodeId);
  if (!found) throw new Error(`Node not found: "${nodeId}"`);
  const plan: CleanupPlan = { ops: [], removed: 0, unwrapped: 0, fluid: 0 };
  const sim = { doc: subDocument(doc, JSON.parse(JSON.stringify(found.node)) as Node) };
  const rootOf = (): Node => sim.doc.pages[0]!.frames[0]!;

  // Each step can enable the next (dropping a width makes the wrapper neutral, removing a
  // child leaves the parent empty): repeat until nothing changes (a few rounds are enough).
  for (let round = 0; round < 6; round++) {
    const before = plan.ops.length;

    if (opts.removeEmpty ?? true) {
      const { ids, removed } = planRemoveEmpty(rootOf());
      if (ids.length > 0) {
        const op: Op = { type: 'deleteNodes', nodeIds: ids };
        sim.doc = applyOp(sim.doc, op).doc;
        plan.ops.push(op);
        plan.removed += removed;
      }
    }

    if (opts.unwrap ?? true) {
      plan.unwrapped += planUnwrap(rootOf(), plan.ops, sim);
    }

    if (opts.fluid ?? true) {
      const { changes, count } = planFluid(rootOf());
      if (changes.length > 0) {
        const op: Op = { type: 'updateStyles', changes };
        sim.doc = applyOp(sim.doc, op).doc;
        plan.ops.push(op);
        plan.fluid += count;
      }
    }

    if (plan.ops.length === before) break;
  }

  return plan;
}
