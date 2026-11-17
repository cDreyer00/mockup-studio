import path from 'node:path';
import { z } from 'zod';
import { foldText } from '@mockup/core';
import { writeAsset } from '../../assets.js';
import {
  baseUrl,
  cdnUrlOf,
  linkDocAsset,
  listDocAssets,
  optimizeDocAssets,
  removeUnusedAssets,
  type AssetInfo,
  type AssetsServiceCtx,
} from '../../assetsService.js';
import { detectAsset, getLibrary, safeStem, type LibraryAsset } from '../../library.js';
import { RouteError } from '../../routes/shared.js';
import { READ, ToolError, WRITE, DESTRUCTIVE, docIdField, type ToolContext } from '../context.js';
import { loadSource } from './images.js';

const kb = (bytes: number): string => `${Math.max(1, Math.round(bytes / 1024))} KB`;

/** Converts the service's status errors (shared with HTTP) into tool errors. */
async function guard<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof RouteError) throw new ToolError(e.message);
    throw e;
  }
}

function docLine(a: AssetInfo): string {
  const dims = a.width && a.height ? ` ${a.width}x${a.height}` : '';
  return `${a.path}${dims} ${a.ext.slice(1)} ${kb(a.size)} uses:${a.uses}${a.cdnUrl ? ` ${a.cdnUrl}` : ''}`;
}

function libLine(a: LibraryAsset, origin: string): string {
  const dims = a.width && a.height ? ` ${a.width}x${a.height}` : '';
  const tags = a.tags.length ? ` [${a.tags.join(', ')}]` : '';
  return `${a.name}${dims} ${a.ext} ${kb(a.size)} id:${a.hash}${tags} ${origin}${a.url}`;
}

