/**
 * HTTP import routes: `POST /api/snapshot`, `/api/import/url` and `/api/import/html`.
 * Registered by `registerSnapshotRoutes`, called in `http.ts` before the global CORS and the
 * 20 MB `express.json` (a snapshot payload with images exceeds that: the parser here accepts 64 MB).
 */
import cors from 'cors';
import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import {
  MOCKUP_EXTENSION_ID,
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
const EXTENSION_ID = /^[a-p]{32}$/;

/** Accepted ids: the extension's fixed one (from the manifest `key`) plus `MOCKUP_EXTENSION_IDS` (read on every call). */
function allowedExtensionIds(): string[] {
  const extra = (process.env.MOCKUP_EXTENSION_IDS ?? '')
    .split(/[\s,]+/)
    .filter((id) => EXTENSION_ID.test(id));
  return [MOCKUP_EXTENSION_ID, ...extra];
}

/** `Origin` of the Mockup Studio extension (`chrome-extension://<id>`); other extensions are rejected. */
export function isExtensionOrigin(origin: string | undefined): boolean {
  if (!origin) return false;
  return allowedExtensionIds().some((id) => origin === `chrome-extension://${id}`);
}

/**
 * Route that accepts the extension origin: only `POST /api/snapshot` (and its preflight). The write
 * guard in `http.ts` calls this; all other routes keep rejecting `chrome-extension://`.
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
  // Own CORS: the global one comes after these routes. The extension is only accepted on /api/snapshot.
  const localCors = cors({ origin: (o, cb) => cb(null, !o || LOCAL_ORIGIN.test(o)) });
  const snapshotCors = cors({
    origin: (o, cb) => cb(null, !o || LOCAL_ORIGIN.test(o) || isExtensionOrigin(o)),
    methods: ['POST', 'OPTIONS'],
    allowedHeaders: ['content-type'],
  });
  const bigJson = express.json({ limit: SNAPSHOT_BODY_LIMIT });

  // Change source: 'editor'. Whoever imports through these routes is the user (extension, paste in the
  // editor, import button), not an agent; with 'mcp' the editor would show the "AI working" badge.
  const service = { store, render: ctx.render, source: 'editor' } as const;

  const handle =
    (fn: (body: Record<string, unknown>) => Promise<unknown>) =>
    (req: Request, res: Response, next: NextFunction): void => {
      const body: unknown = req.body;
      if (!body || typeof body !== 'object' || Array.isArray(body)) {
        next(
          new SnapshotImportError(
            400,
            'Invalid body: send a JSON object (Content-Type: application/json).',
          ),
        );
        return;
      }
      Promise.resolve()
        .then(() => fn(body as Record<string, unknown>))
        .then(
          (result) => void res.json(result),
          (e: unknown) => {
            // 502/503 must also return the message (the global handler only exposes 4xx)
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
      // accepts `{ payload, docId?, ... }` (SnapshotImportRequest) or the bare payload as the body
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
