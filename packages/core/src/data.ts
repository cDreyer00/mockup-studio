/**
 * Real data: repeater node (`type: 'repeater'`), `{{field}}` bindings and JSON/CSV reading.
 *
 * The repeater stores `data` (list of items) and its children are the template. On expansion
 * (canvas, render, export and screenshot) each item produces a copy of all the children, with
 * bindings resolved in `text`, `src` and attribute values. Pure functions, no DOM and no Node.
 */
import { newNodeId } from './ids.js';
import { MAX_DATA_ITEMS } from './schema.js';
import type { DataSource, Node } from './types.js';

/** Separator between the template id and the item index in expanded ids (`tx_ab12~3`). */
export const REPEAT_ID_SEP = '~';

/** Id of the real node (template) for an expanded id: `tx_ab12~3` → `tx_ab12`. */
export function baseNodeId(id: string): string {
  const i = id.indexOf(REPEAT_ID_SEP);
  return i < 0 ? id : id.slice(0, i);
}

/** Item index of an expanded id (`tx_ab12~3` → 3); `0` for template ids. */
export function repeatIndexOf(id: string): number {
  const i = id.lastIndexOf(REPEAT_ID_SEP);
  if (i < 0) return 0;
  const n = Number(id.slice(i + 1));
  return Number.isInteger(n) ? n : 0;
}

const BINDING_RE = /\{\{\s*([^{}|]*?)\s*(?:\|\s*([^{}]*?)\s*)?\}\}/g;

/** Has any `{{...}}` binding? */
export function hasBindings(value: string | undefined): boolean {
  if (!value) return false;
  BINDING_RE.lastIndex = 0;
  return BINDING_RE.test(value);
}

/** Fields cited in the bindings (no duplicates, in order of appearance). */
export function bindingFields(value: string | undefined): string[] {
  if (!value) return [];
  const out: string[] = [];
  for (const m of value.matchAll(BINDING_RE)) {
    const f = m[1]!.trim();
    if (f && !out.includes(f)) out.push(f);
  }
  return out;
}

/** Fields used by all bindings in the subtree (texts, `src`, attributes). */
export function templateFields(nodes: Node[]): string[] {
  const out: string[] = [];
  const add = (v: string | undefined): void => {
    for (const f of bindingFields(v)) if (!out.includes(f)) out.push(f);
  };
  const visit = (n: Node): void => {
    add(n.text);
    add(n.src);
    for (const v of Object.values(n.attrs)) add(v);
    n.children.forEach(visit);
  };
  nodes.forEach(visit);
  return out;
}

/** Reads `a.b.0.c` inside `value` (objects and arrays); `undefined` if the path does not exist. */
export function getPath(value: unknown, path: string): unknown {
  const p = path.trim();
  if (p === '' || p === '.' || p === '$item') return value;
  let cur: unknown = value;
  for (const key of p.split('.')) {
    if (cur === null || cur === undefined) return undefined;
    if (typeof cur !== 'object') return undefined;
    if (!Object.prototype.hasOwnProperty.call(cur, key)) return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
}

function toText(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'bigint') return String(v);
  try {
    return JSON.stringify(v);
  } catch {
    return '';
  }
}

export interface BindingContext {
  item: unknown;
  index: number;
  /** Template field → path in the item. */
  mapping?: Record<string, string>;
}

/** Value of a field: specials `$index` (0..n-1), `$number` (1..n), `$item`; then the mapping. */
export function resolveField(field: string, ctx: BindingContext): unknown {
  const f = field.trim();
  if (f === '$index') return ctx.index;
  if (f === '$number') return ctx.index + 1;
  const mapped = ctx.mapping?.[f];
  return getPath(ctx.item, mapped ?? f);
}

/**
 * Replaces `{{field}}` and `{{field | default}}` with the item's values. A missing field becomes
 * the default (or empty). Objects become JSON.
 */
