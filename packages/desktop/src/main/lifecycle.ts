/** Pure app lifecycle decisions (testable without Electron). */
import path from 'node:path';
import type { AppArgs } from './args.js';

/**
 * Data folder that replaces `userData` (and, with it, the single-instance lock): only when the
 * user asked for it (`--data-dir` or `MOCKUP_DATA_DIR` already set before starting). Without it, the app
 * opened from the Start menu and the CLI's headless instance use the same lock and become a single instance.
 */
export function dataDirOverride(args: AppArgs, env: NodeJS.ProcessEnv): string | null {
  const raw = args.dataDir || env.MOCKUP_DATA_DIR;
  return raw ? path.resolve(raw) : null;
}

export type WindowsClosedAction = 'stay' | 'watch' | 'quit';

/** What to do when the last window closes. */
export function onAllWindowsClosed(
  startedHeadless: boolean,
  sessions: number,
): WindowsClosedAction {
  if (startedHeadless) return 'stay';
  return sessions > 0 ? 'watch' : 'quit';
}

/** Periodic check in headless-after-close mode: quits when the MCP sessions drop to zero. */
export function shouldQuitAfterSessions(
  startedHeadless: boolean,
  hasWindow: boolean,
  sessions: number,
): boolean {
  return !startedHeadless && !hasWindow && sessions <= 0;
}

/** Interval of the MCP sessions check (ms). */
export const SESSION_WATCH_MS = 5000;

/** Port taken by another Mockup Studio daemon: take over (no render) or use the existing one. */
export function existingDaemonAction(health: { render?: boolean }): 'takeover' | 'use' {
  return health.render === false ? 'takeover' : 'use';
}

/** Documents to open on takeover: the previous daemon's and the argv's, without repeats. */
export function mergeFiles(previous: string[], argv: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const f of [...previous, ...argv]) {
    const k = path.resolve(f).toLowerCase();
    if (!seen.has(k)) {
      seen.add(k);
      out.push(f);
    }
  }
  return out;
}
