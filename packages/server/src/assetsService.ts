/**
 * Asset service for a document: listing with hash/usage, CDN link, removal, cleanup of unused
 * assets and optimization (sharp). Shared by the HTTP routes and the MCP tools.
 */
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import {
  assetPathOf,
  collectAssetRefs,
  rewriteAssetRefsOps,
  walk,
  type AssetRef,
  type Document,
  type Op,
} from '@mockup/core';
import type Sharp from 'sharp';
import { EMBEDDABLE_MIME, safeJoin, writeAsset } from './assets.js';
import {
  getLibrary,
  hashBytes,
  kindOfExt,
  detectAsset,
  type AssetKind,
  type DetectedAsset,
} from './library.js';
import { DEFAULT_PORT } from './paths.js';
import { RouteError } from './routes/shared.js';
import type { DocumentStore } from './store.js';

export interface AssetsServiceCtx {
  store: DocumentStore;
  dataDir?: string;
  getPort?: () => number;
}

export interface AssetInfo {
  /** Relative to `assets/`, with forward slashes. */
  path: string;
  name: string;
  /** With leading dot, lowercase (".png"). */
  ext: string;
  kind: AssetKind;
  mime: string;
  size: number;
  width?: number;
  height?: number;
  mtime: number;
  /** Content hash (empty for files that are not images/fonts). */
  hash: string;
  /**
   * Absolute direct link on the local CDN. Empty for files that are not images/fonts and for those
   * not yet registered on the CDN (listing does not register; use the link, `get_asset_url` or the upload).
   */
  cdnUrl: string;
  uses: number;
  nodeIds: string[];
  refKinds: string[];
}

export interface OptimizeOptions {
  paths?: string[];
  maxWidth?: number;
  format?: 'webp' | 'keep';
  quality?: number;
}

export interface OptimizeResult {
  results: { path: string; newPath: string; before: number; after: number }[];
  skipped: { path: string; reason: string }[];
  /** How many references (nodes, styles, data, fonts) were rewritten. */
  rewritten: number;
}

/** Origin (`http://127.0.0.1:<port>`) used in direct links. */
export function baseUrl(ctx: Pick<AssetsServiceCtx, 'getPort'>): string {
  return `http://127.0.0.1:${ctx.getPort?.() || DEFAULT_PORT}`;
}

export function cdnUrlOf(
  ctx: Pick<AssetsServiceCtx, 'getPort'>,
  hash: string,
  ext: string,
): string {
  return `${baseUrl(ctx)}/cdn/${hash}.${ext.replace(/^\./, '')}`;
}

function requireAssetsDir(ctx: AssetsServiceCtx, docId: string): string | null {
  if (!ctx.store.list().some((d) => d.docId === docId)) {
    throw new RouteError(404, `Document not found: ${docId}`);
  }
  return ctx.store.assetsDir(docId);
}

const HIDDEN = (name: string): boolean =>
  name.startsWith('.') || name.endsWith('~') || /\.(tmp|part|crdownload)$/i.test(name);

async function walkFiles(root: string, rel = ''): Promise<{ rel: string; abs: string }[]> {
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(path.join(root, rel), { withFileTypes: true });
  } catch {
    return [];
  }
  const out: { rel: string; abs: string }[] = [];
  for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (HIDDEN(e.name)) continue;
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...(await walkFiles(root, r)));
    else if (e.isFile()) out.push({ rel: r, abs: path.join(root, r) });
  }
  return out;
}

interface HashEntry {
  mtimeMs: number;
  size: number;
  hash: string;
  info: DetectedAsset | null;
}
/** Hash cache by path (validated by mtime and size), capped: evicts the least recently used. */
const HASH_CACHE_MAX = 2000;
const hashCache = new Map<string, HashEntry>();

function cachedHash(abs: string): HashEntry | undefined {
  const c = hashCache.get(abs);
  if (c) {
    hashCache.delete(abs);
    hashCache.set(abs, c);
  }
  return c;
}

