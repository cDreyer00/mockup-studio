import { cssValueProblem } from '@mockup/core';
import type { AssetRegistry } from './assets.js';
import type { StyleRec } from './defaults.js';
import { CORNER_LIST, DIFF_PROPS, INHERITED_PROPS, SIDE_LIST } from './props.js';
import { splitTop } from './util.js';

export interface ReduceInput {
  /** Computed style of the element. */
  cur: StyleRec;
  /** Tag default (defaults iframe). */
  def: StyleRec;
  /** Computed style of the parent (`null` at the root). */
  parent: StyleRec | null;
  /** Computed style of the defaults iframe body (inheritance at the root). */
  body: StyleRec;
  isRoot: boolean;
  assets: AssetRegistry;
  /** Base to resolve relative `url()`s. */
  baseUrl: string;
  /** Side margins declared as `auto` (the computed value carries the used px). */
  autoMargin?: { left: boolean; right: boolean };
  /** Box size (to decide about `transform-origin`). */
  box?: { w: number; h: number };
}

/** 4-side CSS value in the shortest form (`a`, `a b`, `a b c`, `a b c d`). */
function collapse4(v: string[]): string {
  const [t, r, b, l] = v as [string, string, string, string];
  if (t === r && r === b && b === l) return t;
  if (t === b && r === l) return `${t} ${r}`;
  if (r === l) return `${t} ${r} ${b}`;
  return `${t} ${r} ${b} ${l}`;
}

/** Every layer in the list is the default (`auto, auto` vs `auto`). */
const allDefault = (value: string, def: string): boolean =>
  value === def || splitTop(value).every((p) => p === def);

function sideBorder(rec: StyleRec, s: string): string {
  const style = rec[`border-${s}-style`];
  if (!style || style === 'none' || style === 'hidden') return 'none';
  return `${rec[`border-${s}-width`]} ${style} ${rec[`border-${s}-color`]}`;
}

const num = (v: string | undefined): number => {
  const n = parseFloat(v ?? '');
  return Number.isFinite(n) ? n : 0;
};

/**
 * Reduces the computed style to the declarations the canvas would not reproduce on its own: non-inherited
 * ones only when they differ from the tag default; inherited ones, at the root, when they differ from the
 * defaults body and, on descendants, when they differ from what the canvas would already inherit (tag
 * override or parent value). Width, height and position are left to the caller (they depend on DOM measurements).
 */
