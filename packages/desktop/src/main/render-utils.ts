/** Pure functions of the RenderService (testable without Electron). */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { getFrameOf, getPageOfNode, walk, type Document, type Node } from '@mockup/core';

/** Maximum side of the final image, in px, after scaling. */
export const MAX_SIDE_PX = 16384;

/** Reads width/height from a PNG's IHDR header. */
export function pngSize(buf: Buffer): { width: number; height: number } {
  if (buf.length < 24 || buf.readUInt32BE(0) !== 0x89504e47)
    throw new Error('Response is not a valid PNG');
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

/** Render cache limit in bytes (sum of the stored PNG/JPG). */
export const CACHE_MAX_BYTES = 256 * 1024 * 1024;

/**
 * Validates the viewport (`frame × deviceScaleFactor`) before resizing the render window:
 * Chromium fails or runs out of memory with very large surfaces.
 */
export function assertViewport(width: number, height: number, scale: number): void {
  const w = Math.ceil(width * scale);
  const h = Math.ceil(height * scale);
  if (w > MAX_SIDE_PX || h > MAX_SIDE_PX) {
    throw new Error(
      `Frame too large to render: ${Math.ceil(width)}x${Math.ceil(height)}px CSS × scale ${scale} = ${w}x${h}px (limit of ${MAX_SIDE_PX}px per side). Reduce the scale or the frame size.`,
    );
  }
}

/** Validates the final size; throws a clear error when it exceeds the limit. */
export function assertSize(width: number, height: number, scale: number): void {
  const w = Math.round(width * scale);
  const h = Math.round(height * scale);
  if (w < 1 || h < 1) throw new Error(`The node has an empty size (${width}x${height}).`);
  if (w > MAX_SIDE_PX || h > MAX_SIDE_PX) {
    throw new Error(
      `Image too large: ${w}x${h}px (limit of ${MAX_SIDE_PX}px per side). Reduce the scale or capture a smaller node.`,
    );
  }
}

/** Width/height in px declared in the frame's style, when they are `Npx` values. */
export function declaredSize(frame: Node | undefined): { width?: number; height?: number } {
  const styles = (frame?.style ?? {}) as Record<string, unknown>;
  const px = (v: unknown): number | undefined => {
    const m = typeof v === 'string' ? /^\s*(\d+(?:\.\d+)?)px\s*$/.exec(v) : null;
    return m ? Number(m[1]) : undefined;
  };
  return { width: px(styles.width), height: px(styles.height) };
}

/** Limits of the filmstrip (same as the render page). */
export const MAX_FILMSTRIP_CELLS = 12;
export const MAX_FILMSTRIP_COLUMNS = 12;

/** Validates `time`, `build`, `times` and `columns` of a capture before using the render window. */
export function assertMotionRequest(r: {
  time?: number;
  build?: number;
  times?: number[];
  columns?: number;
}): void {
  const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0;
  if (r.time !== undefined && !num(r.time))
    throw new Error(`time must be a number >= 0 (seconds), got ${String(r.time)}.`);
  if (r.build !== undefined && !(Number.isInteger(r.build) && r.build >= 0))
    throw new Error(`build must be an integer >= 0, got ${String(r.build)}.`);
  if (r.times !== undefined) {
    if (!Array.isArray(r.times) || r.times.length < 1 || r.times.length > MAX_FILMSTRIP_CELLS)
      throw new Error(
        `times must have 1 to ${MAX_FILMSTRIP_CELLS} instants, got ${Array.isArray(r.times) ? r.times.length : 0}.`,
      );
    if (!r.times.every(num))
      throw new Error(`times must be numbers >= 0 (seconds), got ${JSON.stringify(r.times)}.`);
  }
  if (r.columns !== undefined) {
    if (r.times === undefined)
      throw new Error('columns only applies together with times (filmstrip).');
    if (!(Number.isInteger(r.columns) && r.columns >= 1 && r.columns <= MAX_FILMSTRIP_COLUMNS))
      throw new Error(
        `columns must be an integer from 1 to ${MAX_FILMSTRIP_COLUMNS}, got ${String(r.columns)}.`,
      );
  }
}

export interface CacheKeyInput {
  doc: Document;
  docId: string;
  nodeId: string;
  scale: number;
  format: string;
  quality?: number;
  maxWidth?: number;
  transparent: boolean;
  /** Animation time (s); absent ≠ 0 (without a time a video with a poster shows the poster). */
  time?: number;
  /** Node animations after this click build. */
  build?: number;
  /** Filmstrip instants (s). */
  times?: number[];
  /** Filmstrip columns. */
  columns?: number;
  /** Fingerprint of the referenced files (see `assetFingerprints`). */
  assets?: string[];
}

/** sha256 of what influences the image: the node's frame, tokens, themes, fonts, page background and parameters. */
export function cacheKey(i: CacheKeyInput): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        frame: getFrameOf(i.doc, i.nodeId) ?? null,
        tokens: i.doc.tokens,
        themes: i.doc.themes ?? [],
        fonts: i.doc.fonts,
        background: getPageOfNode(i.doc, i.nodeId)?.background ?? null,
        docId: i.docId,
        nodeId: i.nodeId,
        scale: i.scale,
        format: i.format,
        quality: i.quality ?? null,
        maxWidth: i.maxWidth ?? null,
        transparent: i.transparent,
        time: i.time ?? null,
        build: i.build ?? null,
        times: i.times ?? null,
        columns: i.times ? (i.columns ?? null) : null,
        assets: i.assets ?? [],
      }),
    )
    .digest('hex');
}

