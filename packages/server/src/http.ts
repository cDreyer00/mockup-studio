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
  /** Identifica o serviço (sempre `mockup-studio`); o CLI confere antes de reutilizar a porta. */
  name: string;
  pid: number;
  port: number;
  startedAt: string;
  version: string;
  docs: number;
  activeDocId: string | null;
  /** `true` quando o daemon tem motor de render (app desktop / Electron headless). */
  render: boolean;
  /**
   * Quem iniciou o daemon: `desktop` (app Electron, janela ou headless), `headless` (daemon Node
   * destacado pelo CLI) ou `serve` (`mockup serve` do usuário). Ausente em daemons antigos.
   */
  mode?: DaemonMode;
  /** `true` quando `POST /api/shutdown` é aceito (senão responde 409). */
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

/** Valida o hostname do header Host (porta qualquer) contra os hosts locais e os extras configurados. */
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
/** Vídeos aceitos no upload (até 500 MB). */
export const VIDEO_EXTS = new Set(['.mp4', '.webm', '.mov', '.m4v', '.ogv']);
/** Animações Lottie/Rive aceitas no upload (até 50 MB). */
export const ANIMATION_EXTS = new Set(['.json', '.lottie', '.riv']);
export const MAX_VIDEO_BYTES = 500 * 1024 * 1024;
export const MAX_ANIMATION_BYTES = 50 * 1024 * 1024;
const UPLOAD_EXTS = [...IMAGE_EXTS, ...VIDEO_EXTS, ...ANIMATION_EXTS];

/** Limite de tamanho do upload pela extensão (imagem 20 MB, animação 50 MB, vídeo 500 MB). */
export function maxBytesFor(ext: string): number {
  if (VIDEO_EXTS.has(ext)) return MAX_VIDEO_BYTES;
  if (ANIMATION_EXTS.has(ext)) return MAX_ANIMATION_BYTES;
  return MAX_ASSET_BYTES;
}

/** Nomes de dispositivo do Windows: `CON.png` ou `nul.tar.gz` abrem o dispositivo, não um arquivo. */
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\.|$)/i;

/**
 * Nome seguro para um asset: basename, só [a-zA-Z0-9._-], sem ponto inicial, máx. 80 chars;
 * sem ponto final; nomes reservados do Windows (`CON`, `NUL`, `COM1`, `LPT1`…) ganham `-arquivo`.
 */
export function sanitizeAssetName(raw: string): { base: string; ext: string } {
  const last = raw.split(/[\\/]/).pop() ?? '';
  const ext = path.extname(last).toLowerCase();
  if (!UPLOAD_EXTS.includes(ext)) {
    throw new HttpError(400, `Extensão não permitida; use: ${UPLOAD_EXTS.join(', ')}`);
  }
  let base = last
    .slice(0, last.length - ext.length)
    .replace(/[^a-zA-Z0-9._-]/g, '-')
    .replace(/^\.+/, '');
  base = base.slice(0, 80 - ext.length).replace(/[. ]+$/, '');
  if (!base) base = 'imagem';
  if (WINDOWS_RESERVED.test(base)) base = base.replace(/^[^.]+/, (m) => `${m}-arquivo`);
  return { base, ext };
}