export function registerAssetsTools(ctx: ToolContext): void {
  const { tool, store, apply } = ctx;
  const svcFor = (): AssetsServiceCtx => ({
    store,
    dataDir: ctx.opts.dataDir,
    getPort: ctx.opts.getPort,
  });
  const lib = () => getLibrary(ctx.opts.dataDir);

  tool(
    'list_assets',
    {
      title: 'List assets',
      description:
        'Lists the files in the document\'s assets/ folder (images and fonts, with size, dimensions, uses and direct /cdn link) or the global library (scope "library"). unused filters to those with no uses.',
      example: { scope: 'document', query: 'cover', unused: false },
      inputSchema: {
        docId: docIdField,
        scope: z
          .enum(['document', 'library'])
          .optional()
          .describe(
            '"document" (default): the document\'s assets/; "library": the global library.',
          ),
        query: z
          .string()
          .optional()
          .describe('Filter by name, path or tag, accent- and case-insensitive, e.g. "cover".'),
        unused: z
          .boolean()
          .optional()
          .describe('true lists only unused files (candidates for remove_unused_assets).'),
      },
      annotations: READ,
    },
    async ({ docId, scope, query, unused }) => {
      const origin = baseUrl(ctx.opts);
      if (scope === 'library') {
        const items = lib().list(query);
        if (!items.length) {
          return query
            ? `No library assets for "${query}".`
            : 'The library is empty. Use upload_asset (library: true) to add one.';
        }
        return `${items.length} asset(s) in the library:\n${items.map((a) => libLine(a, origin)).join('\n')}`;
      }
      const id = store.resolveDocId(docId);
      if (!store.assetsDir(id)) {
        return 'The document has no path on disk yet, so there is no assets/ folder. Save it or use scope "library".';
      }
      let items = await guard(() => listDocAssets(svcFor(), id));
      const q = foldText(query ?? '').trim();
      if (q) items = items.filter((a) => foldText(a.path).includes(q));
      if (unused) items = items.filter((a) => a.uses === 0 && a.kind !== 'other');
      if (!items.length) return unused ? 'No unused assets.' : 'No assets found.';
      const total = items.reduce((s, a) => s + a.size, 0);
      return `${items.length} asset(s), ${kb(total)} in total:\n${items.map(docLine).join('\n')}`;
    },
  );

  tool(
    'upload_asset',
    {
      title: 'Upload asset',
      description:
        "Adds an image or font (woff2, woff, ttf, otf) from an absolute path, http(s) URL or data URL: writes it to the document's assets/ and registers it on the local CDN. Returns the src to use in nodes and the direct /cdn link. library: true stores it in the library only.",
      example: { source: 'C:/photos/cover.png', name: 'cover', library: false },
      inputSchema: {
        source: z
          .string()
          .describe('Absolute path, http(s) URL or data URL, e.g. "C:/photos/cover.png".'),
        name: z
          .string()
          .optional()
          .describe('File name (the extension comes from the bytes), e.g. "cover".'),
        docId: docIdField,
        library: z
          .boolean()
          .optional()
          .describe(
            'true: global library only, without copying into the document (default false; with no path on disk, defaults to true).',
          ),
      },
      annotations: WRITE,
    },
    async ({ source, name, docId, library }) => {
      const { bytes, hint } = await loadSource(source);
      const info = detectAsset(bytes);
      if (!info) {
        throw new ToolError(
          'The content is not a recognized image (PNG, JPEG, GIF, WebP, SVG, AVIF) or font (woff2, woff, ttf, otf). Check the file or the URL.',
        );
      }
      const file = `${safeStem(name ?? hint, info.kind === 'font' ? 'font' : 'image')}${info.ext}`;
      const asset = lib().add(bytes, { name: file, info });
      const link = cdnUrlOf(ctx.opts, asset.hash, asset.ext);
      const dims = info.width ? ` ${info.width}x${info.height}` : '';
      const head = `${info.mime}${dims}, ${kb(bytes.length)}`;
      const dir = library ? null : store.assetsDir(store.resolveDocId(docId));
      if (!dir) {
        const why = library
          ? 'stored in the library only'
          : 'the document has no path on disk yet, so it was stored in the library only (save it to copy into assets/)';
        return `Asset ${why}: id ${asset.hash} (${head}).\nDirect link: ${link}`;
      }
      const sub = info.kind === 'font' ? 'fonts' : '';
      const finalName = await writeAsset(sub ? path.join(dir, sub) : dir, file, bytes);
      const src = sub ? `${sub}/${finalName}` : finalName;
      return `Asset uploaded: id ${asset.hash} (${head}).\nsrc (use in img nodes/setSrc): ${src}\nDirect link: ${link}\nFile: ${path.join(dir, src)}`;
    },
  );

  tool(
    'get_asset_url',
    {
      title: 'Direct link of an asset',
      description:
        'Returns the direct link (/cdn, stable and immutable), the relative src and the on-disk path of an asset. id = CDN hash, relative path in assets/ (with docId) or /cdn/... URL',
      example: { id: 'photos/cover.jpg' },
      inputSchema: {
        id: z
          .string()
          .describe(
            'Hash (32 hex), path in assets/ ("photos/cover.jpg") or URL "/cdn/<hash>.png".',
          ),
        docId: docIdField,
      },
      annotations: WRITE,
    },
    async ({ id, docId }) => {
      const key = id.trim();
      const m = /(?:^|\/cdn\/)([0-9a-f]{32})(?:\.[a-z0-9]+)?(?:[?#].*)?$/i.exec(key);
      const hash = m?.[1]?.toLowerCase();
      if (hash) {
        const r = lib().resolve(hash);
        if (!r) {
          throw new ToolError(
            `Asset "${hash}" is not in the library. Use list_assets (scope "library") or upload_asset.`,
          );
        }
        const url = cdnUrlOf(ctx.opts, hash, r.asset.ext);
        let src = '';
        try {
          const docAssets = await listDocAssets(svcFor(), store.resolveDocId(docId));
          src = docAssets.find((a) => a.hash === hash)?.path ?? '';
        } catch {
          // no document: library only
        }
        return `Direct link: ${url}\nsrc: ${src || "(not in the document's assets/; use upload_asset with the path below as source to copy it)"}\nFile: ${r.file}`;
      }
      const docKey = store.resolveDocId(docId);
      const link = await guard(() => linkDocAsset(svcFor(), docKey, key));
      const rel = key.replace(/\\/g, '/').replace(/^(\.\/)?assets\//, '');
      const dir = store.assetsDir(docKey)!;
      return `Direct link: ${link.url}\nid: ${link.hash}\nsrc: ${rel}\nFile: ${path.join(dir, rel)}`;
    },
  );

  tool(
    'optimize_assets',
    {
      title: 'Optimize images',
      description:
        'Shrinks assets/ images with sharp: caps the width (maxWidth, never upscales) and converts to WebP (or keeps the format). Only replaces when the result is smaller; rewrites the references (one undo) and keeps the originals (use remove_unused_assets afterwards). Skips SVG, GIF and fonts.',
      example: { maxWidth: 1600, format: 'webp', quality: 82 },
      inputSchema: {
        paths: z
          .array(z.string())
          .optional()
          .describe('Paths in assets/, e.g. ["photos/cover.png"] (default: all images in use).'),
        maxWidth: z
          .number()
          .int()
          .positive()
          .optional()
          .describe('Maximum width in px, e.g. 1600 (smaller images are not upscaled).'),
        format: z
          .enum(['webp', 'keep'])
          .optional()
          .describe('"webp" (default) converts; "keep" keeps png/jpg/webp/avif.'),
        quality: z
          .number()
          .int()
          .min(1)
          .max(100)
          .optional()
          .describe('Quality from 1 to 100, e.g. 82 (default 82).'),
        docId: docIdField,
      },
      annotations: WRITE,
    },
    async ({ paths, maxWidth, format, quality, docId }) => {
      const id = store.resolveDocId(docId);
      const r = await guard(() =>
        optimizeDocAssets(svcFor(), id, { paths, maxWidth, format, quality }, (ops) => {
          apply(id, ops, 'optimize_assets');
        }),
      );
      const lines = r.results.map((x) => {
        const pct = Math.round((1 - x.after / x.before) * 100);
        return `${x.path} -> ${x.newPath}: ${kb(x.before)} -> ${kb(x.after)} (-${pct}%)`;
      });
      const before = r.results.reduce((s, x) => s + x.before, 0);
      const after = r.results.reduce((s, x) => s + x.after, 0);
      const head = r.results.length
        ? `${r.results.length} image(s) optimized: ${kb(before)} -> ${kb(after)}; ${r.rewritten} reference(s) rewritten. The originals remain in assets/ (remove_unused_assets deletes the unused ones).`
        : 'No image was replaced.';
      const skipped = r.skipped.map((s) => `${s.path}: ${s.reason}`);
      return [head, ...lines, ...(skipped.length ? ['Skipped:', ...skipped] : [])].join('\n');
    },
  );

  tool(
    'remove_unused_assets',
    {
      title: 'Remove unused assets',
      description:
        'Deletes from assets/ the images and fonts that no node, style, repeater data or document font references. dryRun: true only lists, without deleting.',
      example: { dryRun: true },
      inputSchema: {
        dryRun: z.boolean().optional().describe('true: only lists what would be removed.'),
        docId: docIdField,
      },
      annotations: DESTRUCTIVE,
    },
    async ({ dryRun, docId }) => {
      const id = store.resolveDocId(docId);
      const r = await guard(() => removeUnusedAssets(svcFor(), id, dryRun === true));
      if (!r.removed.length) return `No unused assets (${r.kept} file(s) kept).`;
      return `${dryRun ? 'Would remove' : 'Removed'} ${r.removed.length} file(s) (${r.kept} kept):\n${r.removed.join('\n')}`;
    },
  );
}