const CSS_URL = /url\(\s*(['"]?)(.*?)\1\s*\)/gi;

/** Reference relative to `assets/` (discards data:, http(s):, anchors and absolute paths). */
function relativeRef(raw: string): string | null {
  const ref = raw.trim();
  if (!ref || ref.startsWith('#') || ref.startsWith('/') || ref.startsWith('\\')) return null;
  if (/^[a-z][a-z0-9+.-]*:/i.test(ref)) return null;
  return ref.replace(/^\.\//, '').split(/[?#]/)[0] || null;
}

/**
 * Files in `assets/` that influence the render of the node's frame: the frame images' `src`,
 * relative `url(...)` in the frame's styles (and in the page background) and the document's font files.
 */
export function referencedAssets(doc: Document, nodeId: string): string[] {
  const refs = new Set<string>();
  const add = (raw: string | undefined): void => {
    const r = raw ? relativeRef(raw) : null;
    if (r) refs.add(r);
  };
  const addUrls = (css: string): void => {
    for (const m of css.matchAll(CSS_URL)) add(m[2]);
  };
  const frame = getFrameOf(doc, nodeId);
  if (frame) {
    walk(frame, (n) => {
      if (n.type === 'image') add(n.src);
      for (const v of Object.values(n.style ?? {})) addUrls(String(v));
    });
  }
  addUrls(getPageOfNode(doc, nodeId)?.background ?? '');
  for (const f of doc.fonts ?? []) for (const file of f.files ?? []) add(file);
  return [...refs].sort();
}

/**
 * Size and modification date of each referenced file, read from `assetsDir`. Paths that
 * escape the folder (`..`) and missing files are ignored. Changing the contents of a file with the
 * same name changes the fingerprint (and therefore the cache key).
 */
export function assetFingerprints(assetsDir: string | null | undefined, refs: string[]): string[] {
  if (!assetsDir) return [];
  const root = path.resolve(assetsDir);
  const out: string[] = [];
  for (const raw of refs) {
    let rel = raw;
    try {
      rel = decodeURIComponent(raw);
    } catch {
      /* keeps the original text */
    }
    if (rel.includes('\0') || rel.split(/[\\/]/).includes('..')) continue;
    const target = path.resolve(root, rel);
    if (!target.startsWith(root + path.sep)) continue;
    try {
      const st = fs.statSync(target);
      if (st.isFile()) out.push(`${raw}:${st.size}:${Math.round(st.mtimeMs)}`);
    } catch {
      /* missing: ignore */
    }
  }
  return out;
}

/** LRU cache bounded by size (`sizeOf`; default 1 per entry = entry count limit). */
export class LruCache<V> {
  private map = new Map<string, { value: V; size: number }>();
  private total = 0;
  constructor(
    private max: number,
    private sizeOf: (value: V) => number = () => 1,
  ) {}
  get(key: string): V | undefined {
    const e = this.map.get(key);
    if (e === undefined) return undefined;
    this.map.delete(key);
    this.map.set(key, e);
    return e.value;
  }
  set(key: string, value: V): void {
    this.drop(key);
    const size = this.sizeOf(value);
    this.map.set(key, { value, size });
    this.total += size;
    // drops the least recently used; the entry itself disappears if it alone exceeds the limit
    while (this.total > this.max && this.map.size > 0)
      this.drop(this.map.keys().next().value as string);
  }
  private drop(key: string): void {
    const e = this.map.get(key);
    if (!e) return;
    this.total -= e.size;
    this.map.delete(key);
  }
  get size(): number {
    return this.map.size;
  }
  /** Sum of the entry sizes. */
  get bytes(): number {
    return this.total;
  }
  clear(): void {
    this.map.clear();
    this.total = 0;
  }
}

/** Rejects if `p` does not resolve in `ms`; `onTimeout` runs first (e.g. destroy the hung window). */
export async function withTimeout<T>(
  p: Promise<T>,
  ms: number,
  what: string,
  onTimeout?: () => void,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      onTimeout?.();
      reject(new Error(`Timed out (${Math.round(ms / 1000)} s) in: ${what}`));
    }, ms);
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    clearTimeout(timer);
  }
}
