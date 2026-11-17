/**
 * Peças comuns das rotas HTTP das funcionalidades (assets/CDN, dados, arquivos): contexto,
 * erro com status e o adaptador de handlers assíncronos.
 */
import type { NextFunction, Request, Response } from 'express';
import type { RenderProvider } from '../render.js';
import type { DocumentStore } from '../store.js';

export interface RouteContext {
  store: DocumentStore;
  /** Pasta de dados (`files.json`, `cdn/`, miniaturas). Ausente em testes sem pasta de dados. */
  dataDir?: string;
  render?: RenderProvider;
  getPort?: () => number;
  /** Limite de upload (bytes). */
  maxAssetBytes: number;
}

/** Erro com status HTTP 4xx (o middleware de erro do app mantém o status e a mensagem). */
export class RouteError extends Error {
  readonly expose = true;
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

/** Encaminha exceções (síncronas ou de Promise) para o middleware de erro. */
export const wrap =
  (fn: (req: Request, res: Response) => unknown | Promise<unknown>) =>
  (req: Request, res: Response, next: NextFunction): void => {
    Promise.resolve()
      .then(() => fn(req, res))
      .catch(next);
  };

/** Exige documento aberto com esse id (404 caso contrário). */
export function requireDoc(ctx: RouteContext, docId: string): void {
  if (!ctx.store.list().some((d) => d.docId === docId)) {
    throw new RouteError(404, `Documento não encontrado: ${docId}`);
  }
}
