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
  httpUrl,
  resolveLaunchCommand,
  tomlString,
  type LaunchCommand,
  type LaunchKind,
} from './launch.js';
import {
  codexConfigPath,
  codexHome,
  defaultReadFile,
  describeServer,
  readClaudeRegistrations,
  readCodexRegistration,
  sameServer,
  wantedServer,
  type FsDeps,
  type RegisteredServer,
} from './registry.js';
import {
  findSection,
  getValue,
  parseDoc,
  removeKey,
  renderDoc,
  setKey,
  type TomlDoc,
} from './tomlEdit.js';
import { findOnPath, runTool, type ToolResult } from './tools.js';

export type SetupTarget = 'claude' | 'codex' | 'all';

export interface SetupOptions {
  http?: boolean;
  skill?: boolean;
  print?: boolean;
  command?: LaunchKind;
  port?: number;
  /** Recria o registro do zero (remove + add), mesmo igual. */
  force?: boolean;
  /** Codex: grava `default_tools_approval_mode = "approve"`. */
  approve?: boolean;
  /** Codex: acrescenta o trecho de AGENTS.md. */
  agents?: boolean;
}

export interface SetupDeps {
  findOnPath: (name: string) => string | null;
  runTool: (name: string, args: string[]) => ToolResult;
  launch: (force?: LaunchKind) => LaunchCommand;
  /** Pasta `integrations` (com `claude-code/SKILL.md`), ou `null`. */
  integrationsDir: () => string | null;
  /** Conteúdo do arquivo, ou `null` se não existe. */
  readFile: (p: string) => string | null;
  /** Grava o arquivo, criando as pastas. */
  writeFile: (p: string, content: string) => void;
  home: string;
  env: NodeJS.ProcessEnv;
  cwd: string;
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
    readFile: defaultReadFile,
    writeFile: (p, content) => {
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, content);
    },
    home: os.homedir(),
    env: process.env,
    cwd: process.cwd(),
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
  wanted: RegisteredServer;
}

const DISCARD_WARN =
  '  aviso: o re-registro descarta campos extras (env/headers/aprovações personalizados).';

/** Roda `remove` e `add`; "não encontrado" no remove conta como sucesso. */
function removeAndAdd(spec: ClientSpec, deps: SetupDeps, lines: string[]): boolean {
  const q = (args: string[]) => commandLine(spec.tool, args, deps.platform);
  lines.push(`  > ${q(spec.removeArgs)}`);
  const rm = deps.runTool(spec.tool, spec.removeArgs);
  if (rm.status !== 0 && !/not found|no mcp server/i.test(`${rm.stderr}\n${rm.stdout}`)) {
    lines.push(...failLines(rm, `${q(spec.removeArgs)} && ${q(spec.addArgs)}`));
    return false;
  }
  return runAdd(spec, deps, lines, []);
}

function runAdd(spec: ClientSpec, deps: SetupDeps, lines: string[], help: string[]): boolean {
  const q = (args: string[]) => commandLine(spec.tool, args, deps.platform);
  lines.push(`  > ${q(spec.addArgs)}`);
  const add = deps.runTool(spec.tool, spec.addArgs);
  if (add.status !== 0) {
    lines.push(...failLines(add, q(spec.addArgs)), ...help);
    return false;
  }
  return true;
}

const fsDeps = (deps: SetupDeps): FsDeps => ({
  readFile: deps.readFile,
  home: deps.home,
  env: deps.env,
  cwd: deps.cwd,
});

function registerClaude(spec: ClientSpec, opts: SetupOptions, deps: SetupDeps): SetupResult {
  const q = (args: string[]) => commandLine('claude', args, deps.platform);
  const lines: string[] = [];
  const exe = deps.findOnPath('claude');
  if (opts.print || !exe) {
    lines.push(
      !opts.print && !exe
        ? 'claude: não encontrado no PATH. Para registrar, rode:'
        : 'claude: para registrar, rode:',
      `  ${q(spec.addArgs)}`,
    );
    return { code: 0, lines };
  }

  const regs = readClaudeRegistrations(fsDeps(deps));
  const user = regs.find((r) => r.scope === 'user');
  for (const r of regs) {
    if (r.scope === 'local')
      lines.push(
        `claude: ${SERVER_NAME} registrado também no escopo local de ${r.origin}; o setup só mexe no escopo user.`,
      );
    else if (r.scope === 'project')
      lines.push(
        `claude: ${SERVER_NAME} registrado também no escopo project (${r.origin}); o setup só mexe no escopo user.`,
      );
  }

  if (user && !opts.force && sameServer(user.server, spec.wanted)) {
    lines.push(`claude: ${SERVER_NAME} já registrado com o mesmo comando; nada a fazer.`);
    return { code: 0, lines };
  }
  if (user) {
    lines.push(
      opts.force
        ? `claude: ${SERVER_NAME} será recriado (--force).`
        : `claude: ${SERVER_NAME} registrado com outro comando (${describeServer(user.server)}); atualizando.`,
      DISCARD_WARN,
    );
    if (!removeAndAdd(spec, deps, lines)) return { code: 1, lines };
  } else if (!runAdd(spec, deps, lines, [])) return { code: 1, lines };
  lines.push(`claude: ${SERVER_NAME} ${user ? 'atualizado' : 'registrado'}.`);
  return { code: 0, lines };
}

