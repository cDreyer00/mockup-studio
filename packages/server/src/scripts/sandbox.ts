/**
 * Script sandbox: runs user JavaScript in a `worker_threads.Worker` (created from a
 * string, see `worker-source.ts`) inside a `node:vm` context without `process`, `require`, network,
 * files or `eval`. The context's only way out is a synchronous bridge of JSON strings to the main
 * thread, which answers with `handler(method, args)`.
 *
 * - Timeout on the main thread (`worker.terminate()`): kills `while (true) {}` and loops after `await`.
 * - Cancellation: an aborted `signal` and a watchdog (`alive()`, e.g. the assistant turn that triggered the
 *   script has finished) stop the worker right away, even in loops that never call the API.
 * - Memory: the worker's `resourceLimits`; overflow becomes a readable error and never takes down the daemon.
 * - Size: limits on log lines/characters and on the result.
 * Full security model in `docs/SCRIPTS.md`.
 */
import { MessageChannel, Worker } from 'node:worker_threads';
import { BOOTSTRAP_SOURCE, WORKER_SOURCE } from './worker-source.js';

export const SANDBOX_LIMITS = {
  /** Default and maximum timeout (ms). */
  defaultTimeoutMs: 10_000,
  maxTimeoutMs: 60_000,
  minTimeoutMs: 50,
  /** Maximum size of the script code. */
  maxCodeChars: 500_000,
  /** Worker heap (MB). */
  maxOldGenerationSizeMb: 128,
  maxYoungGenerationSizeMb: 16,
  stackSizeMb: 4,
  /** Logs: lines, characters per line and total. */
  maxLogLines: 500,
  maxLogLine: 2000,
  maxLogChars: 256 * 1024,
  /** Result (`return`) serialized as JSON. */
  maxResultChars: 1_000_000,
  /** Argument of a document API call (JSON). */
  maxArgsChars: 4_000_000,
} as const;

/** Daemon-side implementation of the document API (`method` comes from the context bootstrap). */
export type SandboxHandler = (method: string, args: unknown) => unknown | Promise<unknown>;

export interface SandboxOutcome {
  ok: boolean;
  error?: string;
  /** Value returned by the script, already as JSON (absent if `undefined`). */
  resultJson?: string;
  logs: string[];
  timedOut: boolean;
  /** True if the run was interrupted from outside (`signal` aborted or `alive()` false). */
  cancelled?: boolean;
}

export interface SandboxOptions {
  timeoutMs?: number;
  /** Aborts the run: the worker is terminated immediately. */
  signal?: AbortSignal;
  /** Watchdog: polled every `watchIntervalMs`; when it turns false the worker is terminated. */
  alive?: () => boolean;
}

/** `alive()` watchdog interval (ms). */
export const WATCH_INTERVAL_MS = 100;

export const CANCELLED_ABORT_MESSAGE = 'The run was cancelled; the script was interrupted.';
export const CANCELLED_TURN_MESSAGE = 'The assistant turn ended; the script was interrupted.';

const isAlive = (alive: (() => boolean) | undefined): boolean => {
  if (!alive) return true;
  try {
    return alive() !== false;
  } catch {
    return false;
  }
};

export function clampTimeout(timeoutMs: number | undefined): number {
  const t = Number.isFinite(timeoutMs) ? (timeoutMs as number) : SANDBOX_LIMITS.defaultTimeoutMs;
  return Math.min(
    SANDBOX_LIMITS.maxTimeoutMs,
    Math.max(SANDBOX_LIMITS.minTimeoutMs, Math.floor(t)),
  );
}

const errorText = (e: unknown): string => {
  const s = e instanceof Error ? e.message : String(e);
  return s.length > 4000 ? `${s.slice(0, 4000)}…` : s;
};

type WorkerMessage =
  | { t: 'log'; line: string }
  | { t: 'done'; payload: string }
  | { t: 'rpc'; method: string; args: string };

/**
 * `import()` in a `vm` context without a loader rejects with an error from the worker's realm, which leads
 * to `process` (`e.constructor.constructor('return process')()`). Since `eval` and `new Function`
 * are disabled, the only way to write `import(...)` is the `import` token in the script
 * text: rejecting the text closes the door (at the cost of false positives in comments and strings).
 */
const IMPORT_TOKEN = /\bimport\b/;

export function checkSource(code: string): string | undefined {
  if (code.length > SANDBOX_LIMITS.maxCodeChars) {
    return `The script is too large (${code.length} characters; limit ${SANDBOX_LIMITS.maxCodeChars}).`;
  }
  if (IMPORT_TOKEN.test(code)) {
    return 'The word "import" is not allowed in scripts (import and import() do not exist in the sandbox; use only the doc API). If it appears in a text or comment, rewrite it.';
  }
  return undefined;
}

