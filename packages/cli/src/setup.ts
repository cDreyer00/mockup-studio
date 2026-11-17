/** `mockup setup claude|codex|all`: registers the MCP server in the clients (or prints how to). */
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
  codexServer,
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
  parseDoc,
  readServerTable,
  removeKeyOrTable,
  renderDoc,
  setEnv,
  setKey,
  tomlError,
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
  /** Recreates the registration from scratch (remove + add), even if identical. */
  force?: boolean;
  /** Codex: writes `default_tools_approval_mode = "approve"`. */
  approve?: boolean;
  /** Codex: appends the AGENTS.md snippet. */
  agents?: boolean;
}

export interface SetupDeps {
  findOnPath: (name: string) => string | null;
  runTool: (name: string, args: string[]) => ToolResult;
  launch: (force?: LaunchKind) => LaunchCommand;
  /** `integrations` folder (with `claude-code/SKILL.md`), or `null`. */
  integrationsDir: () => string | null;
  /** File content, or `null` if it does not exist. */
  readFile: (p: string) => string | null;
  /** Writes the file, creating the folders. */
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

/** Candidates for the `integrations` folder, in search order. */
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
  const detail = (r.stderr || r.stdout || r.error || `code ${r.status}`).trim();
  return [`  failed: ${detail}`, `  run manually: ${manual}`];
}

interface ClientSpec {
  tool: 'claude' | 'codex';
  addArgs: string[];
  removeArgs: string[];
  wanted: RegisteredServer;
}

const DISCARD_WARN =
  '  warning: re-registering discards extra fields (custom env/headers/approvals).';

/** Runs `remove` and `add`; "not found" on remove counts as success. */
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
        ? 'claude: not found on the PATH. To register, run:'
        : 'claude: to register, run:',
      `  ${q(spec.addArgs)}`,
    );
    return { code: 0, lines };
  }

  const regs = readClaudeRegistrations(fsDeps(deps));
  const user = regs.find((r) => r.scope === 'user');
  for (const r of regs) {
    if (r.scope === 'local')
      lines.push(
        `claude: ${SERVER_NAME} is also registered in the local scope of ${r.origin}; setup only touches the user scope.`,
      );
    else if (r.scope === 'project')
      lines.push(
        `claude: ${SERVER_NAME} is also registered in the project scope (${r.origin}); setup only touches the user scope.`,
      );
  }

  if (user && !opts.force && sameServer(user.server, spec.wanted)) {
    lines.push(
      `claude: ${SERVER_NAME} is already registered with the same command; nothing to do.`,
    );
    return { code: 0, lines };
  }
  if (user) {
    lines.push(
      opts.force
        ? `claude: ${SERVER_NAME} will be recreated (--force).`
        : `claude: ${SERVER_NAME} is registered with a different command (${describeServer(user.server)}); updating.`,
      DISCARD_WARN,
    );
    if (!removeAndAdd(spec, deps, lines)) return { code: 1, lines };
  } else if (!runAdd(spec, deps, lines, [])) return { code: 1, lines };
  lines.push(`claude: ${SERVER_NAME} ${user ? 'updated' : 'registered'}.`);
  return { code: 0, lines };
}

/** Codex keys that only apply to one transport (those of the other are removed on switch). */
const STDIO_KEYS = ['command', 'args', 'env', 'env_vars', 'cwd'];
const HTTP_KEYS = ['url', 'bearer_token_env_var', 'http_headers', 'env_http_headers'];

/** Applies the desired launch to the section; returns the removed keys. Throws if `env` is unreadable. */
function editCodexSection(doc: TomlDoc, wanted: RegisteredServer): string[] {
  const removed: string[] = [];
  if (wanted.transport === 'http') {
    setKey(doc, 'url', tomlString(wanted.url ?? ''));
    for (const k of STDIO_KEYS) removed.push(...removeKeyOrTable(doc, k));
  } else {
    setKey(doc, 'command', tomlString(wanted.command ?? ''));
    setKey(doc, 'args', `[${(wanted.args ?? []).map(tomlString).join(', ')}]`);
    for (const k of HTTP_KEYS) removed.push(...removeKeyOrTable(doc, k));
    setEnv(doc, wanted.env ?? {}, tomlString);
  }
  return removed;
}

