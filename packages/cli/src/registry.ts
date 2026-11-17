/** Leitura do registro do servidor MCP direto dos arquivos de config do Claude Code e do Codex (sem rodar `mcp get`). */
import fs from 'node:fs';
import path from 'node:path';
import { SERVER_NAME, type LaunchCommand } from './launch.js';
import { findSection, parseDoc, readServerTable, tomlError } from './tomlEdit.js';

export interface RegisteredServer {
  transport: 'stdio' | 'http';
  command?: string;
  args?: string[];
  url?: string;
  env?: Record<string, string>;
}

export interface FsDeps {
  /** Conteúdo do arquivo, ou `null` se não existe/ilegível. */
  readFile: (p: string) => string | null;
  home: string;
  env: NodeJS.ProcessEnv;
  cwd: string;
}

export function defaultReadFile(p: string): string | null {
  try {
    return fs.readFileSync(p, 'utf8');
  } catch {
    return null;
  }
}

export type ClaudeScope = 'user' | 'local' | 'project';

export interface ClaudeRegistration {
  scope: ClaudeScope;
  /** Arquivo ou pasta de origem. */
  origin: string;
  server: RegisteredServer;
}

export function claudeConfigPath(d: Pick<FsDeps, 'home' | 'env'>): string {
  return path.join(d.env.CLAUDE_CONFIG_DIR || d.home, '.claude.json');
}

export function codexHome(d: Pick<FsDeps, 'home' | 'env'>): string {
  return d.env.CODEX_HOME || path.join(d.home, '.codex');
}

export const codexConfigPath = (d: Pick<FsDeps, 'home' | 'env'>) =>
  path.join(codexHome(d), 'config.toml');

function jsonServer(v: unknown): RegisteredServer | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  if (o.type === 'http' || o.type === 'sse' || (typeof o.url === 'string' && !o.command))
    return { transport: 'http', url: typeof o.url === 'string' ? o.url : undefined };
  return {
    transport: 'stdio',
    command: typeof o.command === 'string' ? o.command : undefined,
    args: Array.isArray(o.args) ? o.args.map(String) : [],
    env:
      o.env && typeof o.env === 'object'
        ? Object.fromEntries(
            Object.entries(o.env as Record<string, unknown>).map(([k, x]) => [k, String(x)]),
          )
        : {},
  };
}

const normPath = (p: string) => {
  const s = p.replace(/\\/g, '/').replace(/\/+$/, '');
  return /^[a-z]:/i.test(s) ? s.toLowerCase() : s;
};

function parseJson(text: string | null): Record<string, unknown> | null {
  if (!text) return null;
  try {
    const v: unknown = JSON.parse(text);
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

const serversOf = (o: unknown): Record<string, unknown> | undefined => {
  const s = (o as { mcpServers?: unknown } | undefined)?.mcpServers;
  return s && typeof s === 'object' ? (s as Record<string, unknown>) : undefined;
};

/** Registros do `mockup-studio` no Claude Code: user (`~/.claude.json`), local (do cwd) e project (`.mcp.json`). */
export function readClaudeRegistrations(d: FsDeps): ClaudeRegistration[] {
  const out: ClaudeRegistration[] = [];
  const file = claudeConfigPath(d);
  const cfg = parseJson(d.readFile(file));
  const push = (scope: ClaudeScope, origin: string, raw: unknown) => {
    const server = jsonServer(raw);
    if (server) out.push({ scope, origin, server });
  };
  if (cfg) {
    push('user', file, serversOf(cfg)?.[SERVER_NAME]);
    const projects = cfg.projects;
    if (projects && typeof projects === 'object') {
      const cwd = normPath(d.cwd);
      for (const [k, v] of Object.entries(projects as Record<string, unknown>))
        if (normPath(k) === cwd) push('local', d.cwd, serversOf(v)?.[SERVER_NAME]);
    }
  }
  const mcpJson = path.join(d.cwd, '.mcp.json');
  push('project', mcpJson, serversOf(parseJson(d.readFile(mcpJson)))?.[SERVER_NAME]);
  return out;
}

export interface CodexRegistration {
  path: string;
  server: RegisteredServer;
  /** Valor de `default_tools_approval_mode`, se houver. */
  approve?: string;
  /** O arquivo não é TOML válido (o Codex também não o carrega); `server` fica vazio. */
  error?: string;
}

const strOf = (v: unknown) => (typeof v === 'string' ? v : undefined);

/** Servidor descrito por uma tabela `[mcp_servers.<nome>]` já interpretada. */
export function codexServer(t: Record<string, unknown>): RegisteredServer {
  const url = strOf(t.url);
  if (url) return { transport: 'http', url };
  const env = t.env && typeof t.env === 'object' && !Array.isArray(t.env) ? t.env : {};
  return {
    transport: 'stdio',
    command: strOf(t.command),
    args: Array.isArray(t.args) && t.args.every((x) => typeof x === 'string') ? t.args : undefined,
    env: Object.fromEntries(
      Object.entries(env as Record<string, unknown>).filter(
        (p): p is [string, string] => typeof p[1] === 'string',
      ),
    ),
  };
}

/**
 * Seção `[mcp_servers.mockup-studio]` do config do Codex, ou `null`. Se o arquivo não é TOML válido
 * mas tem o cabeçalho da seção, devolve o registro com `error`.
 */
export function readCodexRegistration(d: FsDeps): CodexRegistration | null {
  const p = codexConfigPath(d);
  const text = d.readFile(p);
  if (text === null) return null;
  const error = tomlError(text);
  if (error)
    return findSection(parseDoc(text)) ? { path: p, server: { transport: 'stdio' }, error } : null;
  const t = readServerTable(text, SERVER_NAME);
  if (!t) return null;
  return { path: p, server: codexServer(t), approve: strOf(t.default_tools_approval_mode) };
}

/** Servidor desejado, no mesmo formato do registrado. */
export function wantedServer(launch: LaunchCommand, http: string | null): RegisteredServer {
  return http
    ? { transport: 'http', url: http }
    : { transport: 'stdio', command: launch.command, args: launch.args, env: launch.env ?? {} };
}

/** `a` (registrado) atende `b` (desejado): mesmo comando/URL e as variáveis de `b` presentes em `a`. */
export function sameServer(a: RegisteredServer, b: RegisteredServer): boolean {
  if (a.transport !== b.transport) return false;
  if (Object.entries(b.env ?? {}).some(([k, v]) => a.env?.[k] !== v)) return false;
  if (a.transport === 'http') return a.url === b.url;
  return (
    a.command === b.command &&
    a.args !== undefined &&
    b.args !== undefined &&
    a.args.length === b.args.length &&
    a.args.every((x, i) => x === b.args?.[i])
  );
}

export function describeServer(s: RegisteredServer): string {
  return s.transport === 'http'
    ? `${s.url ?? '?'}`
    : [s.command ?? '?', ...(s.args ?? [])].join(' ');
}