export function applyBindings(value: string, ctx: BindingContext): string {
  if (!value.includes('{{')) return value;
  return value.replace(BINDING_RE, (_m, field: string, fallback: string | undefined) => {
    const v = resolveField(field, ctx);
    const text = toText(v);
    if (text === '' && fallback !== undefined) return fallback.replace(/^["']|["']$/g, '');
    return text;
  });
}

const URL_ATTRS = new Set(['href', 'src', 'action', 'formaction', 'xlink:href', 'poster', 'data']);

function unsafeUrl(v: string): boolean {
  // eslint-disable-next-line no-control-regex
  const s = v.replace(/[\u0000- ]/g, '').toLowerCase();
  return s.startsWith('javascript:') || s.startsWith('vbscript:') || s.startsWith('data:text/html');
}

function bindNode(n: Node, ctx: BindingContext, suffix: string): Node {
  const out: Node = {
    ...n,
    id: n.id + suffix,
    attrs: {},
    style: { ...n.style },
    children: [],
  };
  for (const [k, v] of Object.entries(n.attrs)) {
    const bound = applyBindings(v, ctx);
    if (URL_ATTRS.has(k.toLowerCase()) && bound !== v && unsafeUrl(bound)) continue;
    out.attrs[k] = bound;
  }
  if (n.text !== undefined) out.text = applyBindings(n.text, ctx);
  if (n.src !== undefined) {
    const src = applyBindings(n.src, ctx);
    if (src !== n.src && unsafeUrl(src)) delete out.src;
    else out.src = src;
  }
  if (n.position) out.position = { ...n.position };
  if (n.type === 'repeater') {
    // Nested repeater: the inner template uses its own items, not the outer item.
    const inner: Node = {
      ...out,
      type: 'element',
      children: expandItems({ ...out, children: n.children }, {}, suffix),
    };
    delete inner.data;
    delete inner.dataSource;
    return inner;
  }
  out.children = n.children.map((c) => bindNode(c, ctx, suffix));
  return out;
}

export interface RepeaterExpandOptions {
  /** Limit of expanded items (default `MAX_DATA_ITEMS`). */
  maxItems?: number;
}

/**
 * Expanded items of the repeater: a list of copies of the children per item. Item 0 keeps the
 * template ids; the others get the `~<index>` suffix (see `baseNodeId`). Without data, returns
 * the template with bindings resolved against an empty item.
 */
export function expandRepeaterChildren(node: Node, opts: RepeaterExpandOptions = {}): Node[] {
  return expandItems(node, opts, '');
}

/**
 * `outer` is the suffix of the outer item (nested repeater): inside it every item gets `~<i>`,
 * including 0, so ids do not collide with those of another outer item.
 */
function expandItems(node: Node, opts: RepeaterExpandOptions, outer: string): Node[] {
  const template = node.children.filter((c) => !c.hidden);
  const mapping = node.dataSource?.mapping;
  const data = Array.isArray(node.data) ? node.data : [];
  const max = Math.min(opts.maxItems ?? MAX_DATA_ITEMS, MAX_DATA_ITEMS);
  const items = data.length > 0 ? data.slice(0, max) : [undefined];
  const out: Node[] = [];
  items.forEach((item, index) => {
    const suffix = outer
      ? `${outer}${REPEAT_ID_SEP}${index}`
      : index === 0
        ? ''
        : `${REPEAT_ID_SEP}${index}`;
    const ctx: BindingContext = { item: item ?? {}, index, mapping };
    for (const c of template) out.push(bindNode(c, ctx, suffix));
  });
  return out;
}

/** Repeater as a plain container (`type: 'element'`) with the expanded items. */
export function expandRepeater(node: Node, opts: RepeaterExpandOptions = {}): Node {
  if (node.type !== 'repeater') return node;
  const out: Node = { ...node, type: 'element', children: expandRepeaterChildren(node, opts) };
  delete out.data;
  delete out.dataSource;
  return out;
}

/** Expands all repeaters in the subtree (returns new nodes; the input is not mutated). */
export function expandRepeaters(node: Node, opts: RepeaterExpandOptions = {}): Node {
  if (node.type === 'repeater') return expandRepeater(node, opts);
  if (!containsRepeater(node)) return node;
  return { ...node, children: node.children.map((c) => expandRepeaters(c, opts)) };
}

/** Does the subtree contain any repeater? */
export function containsRepeater(node: Node): boolean {
  if (node.type === 'repeater') return true;
  return node.children.some(containsRepeater);
}

/**
 * Creates a repeater from a container: same tag, name, style, attributes, flags and position;
 * the children become the template. Gets a new id (`rp_`) unless `id` is given.
 */
export function createRepeaterFrom(
  node: Node,
  data: unknown[] = [],
  source?: DataSource,
  id?: string,
): Node {
  const out: Node = {
    id: id ?? newNodeId('repeater'),
    type: 'repeater',
    name: node.name,
    tag: node.tag,
    attrs: { ...node.attrs },
    style: { ...node.style },
    children: node.children,
    locked: node.locked,
    hidden: node.hidden,
    data,
  };
  if (node.position) out.position = { ...node.position };
  if (source) out.dataSource = source;
  return out;
}

/* ---------------- data reading ---------------- */

/** Detects a CSV delimiter from the first line (`,`, `;` or tab). */
export function detectCsvDelimiter(text: string): string {
  const first = text.split(/\r?\n/, 1)[0] ?? '';
  let best = ',';
  let bestCount = -1;
  for (const d of [',', ';', '\t', '|']) {
    let count = 0;
    let quoted = false;
    for (const ch of first) {
      if (ch === '"') quoted = !quoted;
      else if (!quoted && ch === d) count++;
    }
    if (count > bestCount) {
      best = d;
      bestCount = count;
    }
  }
  return best;
}

/** Rows of a CSV (RFC 4180: quotes, doubled quotes and line breaks inside quotes). */
export function parseCsvRows(text: string, delimiter?: string): string[][] {
  const src = text.replace(/^\uFEFF/, '');
  const d = delimiter ?? detectCsvDelimiter(src);
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]!;
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += ch;
      continue;
    }
    if (ch === '"' && field === '') quoted = true;
    else if (ch === d) {
      row.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else field += ch;
  }
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((c) => c.trim() !== ''));
}