/** Checks the edited text with the TOML parser: valid, with the desired launch and without keys of the other transport. */
function checkCodexText(text: string, wanted: RegisteredServer): string | null {
  const err = tomlError(text);
  if (err) return `the result would not be valid TOML: ${err}`;
  const t = readServerTable(text, SERVER_NAME);
  if (!t) return `the [mcp_servers.${SERVER_NAME}] section was not found after editing`;
  const other = (wanted.transport === 'http' ? STDIO_KEYS : HTTP_KEYS).filter((k) => k in t);
  if (other.length)
    return `keys that do not apply to ${wanted.transport} remain: ${other.join(', ')}`;
  if (!sameServer(codexServer(t), wanted))
    return `the section does not have the expected launch (${describeServer(codexServer(t))})`;
  return null;
}

/** Writes the file only if the result is valid TOML; returns `false` and the message if it does not write. */
function writeDoc(deps: SetupDeps, file: string, doc: TomlDoc, lines: string[]): boolean {
  const text = renderDoc(doc);
  const err = tomlError(text);
  if (err) {
    lines.push(`  nothing written to ${file}: the result would not be valid TOML (${err}).`);
    return false;
  }
  try {
    deps.writeFile(file, text);
    return true;
  } catch (e) {
    lines.push(`  failed to write ${file}: ${e instanceof Error ? e.message : e}`);
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
        `Or, in ${file}:`,
        ...[toml, ...(opts.approve ? [approveLine] : [])]
          .join('\n')
          .split('\n')
          .map((l) => `  ${l}`),
      ]
    : [];
  const existing = readCodexRegistration(fsDeps(deps));
  if (existing?.error) {
    lines.push(
      `codex: ${file} is not valid TOML (${existing.error}); Codex does not load this file either.`,
      '  fix it and run setup again.',
    );
    return { code: opts.print ? 0 : 1, lines };
  }
  const sameCmd = existing ? sameServer(existing.server, spec.wanted) : false;

  if (opts.print) {
    if (!existing || !exe)
      lines.push('codex: to register, run:', `  ${q(spec.addArgs)}`, ...tomlHelp);
    else if (opts.force)
      lines.push(
        `codex: would recreate ${SERVER_NAME}: ${q(spec.removeArgs)} and ${q(spec.addArgs)}`,
      );
    else if (sameCmd)
      lines.push(`codex: ${SERVER_NAME} is already registered with the same command.`);
    else
      lines.push(
        `codex: would edit the launch keys of the section in ${file}, preserving the rest.`,
      );
    if (opts.approve && existing)
      lines.push(`codex: would write ${approveLine} to ${file} (tool approval).`);
    return { code: 0, lines };
  }

  const needsAdd = !existing || opts.force;
  if (needsAdd && !exe) {
    lines.push(
      opts.force && existing
        ? 'codex: --force requires codex on the PATH. To recreate, run:'
        : 'codex: not found on the PATH. To register, run:',
      `  ${q(spec.addArgs)}`,
      ...tomlHelp,
    );
    return { code: opts.force && existing ? 1 : 0, lines };
  }

  if (!existing) {
    if (!runAdd(spec, deps, lines, tomlHelp)) return { code: 1, lines };
    lines.push(`codex: ${SERVER_NAME} registered.`);
  } else if (opts.force) {
    lines.push(`codex: ${SERVER_NAME} will be recreated (--force).`, DISCARD_WARN);
    if (!removeAndAdd(spec, deps, lines)) return { code: 1, lines };
    lines.push(`codex: ${SERVER_NAME} updated.`);
  } else if (sameCmd) {
    lines.push(`codex: ${SERVER_NAME} is already registered with the same command; nothing to do.`);
  } else {
    const doc = parseDoc(deps.readFile(file) ?? '');
    let removed: string[];
    let why: string | null;
    try {
      removed = editCodexSection(doc, spec.wanted);
      why = checkCodexText(renderDoc(doc), spec.wanted);
    } catch (e) {
      removed = [];
      why = e instanceof Error ? e.message : String(e);
    }
    if (why) {
      lines.push(
        `codex: could not safely edit ${file} (${why}); nothing written.`,
        `  edit the [mcp_servers.${SERVER_NAME}] section by hand or recreate the registration with \`mockup setup codex${opts.http ? ' --http' : ''} --force\` (discards extra fields).`,
      );
      return { code: 1, lines };
    }
    if (!writeDoc(deps, file, doc, lines)) return { code: 1, lines };
    lines.push(
      `codex: ${SERVER_NAME} updated in ${file} (only the launch keys; the rest of the config was preserved).`,
    );
    if (removed.length)
      lines.push(
        `  removed because they do not apply to ${spec.wanted.transport}: ${removed.join(', ')}.`,
      );
  }

  if (opts.approve) {
    const doc = parseDoc(deps.readFile(file) ?? '');
    const cur = readCodexRegistration(fsDeps(deps))?.approve;
    if (cur === 'approve') lines.push('codex: default_tools_approval_mode is already "approve".');
    else if (!findSection(doc))
      lines.push(
        `codex: section [mcp_servers.${SERVER_NAME}] not found in ${file}; nothing written.`,
      );
    else {
      setKey(doc, 'default_tools_approval_mode', '"approve"');
      if (!writeDoc(deps, file, doc, lines)) return { code: 1, lines };
      lines.push(
        typeof cur === 'string'
          ? `codex: default_tools_approval_mode changed from "${cur}" to "approve".`
          : 'codex: default_tools_approval_mode = "approve" written (tools that write run without asking for approval).',
      );
    }
  }
  return { code: 0, lines };
}