function rememberHash(abs: string, entry: HashEntry): void {
  hashCache.delete(abs);
  hashCache.set(abs, entry);
  while (hashCache.size > HASH_CACHE_MAX) {
    hashCache.delete(hashCache.keys().next().value!);
  }
}

/** `assets/` paths used by repeaters' `dataSource.path` (cannot be deleted). */
function dataSourcePaths(doc: Document): Set<string> {
  const out = new Set<string>();
  walk(doc, (n) => {
    const p = assetPathOf(n.dataSource?.path);
    if (p) out.add(p);
  });
  return out;
}

/** Recursively lists `assets/` with hash, dimensions, CDN link and usage in the document. */
export async function listDocAssets(ctx: AssetsServiceCtx, docId: string): Promise<AssetInfo[]> {
  const dir = requireAssetsDir(ctx, docId);
  if (!dir) return [];
  const refs = collectAssetRefs(ctx.store.get(docId));
  const lib = getLibrary(ctx.dataDir);
  const files = await walkFiles(dir);
  const out: AssetInfo[] = [];
  for (const f of files) {
    let st: fs.Stats;
    try {
      st = await fs.promises.stat(f.abs);
    } catch {
      continue;
    }
    const ext = path.extname(f.rel).toLowerCase();
    const kind = kindOfExt(ext);
    let hash = '';
    let cdnUrl = '';
    let info: DetectedAsset | null = null;
    if (kind !== 'other') {
      let c = cachedHash(f.abs);
      if (!c || c.mtimeMs !== st.mtimeMs || c.size !== st.size) {
        const bytes = await fs.promises.readFile(f.abs);
        c = {
          mtimeMs: st.mtimeMs,
          size: st.size,
          hash: hashBytes(bytes),
          info: detectAsset(bytes),
        };
        rememberHash(f.abs, c);
      }
      info = c.info;
      if (c.info) {
        hash = c.hash;
        // Read-only: the link appears only if the file was already registered on the CDN.
        if (lib.has(hash)) cdnUrl = cdnUrlOf(ctx, hash, c.info.ext);
      }
    }
    const ref: AssetRef | undefined = refs.get(f.rel);
    out.push({
      path: f.rel,
      name: path.basename(f.rel),
      ext,
      kind,
      mime: info?.mime ?? EMBEDDABLE_MIME[ext] ?? 'application/octet-stream',
      size: st.size,
      ...(info?.width ? { width: info.width, height: info.height } : {}),
      mtime: Math.round(st.mtimeMs),
      hash,
      cdnUrl,
      uses: ref?.nodeIds.length ?? 0,
      nodeIds: ref?.nodeIds ?? [],
      refKinds: ref?.kinds ?? [],
    });
  }
  return out;
}

function resolveRel(
  ctx: AssetsServiceCtx,
  docId: string,
  rel: string,
): { dir: string; rel: string; abs: string } {
  const dir = requireAssetsDir(ctx, docId);
  if (!dir) throw new RouteError(409, 'The document has no path on disk yet; save it first.');
  const clean = assetPathOf(rel) ?? assetPathOf(`assets/${rel}`);
  const abs = clean ? safeJoin(dir, clean) : null;
  if (!clean || !abs) throw new RouteError(400, `Invalid asset path: "${rel}".`);
  return { dir, rel: clean, abs };
}

/** Removes a file from `assets/`; 409 if in use and `force` is not set. */
export async function removeDocAsset(
  ctx: AssetsServiceCtx,
  docId: string,
  rel: string,
  force: boolean,
): Promise<string[]> {
  const r = resolveRel(ctx, docId, rel);
  if (!fs.existsSync(r.abs)) throw new RouteError(404, `Asset not found: ${r.rel}`);
  const ref = collectAssetRefs(ctx.store.get(docId)).get(r.rel);
  if (ref && !force) {
    throw new RouteError(
      409,
      `"${r.rel}" is in use by ${ref.nodeIds.length} node(s)${ref.kinds.includes('font') ? ' and by the document fonts' : ''}. Replace the references or use force to remove it anyway.`,
    );
  }
  await fs.promises.rm(r.abs, { force: true });
  hashCache.delete(r.abs);
  return [r.rel];
}

