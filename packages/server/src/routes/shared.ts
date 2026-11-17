/**
 * Shared pieces of the feature HTTP routes (assets/CDN, data, files): context,
 * error with status and the async handler adapter.
 */
import type { NextFunction, Request, Response } from 'express';
import type { RenderProvider } from '../render.js';
import type { DocumentStore } from '../store.js';

export interface RouteContext {
  store: DocumentStore;
  /** Data folder (`files.json`, `cdn/`, thumbnails). Absent in tests without a data folder. */
  dataDir?: string;
  render?: RenderProvider;
  getPort?: () => number;
  /** Upload limit (bytes). */
  maxAssetBytes: number;
}

/** Error with an HTTP 4xx status (the app's error middleware keeps the status and the message). */
export class RouteError extends Error {
  readonly expose = true;
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

/** Forwards exceptions (sync or from a Promise) to the error middleware. */
export const wrap =
  (fn: (req: Request, res: Response) => unknown | Promise<unknown>) =>
  (req: Request, res: Response, next: NextFunction): void => {
    Promise.resolve()
      .then(() => fn(req, res))
      .catch(next);
  };

/** Requires an open document with this id (404 otherwise). */
export function requireDoc(ctx: RouteContext, docId: string): void {
  if (!ctx.store.list().some((d) => d.docId === docId)) {
    throw new RouteError(404, `Document not found: ${docId}`);
  }
}
