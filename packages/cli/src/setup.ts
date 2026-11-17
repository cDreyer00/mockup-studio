/** `mockup setup claude|codex|all`: registra o servidor MCP nos clientes (ou imprime como fazer). */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  SERVER_NAME,
  claudeAddArgs,
  codexAddArgs,
  codexToml,
  commandLine,
  defaultLaunchDeps,
  resolveLaunchCommand,
  type LaunchCommand,
  type LaunchKind,
} from './launch.js';
import { findOnPath, runTool, type ToolResult } from './tools.js';

export type SetupTarget = 'claude' | 'codex' | 'all';

export interface SetupOptions {
  http?: boolean;
  skill?: boolean;
  print?: boolean;
  command?: LaunchKind;
  port?: number;
}

export interface SetupDeps {
  findOnPath: (name: string) => string | null;
  runTool: (name: string, args: string[]) => ToolResult;
  launch: (force?: LaunchKind) => LaunchCommand;
  /** Pasta `integrations` (com `claude-code/SKILL.md`), ou `null`. */
  integrationsDir: () => string | null;
  home: string;
  platform: NodeJS.Platform;
}

export interface SetupResult {
  code: 0 | 1;
  lines: string[];
}

/** Candidatos da pasta `integrations`, na ordem de busca. */
export function integrationsCandidates(
  env: NodeJS.ProcessEnv = process.env,
  bundleDir: string = path.dirname(fileURLToPath(import.meta.url)),
  resourcesPath: string | undefined = (process as unknown as { resourcesPath?: string })
    .resourcesPath,
): string[] {
  const list: string[] = [];
  if (env.MOCKUP_INTEGRATIONS_DIR) list.push(env.MOCKUP_INTEGRATIONS_DIR);
  list.push(path.resolve(bundleDir, '..', 'integrations'));
  if (resourcesPath) list.push(path.join(resourcesPath, 'integrations'));
  list.push(path.resolve(bundleDir, '..', '..', '..', 'integrations'));
  return list;
}

export function findIntegrationsDir(
  candidates: string[] = integrationsCandidates(),
  exists: (p: string) => boolean = fs.existsSync,
): string | null {
  return candidates.find((d) => exists(path.join(d, 'claude-code', 'SKILL.md'))) ?? null;
}

export function defaultSetupDeps(): SetupDeps {
  return {
    findOnPath: (n) => findOnPath(n),
    runTool: (n, a) => runTool(n, a),
    launch: (force) => resolveLaunchCommand(defaultLaunchDeps(force)),
    integrationsDir: () => findIntegrationsDir(),
    home: os.homedir(),
    platform: process.platform,
  };
}

function failLines(r: ToolResult, manual: string): string[] {
  const detail = (r.stderr || r.stdout || r.error || `código ${r.status}`).trim();
  return [`  falhou: ${detail}`, `  rode manualmente: ${manual}`];
}

interface ClientSpec {
  tool: 'claude' | 'codex';
  addArgs: string[];
  removeArgs: string[];
}

function registerClient(spec: ClientSpec, opts: SetupOptions, deps: SetupDeps): SetupResult {
  const { tool } = spec;
  const q = (args: string[]) => commandLine(tool, args, deps.platform);
  const lines: string[] = [];
  const exe = deps.findOnPath(tool);
  const toml = tool === 'codex' && !opts.http ? codexToml(deps.launch(opts.command)) : null;
  const tomlHelp = toml
    ? ['', 'Ou, em ~/.codex/config.toml:', ...toml.split('\n').map((l) => `  ${l}`)]
    : [];

  if (opts.print || !exe) {
    lines.push(
      !opts.print && !exe
        ? `${tool}: não encontrado no PATH. Para registrar, rode:`
        : `${tool}: para registrar, rode:`,
      `  ${q(spec.addArgs)}`,
      ...tomlHelp,
    );
    return { code: 0, lines };
  }

  const exists = deps.runTool(tool, ['mcp', 'get', SERVER_NAME]).status === 0;
  if (exists) {
    lines.push(`${tool}: ${SERVER_NAME} já registrado; removendo para atualizar...`);
    lines.push(`  > ${q(spec.removeArgs)}`);
    const rm = deps.runTool(tool, spec.removeArgs);
    if (rm.status !== 0) {
      lines.push(...failLines(rm, `${q(spec.removeArgs)} && ${q(spec.addArgs)}`));
      return { code: 1, lines };
    }
  }
  lines.push(`  > ${q(spec.addArgs)}`);
  const add = deps.runTool(tool, spec.addArgs);
  if (add.status !== 0) {
    lines.push(...failLines(add, q(spec.addArgs)), ...tomlHelp);
    return { code: 1, lines };
  }
  lines.push(`${tool}: ${SERVER_NAME} ${exists ? 'atualizado' : 'registrado'}.`);
  return { code: 0, lines };
}

/** Copia a skill para `~/.claude/skills/mockup-studio/SKILL.md`. */
export function installSkill(deps: SetupDeps, print = false): SetupResult {
  const dest = path.join(deps.home, '.claude', 'skills', SERVER_NAME, 'SKILL.md');
  const dir = deps.integrationsDir();
  if (!dir)
    return {
      code: 1,
      lines: [
        'skill: pasta integrations/claude-code/SKILL.md não encontrada (defina MOCKUP_INTEGRATIONS_DIR).',
      ],
    };
  const src = path.join(dir, 'claude-code', 'SKILL.md');
  if (print) return { code: 0, lines: [`skill: copiaria ${src} para ${dest}`] };
  try {
    const existed = fs.existsSync(dest);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
    return { code: 0, lines: [`skill: ${existed ? 'atualizada' : 'instalada'} em ${dest}`] };
  } catch (e) {
    return {
      code: 1,
      lines: [`skill: falhou ao copiar para ${dest}: ${e instanceof Error ? e.message : e}`],
    };
  }
}

export function runSetup(
  target: SetupTarget,
  opts: SetupOptions = {},
  deps: SetupDeps = defaultSetupDeps(),
): SetupResult {
  const launch = deps.launch(opts.command);
  const fmt = { http: opts.http, port: opts.port };
  const lines: string[] = [];
  let code: 0 | 1 = 0;
  const add = (r: SetupResult) => {
    lines.push(...r.lines);
    if (r.code !== 0) code = 1;
  };

  if (target === 'claude' || target === 'all') {
    add(
      registerClient(
        {
          tool: 'claude',
          addArgs: claudeAddArgs(launch, fmt),
          removeArgs: ['mcp', 'remove', SERVER_NAME, '-s', 'user'],
        },
        opts,
        deps,
      ),
    );
    if (opts.skill) add(installSkill(deps, opts.print));
  }
  if (target === 'codex' || target === 'all') {
    if (lines.length) lines.push('');
    add(
      registerClient(
        {
          tool: 'codex',
          addArgs: codexAddArgs(launch, fmt),
          removeArgs: ['mcp', 'remove', SERVER_NAME],
        },
        opts,
        deps,
      ),
    );
    if (opts.skill && target === 'codex')
      lines.push('--skill só vale para o Claude Code: ignorado para o Codex.');
  }
  return { code, lines };
}