/** Removes image/font files from `assets/` that no node, style, data or font references. */
export async function removeUnusedAssets(
  ctx: AssetsServiceCtx,
  docId: string,
  dryRun = false,
): Promise<{ removed: string[]; kept: number }> {
  const dir = requireAssetsDir(ctx, docId);
  if (!dir) return { removed: [], kept: 0 };
  const doc = ctx.store.get(docId);
  const refs = collectAssetRefs(doc);
  const keepData = dataSourcePaths(doc);
  const removed: string[] = [];
  let kept = 0;
  for (const f of await walkFiles(dir)) {
    const removable = kindOfExt(path.extname(f.rel)) !== 'other';
    if (!removable || refs.has(f.rel) || keepData.has(f.rel)) {
      kept++;
      continue;
    }
    if (!dryRun) {
      await fs.promises.rm(f.abs, { force: true });
      hashCache.delete(f.abs);
    }
    removed.push(f.rel);
  }
  return { removed, kept };
}

/** Registers the asset on the CDN and returns the direct link. */
export async function linkDocAsset(
  ctx: AssetsServiceCtx,
  docId: string,
  rel: string,
): Promise<{ hash: string; url: string; cdnPath: string }> {
  const r = resolveRel(ctx, docId, rel);
  let bytes: Buffer;
  try {
    bytes = await fs.promises.readFile(r.abs);
  } catch {
    throw new RouteError(404, `Asset not found: ${r.rel}`);
  }
  const info = detectAsset(bytes);
  if (!info) throw new RouteError(400, `"${r.rel}" is not a recognized image or font.`);
  const a = getLibrary(ctx.dataDir).add(bytes, { name: path.basename(r.rel), info });
  return { hash: a.hash, url: cdnUrlOf(ctx, a.hash, a.ext), cdnPath: a.url };
}

const OPTIMIZABLE = new Set(['.png', '.jpg', '.jpeg', '.webp', '.avif']);

/**
 * Extra `node_modules` folders to look for sharp in when the normal import fails. In the packaged
 * app the main process and the CLI daemon are bundles without node_modules; sharp (native) lives
 * in `resources/native/node_modules` (see `electron-builder.yml`).
 */
function sharpFallbackDirs(): string[] {
  const dirs: string[] = [];
  const env = process.env['MOCKUP_NATIVE_MODULES'];
  if (env) dirs.push(env);
  const resources = (process as { resourcesPath?: string }).resourcesPath;
  if (resources) dirs.push(path.join(resources, 'native', 'node_modules'));
  // packaged CLI daemon: resources/cli/daemon.mjs
  if (process.argv[1]) {
    dirs.push(path.join(path.dirname(process.argv[1]), '..', 'native', 'node_modules'));
  }
  return dirs;
}

/** Loads sharp (normal import or, in the packaged app, from `resources/native/node_modules`). */
export async function loadSharp(): Promise<typeof Sharp> {
  try {
    return (await import('sharp')).default;
  } catch (first) {
    for (const dir of sharpFallbackDirs()) {
      const entry = path.join(dir, 'sharp');
      if (!fs.existsSync(path.join(entry, 'package.json'))) continue;
      return createRequire(import.meta.url)(entry) as typeof Sharp;
    }
    throw first;
  }
}

/**
 * Optimizes `assets/` images with sharp: downscales to `maxWidth` (never upscales), converts to WebP
 * (or keeps the format) and only adopts the result if it is smaller. Writes new files (does not
 * delete the originals) and rewrites references in a single `applyOps` call (one undo).
 */
