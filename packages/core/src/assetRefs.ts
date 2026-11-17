/**
 * References to files in `assets/` within a document: image `src` (including those coming from
 * repeater data), `url(assets/...)` in styles, and font files. Used to count usage in the
 * panel/MCP, remove unused ones, and rewrite references when optimizing or renaming.
 */
import { baseNodeId, expandRepeaters, hasBindings } from './data.js';
import { walk } from './document.js';
import type { Op } from './ops.js';
import type { Document, Node } from './types.js';

export type AssetRefKind = 'src' | 'style' | 'font' | 'data';

export interface AssetRef {
  /** Path relative to `assets/` (forward slashes). */
  path: string;
  /** Nodes that use it (real ids, without the expansion suffix). */
  nodeIds: string[];
  kinds: AssetRefKind[];
}

const STYLE_URL_RE = /url[(]\s*(["']?)(?:\.\/)?assets[/]([^"')]+)\1\s*[)]/g;

/** Is `src` relative to `assets/` (not a data URL, not http, no `..`)? Returns the normalized path. */
export function assetPathOf(src: string | undefined): string | null {
  if (!src) return null;
  const s = src.trim().replace(/\\/g, '/');
  if (!s || /^[a-z][a-z0-9+.-]*:/i.test(s) || s.startsWith('/') || s.startsWith('#')) return null;
  const rel = s.replace(/^(\.\/)?assets\//, '').split(/[?#]/)[0]!;
  if (!rel || rel.split('/').some((seg) => seg === '..' || seg === '')) return null;
  if (rel.includes('{{')) return null;
  return rel;
}

function addRef(
  map: Map<string, AssetRef>,
  path: string,
  nodeId: string,
  kind: AssetRefKind,
): void {
  let ref = map.get(path);
  if (!ref) {
    ref = { path, nodeIds: [], kinds: [] };
    map.set(path, ref);
  }
  const id = baseNodeId(nodeId);
  if (id && !ref.nodeIds.includes(id)) ref.nodeIds.push(id);
  if (!ref.kinds.includes(kind)) ref.kinds.push(kind);
}

/** Map of path → usage. Keys use forward slashes, relative to `assets/`. */
export function collectAssetRefs(doc: Document): Map<string, AssetRef> {
  const map = new Map<string, AssetRef>();
  const visit = (n: Node, fromData: boolean): void => {
    const p = n.type === 'image' || n.tag === 'img' ? assetPathOf(n.src) : null;
    if (p) addRef(map, p, n.id, fromData ? 'data' : 'src');
    for (const v of Object.values(n.style)) {
      for (const m of v.matchAll(STYLE_URL_RE)) {
        const rel = assetPathOf(m[2]);
        if (rel) addRef(map, rel, n.id, 'style');
      }
    }
  };
  walk(doc, (n) => {
    if (n.type === 'repeater') {
      // Template and expanded items (src values coming from the data).
      const bound = new Set<string>();
      walk(n, (t) => {
        if (hasBindings(t.src)) bound.add(t.id);
      });
      walk(expandRepeaters(n), (c) => visit(c, bound.has(baseNodeId(c.id))));
      return false;
    }
    visit(n, false);
  });
  for (const f of doc.fonts) {
    for (const file of f.files ?? []) {
      const rel = assetPathOf(file);
      if (rel) addRef(map, rel, '', 'font');
    }
  }
  return map;
}

/**
 * Ops that swap asset references using the `from → to` map (paths relative to `assets/`):
 * `setSrc` on images, `updateStyles` on `url(assets/...)`, `setData` on data values
 * equal to the old path, and `setFonts` on font files.
 */
export function rewriteAssetRefsOps(doc: Document, renamed: Map<string, string>): Op[] {
  if (renamed.size === 0) return [];
  const srcs: { nodeId: string; src: string }[] = [];
  const styles: { nodeId: string; set: Record<string, string> }[] = [];
  const datas: { nodeId: string; data: unknown[] }[] = [];
  const swap = (v: string): string | undefined => {
    const rel = assetPathOf(v);
    if (!rel) return undefined;
    const to = renamed.get(rel);
    if (!to) return undefined;
    return v.trim().startsWith('assets/') ? `assets/${to}` : to;
  };
  const swapDeep = (v: unknown): { v: unknown; changed: boolean } => {
    if (typeof v === 'string') {
      const to = swap(v);
      return to ? { v: to, changed: true } : { v, changed: false };
    }
    if (Array.isArray(v)) {
      let changed = false;
      const out = v.map((x) => {
        const r = swapDeep(x);
        changed ||= r.changed;
        return r.v;
      });
      return { v: out, changed };
    }
    if (v && typeof v === 'object') {
      let changed = false;
      const out: Record<string, unknown> = {};
      for (const [k, x] of Object.entries(v)) {
        const r = swapDeep(x);
        changed ||= r.changed;
        out[k] = r.v;
      }
      return { v: out, changed };
    }
    return { v, changed: false };
  };
  walk(doc, (n) => {
    if (n.src) {
      const to = swap(n.src);
      if (to) srcs.push({ nodeId: n.id, src: to });
    }
    const set: Record<string, string> = {};
    for (const [k, v] of Object.entries(n.style)) {
      const nv = v.replace(STYLE_URL_RE, (m, q: string, rel: string) => {
        const to = renamed.get(rel);
        return to ? `url(${q}assets/${to}${q})` : m;
      });
      if (nv !== v) set[k] = nv;
    }
    if (Object.keys(set).length) styles.push({ nodeId: n.id, set });
    if (n.type === 'repeater' && n.data) {
      const r = swapDeep(n.data);
      if (r.changed) datas.push({ nodeId: n.id, data: r.v as unknown[] });
    }
  });
  const ops: Op[] = [];
  if (srcs.length) ops.push({ type: 'setSrc', changes: srcs });
  if (styles.length) ops.push({ type: 'updateStyles', changes: styles });
  if (datas.length) ops.push({ type: 'setData', changes: datas });
  if (doc.fonts.some((f) => f.files?.some((x) => renamed.has(x)))) {
    ops.push({
      type: 'setFonts',
      fonts: doc.fonts.map((f) =>
        f.files ? { ...f, files: f.files.map((x) => renamed.get(x) ?? x) } : f,
      ),
    });
  }
  return ops;
}
