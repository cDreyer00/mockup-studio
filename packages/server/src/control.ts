/**
 * Controle de um daemon já rodando (usado pelo CLI e pelo app desktop): lista os documentos
 * abertos, pede o encerramento e espera a porta liberar, para outro processo assumir o lugar.
 */
import { checkHealth } from './health.js';

export interface TakeoverResult {
  ok: boolean;
  /** Caminhos dos documentos que estavam abertos (para reabrir em quem assumir). */
  paths: string[];
  /** Documentos sem arquivo (ainda não salvos): serão perdidos na troca. */
  unsaved: number;
  /** Motivo quando `ok` é falso. */
  reason?: string;
}

/** Documentos abertos no daemon (`GET /api/docs`); falha vira lista vazia. */
export async function listOpenDocuments(
  url: string,
): Promise<{ paths: string[]; unsaved: number }> {
  try {
    const res = await fetch(`${url.replace(/\/+$/, '')}/api/docs`, {
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) return { paths: [], unsaved: 0 };
    const body = (await res.json()) as { documents?: { path: string | null }[] };
    const docs = body.documents ?? [];
    return {
      paths: docs.flatMap((d) => (typeof d.path === 'string' ? [d.path] : [])),
      unsaved: docs.filter((d) => typeof d.path !== 'string').length,
    };
  } catch {
    return { paths: [], unsaved: 0 };
  }
}

/** `POST /api/shutdown`: 202 se o daemon aceitou; 409 se ele não permite (app desktop). */
export async function requestShutdown(
  url: string,
): Promise<{ accepted: boolean; status: number; error?: string }> {
  try {
    const res = await fetch(`${url.replace(/\/+$/, '')}/api/shutdown`, {
      method: 'POST',
      signal: AbortSignal.timeout(5000),
    });
    if (res.status === 202) return { accepted: true, status: 202 };
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    return { accepted: false, status: res.status, error: body.error ?? `HTTP ${res.status}` };
  } catch (e) {
    return { accepted: false, status: 0, error: e instanceof Error ? e.message : String(e) };
  }
}

/** Espera o daemon deixar de responder (porta livre). */
export async function waitForShutdown(url: string, timeoutMs = 15000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await checkHealth(url, 500))) return true;
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

/**
 * Pede o encerramento do daemon em `url`, espera a porta liberar e devolve os documentos que ele
 * tinha abertos. Chame antes de subir o substituto e reabra `paths` nele.
 */
export async function takeOverDaemon(url: string, timeoutMs = 15000): Promise<TakeoverResult> {
  const open = await listOpenDocuments(url);
  const res = await requestShutdown(url);
  if (!res.accepted) return { ok: false, ...open, reason: res.error };
  if (!(await waitForShutdown(url, timeoutMs)))
    return { ok: false, ...open, reason: `o daemon não liberou a porta em ${timeoutMs} ms` };
  return { ok: true, ...open };
}