export async function optimizeDocAssets(
  ctx: AssetsServiceCtx,
  docId: string,
  opts: OptimizeOptions,
  applyOps: (ops: Op[]) => void,
): Promise<OptimizeResult> {
  const dir = requireAssetsDir(ctx, docId);
  if (!dir) throw new RouteError(409, 'The document has no path on disk yet; save it first.');
  let sharp: typeof Sharp;
  try {
    sharp = await loadSharp();
  } catch (e) {
    throw new RouteError(
      501,
      `Optimization unavailable: the sharp module failed to load (${e instanceof Error ? e.message.split('\n')[0] : String(e)}). In the installed app it ships in resources/native (Windows x64 only); reinstall the app. In development: \`npm install sharp -w @mockup/server\`.`,
    );
  }
  const refs = collectAssetRefs(ctx.store.get(docId));
  const quality = Math.min(100, Math.max(1, Math.round(opts.quality ?? 82)));
  const format = opts.format ?? 'webp';

  const skipped: OptimizeResult['skipped'] = [];
  let targets: string[];
  if (opts.paths?.length) {
    targets = [];
    for (const p of opts.paths) {
      const r = resolveRel(ctx, docId, p);
      if (!fs.existsSync(r.abs)) skipped.push({ path: r.rel, reason: 'file not found' });
      else targets.push(r.rel);
    }
  } else {
    targets = (await walkFiles(dir)).map((f) => f.rel).filter((r) => refs.has(r));
    targets = targets.filter((r) => kindOfExt(path.extname(r)) === 'image');
  }

  const results: OptimizeResult['results'] = [];
  const renamed = new Map<string, string>();
  for (const rel of [...new Set(targets)]) {
    const ext = path.extname(rel).toLowerCase();
    if (!OPTIMIZABLE.has(ext)) {
      skipped.push({
        path: rel,
        reason:
          ext === '.svg'
            ? 'SVG is vector'
            : ext === '.gif'
              ? 'GIF (may be animated)'
              : 'not an optimizable image',
      });
      continue;
    }
    const abs = path.join(dir, rel);
    const input = await fs.promises.readFile(abs);
    try {
      const meta = await sharp(input, { animated: true }).metadata();
      if ((meta.pages ?? 1) > 1) {
        skipped.push({ path: rel, reason: 'animated image' });
        continue;
      }
      let pipe = sharp(input).rotate();
      if (opts.maxWidth && meta.width && meta.width > opts.maxWidth) {
        pipe = pipe.resize({ width: Math.round(opts.maxWidth), withoutEnlargement: true });
      }
      const outExt = format === 'webp' ? '.webp' : ext === '.jpeg' ? '.jpg' : ext;
      if (outExt === '.webp') pipe = pipe.webp({ quality });
      else if (outExt === '.jpg') pipe = pipe.jpeg({ quality, mozjpeg: true });
      else if (outExt === '.png') pipe = pipe.png({ compressionLevel: 9, effort: 8 });
      else pipe = pipe.avif({ quality });
      const output = await pipe.toBuffer();
      if (output.length >= input.length) {
        skipped.push({
          path: rel,
          reason: `kept (${input.length} B; the result was not smaller)`,
        });
        continue;
      }
      const relDir = path.posix.dirname(rel);
      const stem = path.posix.basename(rel, path.extname(rel));
      const name =
        outExt === (ext === '.jpeg' ? '.jpg' : ext)
          ? `${stem}-optimized${outExt}`
          : `${stem}${outExt}`;
      const finalName = await writeAsset(
        path.join(dir, relDir === '.' ? '' : relDir),
        name,
        output,
      );
      const newPath = relDir === '.' ? finalName : `${relDir}/${finalName}`;
      const outInfo = detectAsset(output);
      if (outInfo) getLibrary(ctx.dataDir).add(output, { name: finalName, info: outInfo });
      results.push({ path: rel, newPath, before: input.length, after: output.length });
      renamed.set(rel, newPath);
    } catch (e) {
      skipped.push({
        path: rel,
        reason: `processing failed (${e instanceof Error ? e.message : String(e)})`,
      });
    }
  }
  // sharp processing is async and can take a while: re-read the document now so the ops
  // (setData/setFonts write whole lists) start from the current state and do not undo edits made
  // while the images were being processed.
  const current = ctx.store.get(docId);
  const currentRefs = collectAssetRefs(current);
  const ops = rewriteAssetRefsOps(current, renamed);
  if (ops.length) applyOps(ops);
  return {
    results,
    skipped,
    rewritten: [...renamed.keys()].filter((r) => currentRefs.has(r)).length,
  };
}
