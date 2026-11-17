/**
 * Asset routes: local CDN (`/cdn/<hash>.<ext>`), listing/removal/link/optimization of a
 * document's assets (`/api/assets/:docId...`) and the global library (`/api/library`).
 */
import express from 'express';
import type { Express } from 'express';
import { ASSET_CSP } from '../http.js';
import {
  linkDocAsset,
  listDocAssets,
  optimizeDocAssets,
  removeDocAsset,
  removeUnusedAssets,
  type AssetsServiceCtx,
} from '../assetsService.js';
import { EMBEDDABLE_MIME } from '../assets.js';
import { CDN_FILE_RE, detectAsset, getLibrary, safeStem } from '../library.js';
import { RouteError, requireDoc, wrap, type RouteContext } from './shared.js';

const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);

export function registerAssetsRoutes(app: Express, ctx: RouteContext): void {
  const svc: AssetsServiceCtx = { store: ctx.store, dataDir: ctx.dataDir, getPort: ctx.getPort };
  const lib = () => getLibrary(ctx.dataDir);

  // CDN: content-addressed file; immutable, so the cache can last forever.
  app.get('/cdn/:file', (req, res) => {
    const name = String(req.params.file);
    const file = CDN_FILE_RE.test(name) ? lib().fileFor(name) : null;
    if (!file) {
      res.status(404).json({ error: 'File not found in the library' });
      return;
    }
    const ext = name.slice(name.lastIndexOf('.')).toLowerCase();
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    res.setHeader('Content-Security-Policy', ASSET_CSP);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Type', EMBEDDABLE_MIME[ext] ?? 'application/octet-stream');
    // SVG opens in the tab (direct link); the sandboxed CSP blocks script and loads.
    if (ext === '.svg') res.setHeader('Content-Disposition', 'inline');
    res.sendFile(file, { dotfiles: 'allow' }, (err) => {
      if (err && !res.headersSent) res.status(404).json({ error: 'File not found' });
    });
  });

  app.get(
    '/api/assets/:docId',
    wrap(async (req, res) => {
      res.json({ assets: await listDocAssets(svc, String(req.params.docId)) });
    }),
  );

  app.delete(
    '/api/assets/:docId',
    wrap(async (req, res) => {
      const rel = str(req.query.path);
      if (!rel) throw new RouteError(400, 'Provide the asset path in ?path=');
      const force = ['1', 'true'].includes(String(req.query.force ?? ''));
      res.json({ removed: await removeDocAsset(svc, String(req.params.docId), rel, force) });
    }),
  );

  app.post(
    '/api/assets/:docId/remove-unused',
    wrap(async (req, res) => {
      const body = (req.body ?? {}) as { dryRun?: unknown };
      res.json(await removeUnusedAssets(svc, String(req.params.docId), body.dryRun === true));
    }),
  );

  app.post(
    '/api/assets/:docId/link',
    wrap(async (req, res) => {
      const rel = str((req.body as { path?: unknown } | undefined)?.path);
      if (!rel) throw new RouteError(400, 'Missing required field: path');
      res.json(await linkDocAsset(svc, String(req.params.docId), rel));
    }),
  );

  app.post(
    '/api/assets/:docId/optimize',
    wrap(async (req, res) => {
      const docId = String(req.params.docId);
      const b = (req.body ?? {}) as Record<string, unknown>;
      const paths = Array.isArray(b['paths'])
        ? b['paths'].filter((p): p is string => typeof p === 'string')
        : undefined;
      const maxWidth =
        typeof b['maxWidth'] === 'number' && b['maxWidth'] > 0 ? b['maxWidth'] : undefined;
      const format = b['format'] === 'keep' ? 'keep' : 'webp';
      const quality = typeof b['quality'] === 'number' ? b['quality'] : undefined;
      requireDoc(ctx, docId);
      const r = await optimizeDocAssets(svc, docId, { paths, maxWidth, format, quality }, (ops) => {
        ctx.store.applyOps(docId, ops, { source: 'editor', label: 'optimize_assets' });
      });
      res.json({ results: r.results, skipped: r.skipped });
    }),
  );

  // Global library (the CDN itself, with an index).
  app.get(
    '/api/library',
    wrap((req, res) => {
      res.json({ assets: lib().list(str(req.query.query)) });
    }),
  );

  app.post(
    '/api/library',
    express.raw({ type: () => true, limit: ctx.maxAssetBytes }),
    wrap((req, res) => {
      const body: unknown = req.body;
      if (!Buffer.isBuffer(body) || body.length === 0) {
        throw new RouteError(400, 'Empty body: send the image or font bytes');
      }
      const info = detectAsset(body);
      if (!info) {
        throw new RouteError(
          400,
          'The content is not a recognized image (PNG, JPEG, GIF, WebP, SVG, AVIF) or font (woff2, woff, ttf, otf).',
        );
      }
      const stem = safeStem(str(req.query.name) ?? '', 'image');
      res.json(lib().add(body, { name: `${stem}${info.ext}`, info }));
    }),
  );

  app.post(
    '/api/library/:hash/import',
    wrap(async (req, res) => {
      const hash = String(req.params.hash);
      const docId = str((req.body as { docId?: unknown } | undefined)?.docId);
      if (!docId) throw new RouteError(400, 'Missing required field: docId');
      requireDoc(ctx, docId);
      if (!lib().has(hash)) throw new RouteError(404, `Asset not found in the library: ${hash}`);
      const dir = ctx.store.assetsDir(docId);
      if (!dir) throw new RouteError(409, 'Save the document before importing from the library');
      res.json({ src: await lib().importTo(hash, dir) });
    }),
  );

  app.delete(
    '/api/library/:hash',
    wrap((req, res) => {
      if (!lib().remove(String(req.params.hash))) {
        throw new RouteError(404, 'Asset not found in the library');
      }
      res.json({ removed: true });
    }),
  );
}
