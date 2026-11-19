import fs from 'node:fs';
import path from 'node:path';
import { PREVIEW_STATES, exportSvg, type PreviewState } from '@mockup/core';
import cors from 'cors';
import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import { assetDataUrl, writeAsset } from './assets.js';
import { docWithNodes, renderTargetFor } from './component-view.js';
import { KitError, listKits, loadKit } from './kits.js';
import { detectAsset, getLibrary } from './library.js';
import { detectVideo, fetchAnimation, validateAnimation } from './mediaBytes.js';
import { OutlineError, buildTextOutlineOps } from './outlines.js';
import type { TrashProvider } from './files.js';
import { renderUnavailableMessage, type RenderProvider, type RenderScale } from './render.js';
import type { DocumentStore } from './store.js';
import type { McpHandler } from './mcp/session.js';
import { readRecent } from './paths.js';
import { registerFeatureRoutes } from './routes/index.js';
import { isAllowedOrigin } from './ws.js';
import {
  allowsExtensionOrigin,
  isExtensionOrigin,
  registerSnapshotRoutes,
} from './snapshot/http.js';

export const SERVER_NAME = 'mockup-studio';
export const SERVER_VERSION = '0.1.0';

export interface HealthInfo {
  ok: boolean;
  /** Identifies the service (always `mockup-studio`); the CLI checks it before reusing the port. */
  name: string;
  pid: number;
  port: number;
  startedAt: string;
  version: string;
  docs: number;
  activeDocId: string | null;
  /** `true` when the daemon has a render engine (desktop app / headless Electron). */
  render: boolean;
  /**
   * Who started the daemon: `desktop` (Electron app, windowed or headless), `headless` (Node
   * daemon detached by the CLI) or `serve` (the user's `mockup serve`). Absent in older daemons.
   */
  mode?: DaemonMode;
  /** `true` when `POST /api/shutdown` is accepted (otherwise it responds 409). */
  canShutdown?: boolean;
}

export type DaemonMode = 'desktop' | 'headless' | 'serve';

class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

const LOCAL_HOSTNAMES = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

/** Validates the hostname of the Host header (any port) against the local hosts and the configured extras. */
export function isAllowedHost(hostHeader: string | undefined, extra: string[] = []): boolean {
  if (!hostHeader) return false;
  let hostname: string;
  try {
    hostname = new URL(`http://${hostHeader}`).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (LOCAL_HOSTNAMES.has(hostname)) return true;
  return extra.some((h) => {
    const x = h.toLowerCase();
    return x === hostname || x === `[${hostname}]` || `[${x}]` === hostname;
  });
}

export const MAX_ASSET_BYTES = 20 * 1024 * 1024;
const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.avif']);
/** Videos accepted on upload (up to 500 MB). */
export const VIDEO_EXTS = new Set(['.mp4', '.webm', '.mov', '.m4v', '.ogv']);
/** Lottie/Rive animations accepted on upload (up to 50 MB). */
export const ANIMATION_EXTS = new Set(['.json', '.lottie', '.riv']);
export const MAX_VIDEO_BYTES = 500 * 1024 * 1024;
export const MAX_ANIMATION_BYTES = 50 * 1024 * 1024;
const UPLOAD_EXTS = [...IMAGE_EXTS, ...VIDEO_EXTS, ...ANIMATION_EXTS];

/** Upload size limit by extension (image 20 MB, animation 50 MB, video 500 MB). */
export function maxBytesFor(ext: string): number {
  if (VIDEO_EXTS.has(ext)) return MAX_VIDEO_BYTES;
  if (ANIMATION_EXTS.has(ext)) return MAX_ANIMATION_BYTES;
  return MAX_ASSET_BYTES;
}

/** Windows device names: `CON.png` or `nul.tar.gz` open the device, not a file. */
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\.|$)/i;

/**
 * Safe name for an asset: basename, only [a-zA-Z0-9._-], no leading dot, max 80 chars;
 * no trailing dot; Windows reserved names (`CON`, `NUL`, `COM1`, `LPT1`...) get `-file`.
 */
