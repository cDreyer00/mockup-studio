/**
 * Subprocess agent backends: Claude Code (`claude -p`) and Codex (`codex exec`).
 *
 * Each turn is a new process. The prompt goes through stdin; the MCP config and the system prompt go
 * through temporary files (no JSON in the arguments, so it does not depend on Windows quoting). The
 * JSONL output is read line by line and converted into `AgentRunEvent`.
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import type { AssistantBackendInfo } from '@mockup/core';
import type { AgentBackend, AgentRunEvent, AgentRunInput, AgentRunResult } from './backend.js';

/* ---------- locating executables ---------- */

export interface FindExecutableEnv {
  /** PATH value (default: `process.env.PATH`). */
  pathEnv?: string;
  /** PATHEXT value, Windows only (default: `process.env.PATHEXT`). */
  pathExt?: string;
  platform?: NodeJS.Platform;
  /** Checks whether the path is an executable file (injectable in tests). */
  isFile?: (file: string) => boolean;
}

function defaultIsFile(file: string): boolean {
  try {
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

/** Executable extensions accepted on Windows, in order of preference. */
const WIN_EXT_ORDER = ['.exe', '.cmd', '.bat'];

/**
 * Full path of the executable on PATH, or `null`. On Windows it honors PATHEXT and prefers `.exe`
 * over `.cmd`/`.bat` (an `.exe` runs without a shell). A name with a folder separator is tested directly.
 */
export function findExecutable(name: string, env: FindExecutableEnv = {}): string | null {
  const platform = env.platform ?? process.platform;
  const win = platform === 'win32';
  const p = win ? path.win32 : path.posix;
  const isFile = env.isFile ?? defaultIsFile;
  const dirs = (env.pathEnv ?? process.env['PATH'] ?? '')
    .split(win ? ';' : ':')
    .map((d) => d.trim().replace(/^"(.*)"$/, '$1'))
    .filter(Boolean);

  if (!win) {
    if (name.includes('/')) return isFile(name) ? name : null;
    for (const dir of dirs) {
      const full = p.join(dir, name);
      if (isFile(full)) return full;
    }
    return null;
  }

  const allowed = (env.pathExt ?? process.env['PATHEXT'] ?? '.COM;.EXE;.BAT;.CMD')
    .split(';')
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
  const exts = WIN_EXT_ORDER.filter((e) => allowed.includes(e));
  const hasExt = allowed.includes(p.extname(name).toLowerCase());
  if (/[\\/]/.test(name)) {
    if (hasExt && isFile(name)) return name;
    for (const e of exts) if (isFile(name + e)) return name + e;
    return null;
  }
  if (hasExt) {
    for (const dir of dirs) {
      const full = p.join(dir, name);
      if (isFile(full)) return full;
    }
    return null;
  }
  for (const e of exts) {
    for (const dir of dirs) {
      const full = p.join(dir, name + e);
      if (isFile(full)) return full;
    }
  }
  return null;
}

/* ---------- process utilities ---------- */

export function abortError(message = 'Turn cancelled.'): Error {
  const e = new Error(message);
  e.name = 'AbortError';
  return e;
}

export function isAbortError(e: unknown): boolean {
  return e instanceof Error && e.name === 'AbortError';
}

/** Accepted session id (becomes a `--resume` argument): `[A-Za-z0-9_-]{1,128}`, not starting with `-`. */
const SESSION_ID_RE = /^[A-Za-z0-9_][A-Za-z0-9_-]{0,127}$/;

export function isValidSessionId(id: unknown): id is string {
  return typeof id === 'string' && SESSION_ID_RE.test(id);
}

/*
 * Live children: outside Windows they run in their own group (detached) and would survive the
 * daemon going down; on process 'exit' they are all killed synchronously. The listener only exists
 * while there are children.
 */
const liveChildren = new Set<ChildProcess>();
let exitHookInstalled = false;

/** How many agent subprocesses are alive (for tests). */
export function liveChildCount(): number {
  return liveChildren.size;
}

/** Synchronously kills all live agent subprocesses (used on the daemon's 'exit'). */
export function killLiveChildren(): void {
  const pids = [...liveChildren]
    .map((c) => c.pid)
    .filter((p): p is number => typeof p === 'number');
  if (pids.length === 0) return;
  if (process.platform === 'win32') {
    try {
      spawnSync('taskkill', ['/T', '/F', ...pids.flatMap((p) => ['/PID', String(p)])], {
        windowsHide: true,
        stdio: 'ignore',
        timeout: 5000,
      });
    } catch {
      /* best effort */
    }
    return;
  }
  for (const pid of pids) {
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      /* already dead */
    }
  }
}

function trackChild(child: ChildProcess): void {
  liveChildren.add(child);
  if (!exitHookInstalled) {
    exitHookInstalled = true;
    process.on('exit', killLiveChildren);
  }
  const done = (): void => {
    liveChildren.delete(child);
    if (liveChildren.size === 0 && exitHookInstalled) {
      exitHookInstalled = false;
      process.removeListener('exit', killLiveChildren);
    }
  };
  child.once('close', done);
  child.once('error', done);
}

/** Kills the process and all descendants (taskkill /T on Windows, process group elsewhere). */
export function killTree(child: ChildProcess): void {
  const pid = child.pid;
  if (!pid) return;
  if (process.platform === 'win32') {
    try {
      const k = spawn('taskkill', ['/pid', String(pid), '/T', '/F'], {
        windowsHide: true,
        stdio: 'ignore',
      });
      k.on('error', () => child.kill());
    } catch {
      child.kill();
    }
    return;
  }
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    child.kill('SIGKILL');
  }
}