/** Grava o arquivo se mudou; devolve `false` e a mensagem de erro se falhar. */
function writeDoc(deps: SetupDeps, file: string, doc: TomlDoc, lines: string[]): boolean {
  try {
    deps.writeFile(file, renderDoc(doc));
    return true;
  } catch (e) {
    lines.push(`  falhou ao gravar ${file}: ${e instanceof Error ? e.message : e}`);
    return false;
  }
}

function registerCodex(spec: ClientSpec, opts: SetupOptions, deps: SetupDeps): SetupResult {
  const q = (args: string[]) => commandLine('codex', args, deps.platform);
  const lines: string[] = [];
  const exe = deps.findOnPath('codex');
  const file = codexConfigPath(deps);
  const launch = deps.launch(opts.command);
  const toml = !opts.http ? codexToml(launch) : null;
  const approveLine = `default_tools_approval_mode = "approve"`;
  const tomlHelp = toml
    ? [
        '',
        `Ou, em ${file}:`,
        ...[toml, ...(opts.approve ? [approveLine] : [])]
          .join('\n')
          .split('\n')
          .map((l) => `  ${l}`),
      ]
    : [];
  const existing = readCodexRegistration(fsDeps(deps));
  const sameCmd = existing ? sameServer(existing.server, spec.wanted) : false;

  if (opts.print) {
    if (!existing || !exe)
      lines.push('codex: para registrar, rode:', `  ${q(spec.addArgs)}`, ...tomlHelp);
    else if (opts.force)
      lines.push(`codex: recriaria ${SERVER_NAME}: ${q(spec.removeArgs)} e ${q(spec.addArgs)}`);
    else if (sameCmd) lines.push(`codex: ${SERVER_NAME} já registrado com o mesmo comando.`);
    else lines.push(`codex: editaria command/args da seção em ${file}, preservando o resto.`);
    if (opts.approve && existing)
      lines.push(`codex: gravaria ${approveLine} em ${file} (aprovação das ferramentas).`);
    return { code: 0, lines };
  }

  const needsAdd = !existing || opts.force;
  if (needsAdd && !exe) {
    lines.push(
      opts.force && existing
        ? 'codex: --force exige o codex no PATH. Para recriar, rode:'
        : 'codex: não encontrado no PATH. Para registrar, rode:',
      `  ${q(spec.addArgs)}`,
      ...tomlHelp,
    );
    return { code: opts.force && existing ? 1 : 0, lines };
  }

  if (!existing) {
    if (!runAdd(spec, deps, lines, tomlHelp)) return { code: 1, lines };
    lines.push(`codex: ${SERVER_NAME} registrado.`);
  } else if (opts.force) {
    lines.push(`codex: ${SERVER_NAME} será recriado (--force).`, DISCARD_WARN);
    if (!removeAndAdd(spec, deps, lines)) return { code: 1, lines };
    lines.push(`codex: ${SERVER_NAME} atualizado.`);
  } else if (sameCmd) {
    lines.push(`codex: ${SERVER_NAME} já registrado com o mesmo comando; nada a fazer.`);
  } else {
    const doc = parseDoc(deps.readFile(file) ?? '');
    if (spec.wanted.transport === 'http') {
      setKey(doc, 'url', tomlString(spec.wanted.url ?? ''));
      removeKey(doc, 'command');
      removeKey(doc, 'args');
    } else {
      setKey(doc, 'command', tomlString(spec.wanted.command ?? ''));
      setKey(doc, 'args', `[${(spec.wanted.args ?? []).map(tomlString).join(', ')}]`);
      removeKey(doc, 'url');
    }
    if (!writeDoc(deps, file, doc, lines)) return { code: 1, lines };
    lines.push(
      `codex: ${SERVER_NAME} atualizado em ${file} (só command/args; o resto da config foi preservado).`,
    );
  }

  if (opts.approve) {
    const doc = parseDoc(deps.readFile(file) ?? '');
    const cur = getValue(doc, 'default_tools_approval_mode');
    if (cur === 'approve') lines.push('codex: default_tools_approval_mode já é "approve".');
    else if (!findSection(doc))
      lines.push(
        `codex: seção [mcp_servers.${SERVER_NAME}] não encontrada em ${file}; nada gravado.`,
      );
    else {
      setKey(doc, 'default_tools_approval_mode', '"approve"');
      if (!writeDoc(deps, file, doc, lines)) return { code: 1, lines };
      lines.push(
        typeof cur === 'string'
          ? `codex: default_tools_approval_mode trocado de "${cur}" para "approve".`
          : 'codex: default_tools_approval_mode = "approve" gravado (as ferramentas que gravam passam sem pedir aprovação).',
      );
    }
  }
  return { code: 0, lines };
}