/** CSV with header → list of objects (text values; an empty header becomes `colN`). */
export function parseCsv(
  text: string,
  opts: { delimiter?: string } = {},
): Record<string, string>[] {
  const rows = parseCsvRows(text, opts.delimiter);
  if (rows.length === 0) return [];
  const header = rows[0]!.map((h, i) => h.trim() || `col${i + 1}`);
  return rows.slice(1).map((r) => {
    const o: Record<string, string> = {};
    header.forEach((h, i) => {
      o[h] = r[i] ?? '';
    });
    return o;
  });
}

/**
 * List of items inside a JSON: with `select` (`data.items`) it follows the path; without it, uses
 * the value itself if it is a list, otherwise the first property that is a list (shallow search,
 * up to 2 levels). A lone object becomes a one-item list.
 */
export function selectDataList(json: unknown, select?: string): unknown[] {
  if (select && select.trim()) {
    const v = getPath(json, select);
    if (!Array.isArray(v)) throw new Error(`"${select}" does not point to a list in the JSON`);
    return v;
  }
  if (Array.isArray(json)) return json;
  if (json && typeof json === 'object') {
    const obj = json as Record<string, unknown>;
    for (const v of Object.values(obj)) if (Array.isArray(v)) return v;
    for (const v of Object.values(obj)) {
      if (v && typeof v === 'object' && !Array.isArray(v)) {
        for (const w of Object.values(v as Record<string, unknown>)) if (Array.isArray(w)) return w;
      }
    }
    return [json];
  }
  throw new Error('The JSON does not contain a list of items');
}

/** Reads JSON or CSV text and returns the items (capped at `limit`, default `MAX_DATA_ITEMS`). */
export function parseDataText(
  text: string,
  format: 'json' | 'csv',
  opts: { select?: string; limit?: number } = {},
): unknown[] {
  let list: unknown[];
  if (format === 'csv') list = parseCsv(text);
  else {
    let json: unknown;
    try {
      json = JSON.parse(text.replace(/^\uFEFF/, ''));
    } catch (e) {
      throw new Error(`Invalid JSON: ${e instanceof Error ? e.message : String(e)}`);
    }
    list = selectDataList(json, opts.select);
  }
  const limit = Math.min(opts.limit ?? MAX_DATA_ITEMS, MAX_DATA_ITEMS);
  return list.slice(0, limit);
}

/** Format from the file name/URL or content-type (`csv` when it looks like CSV; otherwise `json`). */
export function guessDataFormat(nameOrType: string): 'json' | 'csv' {
  const s = nameOrType.toLowerCase();
  return /\.csv(\?|#|$)|text\/csv|application\/csv|\.tsv(\?|#|$)|tab-separated/.test(s)
    ? 'csv'
    : 'json';
}

/** Data columns (keys of object items, in order of appearance; `$item` for scalars). */
export function dataColumns(data: unknown[], max = 50): string[] {
  const out: string[] = [];
  for (const item of data) {
    if (item && typeof item === 'object' && !Array.isArray(item)) {
      for (const k of Object.keys(item)) if (!out.includes(k)) out.push(k);
    } else if (!out.includes('$item')) out.push('$item');
    if (out.length >= max) break;
  }
  return out;
}