/** Safe argument for `cmd.exe` (only used with `.cmd`/`.bat`): rejects what cannot be quoted. */
export function quoteCmdArg(a: string): string {
  if (/["%\r\n]/.test(a)) throw new Error(`Unsupported argument for running a .cmd: ${a}`);
  return a === '' || /[\s&|<>^()!,;=]/.test(a) ? `"${a}"` : a;
}

export interface Located {
  /** Executable (or Node, when `prefixArgs` holds the script). */
  command: string;
  prefixArgs: string[];
}

function spawnLocated(
  loc: Located,
  args: string[],
  o: { cwd?: string; env?: Record<string, string> },
): ChildProcess {
  const win = process.platform === 'win32';
  const base = {
    cwd: o.cwd,
    env: { ...process.env, ...o.env },
    windowsHide: true,
    detached: !win,
    stdio: ['pipe', 'pipe', 'pipe'] as ['pipe', 'pipe', 'pipe'],
  };
  const all = [...loc.prefixArgs, ...args];
  let child: ChildProcess;
  if (win && /\.(cmd|bat)$/i.test(loc.command)) {
    // No args list: with `shell: true` Node would concatenate it without quoting (and warns about the risk).
    const line = [loc.command, ...all].map(quoteCmdArg).join(' ');
    child = spawn(line, { ...base, shell: true });
  } else {
    child = spawn(loc.command, all, { ...base, shell: false });
  }
  trackChild(child);
  return child;
}

/** Runs the CLI with `args` and returns stdout; rejects on error, non-zero exit code or timeout. */
function runCapture(
  loc: Located,
  args: string[],
  o: { env?: Record<string, string>; timeoutMs: number },
): Promise<string> {
  return new Promise((resolve, reject) => {
    let child: ChildProcess;
    try {
      child = spawnLocated(loc, args, { env: o.env });
    } catch (e) {
      reject(e instanceof Error ? e : new Error(String(e)));
      return;
    }
    let out = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child);
    }, o.timeoutMs);
    child.stdout?.on('data', (c: Buffer) => (out += c.toString()));
    child.stderr?.on('data', () => undefined);
    child.stdin?.on('error', () => undefined);
    child.stdin?.end();
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (timedOut) reject(new Error('timed out'));
      else if (code !== 0) reject(new Error(`exit code ${code}`));
      else resolve(out);
    });
  });
}

/* ---------- JSONL parsers ---------- */

export interface ParsedResult {
  text: string;
  sessionId?: string;
  costUsd?: number;
  isError: boolean;
  error?: string;
}

export interface LineParser {
  /** Processes a stdout line and returns the generated events (invalid lines are ignored). */
  parse(line: string): AgentRunEvent[];
  /** Final result, after the CLI signalled the end of the turn. */
  result(): ParsedResult | undefined;
  /** Last error seen in the stream (to compose the message when the turn fails). */
  lastError(): string | undefined;
}

const MCP_PREFIX = /^mcp__[^_]+__/;

