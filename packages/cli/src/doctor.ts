/** `mockup doctor`: environment diagnostics (read-only; never starts a daemon or registers anything). */
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { checkHealth, getDataDir, listSystemFonts, resolvePort } from '@mockup/server';
import { findDaemon, isMockupHealth, type DaemonLocation } from './discover.js';
import { locateElectron, type ElectronLaunch } from './electron.js';
import {
  SERVER_NAME,
  claudeAddArgs,
  codexAddArgs,
  codexToml,
  commandLine,
  defaultLaunchDeps,
  mcpServersJson,
  resolveLaunchCommand,
  vscodeMcpJson,
  type LaunchCommand,
  type LaunchKind,
} from './launch.js';
import {
  codexHome,
  defaultReadFile,
  describeServer,
  readClaudeRegistrations,
  readCodexRegistration,
  sameServer,
  wantedServer,
  type RegisteredServer,
} from './registry.js';
import { cliRuntime, type CliRuntime } from './runtime.js';
import { findOnPath, runTool, type ToolResult } from './tools.js';

export type Level = 'ok' | 'warn' | 'error';

export interface Check {
  id: string;
  level: Level;
  label: string;
  detail?: string;
}

export type PortState = 'free' | 'mockup' | 'other';

export interface DoctorDeps {
  runtime: CliRuntime;
  platform: NodeJS.Platform;
  nodeVersion: string;
  dataDir: () => string;
  fileExists: (p: string) => boolean;
  findDaemon: () => Promise<DaemonLocation | null>;
  resolvePort: () => number;
  probePort: (port: number) => Promise<PortState>;
  locateElectron: () => ElectronLaunch | null;
  /** Number of font families installed on the system. */
  listFonts: () => Promise<number>;
  findOnPath: (name: string) => string | null;
  runTool: (name: string, args: string[]) => ToolResult;
  launch: (force?: LaunchKind) => LaunchCommand;
  /** File content, or `null` if it does not exist. */
  readFile: (p: string) => string | null;
  home: string;
  env: NodeJS.ProcessEnv;
  cwd: string;
  /** Maximum time for each asynchronous check. */
  timeoutMs: number;
}

export interface DoctorReport {
  ok: boolean;
  version: string;
  runtime: CliRuntime;
  checks: Check[];
  launch: LaunchCommand;
  commands: {
    claudeStdio: string;
    claudeHttp: string;
    codex: string;
    codexToml: string;
    mcpServers: string;
    vscode: string;
  };
}

/** Connects over TCP; `true` if the connection was accepted. */
function tcpConnects(port: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.connect({ port, host: '127.0.0.1' });
    const done = (v: boolean) => {
      s.destroy();
      resolve(v);
    };
    s.setTimeout(timeoutMs, () => done(false));
    s.once('connect', () => done(true));
    s.once('error', () => done(false));
  });
}

export async function probePort(port: number, timeoutMs = 1500): Promise<PortState> {
  if (isMockupHealth(await checkHealth(`http://127.0.0.1:${port}`, timeoutMs))) return 'mockup';
  return (await tcpConnects(port, timeoutMs)) ? 'other' : 'free';
}

async function countFonts(): Promise<number> {
  const fonts = await listSystemFonts();
  return new Set(fonts.map((f) => f.family)).size;
}

export function defaultDoctorDeps(): DoctorDeps {
  return {
    runtime: cliRuntime(),
    platform: process.platform,
    nodeVersion: process.versions.node,
    dataDir: () => getDataDir(),
    fileExists: fs.existsSync,
    findDaemon,
    resolvePort: () => resolvePort(),
    probePort: (p) => probePort(p),
    locateElectron: () => locateElectron(),
    listFonts: countFonts,
    findOnPath: (n) => findOnPath(n),
    runTool: (n, a) => runTool(n, a, { timeoutMs: 5000 }),
    launch: (force) => resolveLaunchCommand(defaultLaunchDeps(force)),
    readFile: defaultReadFile,
    home: os.homedir(),
    env: process.env,
    cwd: process.cwd(),
    timeoutMs: 5000,
  };
}

const TIMED_OUT = Symbol('timeout');