export function reduceStyles(input: ReduceInput): Record<string, string> {
  const { cur, def, parent, body, isRoot } = input;
  const out: Record<string, string> = {};

  for (const p of DIFF_PROPS) {
    if (cur[p] !== def[p] && cur[p]) out[p] = cur[p]!;
  }

  // Inherited.
  for (const p of INHERITED_PROPS) {
    const expected = isRoot || !parent ? body[p] : def[p] !== body[p] ? def[p] : parent[p];
    if (cur[p] !== expected && cur[p]) out[p] = cur[p]!;
  }

  // Margins and paddings.
  const margins = SIDE_LIST.map((s) => cur[`margin-${s}`]!);
  if (input.autoMargin?.left) margins[3] = 'auto';
  if (input.autoMargin?.right) margins[1] = 'auto';
  box4(
    out,
    'margin',
    margins,
    SIDE_LIST.map((s) => def[`margin-${s}`]!),
  );
  box4(
    out,
    'padding',
    SIDE_LIST.map((s) => cur[`padding-${s}`]!),
    SIDE_LIST.map((s) => def[`padding-${s}`]!),
  );

  // Borders.
  const sides = SIDE_LIST.map((s) => ({ s, v: sideBorder(cur, s), d: sideBorder(def, s) }));
  const changed = sides.filter((x) => x.v !== x.d);
  if (changed.length === 4 && changed.every((x) => x.v === changed[0]!.v)) {
    out['border'] = changed[0]!.v;
  } else {
    for (const x of changed) out[`border-${x.s}`] = x.v;
  }

  // Radius.
  const radii = CORNER_LIST.map((c) => ({
    c,
    v: cur[`border-${c}-radius`]!,
    d: def[`border-${c}-radius`]!,
  }));
  const rChanged = radii.filter((x) => x.v !== x.d);
  if (rChanged.length > 0) {
    if (rChanged.length === 4 && rChanged.every((x) => x.v === rChanged[0]!.v)) {
      out['border-radius'] = rChanged[0]!.v;
    } else if (rChanged.length === 4 && radii.every((x) => !x.v.includes(' '))) {
      out['border-radius'] = radii.map((x) => x.v).join(' ');
    } else {
      for (const x of rChanged) out[`border-${x.c}-radius`] = x.v;
    }
  }

  // Overflow and gap.
  pair(
    out,
    'overflow',
    cur['overflow-x'],
    cur['overflow-y'],
    def['overflow-x'],
    def['overflow-y'],
    'overflow-x',
    'overflow-y',
  );
  pair(
    out,
    'gap',
    cur['row-gap'],
    cur['column-gap'],
    def['row-gap'],
    def['column-gap'],
    'row-gap',
    'column-gap',
  );

  // min/max: px values of content-box boxes are converted to border-box (the canvas uses border-box).
  const contentBox = cur['box-sizing'] === 'content-box';
  for (const p of ['min-width', 'min-height', 'max-width', 'max-height']) {
    let v = cur[p];
    if (!v || v === def[p] || v === 'auto' || v === 'none') continue;
    if (contentBox && /^-?[\d.]+px$/.test(v)) {
      const horizontal = p.endsWith('width');
      const extra = horizontal
        ? num(cur['padding-left']) +
          num(cur['padding-right']) +
          (sideBorder(cur, 'left') === 'none' ? 0 : num(cur['border-left-width'])) +
          (sideBorder(cur, 'right') === 'none' ? 0 : num(cur['border-right-width']))
        : num(cur['padding-top']) +
          num(cur['padding-bottom']) +
          (sideBorder(cur, 'top') === 'none' ? 0 : num(cur['border-top-width'])) +
          (sideBorder(cur, 'bottom') === 'none' ? 0 : num(cur['border-bottom-width']));
      v = `${Math.round((num(v) + extra) * 100) / 100}px`;
    }
    out[p] = v;
  }

  // Background.
  if (cur['background-color'] !== def['background-color'])
    out['background-color'] = cur['background-color']!;
  const bgImage = cur['background-image']!;
  if (bgImage && bgImage !== 'none') {
    out['background-image'] = input.assets.rewriteUrls(bgImage, input.baseUrl);
    for (const [p, initial] of [
      ['background-size', 'auto'],
      ['background-position', '0% 0%'],
      ['background-repeat', 'repeat'],
      ['background-origin', 'padding-box'],
      ['background-clip', 'border-box'],
    ] as const) {
      const v = cur[p];
      if (v && !allDefault(v, initial) && !(p === 'background-position' && v === '0% 0%'))
        out[p] = v;
    }
  }
  if (cur['background-clip'] === 'text' || cur['-webkit-background-clip'] === 'text') {
    out['background-clip'] = 'text';
    out['-webkit-background-clip'] = 'text';
  }

  // Color of "filled" text (gradient text: transparent fill).
  const fillProp = '-webkit-text-fill-color';
  const fill = cur[fillProp]!;
  const parentExplicit = !!parent && parent[fillProp] !== parent['color'];
  if (fill && fill !== cur['color']) {
    if (isRoot || !(parentExplicit && parent![fillProp] === fill)) out[fillProp] = fill;
  } else if (!isRoot && parentExplicit) {
    out[fillProp] = 'currentcolor';
  }

  // Text decoration.
  const deco = cur['text-decoration-line']!;
  if (deco !== def['text-decoration-line']) out['text-decoration-line'] = deco;
  if (deco && deco !== 'none') {
    if (cur['text-decoration-color'] !== cur['color'])
      out['text-decoration-color'] = cur['text-decoration-color']!;
    if (cur['text-decoration-style'] !== 'solid')
      out['text-decoration-style'] = cur['text-decoration-style']!;
    const th = cur['text-decoration-thickness'];
    if (th && th !== 'auto' && th !== 'from-font') out['text-decoration-thickness'] = th;
  }

  // Outline.
  const oStyle = cur['outline-style'];
  if (oStyle && oStyle !== 'none' && oStyle !== 'hidden' && num(cur['outline-width']) > 0) {
    const o = `${cur['outline-width']} ${oStyle} ${cur['outline-color']}`;
    const dStyle = def['outline-style'];
    const dO =
      dStyle && dStyle !== 'none'
        ? `${def['outline-width']} ${dStyle} ${def['outline-color']}`
        : '';
    if (o !== dO) out['outline'] = o;
    if (num(cur['outline-offset']) !== 0) out['outline-offset'] = cur['outline-offset']!;
  }

  // Transform.
  const tf = cur['transform'];
  if (tf && tf !== 'none') {
    out['transform'] = tf;
    const origin = cur['transform-origin'];
    const b = input.box;
    if (origin && b) {
      const [ox, oy] = origin.split(/\s+/).map(parseFloat);
      if (!(Math.abs((ox ?? 0) - b.w / 2) <= 1 && Math.abs((oy ?? 0) - b.h / 2) <= 1)) {
        out['transform-origin'] = origin;
      }
    }
  }

  // Drops values the core would reject (and empty ones).
  for (const k of Object.keys(out)) {
    const v = out[k];
    if (!v || cssValueProblem(v) !== null) delete out[k];
  }
  return out;
}

function box4(out: Record<string, string>, name: string, vals: string[], defs: string[]): void {
  const idx = [0, 1, 2, 3].filter((i) => vals[i] !== defs[i]);
  if (idx.length === 0) return;
  if (idx.length === 4) {
    out[name] = collapse4(vals);
    return;
  }
  for (const i of idx) out[`${name}-${SIDE_LIST[i]!}`] = vals[i]!;
}

function pair(
  out: Record<string, string>,
  shorthand: string,
  a: string | undefined,
  b: string | undefined,
  da: string | undefined,
  db: string | undefined,
  ka: string,
  kb: string,
): void {
  const ca = a !== da;
  const cb = b !== db;
  if (!ca && !cb) return;
  if (ca && cb && a === b) out[shorthand] = a!;
  else {
    if (ca && a) out[ka] = a;
    if (cb && b) out[kb] = b;
  }
}
