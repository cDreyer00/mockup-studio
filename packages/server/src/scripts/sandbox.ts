/**
 * Sandbox dos scripts: executa JavaScript do usuário num `worker_threads.Worker` (criado de uma
 * string, ver `worker-source.ts`) dentro de um contexto `node:vm` sem `process`, `require`, rede,
 * arquivos nem `eval`. A única saída do contexto é uma ponte síncrona de strings JSON para o thread
 * principal, que responde com `handler(method, args)`.
 *
 * - Timeout no thread principal (`worker.terminate()`): mata `while (true) {}` e laços depois de `await`.
 * - Cancelamento: `signal` abortado e um vigia (`alive()`, ex.: o turno do assistente que disparou o
 *   script terminou) encerram o worker na hora, inclusive em laços que nunca chamam a API.
 * - Memória: `resourceLimits` do worker; estouro vira um erro legível e nunca derruba o daemon.
 * - Tamanho: limites de linhas/caracteres de log e do resultado.
 * Modelo de segurança completo em `docs/SCRIPTS.md`.
 */
import { MessageChannel, Worker } from 'node:worker_threads';
import { BOOTSTRAP_SOURCE, WORKER_SOURCE } from './worker-source.js';

export const SANDBOX_LIMITS = {
  /** Timeout padrão e máximo (ms). */
  defaultTimeoutMs: 10_000,
  maxTimeoutMs: 60_000,
  minTimeoutMs: 50,
  /** Tamanho máximo do código do script. */
  maxCodeChars: 500_000,
  /** Heap do worker (MB). */
  maxOldGenerationSizeMb: 128,
  maxYoungGenerationSizeMb: 16,
  stackSizeMb: 4,
  /** Logs: linhas, caracteres por linha e total. */
  maxLogLines: 500,
  maxLogLine: 2000,
  maxLogChars: 256 * 1024,
  /** Resultado (`return`) serializado em JSON. */
  maxResultChars: 1_000_000,
  /** Argumento de uma chamada da API do documento (JSON). */
  maxArgsChars: 4_000_000,
} as const;

/** Implementação do lado do daemon da API do documento (`method` vem do bootstrap do contexto). */
export type SandboxHandler = (method: string, args: unknown) => unknown | Promise<unknown>;

export interface SandboxOutcome {
  ok: boolean;
  error?: string;
  /** Valor devolvido pelo script, já em JSON (ausente se `undefined`). */
  resultJson?: string;
  logs: string[];
  timedOut: boolean;
  /** Verdadeiro se a execução foi interrompida de fora (`signal` abortado ou `alive()` falso). */
  cancelled?: boolean;
}

export interface SandboxOptions {
  timeoutMs?: number;
  /** Aborta a execução: o worker é encerrado imediatamente. */
  signal?: AbortSignal;
  /** Vigia: consultado a cada `watchIntervalMs`; ao ficar falso o worker é encerrado. */
  alive?: () => boolean;
}

/** Intervalo do vigia de `alive()` (ms). */
export const WATCH_INTERVAL_MS = 100;

export const CANCELLED_ABORT_MESSAGE = 'A execução foi cancelada; o script foi interrompido.';
export const CANCELLED_TURN_MESSAGE = 'O turno do assistente terminou; o script foi interrompido.';

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
 * `import()` num contexto `vm` sem loader rejeita com um erro do realm do worker, e dele se chega
 * ao `process` (`e.constructor.constructor('return process')()`). Como `eval` e `new Function`
 * estão desligados, a única forma de escrever `import(...)` é o token `import` no texto do
 * script: recusar o texto fecha a porta (às custas de falsos positivos em comentários e strings).
 */
const IMPORT_TOKEN = /\bimport\b/;

export function checkSource(code: string): string | undefined {
  if (code.length > SANDBOX_LIMITS.maxCodeChars) {
    return `O script é grande demais (${code.length} caracteres; limite ${SANDBOX_LIMITS.maxCodeChars}).`;
  }
  if (IMPORT_TOKEN.test(code)) {
    return 'A palavra "import" não é permitida em scripts (import e import() não existem na sandbox; use só a API doc). Se aparece num texto ou comentário, reescreva-a.';
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
    // Ninguém usa a saída do worker (o script não tem console do processo); descarta.
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
        if (typeof m.method !== 'string') throw new Error('Chamada inválida.');
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
              : { ok: false, error: p.error ?? 'Erro desconhecido.' },
          );
        } catch {
          settle({ ok: false, error: 'Resposta inválida da sandbox.' });
        }
      }
    });

    worker.on('error', (e: Error & { code?: string }) => {
      if (e.code === 'ERR_WORKER_OUT_OF_MEMORY') {
        settle({
          ok: false,
          error: `O script estourou o limite de memória (${SANDBOX_LIMITS.maxOldGenerationSizeMb} MB) e foi interrompido.`,
        });
      } else {
        settle({ ok: false, error: `Falha interna da sandbox: ${errorText(e)}` });
      }
    });

    // Sem resultado e sem erro: o worker terminou sozinho (ex.: uma promessa que nunca resolve).
    // A mensagem `done` pode chegar um instante depois do `exit`: dá uma pequena folga.
    worker.on('exit', () => {
      if (closed) return;
      exitTimer = setTimeout(
        () =>
          settle({
            ok: false,
            error:
              'O script terminou sem devolver um resultado (uma promessa que nunca resolve? Lembre que não há setTimeout).',
          }),
        50,
      );
    });

    const timer = setTimeout(() => {
      settle({
        ok: false,
        timedOut: true,
        error: `O script excedeu o tempo limite de ${timeoutMs} ms e foi interrompido.`,
      });
    }, timeoutMs);

    // Cancelamento de fora: `signal` (imediato) e vigia de `alive()` (cobre laços sem chamadas à API).
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
