export { startDaemon } from './daemon.js';
export type { DaemonHandle, DaemonOptions } from './daemon.js';
export { DocumentStore } from './store.js';
export {
  DEFAULT_PORT,
  DOCUMENT_EXT,
  normalizeDocumentPath,
  getDataDir,
  readDaemonInfo,
  removeDaemonInfo,
  resolvePort,
  writeDaemonInfo,
} from './paths.js';
export type { DaemonInfo } from './paths.js';
export type { HealthInfo } from './http.js';
export { isAllowedHost } from './http.js';
export { isAllowedOrigin } from './ws.js';

import type { HealthInfo } from './http.js';

/** Consulta `GET <url>/api/health`; devolve `null` se o daemon não responder. */
export async function checkHealth(url: string, timeoutMs = 1500): Promise<HealthInfo | null> {
  try {
    const res = await fetch(`${url.replace(/\/+$/, '')}/api/health`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return null;
    return (await res.json()) as HealthInfo;
  } catch {
    return null;
  }
}