export function sanitizeAssetName(raw: string): { base: string; ext: string } {
  const last = raw.split(/[\\/]/).pop() ?? '';
  const ext = path.extname(last).toLowerCase();
  if (!UPLOAD_EXTS.includes(ext)) {
    throw new HttpError(400, `Extension not allowed; use: ${UPLOAD_EXTS.join(', ')}`);
  }
  let base = last
    .slice(0, last.length - ext.length)
    .replace(/[^a-zA-Z0-9._-]/g, '-')
    .replace(/^\.+/, '');
  base = base.slice(0, 80 - ext.length).replace(/[. ]+$/, '');
  if (!base) base = 'image';
  if (WINDOWS_RESERVED.test(base)) base = base.replace(/^[^.]+/, (m) => `${m}-file`);
  return { base, ext };
}

const LOCAL_ORIGIN = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Policy for `/assets` responses: an SVG opened directly in a tab runs no script and loads
 * nothing from the daemon origin (which reaches `/api`, `/mcp` and the WS). `<img>` ignores these headers.
 */
export const ASSET_CSP = "default-src 'none'; img-src data:; style-src 'unsafe-inline'; sandbox";

export function createApp(
  store: DocumentStore,
  mcp: McpHandler,
  ctx: {
    getPort?: () => number;
    startedAt?: string;
    allowedHosts?: string[];
    dataDir?: string;
    maxAssetBytes?: number;
    render?: RenderProvider;
    /** OS trash for deleted documents (desktop app); without it they are deleted permanently. */
    trash?: TrashProvider;
    /** Editor build served at `/` (SPA). */
    editorDir?: string;
    /** Who started the daemon (reported in health). */
    mode?: DaemonMode;
    /** Shuts the daemon down (saving the documents); without it `POST /api/shutdown` responds 409. */
    shutdown?: () => void;
  } = {},
): Express {
  const app = express();
  const startedAt = ctx.startedAt ?? new Date().toISOString();

  app.use((req, res, next) => {
    if (!isAllowedHost(req.headers.host, ctx.allowedHosts)) {
      res.status(403).json({ error: 'Host not allowed' });
      return;
    }
    next();
  });
  // Browsers send "simple" POSTs (text/plain, form) from any site without a preflight:
  // reject writes from another origin before reading the body. Clients without Origin (CLI, agents) pass.
  app.use((req, res, next) => {
    const route = req.path.toLowerCase();
    const guarded =
      route === '/mcp' ||
      route.startsWith('/mcp/') ||
      (route.startsWith('/api/') && !SAFE_METHODS.has(req.method));
    const extension =
      isExtensionOrigin(req.headers.origin) && allowsExtensionOrigin(req.method, route);
    if (guarded && !extension && !isAllowedOrigin(req.headers.origin)) {
      res.status(403).json({ error: 'Origin not allowed' });
      return;
    }
    next();
  });
  // Snapshot import (extension, editor, MCP): before the global CORS and the 20 MB json parser.
  registerSnapshotRoutes(app, store, { render: ctx.render });
  app.use(
    cors({
      origin: (origin, cb) => cb(null, !origin || LOCAL_ORIGIN.test(origin)),
      exposedHeaders: ['mcp-session-id'],
    }),
  );

  const wrap =
    (fn: (req: Request, res: Response) => unknown | Promise<unknown>) =>
    (req: Request, res: Response, next: NextFunction): void => {
      Promise.resolve()
        .then(() => fn(req, res))
        .catch(next);
    };

  const str = (v: unknown, field: string): string => {
    if (typeof v !== 'string' || !v) throw new HttpError(400, `Missing required field: ${field}`);
    return v;
  };

  // Media upload: raw binary body, mounted before express.json for any Content-Type.
  // The limit is per extension and is applied BEFORE buffering (one raw parser per limit).
  const limitFor = (ext: string): number =>
    ctx.maxAssetBytes !== undefined ? ctx.maxAssetBytes : maxBytesFor(ext);
  const rawParsers = new Map<number, express.RequestHandler>();
  const rawFor = (limit: number): express.RequestHandler => {
    let h = rawParsers.get(limit);
    if (!h) rawParsers.set(limit, (h = express.raw({ type: () => true, limit })));
    return h;
  };
  const extOf = (req: Request): string =>
    path.extname(typeof req.query.name === 'string' ? req.query.name : '').toLowerCase();
  /** Folder (under assets/) and final extension of a file, checking the bytes. */
  const classifyUpload = (ext: string, body: Buffer): { sub: string; ext: string } => {
    if (VIDEO_EXTS.has(ext)) {
      const kind = detectVideo(body.subarray(0, 16));
      if (!kind)
        throw new HttpError(
          415,
          'The file is not a recognized video (mp4, m4v, mov, webm or ogv). Check the file.',
        );
      return { sub: 'videos', ext: kind.ext };
    }
    if (ext === '.riv' || ext === '.json' || ext === '.lottie') {
      const provider = ext === '.riv' ? 'rive' : 'lottie';
      const v = validateAnimation(body, provider);
      if (!v.startsWith('.')) throw new HttpError(415, v);
      return { sub: provider, ext: v };
    }
    return { sub: '', ext };
  };
  app.post(
    '/api/assets/:docId',
    (req, _res, next) => {
      // fail early (without reading the body) for a missing document or one without a path
      try {
        const docId = String(req.params.docId);
        if (!store.list().some((d) => d.docId === docId))
          throw new HttpError(404, `Document not found: ${docId}`);
        if (!store.assetsDir(docId))
          throw new HttpError(409, 'Save the document before uploading images');
        // reject early, without reading the body, anything over the extension's limit
        const limit = limitFor(extOf(req));
        if (Number(req.headers['content-length'] ?? 0) > limit)
          throw new HttpError(413, 'File too large for this extension');
        // the raw parser only accepts the extension's limit (also applies to chunked bodies)
        rawFor(limit)(req, _res, next);
      } catch (e) {
        next(e);
      }
    },
    wrap(async (req, res) => {
      const docId = String(req.params.docId);
      const dir = store.assetsDir(docId)!;
      const name = typeof req.query.name === 'string' ? req.query.name : '';
      const { base, ext } = sanitizeAssetName(name);
      const body: unknown = req.body;
      if (!Buffer.isBuffer(body) || body.length === 0)
        throw new HttpError(400, 'Empty body: send the file bytes');
      if (body.length > limitFor(ext))
        throw new HttpError(
          413,
          `File exceeds the ${Math.round(limitFor(ext) / 1024 / 1024)} MB limit for ${ext}`,
        );
      const cls = classifyUpload(ext, body);
      const file = await writeAsset(path.join(dir, cls.sub), `${base}${cls.ext}`, body);
      // register in the local CDN (direct link in the asset listing)
      const info = detectAsset(body);
      if (info) getLibrary(ctx.dataDir).add(body, { name: file, info });
      res.json({ src: cls.sub ? `${cls.sub}/${file}` : file });
    }),
  );
  // Copies a Lottie/Rive from an http(s) URL into assets/lottie|rive/ (offline-first).
  app.post(
    '/api/assets/:docId/fetch',
    express.json({ limit: '64kb' }),
    wrap(async (req, res) => {
      const docId = String(req.params.docId);
      if (!store.list().some((d) => d.docId === docId))
        throw new HttpError(404, `Document not found: ${docId}`);
      const dir = store.assetsDir(docId);
      if (!dir) throw new HttpError(409, 'Save the document before copying files');
      const { url, kind } = (req.body ?? {}) as { url?: unknown; kind?: unknown };
      if (typeof url !== 'string' || !/^https?:\/\//i.test(url))
        throw new HttpError(400, 'Field url must be an http(s) URL');
      if (kind !== 'lottie' && kind !== 'rive')
        throw new HttpError(400, 'Field kind must be "lottie" or "rive"');
      let got;
      try {
        got = await fetchAnimation(url, kind);
      } catch (e) {
        throw new HttpError(502, e instanceof Error ? e.message : String(e));
      }
      const safe = sanitizeAssetName(`${got.hint.replace(/\.[^.]*$/, '') || kind}${got.ext}`);
      const file = await writeAsset(path.join(dir, kind), `${safe.base}${safe.ext}`, got.bytes);
      res.json({ src: `${kind}/${file}` });
    }),
  );
  app.use(express.json({ limit: '20mb' }));

  app.get(
    '/api/health',
    wrap((_req, res) => {
      const body: HealthInfo = {
        ok: true,
        name: SERVER_NAME,
        pid: process.pid,
        port: ctx.getPort?.() ?? 0,
        startedAt,
        version: SERVER_VERSION,
        docs: store.list().length,
        activeDocId: store.activeDocId,
        render: !!ctx.render,
        mode: ctx.mode ?? (ctx.render ? 'desktop' : 'serve'),
        canShutdown: !!ctx.shutdown,
      };
      res.json(body);
    }),
  );

  // Requests daemon shutdown (used by `mockup stop` and when swapping for a daemon with render).
  // Protected like the other writes (local Host and absent/local Origin, in the middlewares above).
  app.post(
    '/api/shutdown',
    wrap((_req, res) => {
      if (!ctx.shutdown)
        throw new HttpError(
          409,
          'This daemon cannot be shut down over HTTP (it is the desktop app: close it from the window or the menu).',
        );
      res.status(202).json({ ok: true, pid: process.pid });
      const stop = ctx.shutdown;
      setImmediate(stop);
    }),
  );

  app.get(
    '/api/docs',
    wrap((_req, res) => {
      res.json({ documents: store.list(), activeDocId: store.activeDocId });
    }),
  );

  app.get(
    '/api/docs/:id',
    wrap((req, res) => {
      const id = String(req.params.id);
      if (!store.list().some((d) => d.docId === id))
        throw new HttpError(404, `Document not found: ${id}`);
      res.json({ info: store.getInfo(id), doc: store.get(id), selection: store.getSelection(id) });
    }),
  );

  app.get(
    '/api/recent',
    wrap((_req, res) => {
      res.json({ recent: readRecent(ctx.dataDir).filter((p) => fs.existsSync(p)) });
    }),
  );

  // Component kits (kits/ folder): the editor lists and imports through here.
  app.get(
    '/api/kits',
    wrap((_req, res) => {
      res.json({ kits: listKits() });
    }),
  );

  app.get(
    '/api/kits/:name',
    wrap((req, res) => {
      const name = String(req.params.name);
      // plain names only: file paths are not accepted over HTTP
      if (!/^[\w.-]+$/.test(name)) throw new HttpError(404, `Kit not found: ${name}`);
      try {
        res.json(loadKit(name).doc);
      } catch (e) {
        if (e instanceof KitError) throw new HttpError(e.status, e.message);
        throw e;
      }
    }),
  );

  app.post(
    '/api/open',
    wrap(async (req, res) => {
      const { doc: _doc, ...info } = await store.open(str(req.body?.path, 'path'));
      res.json(info);
    }),
  );

  app.post(
    '/api/new',
    wrap(async (req, res) => {
      const { doc: _doc, ...info } = await store.create(
        str(req.body?.path, 'path'),
        str(req.body?.name, 'name'),
      );
      res.json(info);
    }),
  );

  app.post(
    '/api/save',
    wrap(async (req, res) => {
      const docId = typeof req.body?.docId === 'string' ? req.body.docId : undefined;
      res.json({ path: await store.save(docId) });
    }),
  );

  app.post(
    '/api/active',
    wrap((req, res) => {
      store.setActive(str(req.body?.docId, 'docId'));
      res.json({ ok: true, activeDocId: store.activeDocId });
    }),
  );

  // Text to outlines (called by the editor): converts text nodes to svg, one undo entry.
  app.post(
    '/api/docs/:docId/text-to-outlines',
    wrap(async (req, res) => {
      const docId = String(req.params.docId);
      if (!store.list().some((d) => d.docId === docId))
        throw new HttpError(404, `Document not found: ${docId}`);
      const nodeIds: unknown = req.body?.nodeIds;
      if (
        !Array.isArray(nodeIds) ||
        nodeIds.length === 0 ||
        nodeIds.some((n) => typeof n !== 'string')
      )
        throw new HttpError(400, 'nodeIds must be a list of text node ids, e.g.: ["tx_ab12cd34"]');
      try {
        const out = await buildTextOutlineOps({
          doc: docWithNodes(store.get(docId), nodeIds as string[]),
          docId,
          nodeIds: nodeIds as string[],
          assetsDir: store.assetsDir(docId),
          render: ctx.render,
        });
        store.applyOps(docId, out.ops, { source: 'editor', label: 'text_to_outlines' });
        res.json({ nodeIds: out.nodeIds, notes: out.notes });
      } catch (e) {
        if (e instanceof OutlineError) throw new HttpError(e.status, e.message);
        throw e;
      }
    }),
  );

  app.get(
    '/assets/:docId/*splat',
    wrap((req, res) => {
      const docId = String(req.params.docId);
      if (!store.list().some((d) => d.docId === docId))
        throw new HttpError(404, 'Document not found');
      const dir = store.assetsDir(docId);
      if (!dir) throw new HttpError(404, 'Document has no assets folder');
      const splat = (req.params as Record<string, unknown>).splat;
      const rel = Array.isArray(splat) ? splat.join('/') : String(splat ?? '');
      if (!rel || rel.split(/[\\/]/).includes('..') || rel.includes('\0')) {
        throw new HttpError(403, 'Invalid path');
      }
      const root = path.resolve(dir);
      const target = path.resolve(root, rel);
      if (!target.startsWith(root + path.sep)) throw new HttpError(403, 'Invalid path');
      res.setHeader('Content-Security-Policy', ASSET_CSP);
      res.setHeader('X-Content-Type-Options', 'nosniff');
      if (path.extname(target).toLowerCase() === '.svg')
        res.setHeader('Content-Disposition', 'attachment');
      return new Promise<void>((resolve) => {
        res.sendFile(target, { dotfiles: 'allow' }, (err) => {
          if (err && !res.headersSent) res.status(404).json({ error: 'File not found' });
          resolve();
        });
      });
    }),
  );

  // Node render: PNG/JPG via the render engine (Electron) and SVG exported by core.
  app.get(
    '/render/:docId/:file',
    wrap(async (req, res) => {
      const docId = String(req.params.docId);
      const m = /^(.+)\.(png|jpg|svg)$/i.exec(String(req.params.file));
      if (!m) throw new HttpError(404, 'Invalid format: use .png, .jpg or .svg');
      const nodeId = m[1]!;
      const ext = m[2]!.toLowerCase();
      if (!store.list().some((d) => d.docId === docId))
        throw new HttpError(404, `Document not found: ${docId}`);
      // expanded instances (and preview of a main `cp_...`): the render page does not know components
      const target = renderTargetFor(store.get(docId), nodeId);
      if (!target) throw new HttpError(404, `Node not found: ${nodeId}`);
      const doc = target.doc;
      const renderNodeId = target.nodeId;
      res.setHeader('Cache-Control', 'no-store');

      if (ext === 'svg') {
        const layout = ctx.render
          ? await ctx.render.measure({
              doc,
              docId,
              nodeId: renderNodeId,
              assetsDir: store.assetsDir(docId),
            })
          : undefined;
        const assets = store.assetsDir(docId);
        const resolveImage = (src: string): string | undefined => assetDataUrl(assets, src);
        let svg: string;
        try {
          svg = exportSvg(doc, { nodeId: renderNodeId, layout, resolveImage });
        } catch (e) {
          console.error('[mockup-daemon] exportSvg error:', e instanceof Error ? e.message : e);
          res.status(500).json({ error: 'Failed to export the SVG' });
          return;
        }
        // Same isolation as assets: opened directly in a tab, the SVG runs no script and loads nothing.
        res.setHeader('Content-Security-Policy', ASSET_CSP);
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.type('image/svg+xml; charset=utf-8').send(svg);
        return;
      }

      if (!ctx.render) {
        res
          .status(503)
          .json({ error: renderUnavailableMessage({ pid: process.pid, port: ctx.getPort?.() }) });
        return;
      }
      const scale = Number(req.query.scale ?? 1);
      if (![1, 2, 3].includes(scale)) throw new HttpError(400, 'scale must be 1, 2 or 3');
      const quality = req.query.quality === undefined ? undefined : Number(req.query.quality);
      if (quality !== undefined && !(quality >= 0 && quality <= 100))
        throw new HttpError(400, 'quality must be between 0 and 100');
      const maxWidth = req.query.maxWidth === undefined ? undefined : Number(req.query.maxWidth);
      if (maxWidth !== undefined && !(Number.isFinite(maxWidth) && maxWidth > 0))
        throw new HttpError(400, 'Invalid maxWidth');
      const t = String(req.query.transparent ?? '');
      const stateQ = req.query.state === undefined ? undefined : String(req.query.state);
      if (stateQ !== undefined && !(PREVIEW_STATES as readonly string[]).includes(stateQ))
        throw new HttpError(400, `state must be one of: ${PREVIEW_STATES.join(', ')}`);
      let result;
      try {
        result = await ctx.render.capture({
          doc,
          docId,
          nodeId: renderNodeId,
          assetsDir: store.assetsDir(docId),
          scale: scale as RenderScale,
          format: ext === 'jpg' ? 'jpg' : 'png',
          quality,
          maxWidth,
          transparent: t === '1' || t === 'true',
          state: stateQ as PreviewState | undefined,
        });
      } catch (e) {
        throw new HttpError(500, e instanceof Error ? e.message : 'Render failed');
      }
      res.type(result.mime).send(result.data);
    }),
  );

  // Assets/CDN (/cdn, /api/assets, /api/library), repeater data and file organization.
  registerFeatureRoutes(app, {
    store,
    dataDir: ctx.dataDir,
    render: ctx.render,
    trash: ctx.trash,
    getPort: ctx.getPort,
    maxAssetBytes: ctx.maxAssetBytes ?? MAX_ASSET_BYTES,
  });

  app.all('/mcp', (req, res) => {
    if (!['POST', 'GET', 'DELETE'].includes(req.method)) {
      res.status(405).json({ error: 'Method not allowed' });
      return;
    }
    void mcp.handleMcpRequest(req, res);
  });

  // Static editor (desktop app and `mockup serve`): same origin as /api, /assets and /ws.
  if (ctx.editorDir && fs.existsSync(path.join(ctx.editorDir, 'index.html'))) {
    const editorDir = path.resolve(ctx.editorDir);
    app.use(express.static(editorDir, { index: 'index.html', fallthrough: true }));
    // SPA fallback: GET without an extension outside the daemon routes returns index.html.
    const reserved = /^\/(api|assets|cdn|mcp|ws|render)(\/|$)/i;
    app.use((req, res, next) => {
      if (req.method !== 'GET' || reserved.test(req.path) || path.extname(req.path)) return next();
      res.sendFile(path.join(editorDir, 'index.html'));
    });
  }

  app.use((_req, res) => {
    res.status(404).json({ error: 'Route not found' });
  });

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (res.headersSent) return;
    const e = err as { status?: number; type?: string; message?: string; expose?: boolean };
    let status: number | null = null;
    if (err instanceof HttpError) status = err.status;
    else if (typeof e?.type === 'string' && e.type.startsWith('entity.'))
      status = e.status && e.status >= 400 && e.status < 500 ? e.status : 400;
    else if (e?.expose === true && e.status && e.status >= 400 && e.status < 500) status = e.status;
    if (status === null) {
      console.error('[mockup-daemon] internal error:', e?.message ?? err);
      res.status(500).json({ error: 'Internal error' });
      return;
    }
    res.status(status).json({ error: e.message ?? 'Invalid request' });
  });

  return app;
}
