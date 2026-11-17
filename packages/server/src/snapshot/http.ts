/**
 * Rotas HTTP de importação: `POST /api/snapshot`, `/api/import/url` e `/api/import/html`.
 * Registradas por `registerSnapshotRoutes`, chamada em `http.ts` antes do CORS global e do
 * `express.json` de 20 MB (um payload de snapshot com imagens passa disso: o parser daqui aceita 64 MB).
 */
import cors from 'cors';
import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import {
  SNAPSHOT_ROUTES,
  isSnapshotPayload,
  type ImportHtmlRequest,
  type ImportUrlRequest,
  type SnapshotImportRequest,
} from '@mockup/snapshot-core';
import type { RenderProvider } from '../render.js';
import type { DocumentStore } from '../store.js';
import { importFromHtml, importFromPayload, importFromUrl } from './service.js';
import { SnapshotImportError, parsePlacement } from './validate.js';

export const SNAPSHOT_BODY_LIMIT = '64mb';

const LOCAL_ORIGIN = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;
const EXTENSION_ORIGIN = /^chrome-extension:\/\/[a-p]{32}$/;

/** `Origin` de uma extensão MV3 (`chrome-extension://<id de 32 letras a-p>`). */
export function isExtensionOrigin(origin: string | undefined): boolean {
  return !!origin && EXTENSION_ORIGIN.test(origin);
}

/**
 * Rota que aceita a origem da extensão: só `POST /api/snapshot` (e o preflight dela). O guard de
 * escrita do `http.ts` chama isto; as demais rotas continuam recusando `chrome-extension://`.
 */
export function allowsExtensionOrigin(method: string, route: string): boolean {
  return method === 'POST' && route === SNAPSHOT_ROUTES.snapshot;
}

export interface SnapshotRoutesCtx {
  render?: RenderProvider;
}

export function registerSnapshotRoutes(
  app: Express,
  store: DocumentStore,
  ctx: SnapshotRoutesCtx = {},
): void {
  // CORS próprio: o global fica depois destas rotas. A extensão só é aceita em /api/snapshot.
  const localCors = cors({ origin: (o, cb) => cb(null, !o || LOCAL_ORIGIN.test(o)) });
  const snapshotCors = cors({
    origin: (o, cb) => cb(null, !o || LOCAL_ORIGIN.test(o) || EXTENSION_ORIGIN.test(o)),
    methods: ['POST', 'OPTIONS'],
    allowedHeaders: ['content-type'],
  });
  const bigJson = express.json({ limit: SNAPSHOT_BODY_LIMIT });

  // Origem das mudanças: 'editor'. Quem importa pelas rotas é o usuário (extensão, colar no editor,
  // botão de importar), não um agente; com 'mcp' o editor mostraria o selo "IA trabalhando".
  const service = { store, render: ctx.render, source: 'editor' } as const;

  const handle =
    (fn: (body: Record<string, unknown>) => Promise<unknown>) =>
    (req: Request, res: Response, next: NextFunction): void => {
      const body: unknown = req.body;
      if (!body || typeof body !== 'object' || Array.isArray(body)) {
        next(
          new SnapshotImportError(
            400,
            'Corpo inválido: envie um objeto JSON (Content-Type: application/json).',
          ),
        );
        return;
      }
      Promise.resolve()
        .then(() => fn(body as Record<string, unknown>))
        .then(
          (result) => void res.json(result),
          (e: unknown) => {
            // 502/503 também precisam sair com a mensagem (o handler global só expõe 4xx)
            if (e instanceof SnapshotImportError) res.status(e.status).json({ error: e.message });
            else next(e);
          },
        );
    };

  app.options(SNAPSHOT_ROUTES.snapshot, snapshotCors);
  app.post(
    SNAPSHOT_ROUTES.snapshot,
    snapshotCors,
    bigJson,
    handle((body) => {
      // aceita `{ payload, docId?, ... }` (SnapshotImportRequest) ou o payload puro no corpo
      const request: SnapshotImportRequest =
        body.payload === undefined && (isSnapshotPayload(body) || 'format' in body)
          ? { payload: body as unknown as SnapshotImportRequest['payload'] }
          : { ...parsePlacement(body), payload: body.payload as SnapshotImportRequest['payload'] };
      return importFromPayload(service, request);
    }),
  );
  app.post(
    SNAPSHOT_ROUTES.importUrl,
    localCors,
    bigJson,
    handle((body) => importFromUrl(service, body as unknown as ImportUrlRequest)),
  );
  app.post(
    SNAPSHOT_ROUTES.importHtml,
    localCors,
    bigJson,
    handle((body) => importFromHtml(service, body as unknown as ImportHtmlRequest)),
  );
}
