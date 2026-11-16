import path from 'node:path';
import cors from 'cors';
import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import type { DocumentStore } from './store.js';
import type { McpHandler } from './mcp/session.js';

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

const LOCAL_ORIGIN = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;

export function createApp(
  store: DocumentStore,
  mcp: McpHandler,
  ctx: { getPort?: () => number; startedAt?: string } = {},
): Express {
  const app = express();
  const startedAt = ctx.startedAt ?? new Date().toISOString();

  app.use(
    cors({
      origin: (origin, cb) => cb(null, !origin || LOCAL_ORIGIN.test(origin)),
      exposedHeaders: ['mcp-session-id'],
    }),
  );
  app.use(express.json({ limit: '20mb' }));

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
    const e = err as { status?: number; type?: string; message?: string };
    const status =
      err instanceof HttpError
        ? err.status
        : e.type === 'entity.parse.failed'
          ? 400
          : (e.status ?? 400);
    res.status(status).json({ error: e.message ?? 'Erro desconhecido' });
  });

  return app;
}
