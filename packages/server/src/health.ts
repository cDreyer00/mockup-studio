import type { HealthInfo } from './http.js';

/** Queries `GET <url>/api/health`; returns `null` if the daemon does not respond. */
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