/** Tool name without the `mcp__<server>__` prefix (Claude Code). */
export function stripMcpPrefix(name: string): string {
  return name.replace(MCP_PREFIX, '');
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

/** First non-empty line, up to 200 characters. */
export function shortSummary(text: string): string {
  const line = text.split(/\r?\n/).find((l) => l.trim()) ?? '';
  return line.length > 200 ? line.slice(0, 197) + '...' : line.trim();
}

function contentToText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((c) => (isObj(c) && typeof c['text'] === 'string' ? c['text'] : ''))
      .filter(Boolean)
      .join('\n');
  }
  return '';
}

function parseJsonLine(line: string, log: (m: string) => void): Obj | undefined {
  const t = line.trim();
  if (!t) return undefined;
  try {
    const v: unknown = JSON.parse(t);
    return isObj(v) ? v : undefined;
  } catch {
    log(`non-JSON line ignored: ${t.length > 200 ? t.slice(0, 200) + '...' : t}`);
    return undefined;
  }
}

/** Output of `claude -p --output-format stream-json --verbose --include-partial-messages`. */
export class ClaudeStreamParser implements LineParser {
  private final?: ParsedResult;
  private error?: string;
  private sessionSent = false;
  /** Message ids whose text already arrived in deltas (do not repeat when the full message comes). */
  private readonly streamed = new Set<string>();
  private emittedText = false;
  private needSep = false;

  constructor(private readonly log: (m: string) => void = () => undefined) {}

  result(): ParsedResult | undefined {
    return this.final;
  }
  lastError(): string | undefined {
    return this.error;
  }

  private text(t: string): AgentRunEvent[] {
    if (!t) return [];
    const sep = this.needSep && this.emittedText ? '\n\n' : '';
    this.needSep = false;
    this.emittedText = true;
    return [{ kind: 'text', text: sep + t }];
  }

  private session(id: unknown): AgentRunEvent[] {
    if (this.sessionSent || typeof id !== 'string' || !id) return [];
    this.sessionSent = true;
    return [{ kind: 'session', sessionId: id }];
  }

  parse(line: string): AgentRunEvent[] {
    const o = parseJsonLine(line, this.log);
    if (!o) return [];
    const out: AgentRunEvent[] = [];
    switch (o['type']) {
      case 'system':
        if (o['subtype'] === 'init') out.push(...this.session(o['session_id']));
        break;
      case 'stream_event': {
        const ev = o['event'];
        if (!isObj(ev)) break;
        if (ev['type'] === 'message_start') {
          const id = isObj(ev['message']) ? str(ev['message']['id']) : undefined;
          if (id) this.streamed.add(id);
          this.needSep = true;
        } else if (ev['type'] === 'content_block_delta' && isObj(ev['delta'])) {
          if (ev['delta']['type'] === 'text_delta')
            out.push(...this.text(str(ev['delta']['text']) ?? ''));
        }
        break;
      }
      case 'assistant': {
        const msg = o['message'];
        if (!isObj(msg) || !Array.isArray(msg['content'])) break;
        const id = str(msg['id']);
        const wasStreamed = id !== undefined && this.streamed.has(id);
        if (!wasStreamed) this.needSep = true;
        for (const b of msg['content']) {
          if (!isObj(b)) continue;
          if (b['type'] === 'text' && !wasStreamed) out.push(...this.text(str(b['text']) ?? ''));
          else if (b['type'] === 'tool_use') {
            out.push({
              kind: 'tool',
              id: str(b['id']) ?? '',
              name: stripMcpPrefix(str(b['name']) ?? 'tool'),
              input: b['input'],
            });
          }
        }
        break;
      }
      case 'user': {
        const msg = o['message'];
        if (!isObj(msg) || !Array.isArray(msg['content'])) break;
        for (const b of msg['content']) {
          if (!isObj(b) || b['type'] !== 'tool_result') continue;
          const ok = b['is_error'] !== true;
          const summary = shortSummary(contentToText(b['content']));
          out.push({
            kind: 'tool-result',
            id: str(b['tool_use_id']) ?? '',
            ok,
            ...(summary ? { summary } : {}),
          });
        }
        break;
      }
      case 'result': {
        out.push(...this.session(o['session_id']));
        const sub = str(o['subtype']);
        const isError = o['is_error'] === true || (sub !== undefined && sub !== 'success');
        const errors = Array.isArray(o['errors'])
          ? o['errors'].filter((e) => typeof e === 'string')
          : [];
        const resultText = str(o['result']) ?? '';
        const error = isError
          ? resultText || errors.join('; ') || sub || 'unknown error'
          : undefined;
        this.final = {
          text: resultText,
          sessionId: str(o['session_id']),
          costUsd: typeof o['total_cost_usd'] === 'number' ? o['total_cost_usd'] : undefined,
          isError,
          error,
        };
        if (error) this.error = error;
        break;
      }
      default:
        break;
    }
    return out;
  }
}