export async function runInSandbox(
  code: string,
  handler: SandboxHandler,
  opts: SandboxOptions = {},
): Promise<SandboxOutcome> {
  const rejected = checkSource(code);
  if (rejected) return { ok: false, error: rejected, logs: [], timedOut: false };
  if (opts.signal?.aborted) {
    return {
      ok: false,
      error: CANCELLED_ABORT_MESSAGE,
      logs: [],
      timedOut: false,
      cancelled: true,
    };
  }
  if (!isAlive(opts.alive)) {
    return { ok: false, error: CANCELLED_TURN_MESSAGE, logs: [], timedOut: false, cancelled: true };
  }
  const timeoutMs = clampTimeout(opts.timeoutMs);

  return new Promise<SandboxOutcome>((resolve) => {
    const { port1, port2 } = new MessageChannel();
    const sab = new SharedArrayBuffer(4);
    const i32 = new Int32Array(sab);
    const logs: string[] = [];
    let logChars = 0;
    let closed = false;

    const worker = new Worker(WORKER_SOURCE, {
      eval: true,
      env: {},
      stdin: false,
      stdout: true,
      stderr: true,
      execArgv: [],
      resourceLimits: {
        maxOldGenerationSizeMb: SANDBOX_LIMITS.maxOldGenerationSizeMb,
        maxYoungGenerationSizeMb: SANDBOX_LIMITS.maxYoungGenerationSizeMb,
        stackSizeMb: SANDBOX_LIMITS.stackSizeMb,
      },
      workerData: {
        port: port2,
        sab,
        bootstrap: BOOTSTRAP_SOURCE,
        code,
        limits: JSON.stringify({
          maxArgsChars: SANDBOX_LIMITS.maxArgsChars,
          maxLogLine: SANDBOX_LIMITS.maxLogLine,
          maxLogLines: SANDBOX_LIMITS.maxLogLines,
          maxLogChars: SANDBOX_LIMITS.maxLogChars,
          maxResultChars: SANDBOX_LIMITS.maxResultChars,
        }),
      },
      transferList: [port2],
    });
    worker.unref();
    // Nobody uses the worker's output (the script has no process console); discard it.
    worker.stdout.resume();
    worker.stderr.resume();

    let exitTimer: NodeJS.Timeout | undefined;
    let watch: NodeJS.Timeout | undefined;
    const onAbort = () => cancel(CANCELLED_ABORT_MESSAGE);

    const settle = (out: Omit<SandboxOutcome, 'logs' | 'timedOut'> & { timedOut?: boolean }) => {
      if (closed) return;
      closed = true;
      if (timer) clearTimeout(timer);
      if (exitTimer) clearTimeout(exitTimer);
      if (watch) clearInterval(watch);
      opts.signal?.removeEventListener('abort', onAbort);
      port1.close();
      worker
        .terminate()
        .catch(() => undefined)
        .then(() => resolve({ timedOut: false, ...out, logs }));
    };

    const cancel = (error: string) => settle({ ok: false, error, cancelled: true });

    const reply = (json: string) => {
      if (closed) return;
      port1.postMessage(json);
      Atomics.store(i32, 0, 1);
      Atomics.notify(i32, 0);
    };

    const handleRpc = async (m: Extract<WorkerMessage, { t: 'rpc' }>) => {
      let out: string;
      try {
        if (typeof m.method !== 'string') throw new Error('Invalid call.');
        const args: unknown = m.args ? JSON.parse(m.args) : null;
        const value = await handler(m.method, args);
        out = JSON.stringify({ ok: true, value: value === undefined ? null : value });
      } catch (e) {
        out = JSON.stringify({ ok: false, error: errorText(e) });
      }
      reply(out);
    };

    port1.on('message', (m: WorkerMessage) => {
      if (closed || !m || typeof m !== 'object') return;
      if (m.t === 'log') {
        if (
          typeof m.line === 'string' &&
          logs.length < SANDBOX_LIMITS.maxLogLines + 1 &&
          logChars < SANDBOX_LIMITS.maxLogChars + SANDBOX_LIMITS.maxLogLine
        ) {
          logs.push(m.line);
          logChars += m.line.length;
        }
      } else if (m.t === 'rpc') {
        void handleRpc(m);
      } else if (m.t === 'done') {
        try {
          const p = JSON.parse(m.payload) as { ok: boolean; result?: string; error?: string };
          settle(
            p.ok
              ? { ok: true, ...(p.result !== undefined ? { resultJson: p.result } : {}) }
              : { ok: false, error: p.error ?? 'Unknown error.' },
          );
        } catch {
          settle({ ok: false, error: 'Invalid response from the sandbox.' });
        }
      }
    });

    worker.on('error', (e: Error & { code?: string }) => {
      if (e.code === 'ERR_WORKER_OUT_OF_MEMORY') {
        settle({
          ok: false,
          error: `The script exceeded the memory limit (${SANDBOX_LIMITS.maxOldGenerationSizeMb} MB) and was interrupted.`,
        });
      } else {
        settle({ ok: false, error: `Internal sandbox failure: ${errorText(e)}` });
      }
    });

    // No result and no error: the worker ended on its own (e.g. a promise that never resolves).
    // The `done` message may arrive a moment after `exit`: allow a small grace period.
    worker.on('exit', () => {
      if (closed) return;
      exitTimer = setTimeout(
        () =>
          settle({
            ok: false,
            error:
              'The script ended without returning a result (a promise that never resolves? Remember there is no setTimeout).',
          }),
        50,
      );
    });

    const timer = setTimeout(() => {
      settle({
        ok: false,
        timedOut: true,
        error: `The script exceeded the ${timeoutMs} ms time limit and was interrupted.`,
      });
    }, timeoutMs);

    // Cancellation from outside: `signal` (immediate) and the `alive()` watchdog (covers loops with no API calls).
    if (opts.signal) opts.signal.addEventListener('abort', onAbort, { once: true });
    if (opts.alive) {
      watch = setInterval(() => {
        if (!isAlive(opts.alive)) cancel(CANCELLED_TURN_MESSAGE);
      }, WATCH_INTERVAL_MS);
      watch.unref();
    }
    if (opts.signal?.aborted) onAbort();
  });
}
