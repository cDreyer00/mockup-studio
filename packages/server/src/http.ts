import fs from 'node:fs';
import path from 'node:path';
import cors from 'cors';
import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import type { DocumentStore } from './store.js';
import type { McpHandler } from './mcp/session.js';
import { readRecent } from './paths.js';

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
}

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

/** Nome seguro para um asset: basename, só [a-zA-Z0-9._-], sem ponto inicial, máx. 80 chars. */
export function sanitizeAssetName(raw: string): { base: string; ext: string } {
  const last = raw.split(/[\\/]/).pop() ?? '';
  const ext = path.extname(last).toLowerCase();
  if (!IMAGE_EXTS.has(ext)) {
    throw new HttpError(400, `Extensão não permitida; use: ${[...IMAGE_EXTS].join(', ')}`);
  }
  let base = last
    .slice(0, last.length - ext.length)
    .replace(/[^a-zA-Z0-9._-]/g, '-')
    .replace(/^\.+/, '');
  base = base.slice(0, 80 - ext.length);
  if (!base) base = 'imagem';
  return { base, ext };
}

const LOCAL_ORIGIN = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;

export function createApp(
  store: DocumentStore,
  mcp: McpHandler,
  ctx: {
    getPort?: () => number;
    startedAt?: string;
    allowedHosts?: string[];
    dataDir?: string;
    maxAssetBytes?: number;
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

  // Upload de imagem: corpo binário cru, montado antes do express.json para qualquer Content-Type.
  const maxAsset = ctx.maxAssetBytes ?? MAX_ASSET_BYTES;
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
        next();
      } catch (e) {
        next(e);
      }
    },
    express.raw({ type: () => true, limit: maxAsset }),
    wrap(async (req, res) => {
      const docId = String(req.params.docId);
      const dir = store.assetsDir(docId)!;
      const name = typeof req.query.name === 'string' ? req.query.name : '';
      const { base, ext } = sanitizeAssetName(name);
      const body: unknown = req.body;
      if (!Buffer.isBuffer(body) || body.length === 0)
        throw new HttpError(400, 'Corpo vazio: envie os bytes da imagem');
      await fs.promises.mkdir(dir, { recursive: true });
      for (let i = 0; i < 1000; i++) {
        const finalName = i === 0 ? `${base}${ext}` : `${base}-${i}${ext}`;
        try {
          await fs.promises.writeFile(path.join(dir, finalName), body, { flag: 'wx' });
          res.json({ src: finalName });
          return;
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
        }
      }
      throw new HttpError(409, 'Não foi possível gerar um nome único para o arquivo');
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
      };
      res.json(body);
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
      return new Promise<void>((resolve) => {
        res.sendFile(target, { dotfiles: 'allow' }, (err) => {
          if (err && !res.headersSent) res.status(404).json({ error: 'Arquivo não encontrado' });
          resolve();
        });
      });
    }),
  );

  app.all('/mcp', (req, res) => {
    if (!['POST', 'GET', 'DELETE'].includes(req.method)) {
      res.status(405).json({ error: 'Método não permitido' });
      return;
    }
    void mcp.handleMcpRequest(req, res);
  });

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