async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | typeof TIMED_OUT> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<typeof TIMED_OUT>((r) => {
        timer = setTimeout(() => r(TIMED_OUT), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

export async function runDoctor(
  opts: { command?: LaunchKind; port?: number } = {},
  deps: DoctorDeps = defaultDoctorDeps(),
): Promise<DoctorReport> {
  const checks: Check[] = [];
  const add = (id: string, level: Level, label: string, detail?: string) =>
    checks.push({ id, level, label, ...(detail !== undefined ? { detail } : {}) });
  const rt = deps.runtime;

  // CLI and runtime
  add(
    'cli',
    'ok',
    `mockup CLI ${rt.version}`,
    rt.kind === 'electron'
      ? `Electron ${rt.electronVersion ?? '?'} as Node (${rt.execPath})`
      : `Node (${rt.execPath})`,
  );
  const major = Number(deps.nodeVersion.split('.')[0]);
  if (major >= 24) add('node', 'ok', `Node ${deps.nodeVersion}`);
  else if (rt.kind === 'electron')
    add('node', 'warn', `Embedded Node ${deps.nodeVersion}`, 'the project requires Node >= 24');
  else add('node', 'error', `Node ${deps.nodeVersion}`, 'Mockup Studio requires Node >= 24');

  // data folder and daemon.json
  let port = 0;
  try {
    const dir = deps.dataDir();
    add('dataDir', 'ok', 'Data folder', dir);
    const info = path.join(dir, 'daemon.json');
    add(
      'daemonJson',
      'ok',
      'daemon.json',
      deps.fileExists(info) ? info : 'missing (no daemon registered)',
    );
  } catch (e) {
    add('dataDir', 'warn', 'Data folder', msg(e));
  }

  try {
    port = opts.port ?? deps.resolvePort();
  } catch (e) {
    add('port', 'error', 'Port', msg(e));
  }

  // daemon
  let daemonPort: number | undefined;
  try {
    const d = await withTimeout(deps.findDaemon(), deps.timeoutMs);
    if (d === TIMED_OUT) add('daemon', 'warn', 'Daemon', 'no response in time');
    else if (!d) add('daemon', 'warn', 'Daemon', 'not running (`mockup mcp` starts it on its own)');
    else {
      daemonPort = d.port;
      const render =
        d.render === undefined ? 'render unknown' : d.render ? 'with render' : 'no render';
      add(
        'daemon',
        d.render === false ? 'warn' : 'ok',
        'Daemon running',
        `${d.url} (pid ${d.pid ?? '?'}, mode ${d.mode ?? '?'}, ${render})`,
      );
      if (d.render === false)
        add('screenshot', 'warn', 'Screenshot unavailable in this daemon (no render engine)');
    }
  } catch (e) {
    add('daemon', 'warn', 'Daemon', msg(e));
  }

  // port
  if (port) {
    try {
      const state =
        daemonPort === port ? 'mockup' : await withTimeout(deps.probePort(port), deps.timeoutMs);
      if (state === 'mockup') add('port', 'ok', `Port ${port}`, 'in use by Mockup Studio');
      else if (state === 'free') add('port', 'ok', `Port ${port}`, 'free');
      else if (state === 'other')
        add(
          'port',
          'warn',
          `Port ${port}`,
          'in use by another process (set MOCKUP_PORT to use a different one)',
        );
      else add('port', 'warn', `Port ${port}`, 'no response in time');
    } catch (e) {
      add('port', 'warn', `Port ${port}`, msg(e));
    }
  }

  // Electron
  try {
    const el = deps.locateElectron();
    if (el) add('electron', 'ok', 'Electron', `${el.source}: ${el.exe}`);
    else
      add(
        'electron',
        'warn',
        'Electron not found',
        'screenshots will be unavailable (install the desktop app or set MOCKUP_DESKTOP_EXE)',
      );
  } catch (e) {
    add('electron', 'warn', 'Electron', msg(e));
  }

  // fonts
  try {
    const n = await withTimeout(deps.listFonts(), deps.timeoutMs);
    if (n === TIMED_OUT) add('fonts', 'warn', 'Fonts', 'listing took too long');
    else if (n === 0) add('fonts', 'warn', 'Fonts', 'no font family found');
    else add('fonts', 'ok', 'Fonts', `${n} families installed`);
  } catch (e) {
    add('fonts', 'warn', 'Fonts', msg(e));
  }

  // tools on the PATH
  const mockupPath = deps.findOnPath('mockup');
  if (mockupPath) add('mockupPath', 'ok', '`mockup` on the PATH', mockupPath);
  else
    add(
      'mockupPath',
      'warn',
      '`mockup` not on the PATH',
      'run `mockup install-cli` (or use --command absolute in the commands below)',
    );
  for (const tool of ['claude', 'codex'] as const) {
    const exe = deps.findOnPath(tool);
    if (!exe) {
      add(tool, 'warn', `${tool} not found on the PATH`);
      continue;
    }
    const v = deps.runTool(tool, ['--version']);
    const version = v.status === 0 ? v.stdout.trim().split(/\r?\n/)[0] : 'unknown version';
    const fsd = { readFile: deps.readFile, home: deps.home, env: deps.env, cwd: deps.cwd };
    const notReg = `${SERVER_NAME} not registered: run \`mockup setup ${tool}\` (${exe})`;
    let server: RegisteredServer | undefined;
    if (tool === 'claude') {
      const regs = readClaudeRegistrations(fsd);
      const main = regs.find((r) => r.scope === 'user') ?? regs[0];
      server = main?.server;
      add(
        tool,
        main ? 'ok' : 'warn',
        `${tool} ${version}`,
        main
          ? `${SERVER_NAME} registered in scope ${main.scope}: ${describeServer(main.server)} (${exe})`
          : notReg,
      );
    } else {
      const reg = readCodexRegistration(fsd);
      server = reg?.error ? undefined : reg?.server;
      add(
        tool,
        reg?.error ? 'error' : reg ? 'ok' : 'warn',
        `${tool} ${version}`,
        reg?.error
          ? `${reg.path} is not valid TOML (${reg.error}); Codex does not load the file. Fix it.`
          : reg
            ? `${SERVER_NAME} registered in ${reg.path}: ${describeServer(reg.server)} (${exe})`
            : notReg,
      );
      if (reg && !reg.error) {
        if (reg.approve === 'approve')
          add(
            'codexApprove',
            'ok',
            'Codex: tool approval',
            'default_tools_approval_mode = "approve"',
          );
        else
          add(
            'codexApprove',
            'warn',
            'Codex: tools that write require approval',
            'in `codex exec` they are blocked; run `mockup setup codex --approve`',
          );
        const agentsFile = path.join(codexHome(fsd), 'AGENTS.md');
        if ((deps.readFile(agentsFile) ?? '').includes('<!-- mockup-studio:start -->'))
          add('codexAgents', 'ok', 'Codex: AGENTS.md with the Mockup Studio snippet', agentsFile);
        else
          add(
            'codexAgents',
            'warn',
            'Codex: AGENTS.md without the Mockup Studio snippet',
            `Codex may hand-write HTML instead of using the MCP; run \`mockup setup codex --agents\` (${agentsFile})`,
          );
      }
    }
    if (server && server.transport === 'stdio') {
      const l = deps.launch(opts.command);
      if (!sameServer(server, wantedServer(l, null)))
        add(
          `${tool}Launch`,
          'warn',
          `${tool}: registered command differs from the current launch command`,
          `registered: ${describeServer(server)}; current: ${describeServer(wantedServer(l, null))}; run \`mockup setup ${tool}\``,
        );
    }
  }

  const launch = deps.launch(opts.command);
  const q = (tool: string, args: string[]) => commandLine(tool, args, deps.platform);
  const fmt = { port: port || undefined };
  return {
    ok: !checks.some((c) => c.level === 'error'),
    version: rt.version,
    runtime: rt,
    checks,
    launch,
    commands: {
      claudeStdio: q('claude', claudeAddArgs(launch, fmt)),
      claudeHttp: q('claude', claudeAddArgs(launch, { ...fmt, http: true })),
      codex: q('codex', codexAddArgs(launch)),
      codexToml: codexToml(launch),
      mcpServers: mcpServersJson(launch),
      vscode: vscodeMcpJson(launch),
    },
  };
}

const MARK: Record<Level, string> = { ok: '✔', warn: '!', error: '✘' };

/** Text report (no ANSI colors). */
export function formatDoctor(r: DoctorReport): string {
  const out: string[] = ['Mockup Studio - diagnostics', ''];
  for (const c of r.checks)
    out.push(`${MARK[c.level]} ${c.label}${c.detail ? `: ${c.detail}` : ''}`);
  const indent = (s: string) =>
    s
      .split('\n')
      .map((l) => `  ${l}`)
      .join('\n');
  out.push(
    '',
    `MCP launch command (${r.launch.kind}): ${[r.launch.command, ...r.launch.args].join(' ')}`,
    '',
    'Register in Claude Code (stdio):',
    indent(r.commands.claudeStdio),
    'Register in Claude Code (HTTP, requires the daemon to be running):',
    indent(r.commands.claudeHttp),
    'Register in Codex:',
    indent(r.commands.codex),
    'Or in ~/.codex/config.toml:',
    indent(r.commands.codexToml),
    'Other clients (mcpServers JSON):',
    indent(r.commands.mcpServers),
    '',
    'Shortcut: `mockup setup claude|codex|all` registers it (use --print to only see the commands).',
  );
  return out.join('\n');
}
