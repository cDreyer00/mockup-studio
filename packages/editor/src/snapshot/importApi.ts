/** Cliente HTTP das rotas de importação do daemon e helpers de seleção do frame importado. */
import { SNAPSHOT_ROUTES } from '@mockup/snapshot-core';
import type {
  ImportUrlRequest,
  SnapshotImportRequest,
  SnapshotImportResult,
} from '@mockup/snapshot-core';
import { getEntry } from '../model/tree';
import { useDoc } from '../state/docStore';
import { currentPageId } from '../state/hooks';
import { ui } from '../state/uiStore';

/** Erro de uma rota de importação (guarda o status HTTP). */
export class ImportError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'ImportError';
  }
}

async function postJson<T>(route: string, body: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(route, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch {
    throw new ImportError('Sem conexão com o daemon', 0);
  }
  const json = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok)
    throw new ImportError(json.error ?? `Falha na importação (${res.status})`, res.status);
  return json;
}

export function postSnapshot(req: SnapshotImportRequest): Promise<SnapshotImportResult> {
  return postJson(SNAPSHOT_ROUTES.snapshot, req);
}

export function postImportUrl(req: ImportUrlRequest): Promise<SnapshotImportResult> {
  return postJson(SNAPSHOT_ROUTES.importUrl, req);
}

/**
 * Espera o frame importado chegar no documento (o `doc:changed` pode vir depois da resposta HTTP)
 * e o seleciona (trocando de página se preciso). `fit` enquadra o frame no canvas.
 * Devolve `false` se o frame não apareceu a tempo.
 */
export function selectImported(
  frameId: string,
  opts: { fit?: boolean; timeoutMs?: number } = {},
): Promise<boolean> {
  const present = (): boolean => {
    const doc = useDoc.getState().doc;
    return !!doc && !!getEntry(doc, frameId);
  };
  const done = (): boolean => {
    const doc = useDoc.getState().doc!;
    const { pageId } = getEntry(doc, frameId)!;
    if (currentPageId() !== pageId) ui.setPage(pageId);
    ui.select([frameId]);
    if (opts.fit) ui.focus([frameId]);
    return true;
  };
  if (present()) return Promise.resolve(done());
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      unsub();
      resolve(false);
    }, opts.timeoutMs ?? 5000);
    const unsub = useDoc.subscribe(() => {
      if (!present()) return;
      clearTimeout(timer);
      unsub();
      resolve(done());
    });
  });
}