export const AGENTS_START = '<!-- mockup-studio:start -->';
export const AGENTS_END = '<!-- mockup-studio:end -->';

/** Acrescenta (ou atualiza) o trecho de AGENTS.md do Codex entre marcadores. */
export function installAgents(deps: SetupDeps, print = false): SetupResult {
  const dest = path.join(codexHome(deps), 'AGENTS.md');
  const dir = deps.integrationsDir();
  const src = dir ? path.join(dir, 'codex', 'AGENTS.snippet.md') : null;
  const raw = src ? deps.readFile(src) : null;
  if (!src || raw === null)
    return {
      code: 1,
      lines: [
        'agents: integrations/codex/AGENTS.snippet.md não encontrado (defina MOCKUP_INTEGRATIONS_DIR).',
      ],
    };
  if (print) return { code: 0, lines: [`agents: acrescentaria ${src} ao ${dest}`] };

  const snippet = raw
    .replace(/\r\n/g, '\n')
    .replace(/^(\s*<!--[\s\S]*?-->\s*\n)+/, '')
    .trim();
  const current = deps.readFile(dest);
  const eol = current?.includes('\r\n') ? '\r\n' : '\n';
  const block = `${AGENTS_START}\n${snippet}\n${AGENTS_END}`.replace(/\n/g, eol);
  let next: string;
  let verb: string;
  if (current === null || current.trim() === '') {
    next = block + eol;
    verb = current === null ? 'criado' : 'atualizado';
  } else {
    const s = current.indexOf(AGENTS_START);
    const e = current.indexOf(AGENTS_END);
    if (s >= 0 && e > s) {
      next = current.slice(0, s) + block + current.slice(e + AGENTS_END.length);
      verb = next === current ? 'já atualizado' : 'atualizado';
    } else if (s >= 0 || e >= 0)
      return {
        code: 1,
        lines: [`agents: marcadores incompletos em ${dest}; corrija ou remova-os e rode de novo.`],
      };
    else {
      const base = /\r?\n$/.test(current) ? current : current + eol;
      next = base + eol + block + eol;
      verb = 'acrescentado';
    }
  }
  if (next === current) return { code: 0, lines: [`agents: ${dest} já atualizado.`] };
  try {
    deps.writeFile(dest, next);
  } catch (e) {
    return {
      code: 1,
      lines: [`agents: falhou ao gravar ${dest}: ${e instanceof Error ? e.message : e}`],
    };
  }
  return { code: 0, lines: [`agents: trecho ${verb} em ${dest}.`] };
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

  const http = opts.http ? httpUrl(fmt) : null;
  const wanted = wantedServer(launch, http);

  if (target === 'claude' || target === 'all') {
    add(
      registerClaude(
        {
          tool: 'claude',
          addArgs: claudeAddArgs(launch, fmt),
          removeArgs: ['mcp', 'remove', SERVER_NAME, '-s', 'user'],
          wanted,
        },
        opts,
        deps,
      ),
    );
    if (opts.skill) add(installSkill(deps, opts.print));
    if (target === 'claude' && (opts.approve || opts.agents))
      lines.push('--approve e --agents só valem para o Codex: ignorados para o Claude Code.');
  }
  if (target === 'codex' || target === 'all') {
    if (lines.length) lines.push('');
    add(
      registerCodex(
        {
          tool: 'codex',
          addArgs: codexAddArgs(launch, fmt),
          removeArgs: ['mcp', 'remove', SERVER_NAME],
          wanted,
        },
        opts,
        deps,
      ),
    );
    if (opts.agents) add(installAgents(deps, opts.print));
    if (opts.skill && target === 'codex')
      lines.push('--skill só vale para o Claude Code: ignorado para o Codex.');
  }
  return { code, lines };
}