/** Output of `codex exec --json`. */
export class CodexStreamParser implements LineParser {
  private final?: ParsedResult;
  private error?: string;
  private lastMessage = '';
  private emittedText = false;
  private readonly started = new Set<string>();

  constructor(private readonly log: (m: string) => void = () => undefined) {}

  result(): ParsedResult | undefined {
    return this.final;
  }
  lastError(): string | undefined {
    return this.error;
  }

  private toolStart(item: Obj, name: string, input: unknown): AgentRunEvent[] {
    const id = str(item['id']) ?? '';
    if (this.started.has(id)) return [];
    this.started.add(id);
    return [{ kind: 'tool', id, name, input }];
  }

  parse(line: string): AgentRunEvent[] {
    const o = parseJsonLine(line, this.log);
    if (!o) return [];
    const out: AgentRunEvent[] = [];
    switch (o['type']) {
      case 'item.started':
      case 'item.completed': {
        const item = o['item'];
        if (!isObj(item)) break;
        const done = o['type'] === 'item.completed';
        const kind = str(item['type']);
        if (kind === 'agent_message' && done) {
          const text = str(item['text']) ?? '';
          if (text) {
            out.push({ kind: 'text', text: (this.emittedText ? '\n\n' : '') + text });
            this.emittedText = true;
            this.lastMessage = text;
          }
        } else if (kind === 'mcp_tool_call') {
          const name = str(item['tool']) ?? str(item['name']) ?? 'tool';
          out.push(...this.toolStart(item, name, item['arguments']));
          if (done) {
            const err = item['error'];
            const failed = item['status'] === 'failed' || (err !== undefined && err !== null);
            const body = isObj(item['result'])
              ? contentToText(item['result']['content'])
              : contentToText(item['result']);
            const errText = isObj(err) ? (str(err['message']) ?? '') : (str(err) ?? '');
            const summary = shortSummary(failed && errText ? errText : body);
            out.push({
              kind: 'tool-result',
              id: str(item['id']) ?? '',
              ok: !failed,
              ...(summary ? { summary } : {}),
            });
          }
        } else if (kind === 'command_execution') {
          out.push(...this.toolStart(item, 'shell', { command: item['command'] }));
          if (done) {
            const code = item['exit_code'];
            const summary = shortSummary(str(item['aggregated_output']) ?? '');
            out.push({
              kind: 'tool-result',
              id: str(item['id']) ?? '',
              ok: code === 0 || code === undefined || code === null,
              ...(summary ? { summary } : {}),
            });
          }
        }
        break;
      }
      case 'turn.completed':
        this.final = { text: this.lastMessage, isError: false };
        break;
      case 'turn.failed': {
        const e = o['error'];
        const msg = (isObj(e) ? str(e['message']) : str(e)) ?? this.error ?? 'the turn failed';
        this.error = msg;
        this.final = { text: this.lastMessage, isError: true, error: msg };
        break;
      }
      case 'error': {
        // May be a transient warning (reconnect); only becomes a failure if the turn does not complete.
        const msg = str(o['message']);
        if (msg) this.error = msg;
        break;
      }
      default:
        break;
    }
    return out;
  }
}

/* ---------- base class ---------- */

export interface CliBackendOptions {
  /** Executable (or Node, with `prefixArgs` pointing to a script): for tests. */
  command?: string;
  prefixArgs?: string[];
  /** Extra environment variables for the subprocess. */
  env?: Record<string, string>;
  /** Maximum time of a turn in ms (default: 10 min). */
  timeoutMs?: number;
  log?: (message: string) => void;
}

export const DEFAULT_TURN_TIMEOUT_MS = 10 * 60 * 1000;
const INFO_TTL_MS = 30_000;
const VERSION_TIMEOUT_MS = 5000;
const MODEL_RE = /^[\w.:/[\]-]+$/;