const LOCAL_ORIGIN = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Política das respostas de `/assets`: um SVG aberto direto numa aba não roda script nem carrega
 * nada na origem do daemon (que alcança `/api`, `/mcp` e o WS). `<img>` ignora esses headers.
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
    /** Build do editor servido em `/` (SPA). */
    editorDir?: string;
    /** Quem iniciou o daemon (informado no health). */
    mode?: DaemonMode;
    /** Encerra o daemon (salvando os documentos); sem ele `POST /api/shutdown` responde 409. */
    shutdown?: () => void;
  } = {},
): Express {
  const app = express();
  const startedAt = ctx.startedAt ?? new Date().toISOString();

  app.use((req, res, next) => {
    if (!isAllowedHost(req.headers.host, ctx.allowedHosts)) {
      res.status(403).json({ error: 'Host não permitido' });
      return;
    }
    next();
  });
  // Navegadores mandam POST "simples" (text/plain, form) de qualquer site sem preflight:
  // recusa escrita de outra origem antes de ler o corpo. Clientes sem Origin (CLI, agentes) passam.
  app.use((req, res, next) => {
    const route = req.path.toLowerCase();
    const guarded =
      route === '/mcp' ||
      route.startsWith('/mcp/') ||
      (route.startsWith('/api/') && !SAFE_METHODS.has(req.method));
    const extension =
      isExtensionOrigin(req.headers.origin) && allowsExtensionOrigin(req.method, route);
    if (guarded && !extension && !isAllowedOrigin(req.headers.origin)) {
      res.status(403).json({ error: 'Origem não permitida' });
      return;
    }
    next();
  });
  // Importação de snapshots (extensão, editor, MCP): antes do CORS global e do json de 20 MB.
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
    if (typeof v !== 'string' || !v)
      throw new HttpError(400, `Campo obrigatório ausente: ${field}`);
    return v;
  };

  // Upload de mídia: corpo binário cru, montado antes do express.json para qualquer Content-Type.
  // O limite vale por extensão e é aplicado ANTES de bufferizar (um parser raw por limite).
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
  /** Pasta (sob assets/) e extensão final de um arquivo, conferindo os bytes. */
  const classifyUpload = (ext: string, body: Buffer): { sub: string; ext: string } => {
    if (VIDEO_EXTS.has(ext)) {
      const kind = detectVideo(body.subarray(0, 16));
      if (!kind)
        throw new HttpError(
          415,
          'O arquivo não é um vídeo reconhecido (mp4, m4v, mov, webm ou ogv). Confira o arquivo.',
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
      // falha cedo (sem ler o corpo) para documento inexistente ou sem caminho
      try {
        const docId = String(req.params.docId);
        if (!store.list().some((d) => d.docId === docId))
          throw new HttpError(404, `Documento não encontrado: ${docId}`);
        if (!store.assetsDir(docId))
          throw new HttpError(409, 'Salve o documento antes de enviar imagens');
        // recusa cedo, sem ler o corpo, o que passa do limite da extensão
        const limit = limitFor(extOf(req));
        if (Number(req.headers['content-length'] ?? 0) > limit)
          throw new HttpError(413, 'Arquivo grande demais para esta extensão');
        // o parser raw só aceita o limite da extensão (vale também para corpo chunked)
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
        throw new HttpError(400, 'Corpo vazio: envie os bytes do arquivo');
      if (body.length > limitFor(ext))
        throw new HttpError(
          413,
          `Arquivo passa do limite de ${Math.round(limitFor(ext) / 1024 / 1024)} MB para ${ext}`,
        );
      const cls = classifyUpload(ext, body);
      const file = await writeAsset(path.join(dir, cls.sub), `${base}${cls.ext}`, body);
      // registra no CDN local (link direto na listagem de assets)
      const info = detectAsset(body);
      if (info) getLibrary(ctx.dataDir).add(body, { name: file, info });
      res.json({ src: cls.sub ? `${cls.sub}/${file}` : file });
    }),
  );
  // Copia um Lottie/Rive de uma URL http(s) para assets/lottie|rive/ (offline-first).
  app.post(
    '/api/assets/:docId/fetch',
    express.json({ limit: '64kb' }),
    wrap(async (req, res) => {
      const docId = String(req.params.docId);
      if (!store.list().some((d) => d.docId === docId))
        throw new HttpError(404, `Documento não encontrado: ${docId}`);
      const dir = store.assetsDir(docId);
      if (!dir) throw new HttpError(409, 'Salve o documento antes de copiar arquivos');
      const { url, kind } = (req.body ?? {}) as { url?: unknown; kind?: unknown };
      if (typeof url !== 'string' || !/^https?:\/\//i.test(url))
        throw new HttpError(400, 'Campo url deve ser uma URL http(s)');
      if (kind !== 'lottie' && kind !== 'rive')
        throw new HttpError(400, 'Campo kind deve ser "lottie" ou "rive"');
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

  // Pede o encerramento do daemon (usado por `mockup stop` e na troca por um daemon com render).
  // Protegida como as demais escritas (Host local e Origin ausente/local, nos middlewares acima).
  app.post(
    '/api/shutdown',
    wrap((_req, res) => {
      if (!ctx.shutdown)
        throw new HttpError(
          409,
          'Este daemon não pode ser encerrado por HTTP (é o app desktop: feche-o pela janela ou pelo menu).',
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
        throw new HttpError(404, `Documento não encontrado: ${id}`);
      res.json({ info: store.getInfo(id), doc: store.get(id), selection: store.getSelection(id) });
    }),
  );

  app.get(
    '/api/recent',
    wrap((_req, res) => {
      res.json({ recent: readRecent(ctx.dataDir).filter((p) => fs.existsSync(p)) });
    }),
  );

  // Kits de componentes (pasta kits/): o editor lista e importa por aqui.
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
      // só nomes simples: caminhos de arquivo não são aceitos por HTTP
      if (!/^[\w.-]+$/.test(name)) throw new HttpError(404, `Kit não encontrado: ${name}`);
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

  // Texto em contornos (o editor chama): converte nós de texto em svg, uma entrada de undo.
  app.post(
    '/api/docs/:docId/text-to-outlines',
    wrap(async (req, res) => {
      const docId = String(req.params.docId);
      if (!store.list().some((d) => d.docId === docId))
        throw new HttpError(404, `Documento não encontrado: ${docId}`);
      const nodeIds: unknown = req.body?.nodeIds;
      if (!Array.isArray(nodeIds) || nodeIds.length === 0 || nodeIds.some((n) => typeof n !== 'string'))
        throw new HttpError(400, 'nodeIds deve ser uma lista de ids de nós de texto, ex.: ["tx_ab12cd34"]');
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
        throw new HttpError(404, 'Documento não encontrado');
      const dir = store.assetsDir(docId);
      if (!dir) throw new HttpError(404, 'Documento sem pasta de assets');
      const splat = (req.params as Record<string, unknown>).splat;
      const rel = Array.isArray(splat) ? splat.join('/') : String(splat ?? '');
      if (!rel || rel.split(/[\\/]/).includes('..') || rel.includes('\0')) {
        throw new HttpError(403, 'Caminho inválido');
      }
      const root = path.resolve(dir);
      const target = path.resolve(root, rel);
      if (!target.startsWith(root + path.sep)) throw new HttpError(403, 'Caminho inválido');
      res.setHeader('Content-Security-Policy', ASSET_CSP);
      res.setHeader('X-Content-Type-Options', 'nosniff');
      if (path.extname(target).toLowerCase() === '.svg')
        res.setHeader('Content-Disposition', 'attachment');
      return new Promise<void>((resolve) => {
        res.sendFile(target, { dotfiles: 'allow' }, (err) => {
          if (err && !res.headersSent) res.status(404).json({ error: 'Arquivo não encontrado' });
          resolve();
        });
      });
    }),
  );

  // Render do nó: PNG/JPG pelo motor de render (Electron) e SVG exportado pelo core.
  app.get(
    '/render/:docId/:file',
    wrap(async (req, res) => {
      const docId = String(req.params.docId);
      const m = /^(.+)\.(png|jpg|svg)$/i.exec(String(req.params.file));
      if (!m) throw new HttpError(404, 'Formato inválido: use .png, .jpg ou .svg');
      const nodeId = m[1]!;
      const ext = m[2]!.toLowerCase();
      if (!store.list().some((d) => d.docId === docId))
        throw new HttpError(404, `Documento não encontrado: ${docId}`);
      // instâncias expandidas (e prévia de um principal `cp_...`): a página de render não conhece componentes
      const target = renderTargetFor(store.get(docId), nodeId);
      if (!target) throw new HttpError(404, `Nó não encontrado: ${nodeId}`);
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
          console.error('[mockup-daemon] erro no exportSvg:', e instanceof Error ? e.message : e);
          res.status(500).json({ error: 'Falha ao exportar o SVG' });
          return;
        }
        // Mesmo isolamento dos assets: aberto direto numa aba, o SVG não roda script nem carrega nada.
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
      if (![1, 2, 3].includes(scale)) throw new HttpError(400, 'scale deve ser 1, 2 ou 3');
      const quality = req.query.quality === undefined ? undefined : Number(req.query.quality);
      if (quality !== undefined && !(quality >= 0 && quality <= 100))
        throw new HttpError(400, 'quality deve estar entre 0 e 100');
      const maxWidth = req.query.maxWidth === undefined ? undefined : Number(req.query.maxWidth);
      if (maxWidth !== undefined && !(Number.isFinite(maxWidth) && maxWidth > 0))
        throw new HttpError(400, 'maxWidth inválido');
      const t = String(req.query.transparent ?? '');
      const stateQ = req.query.state === undefined ? undefined : String(req.query.state);
      if (stateQ !== undefined && !(PREVIEW_STATES as readonly string[]).includes(stateQ))
        throw new HttpError(400, `state deve ser um de: ${PREVIEW_STATES.join(', ')}`);
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
        throw new HttpError(500, e instanceof Error ? e.message : 'Falha no render');
      }
      res.type(result.mime).send(result.data);
    }),
  );

  // Assets/CDN (/cdn, /api/assets, /api/library), dados de repetidores e organização de arquivos.
  registerFeatureRoutes(app, {
    store,
    dataDir: ctx.dataDir,
    render: ctx.render,
    getPort: ctx.getPort,
    maxAssetBytes: ctx.maxAssetBytes ?? MAX_ASSET_BYTES,
  });

  app.all('/mcp', (req, res) => {
    if (!['POST', 'GET', 'DELETE'].includes(req.method)) {
      res.status(405).json({ error: 'Método não permitido' });
      return;
    }
    void mcp.handleMcpRequest(req, res);
  });

  // Editor estático (app desktop e `mockup serve`): mesma origem que /api, /assets e /ws.
  if (ctx.editorDir && fs.existsSync(path.join(ctx.editorDir, 'index.html'))) {
    const editorDir = path.resolve(ctx.editorDir);
    app.use(express.static(editorDir, { index: 'index.html', fallthrough: true }));
    // Fallback de SPA: GET sem extensão fora das rotas do daemon devolve o index.html.
    const reserved = /^\/(api|assets|cdn|mcp|ws|render)(\/|$)/i;
    app.use((req, res, next) => {
      if (req.method !== 'GET' || reserved.test(req.path) || path.extname(req.path)) return next();
      res.sendFile(path.join(editorDir, 'index.html'));
    });
  }

  app.use((_req, res) => {
    res.status(404).json({ error: 'Rota não encontrada' });
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
      console.error('[mockup-daemon] erro interno:', e?.message ?? err);
      res.status(500).json({ error: 'Erro interno' });
      return;
    }
    res.status(status).json({ error: e.message ?? 'Requisição inválida' });
  });

  return app;
}
