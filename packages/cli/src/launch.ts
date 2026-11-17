/** Comando que os clientes MCP (Claude Code, Codex...) usam para lançar `mockup mcp`, e seus formatos. */
import fs from 'node:fs';
import { resolvePort } from '@mockup/server';
import { shimPath } from './install.js';
import { cliRuntime, type CliRuntime } from './runtime.js';
import { findOnPath } from './tools.js';

export const SERVER_NAME = 'mockup-studio';

export type LaunchKind = 'path' | 'shim' | 'absolute';

export interface LaunchCommand {
  command: string;
  args: string[];
  env?: Record<string, string>;
  kind: LaunchKind;
}

export interface LaunchDeps {
  runtime: CliRuntime;
  /** Caminho de `mockup` no PATH, ou `null`. */
  which: (name: string) => string | null;
  shim: string;
  exists: (p: string) => boolean;
  /** Força o tipo de comando (`--command path|shim|absolute`). */
  force?: LaunchKind;
}

export function defaultLaunchDeps(force?: LaunchKind): LaunchDeps {
  return {
    runtime: cliRuntime(),
    which: (n) => findOnPath(n),
    shim: shimPath(),
    exists: fs.existsSync,
    force,
  };
}

/** Converte o valor de `--command`; lança erro se inválido. */
export function parseLaunchKind(v: unknown): LaunchKind | undefined {
  if (v === undefined) return undefined;
  if (v === 'path' || v === 'shim' || v === 'absolute') return v;
  throw new Error('--command exige path, shim ou absolute.');
}

export function resolveLaunchCommand(deps: LaunchDeps = defaultLaunchDeps()): LaunchCommand {
  const { force } = deps;
  if (force === 'path' || (!force && deps.which('mockup')))
    return { command: 'mockup', args: ['mcp'], kind: 'path' };
  if (force === 'shim' || (!force && deps.exists(deps.shim)))
    return { command: deps.shim, args: ['mcp'], kind: 'shim' };
  const r = deps.runtime;
  const launch: LaunchCommand = {
    command: r.execPath,
    args: [r.script, 'mcp'],
    kind: 'absolute',
  };
  if (r.kind === 'electron') launch.env = { ELECTRON_RUN_AS_NODE: '1' };
  return launch;
}

export interface FormatOptions {
  http?: boolean;
  port?: number;
}

export const httpUrl = (o: FormatOptions) => `http://127.0.0.1:${o.port ?? resolvePort()}/mcp`;

function envPairs(l: LaunchCommand, flag: string): string[] {
  return Object.entries(l.env ?? {}).flatMap(([k, v]) => [flag, `${k}=${v}`]);
}

/** Argumentos de `claude` para registrar o servidor (escopo de usuário). */
export function claudeAddArgs(l: LaunchCommand, o: FormatOptions = {}): string[] {
  if (o.http)
    return ['mcp', 'add', '--scope', 'user', '--transport', 'http', SERVER_NAME, httpUrl(o)];
  return [
    'mcp',
    'add',
    '--scope',
    'user',
    ...envPairs(l, '-e'),
    SERVER_NAME,
    '--',
    l.command,
    ...l.args,
  ];
}

/** Argumentos de `codex` para registrar o servidor. */
export function codexAddArgs(l: LaunchCommand, o: FormatOptions = {}): string[] {
  if (o.http) return ['mcp', 'add', SERVER_NAME, '--url', httpUrl(o)];
  return ['mcp', 'add', SERVER_NAME, ...envPairs(l, '--env'), '--', l.command, ...l.args];
}

/** String TOML básica (escapa `\`, `"` e controles: caminhos do Windows). */
export function tomlString(s: string): string {
  // eslint-disable-next-line no-control-regex -- os controles TOML precisam de escape
  const esc = s.replace(/[\\"\u0000-\u001f\u007f]/g, (c) => {
    switch (c) {
      case '\\':
        return '\\\\';
      case '"':
        return '\\"';
      case '\n':
        return '\\n';
      case '\r':
        return '\\r';
      case '\t':
        return '\\t';
      default:
        return `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`;
    }
  });
  return `"${esc}"`;
}

/** Bloco para `~/.codex/config.toml`. */
export function codexToml(l: LaunchCommand): string {
  const lines = [
    `[mcp_servers.${SERVER_NAME}]`,
    `command = ${tomlString(l.command)}`,
    `args = [${l.args.map(tomlString).join(', ')}]`,
  ];
  const env = Object.entries(l.env ?? {});
  if (env.length) {
    lines.push('', `[mcp_servers.${SERVER_NAME}.env]`);
    for (const [k, v] of env) lines.push(`${k} = ${tomlString(v)}`);
  }
  return lines.join('\n');
}

/** JSON `mcpServers` (Claude Desktop, Cursor, `.mcp.json`...). */
export function mcpServersJson(l: LaunchCommand): string {
  const entry = { command: l.command, args: l.args, ...(l.env ? { env: l.env } : {}) };
  return JSON.stringify({ mcpServers: { [SERVER_NAME]: entry } }, null, 2);
}

/** JSON do `mcp.json` do VS Code. */
export function vscodeMcpJson(l: LaunchCommand): string {
  const entry = {
    type: 'stdio',
    command: l.command,
    args: l.args,
    ...(l.env ? { env: l.env } : {}),
  };
  return JSON.stringify({ servers: { [SERVER_NAME]: entry } }, null, 2);
}

/** Aspas para imprimir um comando copiável (cmd/PowerShell no Windows, sh no resto). */
export function shellQuote(s: string, platform: NodeJS.Platform = process.platform): string {
  if (platform === 'win32') {
    if (/^[A-Za-z0-9_@%+=:,./\\-]+$/.test(s)) return s;
    return `"${s.replace(/"/g, '\\"')}"`;
  }
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(s)) return s;
  return `'${s.replace(/'/g, "'\\''")}'`;
}

/** Linha de comando copiável: `claude mcp add ...`. */
export function commandLine(
  tool: string,
  args: string[],
  platform: NodeJS.Platform = process.platform,
): string {
  return [tool, ...args.map((a) => shellQuote(a, platform))].join(' ');
}
