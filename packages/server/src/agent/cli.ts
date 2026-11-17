/**
 * Backends de agente por subprocesso: Claude Code (`claude -p`) e Codex (`codex exec`).
 *
 * Cada turno é um processo novo. O prompt vai por stdin; a config MCP e o prompt de sistema vão por
 * arquivos temporários (nada de JSON nos argumentos, para não depender do quoting do Windows). A
 * saída JSONL é lida linha a linha e convertida em `AgentRunEvent`.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import type { AssistantBackendInfo } from '@mockup/core';
import type { AgentBackend, AgentRunEvent, AgentRunInput, AgentRunResult } from './backend.js';

/* ---------- localizar executáveis ---------- */

export interface FindExecutableEnv {
  /** Valor do PATH (padrão: `process.env.PATH`). */
  pathEnv?: string;
  /** Valor do PATHEXT, só no Windows (padrão: `process.env.PATHEXT`). */
  pathExt?: string;
  platform?: NodeJS.Platform;
  /** Testa se o caminho é um arquivo executável (injetável nos testes). */
  isFile?: (file: string) => boolean;
}

function defaultIsFile(file: string): boolean {
  try {
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

/** Extensões de executável aceitas no Windows, em ordem de preferência. */
const WIN_EXT_ORDER = ['.exe', '.cmd', '.bat'];

/**
 * Caminho completo do executável no PATH ou `null`. No Windows respeita o PATHEXT e prefere `.exe`
 * a `.cmd`/`.bat` (um `.exe` roda sem shell). Nome com separador de pasta é testado direto.
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

/* ---------- utilitários de processo ---------- */

export function abortError(message = 'Turno cancelado.'): Error {
  const e = new Error(message);
  e.name = 'AbortError';
  return e;
}

export function isAbortError(e: unknown): boolean {
  return e instanceof Error && e.name === 'AbortError';
}

/** Mata o processo e todos os descendentes (taskkill /T no Windows, grupo de processos no resto). */
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

/** Argumento seguro para `cmd.exe` (só usado com `.cmd`/`.bat`): recusa o que não dá para citar. */
function quoteCmdArg(a: string): string {
  if (/["%\r\n]/.test(a)) throw new Error(`Argumento não suportado para executar um .cmd: ${a}`);
  return a === '' || /[\s&|<>^()!,;=]/.test(a) ? `"${a}"` : a;
}

export interface Located {
  /** Executável (ou o Node, quando `prefixArgs` tem o script). */
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
  if (win && /\.(cmd|bat)$/i.test(loc.command)) {
    // Sem lista de args: com `shell: true` o Node a concatenaria sem citar (e avisa de risco).
    const line = [loc.command, ...all].map(quoteCmdArg).join(' ');
    return spawn(line, { ...base, shell: true });
  }
  return spawn(loc.command, all, { ...base, shell: false });
}

/* ---------- parsers de JSONL ---------- */

export interface ParsedResult {
  text: string;
  sessionId?: string;
  costUsd?: number;
  isError: boolean;
  error?: string;
}

export interface LineParser {
  /** Processa uma linha de stdout e devolve os eventos gerados (linhas inválidas são ignoradas). */
  parse(line: string): AgentRunEvent[];
  /** Resultado final, depois que a CLI sinalizou o fim do turno. */
  result(): ParsedResult | undefined;
  /** Último erro visto no fluxo (para compor a mensagem quando o turno falha). */
  lastError(): string | undefined;
}

const MCP_PREFIX = /^mcp__[^_]+__/;

/** Nome da ferramenta sem o prefixo `mcp__<servidor>__` (Claude Code). */
export function stripMcpPrefix(name: string): string {
  return name.replace(MCP_PREFIX, '');
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

/** Primeira linha não vazia, até 200 caracteres. */
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
    log(`linha não-JSON ignorada: ${t.length > 200 ? t.slice(0, 200) + '...' : t}`);
    return undefined;
  }
}

/** Saída de `claude -p --output-format stream-json --verbose --include-partial-messages`. */
export class ClaudeStreamParser implements LineParser {
  private final?: ParsedResult;
  private error?: string;
  private sessionSent = false;
  /** Ids de mensagem cujo texto já chegou em deltas (não repetir quando vier a mensagem completa). */
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
              name: stripMcpPrefix(str(b['name']) ?? 'ferramenta'),
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
          ? resultText || errors.join('; ') || sub || 'erro desconhecido'
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

/** Saída de `codex exec --json`. */
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
          const name = str(item['tool']) ?? str(item['name']) ?? 'ferramenta';
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
        const msg = (isObj(e) ? str(e['message']) : str(e)) ?? this.error ?? 'o turno falhou';
        this.error = msg;
        this.final = { text: this.lastMessage, isError: true, error: msg };
        break;
      }
      case 'error': {
        // Pode ser aviso transitório (reconexão); só vira falha se o turno não completar.
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

/* ---------- classe base ---------- */

export interface CliBackendOptions {
  /** Executável (ou o Node, com `prefixArgs` apontando para um script): para testes. */
  command?: string;
  prefixArgs?: string[];
  /** Variáveis de ambiente extras do subprocesso. */
  env?: Record<string, string>;
  /** Tempo máximo de um turno em ms (padrão: 10 min). */
  timeoutMs?: number;
  log?: (message: string) => void;
}

export const DEFAULT_TURN_TIMEOUT_MS = 10 * 60 * 1000;
const INFO_TTL_MS = 30_000;
const VERSION_TIMEOUT_MS = 5000;
const MODEL_RE = /^[\w.:/[\]-]+$/;

/** Arquivos e argumentos de um turno, montados pelo backend concreto. */
interface RunPlan {
  args: string[];
  stdin: string;
}

abstract class CliBackend implements AgentBackend {
  abstract readonly id: string;
  abstract readonly name: string;
  /** Nome do executável procurado no PATH. */
  protected abstract readonly exe: string;
  /** Variável de ambiente que sobrescreve o caminho do executável. */
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

  protected abstract plan(input: AgentRunInput, dir: string, cwd: string): RunPlan;
  protected abstract createParser(): LineParser;

  /** Onde está o executável (testes > override por env > PATH). */
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
        detail: `Não encontrado (${this.exe}). ${this.installHint}`,
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
    if (!loc) throw new Error(`${this.name} não encontrado no PATH. ${this.installHint}`);
    if (input.model && !MODEL_RE.test(input.model)) {
      throw new Error(`Nome de modelo inválido: ${input.model}`);
    }
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mockup-agent-'));
    try {
      let cwd = dir;
      if (input.cwd) {
        fs.mkdirSync(input.cwd, { recursive: true });
        cwd = input.cwd;
      }
      const plan = this.plan(input, dir, cwd);
      return await this.exec(loc, plan, cwd, emit, signal);
    } finally {
      try {
        fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      } catch (e) {
        this.log(`não foi possível apagar ${dir}: ${e instanceof Error ? e.message : String(e)}`);
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
            this.log(`erro no tratamento de evento: ${e instanceof Error ? e.message : String(e)}`);
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
        // Se o 'close' não vier (processo preso), não deixa o turno pendurado.
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
        settle(() => reject(new Error(`Não foi possível iniciar ${this.name}: ${err.message}`))),
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
      `${this.name} excedeu o tempo limite do turno (${Math.round(ms / 1000)} s) e foi encerrado.`,
    );
  }

  private failureMessage(reason: string | undefined, code: number | null, stderr: string): string {
    let msg =
      reason ??
      (code !== 0 && code !== null
        ? `${this.name} terminou com código ${code}.`
        : `${this.name} terminou sem devolver resposta.`);
    const tail = stderr.trim().split(/\r?\n/).slice(-6).join('\n').slice(-600);
    if (tail && !msg.includes(tail)) msg += `\n${tail}`;
    if (/log ?in|logged|auth|credential|unauthori[sz]ed|api key|401/i.test(`${msg}`)) {
      msg += `\nVerifique se ${this.name} está instalado e logado (abra a CLI no terminal e entre na sua conta).`;
    }
    return msg;
  }
}

/* ---------- Claude Code ---------- */

/** Nome do servidor MCP do daemon dentro da config do Claude Code. */
export const MCP_SERVER_NAME = 'mockup-studio';

export class ClaudeCliBackend extends CliBackend {
  readonly id = 'claude';
  readonly name = 'Claude Code';
  protected readonly exe = 'claude';
  protected readonly envBin = 'MOCKUP_CLAUDE_BIN';
  protected readonly installHint =
    'Instale o Claude Code (https://claude.com/claude-code) e faça login com `claude`.';

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
      // Sem ferramentas embutidas (Bash, Read, Edit...): só as do MCP do mockup-studio.
      '--tools',
      '',
      '--strict-mcp-config',
      // Nada de prompt interativo: o que não está liberado abaixo é negado sozinho.
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
    if (input.resumeSession) args.push('--resume', input.resumeSession);

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

export class CodexCliBackend extends CliBackend {
  readonly id = 'codex';
  readonly name = 'Codex';
  protected readonly exe = 'codex';
  protected readonly envBin = 'MOCKUP_CODEX_BIN';
  protected readonly installHint =
    'Instale o Codex CLI (https://developers.openai.com/codex/cli) e faça login com `codex login`.';

  protected createParser(): LineParser {
    return new CodexStreamParser(this.log);
  }

  protected plan(input: AgentRunInput, dir: string, cwd: string): RunPlan {
    // `-i` aceita vários valores: fica logo depois de `exec` e antes de outra flag.
    const args = ['exec'];
    (input.images ?? []).forEach((img, i) => {
      const ext = img.mime === 'image/jpeg' ? 'jpg' : 'png';
      const file = path.join(dir, `imagem-${i + 1}.${ext}`);
      fs.writeFileSync(file, Buffer.from(img.data, 'base64'));
      args.push('-i', file);
    });
    args.push('--json', '--skip-git-repo-check', '--ephemeral', '-s', 'read-only', '-C', cwd);
    if (input.model) args.push('-m', input.model);
    if (input.mcp) {
      // Valores sem aspas: se não forem TOML válido o Codex usa a string crua (evita aspas em .cmd).
      const key = `mcp_servers.${input.mcp.name.replace(/[^A-Za-z0-9_]/g, '_')}`;
      args.push(
        '-c',
        `${key}.url=${input.mcp.url}`,
        '-c',
        `${key}.default_tools_approval_mode=approve`,
      );
    }
    // O Codex não tem arquivo de system prompt por flag estável: vai junto no prompt (stdin).
    const stdin = input.system
      ? `${input.system}\n\n---\n\n${input.prompt}\n`
      : `${input.prompt}\n`;
    return { args, stdin };
  }
}

/* ---------- detecção ---------- */

/** Backends padrão do daemon, na ordem de preferência do modo `auto`. */
export function detectBackends(): AgentBackend[] {
  return [new ClaudeCliBackend(), new CodexCliBackend()];
}