/** Files and arguments of a turn, built by the concrete backend. */
interface RunPlan {
  args: string[];
  stdin: string;
}

abstract class CliBackend implements AgentBackend {
  abstract readonly id: string;
  abstract readonly name: string;
  /** Name of the executable looked up on PATH. */
  protected abstract readonly exe: string;
  /** Environment variable that overrides the executable path. */
  protected abstract readonly envBin: string;
  protected abstract readonly installHint: string;

  protected readonly log: (m: string) => void;
  private infoCache?: { at: number; value: Promise<AssistantBackendInfo> };

  constructor(protected readonly options: CliBackendOptions = {}) {
    this.log =
      options.log ??
      ((m) => {
        console.error('[mockup-assistant]', m);
      });
  }

  protected abstract plan(
    input: AgentRunInput,
    dir: string,
    cwd: string,
  ): RunPlan | Promise<RunPlan>;
  protected abstract createParser(): LineParser;

  /** Where the executable is (tests > env override > PATH). */
  protected locate(): Located | null {
    if (this.options.command) {
      return { command: this.options.command, prefixArgs: this.options.prefixArgs ?? [] };
    }
    const override = process.env[this.envBin];
    if (override) {
      return fs.existsSync(override) ? { command: override, prefixArgs: [] } : null;
    }
    const found = findExecutable(this.exe);
    return found ? { command: found, prefixArgs: [] } : null;
  }

  info(): Promise<AssistantBackendInfo> {
    const now = Date.now();
    if (this.infoCache && now - this.infoCache.at < INFO_TTL_MS) return this.infoCache.value;
    const value = this.readInfo();
    this.infoCache = { at: now, value };
    return value;
  }

  private async readInfo(): Promise<AssistantBackendInfo> {
    const loc = this.locate();
    if (!loc) {
      return {
        id: this.id,
        name: this.name,
        available: false,
        detail: `Not found (${this.exe}). ${this.installHint}`,
      };
    }
    const shown = loc.prefixArgs[0] ?? loc.command;
    const version = await this.readVersion(loc);
    return {
      id: this.id,
      name: this.name,
      available: true,
      path: shown,
      ...(version ? { detail: version } : {}),
    };
  }

  private readVersion(loc: Located): Promise<string | undefined> {
    return new Promise((resolve) => {
      let out = '';
      let child: ChildProcess;
      try {
        child = spawnLocated(loc, ['--version'], { env: this.options.env });
      } catch {
        resolve(undefined);
        return;
      }
      const timer = setTimeout(() => {
        killTree(child);
        resolve(undefined);
      }, VERSION_TIMEOUT_MS);
      child.stdout?.on('data', (c: Buffer) => (out += c.toString()));
      child.stderr?.on('data', () => undefined);
      child.stdin?.end();
      child.on('error', () => {
        clearTimeout(timer);
        resolve(undefined);
      });
      child.on('close', () => {
        clearTimeout(timer);
        resolve(
          out
            .split(/\r?\n/)
            .find((l) => l.trim())
            ?.trim(),
        );
      });
    });
  }