export const AGENTS_START = '<!-- mockup-studio:start -->';
export const AGENTS_END = '<!-- mockup-studio:end -->';

/** Appends (or updates) the Codex AGENTS.md snippet between markers. */
export function installAgents(deps: SetupDeps, print = false): SetupResult {
  const dest = path.join(codexHome(deps), 'AGENTS.md');
  const dir = deps.integrationsDir();
  const src = dir ? path.join(dir, 'codex', 'AGENTS.snippet.md') : null;
  const raw = src ? deps.readFile(src) : null;
  if (!src || raw === null)
    return {
      code: 1,
      lines: [
        'agents: integrations/codex/AGENTS.snippet.md not found (set MOCKUP_INTEGRATIONS_DIR).',
      ],
    };
  if (print) return { code: 0, lines: [`agents: would append ${src} to ${dest}`] };

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
    verb = current === null ? 'created' : 'updated';
  } else {
    const s = current.indexOf(AGENTS_START);
    const e = current.indexOf(AGENTS_END);
    if (s >= 0 && e > s) {
      next = current.slice(0, s) + block + current.slice(e + AGENTS_END.length);
      verb = next === current ? 'already up to date' : 'updated';
    } else if (s >= 0 || e >= 0)
      return {
        code: 1,
        lines: [`agents: incomplete markers in ${dest}; fix or remove them and run again.`],
      };
    else {
      const base = /\r?\n$/.test(current) ? current : current + eol;
      next = base + eol + block + eol;
      verb = 'appended';
    }
  }
  if (next === current) return { code: 0, lines: [`agents: ${dest} is already up to date.`] };
  try {
    deps.writeFile(dest, next);
  } catch (e) {
    return {
      code: 1,
      lines: [`agents: failed to write ${dest}: ${e instanceof Error ? e.message : e}`],
    };
  }
  return { code: 0, lines: [`agents: snippet ${verb} in ${dest}.`] };
}

/** Copies the skill to `~/.claude/skills/mockup-studio/SKILL.md`. */
export function installSkill(deps: SetupDeps, print = false): SetupResult {
  const dest = path.join(deps.home, '.claude', 'skills', SERVER_NAME, 'SKILL.md');
  const dir = deps.integrationsDir();
  if (!dir)
    return {
      code: 1,
      lines: [
        'skill: folder integrations/claude-code/SKILL.md not found (set MOCKUP_INTEGRATIONS_DIR).',
      ],
    };
  const src = path.join(dir, 'claude-code', 'SKILL.md');
  if (print) return { code: 0, lines: [`skill: would copy ${src} to ${dest}`] };
  try {
    const existed = fs.existsSync(dest);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
    return { code: 0, lines: [`skill: ${existed ? 'updated' : 'installed'} at ${dest}`] };
  } catch (e) {
    return {
      code: 1,
      lines: [`skill: failed to copy to ${dest}: ${e instanceof Error ? e.message : e}`],
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
      lines.push('--approve and --agents only apply to Codex: ignored for Claude Code.');
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
      lines.push('--skill only applies to Claude Code: ignored for Codex.');
  }
  return { code, lines };
}
