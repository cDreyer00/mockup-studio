/**
 * Control of an already running daemon (used by the CLI and the desktop app): lists the open
 * documents, requests shutdown and waits for the port to be released, so another process can take its place.
 */
import { checkHealth } from './health.js';

export interface TakeoverResult {
  ok: boolean;
  /** Paths of the documents that were open (to reopen in whoever takes over). */
  paths: string[];
  /** Documents without a file (not saved yet): they will be lost in the swap. */
  unsaved: number;
  /** Reason when `ok` is false. */
  reason?: string;
}

/** Documents open in the daemon (`GET /api/docs`); failure becomes an empty list. */
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

/** `POST /api/shutdown`: 202 if the daemon accepted; 409 if it does not allow it (desktop app). */
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

/** Waits for the daemon to stop responding (port free). */
export async function waitForShutdown(url: string, timeoutMs = 15000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await checkHealth(url, 500))) return true;
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

/**
 * Requests shutdown of the daemon at `url`, waits for the port to be released and returns the documents it
 * had open. Call before starting the replacement and reopen `paths` in it.
 */
export async function takeOverDaemon(url: string, timeoutMs = 15000): Promise<TakeoverResult> {
  const open = await listOpenDocuments(url);
  const res = await requestShutdown(url);
  if (!res.accepted) return { ok: false, ...open, reason: res.error };
  if (!(await waitForShutdown(url, timeoutMs)))
    return {
      ok: false,
      ...open,
      reason: `the daemon did not release the port within ${timeoutMs} ms`,
    };
  return { ok: true, ...open };
}
