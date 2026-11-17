/** Locates and runs external tools (`claude`, `codex`, `mockup`) in an injectable way. */
import { spawnSync, type SpawnSyncOptions } from 'node:child_process';

export type SpawnSyncFn = (
  cmd: string,
  args: string[],
  opts: SpawnSyncOptions,
) => {
  status: number | null;
  stdout?: string | Buffer | null;
  stderr?: string | Buffer | null;
  error?: Error;
};

export interface ToolEnv {
  platform?: NodeJS.Platform;
  spawn?: SpawnSyncFn;
}

export interface ToolResult {
  status: number | null;
  stdout: string;
  stderr: string;
  error?: string;
}

const defaultSpawn: SpawnSyncFn = (cmd, args, opts) => spawnSync(cmd, args, opts);

const text = (v: string | Buffer | null | undefined): string => (v ? v.toString() : '');

/** First `where` line that ends in .exe, .cmd or .bat. */
export function pickWindowsExecutable(out: string): string | null {
  for (const line of out.split(/\r?\n/)) {
    const l = line.trim();
    if (/\.(exe|cmd|bat)$/i.test(l)) return l;
  }
  return null;
}

/** Full path of the executable on the PATH (`where` on Windows, `command -v` elsewhere) or `null`. */
export function findOnPath(name: string, env: ToolEnv = {}): string | null {
  const platform = env.platform ?? process.platform;
  const spawn = env.spawn ?? defaultSpawn;
  const opts: SpawnSyncOptions = {
    encoding: 'utf8',
    timeout: 5000,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  };
  try {
    if (platform === 'win32') {
      const r = spawn('where', [name], opts);
      return r.status === 0 ? pickWindowsExecutable(text(r.stdout)) : null;
    }
    const r = spawn('sh', ['-c', 'command -v "$1"', 'sh', name], opts);
    const first = text(r.stdout).split(/\r?\n/)[0]?.trim();
    return r.status === 0 && first ? first : null;
  } catch {
    return null;
  }
}

/** Quoted argument for `cmd.exe`. */
export function quoteCmdArg(a: string): string {
  return `"${a.replace(/"/g, '""')}"`;
}

export interface RunToolOptions extends ToolEnv {
  timeoutMs?: number;
  /** Resolves the full path (default: `findOnPath`). */
  resolve?: (name: string) => string | null;
}

/**
 * Runs `name args...` without a shell, resolving the full path. On Windows, `.cmd`/`.bat` run
 * through `cmd.exe /d /s /c` with correct quoting.
 */
export function runTool(name: string, args: string[], o: RunToolOptions = {}): ToolResult {
  const platform = o.platform ?? process.platform;
  const spawn = o.spawn ?? defaultSpawn;
  const full = (o.resolve ?? ((n) => findOnPath(n, o)))(name);
  if (!full)
    return { status: null, stdout: '', stderr: '', error: `${name} not found on the PATH` };
  const opts: SpawnSyncOptions = {
    encoding: 'utf8',
    timeout: o.timeoutMs ?? 15000,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  };
  let cmd = full;
  let argv = args;
  if (platform === 'win32' && /\.(cmd|bat)$/i.test(full)) {
    cmd = process.env.ComSpec ?? 'cmd.exe';
    argv = ['/d', '/s', '/c', `"${[full, ...args].map(quoteCmdArg).join(' ')}"`];
    opts.windowsVerbatimArguments = true;
  }
  try {
    const r = spawn(cmd, argv, opts);
    return {
      status: r.status,
      stdout: text(r.stdout),
      stderr: text(r.stderr),
      error: r.error?.message,
    };
  } catch (e) {
    return {
      status: null,
      stdout: '',
      stderr: '',
      error: e instanceof Error ? e.message : String(e),
    };
  }
}