  async run(
    input: AgentRunInput,
    emit: (ev: AgentRunEvent) => void,
    signal: AbortSignal,
  ): Promise<AgentRunResult> {
    if (signal.aborted) throw abortError();
    const loc = this.locate();
    if (!loc) throw new Error(`${this.name} not found on PATH. ${this.installHint}`);
    if (input.model && !MODEL_RE.test(input.model)) {
      throw new Error(`Invalid model name: ${input.model}`);
    }
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mockup-agent-'));
    try {
      let cwd = dir;
      if (input.cwd) {
        fs.mkdirSync(input.cwd, { recursive: true });
        cwd = input.cwd;
      }
      const plan = await this.plan(input, dir, cwd);
      return await this.exec(loc, plan, cwd, emit, signal);
    } finally {
      try {
        fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      } catch (e) {
        this.log(`could not delete ${dir}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }

  private exec(
    loc: Located,
    plan: RunPlan,
    cwd: string,
    emit: (ev: AgentRunEvent) => void,
    signal: AbortSignal,
  ): Promise<AgentRunResult> {
    const parser = this.createParser();
    const timeoutMs = this.options.timeoutMs ?? DEFAULT_TURN_TIMEOUT_MS;
    return new Promise<AgentRunResult>((resolve, reject) => {
      let child: ChildProcess;
      try {
        child = spawnLocated(loc, plan.args, { cwd, env: this.options.env });
      } catch (e) {
        reject(e instanceof Error ? e : new Error(String(e)));
        return;
      }
      let aborted = false;
      let timedOut = false;
      let settled = false;
      let stderrTail = '';
      let buf = '';
      const decoder = new StringDecoder('utf8');

      const feed = (line: string): void => {
        for (const ev of parser.parse(line)) {
          try {
            emit(ev);
          } catch (e) {
            this.log(`error handling event: ${e instanceof Error ? e.message : String(e)}`);
          }
        }
      };
      const settle = (fn: () => void): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        clearTimeout(fallback);
        signal.removeEventListener('abort', onAbort);
        fn();
      };
      let fallback: NodeJS.Timeout | undefined;
      const onAbort = (): void => {
        aborted = true;
        killTree(child);
        // If 'close' never comes (stuck process), do not leave the turn hanging.
        fallback = setTimeout(() => settle(() => reject(abortError())), 3000);
      };
      const timer = setTimeout(() => {
        timedOut = true;
        killTree(child);
        fallback = setTimeout(() => settle(() => reject(this.timeoutError(timeoutMs))), 3000);
      }, timeoutMs);

      signal.addEventListener('abort', onAbort, { once: true });
      if (signal.aborted) onAbort();

      child.stdout?.on('data', (chunk: Buffer) => {
        buf += decoder.write(chunk);
        let i: number;
        while ((i = buf.indexOf('\n')) >= 0) {
          feed(buf.slice(0, i));
          buf = buf.slice(i + 1);
        }
      });
      child.stderr?.on('data', (c: Buffer) => {
        stderrTail = (stderrTail + c.toString()).slice(-4000);
      });
      child.stdin?.on('error', () => undefined);
      child.on('error', (err) =>
        settle(() => reject(new Error(`Could not start ${this.name}: ${err.message}`))),
      );
      child.on('close', (code) => {
        buf += decoder.end();
        if (buf.trim()) feed(buf);
        buf = '';
        settle(() => {
          if (aborted) return reject(abortError());
          if (timedOut) return reject(this.timeoutError(timeoutMs));
          const res = parser.result();
          if (res && !res.isError) {
            return resolve({ text: res.text, sessionId: res.sessionId, costUsd: res.costUsd });
          }
          reject(
            new Error(this.failureMessage(res?.error ?? parser.lastError(), code, stderrTail)),
          );
        });
      });

      if (!settled) child.stdin?.end(plan.stdin);
    });
  }

  private timeoutError(ms: number): Error {
    return new Error(
      `${this.name} exceeded the turn time limit (${Math.round(ms / 1000)} s) and was terminated.`,
    );
  }

  private failureMessage(reason: string | undefined, code: number | null, stderr: string): string {
    let msg =
      reason ??
      (code !== 0 && code !== null
        ? `${this.name} exited with code ${code}.`
        : `${this.name} finished without returning a response.`);
    const tail = stderr.trim().split(/\r?\n/).slice(-6).join('\n').slice(-600);
    if (tail && !msg.includes(tail)) msg += `\n${tail}`;
    if (/log ?in|logged|auth|credential|unauthori[sz]ed|api key|401/i.test(`${msg}`)) {
      msg += `\nCheck that ${this.name} is installed and signed in (open the CLI in a terminal and sign in to your account).`;
    }
    return msg;
  }
}

/* ---------- Claude Code ---------- */

/** Name of the daemon MCP server inside the Claude Code config. */
export const MCP_SERVER_NAME = 'mockup-studio';

export class ClaudeCliBackend extends CliBackend {
  readonly id = 'claude';
  readonly name = 'Claude Code';
  protected readonly exe = 'claude';
  protected readonly envBin = 'MOCKUP_CLAUDE_BIN';
  protected readonly installHint =
    'Install Claude Code (https://claude.com/claude-code) and sign in with `claude`.';

  protected override locate(): Located | null {
    const script = process.env['MOCKUP_AGENT_CLI'];
    if (!this.options.command && script) return { command: process.execPath, prefixArgs: [script] };
    return super.locate();
  }

  protected createParser(): LineParser {
    return new ClaudeStreamParser(this.log);
  }

  protected plan(input: AgentRunInput, dir: string): RunPlan {
    const args = [
      '-p',
      '--input-format',
      'stream-json',
      '--output-format',
      'stream-json',
      '--verbose',
      '--include-partial-messages',
      // No built-in tools (Bash, Read, Edit...): only the mockup-studio MCP ones.
      '--tools',
      '',
      '--strict-mcp-config',
      // No interactive prompt: anything not allowed below is denied automatically.
      '--permission-mode',
      'dontAsk',
      '--setting-sources',
      '',
      '--disable-slash-commands',
    ];
    if (input.mcp) {
      const cfg = path.join(dir, 'mcp.json');
      fs.writeFileSync(
        cfg,
        JSON.stringify({ mcpServers: { [input.mcp.name]: { type: 'http', url: input.mcp.url } } }),
        'utf8',
      );
      args.push('--mcp-config', cfg, '--allowedTools', `mcp__${input.mcp.name}`);
    }
    if (input.system) {
      const sys = path.join(dir, 'system.txt');
      fs.writeFileSync(sys, input.system, 'utf8');
      args.push('--append-system-prompt-file', sys);
    }
    if (input.model) args.push('--model', input.model);
    // A single argument (`--resume=<id>`) and only with a valid id: nothing becomes a flag by mistake.
    if (isValidSessionId(input.resumeSession)) args.push(`--resume=${input.resumeSession}`);

    const content: unknown[] = [{ type: 'text', text: input.prompt }];
    for (const img of input.images ?? []) {
      content.push({
        type: 'image',
        source: { type: 'base64', media_type: img.mime, data: img.data },
      });
    }
    const stdin = JSON.stringify({ type: 'user', message: { role: 'user', content } }) + '\n';
    return { args, stdin };
  }
}

/* ---------- Codex ---------- */

/**
 * Codex features turned off in the turn (only those present in `codex features list`): shell and
 * unified exec, and the integrations that give other tools to the agent.
 */
export const CODEX_DISABLED_FEATURES = [
  'shell_tool',
  'unified_exec',
  'apps',
  'browser_use',
  'computer_use',
  'in_app_browser',
] as const;

/** MCP server name that can be turned off via `-c mcp_servers.<name>.enabled=false` (simple TOML key). */
const TOML_BARE_KEY = /^[A-Za-z0-9_-]+$/;

/** Server names from `codex mcp list --json`. Invalid input becomes an empty list. */
export function parseCodexMcpList(json: string): string[] {
  try {
    const v: unknown = JSON.parse(json);
    if (!Array.isArray(v)) return [];
    return v.flatMap((s) => (isObj(s) && typeof s['name'] === 'string' ? [s['name']] : []));
  } catch {
    return [];
  }
}

/** Features from `codex features list` (`<name> <stage> <state>` per line), without the removed ones. */
export function parseCodexFeatures(text: string): string[] {
  const out: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const [name, stage] = line.trim().split(/\s+/);
    if (name && /^[a-z0-9_.]+$/.test(name) && stage !== 'removed') out.push(name);
  }
  return out;
}

export interface CodexIsolation {
  /** MCP servers configured by the user (all of them will be turned off in the turn). */
  servers: string[];
  /** Features that exist in this Codex version. */
  features: string[];
}

/** Key of the turn's server: the MCP name's, without colliding with a user server. */
export function codexTurnServerKey(name: string, existing: string[]): string {
  const key = name.replace(/[^A-Za-z0-9_]/g, '_');
  return existing.includes(key) ? `${key}_turn` : key;
}

/** Isolation arguments `-c mcp_servers.<name>.enabled=false` and `--disable <feature>`. */
export function codexIsolationArgs(iso: CodexIsolation, log?: (m: string) => void): string[] {
  const args: string[] = [];
  for (const name of iso.servers) {
    if (!TOML_BARE_KEY.test(name)) {
      // Codex does not accept quoted keys in `-c`: there is no way to turn this server off.
      log?.(
        `Codex MCP server "${name}" cannot be turned off in the turn (name outside [A-Za-z0-9_-])`,
      );
      continue;
    }
    args.push('-c', `mcp_servers.${name}.enabled=false`);
  }
  for (const f of CODEX_DISABLED_FEATURES) {
    if (iso.features.includes(f)) args.push('--disable', f);
  }
  return args;
}

export interface CodexCliBackendOptions extends CliBackendOptions {
  /** User MCP servers (default: `codex mcp list --json`). Failure = empty list. */
  listMcpServers?: () => Promise<string[]>;
  /** Codex features (default: `codex features list`). Failure = empty list. */
  listFeatures?: () => Promise<string[]>;
}

const ISOLATION_TTL_MS = 10_000;
const ISOLATION_TIMEOUT_MS = 5000;

export class CodexCliBackend extends CliBackend {
  readonly id = 'codex';
  readonly name = 'Codex';
  protected readonly exe = 'codex';
  protected readonly envBin = 'MOCKUP_CODEX_BIN';
  protected readonly installHint =
    'Install the Codex CLI (https://developers.openai.com/codex/cli) and sign in with `codex login`.';

  private isolationCache?: { at: number; value: Promise<CodexIsolation> };

  constructor(protected override readonly options: CodexCliBackendOptions = {}) {
    super(options);
  }

  protected createParser(): LineParser {
    return new CodexStreamParser(this.log);
  }

  /** Codex MCP servers and features, with a short cache; any failure becomes an empty list (not cached). */
  protected isolation(): Promise<CodexIsolation> {
    const now = Date.now();
    if (this.isolationCache && now - this.isolationCache.at < ISOLATION_TTL_MS) {
      return this.isolationCache.value;
    }
    const attempt = async (): Promise<{ iso: CodexIsolation; ok: boolean }> => {
      let ok = true;
      const guard = async (fn: () => Promise<string[]>, what: string): Promise<string[]> => {
        try {
          return await fn();
        } catch (e) {
          ok = false;
          this.log(`${what} unavailable: ${e instanceof Error ? e.message : String(e)}`);
          return [];
        }
      };
      const [servers, features] = await Promise.all([
        guard(
          this.options.listMcpServers ??
            (() => this.runList(['mcp', 'list', '--json'], parseCodexMcpList)),
          'codex mcp list',
        ),
        guard(
          this.options.listFeatures ??
            (() => this.runList(['features', 'list'], parseCodexFeatures)),
          'codex features list',
        ),
      ]);
      return { iso: { servers, features }, ok };
    };
    const value = attempt().then((r) => {
      if (!r.ok && this.isolationCache?.value === value) this.isolationCache = undefined;
      return r.iso;
    });
    this.isolationCache = { at: now, value };
    return value;
  }

  private async runList(args: string[], parse: (out: string) => string[]): Promise<string[]> {
    const loc = this.locate();
    if (!loc) return [];
    return parse(
      await runCapture(loc, args, { env: this.options.env, timeoutMs: ISOLATION_TIMEOUT_MS }),
    );
  }

  protected async plan(input: AgentRunInput, dir: string, cwd: string): Promise<RunPlan> {
    const iso = await this.isolation();
    // `-i` accepts several values: it goes right after `exec` and before another flag.
    const args = ['exec'];
    (input.images ?? []).forEach((img, i) => {
      const ext = img.mime === 'image/jpeg' ? 'jpg' : 'png';
      const file = path.join(dir, `image-${i + 1}.${ext}`);
      fs.writeFileSync(file, Buffer.from(img.data, 'base64'));
      args.push('-i', file);
    });
    args.push('--json', '--skip-git-repo-check', '--ephemeral', '-s', 'read-only', '-C', cwd);
    if (input.model) args.push('-m', input.model);
    // The `-c` flags only add to the user's config: turns off their MCPs and tools in this turn.
    args.push(...codexIsolationArgs(iso, this.log));
    if (input.mcp) {
      // Unquoted values: if they are not valid TOML Codex uses the raw string (avoids quotes in .cmd).
      const key = `mcp_servers.${codexTurnServerKey(input.mcp.name, iso.servers)}`;
      args.push(
        '-c',
        `${key}.url=${input.mcp.url}`,
        '-c',
        `${key}.default_tools_approval_mode=approve`,
      );
    }
    // Codex has no stable flag for a system prompt file: it goes along in the prompt (stdin).
    const stdin = input.system
      ? `${input.system}\n\n---\n\n${input.prompt}\n`
      : `${input.prompt}\n`;
    return { args, stdin };
  }
}

/* ---------- detection ---------- */

/** Default daemon backends, in the preference order of `auto` mode. */
export function detectBackends(): AgentBackend[] {
  return [new ClaudeCliBackend(), new CodexCliBackend()];
}
