/** `mockup doctor`: diagnóstico do ambiente (somente leitura; nunca sobe daemon nem registra nada). */
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
  /** Quantidade de famílias de fontes instaladas no sistema. */
  listFonts: () => Promise<number>;
  findOnPath: (name: string) => string | null;
  runTool: (name: string, args: string[]) => ToolResult;
  launch: (force?: LaunchKind) => LaunchCommand;
  /** Conteúdo do arquivo, ou `null` se não existe. */
  readFile: (p: string) => string | null;
  home: string;
  env: NodeJS.ProcessEnv;
  cwd: string;
  /** Tempo máximo de cada checagem assíncrona. */
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

/** Conecta por TCP; `true` se aceitou a conexão. */
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

  // CLI e runtime
  add(
    'cli',
    'ok',
    `mockup CLI ${rt.version}`,
    rt.kind === 'electron'
      ? `Electron ${rt.electronVersion ?? '?'} como Node (${rt.execPath})`
      : `Node (${rt.execPath})`,
  );
  const major = Number(deps.nodeVersion.split('.')[0]);
  if (major >= 24) add('node', 'ok', `Node ${deps.nodeVersion}`);
  else if (rt.kind === 'electron')
    add('node', 'warn', `Node embutido ${deps.nodeVersion}`, 'o projeto pede Node >= 24');
  else add('node', 'error', `Node ${deps.nodeVersion}`, 'o Mockup Studio exige Node >= 24');

  // pasta de dados e daemon.json
  let port = 0;
  try {
    const dir = deps.dataDir();
    add('dataDir', 'ok', 'Pasta de dados', dir);
    const info = path.join(dir, 'daemon.json');
    add(
      'daemonJson',
      'ok',
      'daemon.json',
      deps.fileExists(info) ? info : 'ausente (nenhum daemon registrado)',
    );
  } catch (e) {
    add('dataDir', 'warn', 'Pasta de dados', msg(e));
  }

  try {
    port = opts.port ?? deps.resolvePort();
  } catch (e) {
    add('port', 'error', 'Porta', msg(e));
  }

  // daemon
  let daemonPort: number | undefined;
  try {
    const d = await withTimeout(deps.findDaemon(), deps.timeoutMs);
    if (d === TIMED_OUT) add('daemon', 'warn', 'Daemon', 'sem resposta a tempo');
    else if (!d) add('daemon', 'warn', 'Daemon', 'não está rodando (o `mockup mcp` sobe sozinho)');
    else {
      daemonPort = d.port;
      const render =
        d.render === undefined ? 'render desconhecido' : d.render ? 'com render' : 'sem render';
      add(
        'daemon',
        d.render === false ? 'warn' : 'ok',
        'Daemon rodando',
        `${d.url} (pid ${d.pid ?? '?'}, modo ${d.mode ?? '?'}, ${render})`,
      );
      if (d.render === false)
        add('screenshot', 'warn', 'Screenshot indisponível neste daemon (sem motor de render)');
    }
  } catch (e) {
    add('daemon', 'warn', 'Daemon', msg(e));
  }

  // porta
  if (port) {
    try {
      const state =
        daemonPort === port ? 'mockup' : await withTimeout(deps.probePort(port), deps.timeoutMs);
      if (state === 'mockup') add('port', 'ok', `Porta ${port}`, 'em uso pelo Mockup Studio');
      else if (state === 'free') add('port', 'ok', `Porta ${port}`, 'livre');
      else if (state === 'other')
        add(
          'port',
          'warn',
          `Porta ${port}`,
          'ocupada por outro processo (defina MOCKUP_PORT para usar outra)',
        );
      else add('port', 'warn', `Porta ${port}`, 'sem resposta a tempo');
    } catch (e) {
      add('port', 'warn', `Porta ${port}`, msg(e));
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
        'Electron não encontrado',
        'o screenshot ficará indisponível (instale o app desktop ou defina MOCKUP_DESKTOP_EXE)',
      );
  } catch (e) {
    add('electron', 'warn', 'Electron', msg(e));
  }

  // fontes
  try {
    const n = await withTimeout(deps.listFonts(), deps.timeoutMs);
    if (n === TIMED_OUT) add('fonts', 'warn', 'Fontes', 'listagem demorou demais');
    else if (n === 0) add('fonts', 'warn', 'Fontes', 'nenhuma família de fonte encontrada');
    else add('fonts', 'ok', 'Fontes', `${n} famílias instaladas`);
  } catch (e) {
    add('fonts', 'warn', 'Fontes', msg(e));
  }

  // ferramentas no PATH
  const mockupPath = deps.findOnPath('mockup');
  if (mockupPath) add('mockupPath', 'ok', '`mockup` no PATH', mockupPath);
  else
    add(
      'mockupPath',
      'warn',
      '`mockup` fora do PATH',
      'rode `mockup install-cli` (ou use --command absolute nos comandos abaixo)',
    );
  for (const tool of ['claude', 'codex'] as const) {
    const exe = deps.findOnPath(tool);
    if (!exe) {
      add(tool, 'warn', `${tool} não encontrado no PATH`);
      continue;
    }
    const v = deps.runTool(tool, ['--version']);
    const version = v.status === 0 ? v.stdout.trim().split(/\r?\n/)[0] : 'versão desconhecida';
    const fsd = { readFile: deps.readFile, home: deps.home, env: deps.env, cwd: deps.cwd };
    const notReg = `${SERVER_NAME} não registrado: rode \`mockup setup ${tool}\` (${exe})`;
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
          ? `${SERVER_NAME} registrado no escopo ${main.scope}: ${describeServer(main.server)} (${exe})`
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
          ? `${reg.path} não é TOML válido (${reg.error}); o Codex não carrega o arquivo. Corrija-o.`
          : reg
            ? `${SERVER_NAME} registrado em ${reg.path}: ${describeServer(reg.server)} (${exe})`
            : notReg,
      );
      if (reg && !reg.error) {
        if (reg.approve === 'approve')
          add(
            'codexApprove',
            'ok',
            'Codex: aprovação das ferramentas',
            'default_tools_approval_mode = "approve"',
          );
        else
          add(
            'codexApprove',
            'warn',
            'Codex: ferramentas que gravam pedem aprovação',
            'no `codex exec` elas são bloqueadas; rode `mockup setup codex --approve`',
          );
        const agentsFile = path.join(codexHome(fsd), 'AGENTS.md');
        if ((deps.readFile(agentsFile) ?? '').includes('<!-- mockup-studio:start -->'))
          add('codexAgents', 'ok', 'Codex: AGENTS.md com o trecho do Mockup Studio', agentsFile);
        else
          add(
            'codexAgents',
            'warn',
            'Codex: AGENTS.md sem o trecho do Mockup Studio',
            `o Codex pode escrever HTML à mão em vez de usar o MCP; rode \`mockup setup codex --agents\` (${agentsFile})`,
          );
      }
    }
    if (server && server.transport === 'stdio') {
      const l = deps.launch(opts.command);
      if (!sameServer(server, wantedServer(l, null)))
        add(
          `${tool}Launch`,
          'warn',
          `${tool}: comando registrado difere do comando de lançamento atual`,
          `registrado: ${describeServer(server)}; atual: ${describeServer(wantedServer(l, null))}; rode \`mockup setup ${tool}\``,
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

/** Relatório em texto (sem cores ANSI). */
export function formatDoctor(r: DoctorReport): string {
  const out: string[] = ['Mockup Studio - diagnóstico', ''];
  for (const c of r.checks)
    out.push(`${MARK[c.level]} ${c.label}${c.detail ? `: ${c.detail}` : ''}`);
  const indent = (s: string) =>
    s
      .split('\n')
      .map((l) => `  ${l}`)
      .join('\n');
  out.push(
    '',
    `Comando de lançamento do MCP (${r.launch.kind}): ${[r.launch.command, ...r.launch.args].join(' ')}`,
    '',
    'Registrar no Claude Code (stdio):',
    indent(r.commands.claudeStdio),
    'Registrar no Claude Code (HTTP, exige o daemon rodando):',
    indent(r.commands.claudeHttp),
    'Registrar no Codex:',
    indent(r.commands.codex),
    'Ou em ~/.codex/config.toml:',
    indent(r.commands.codexToml),
    'Outros clientes (JSON mcpServers):',
    indent(r.commands.mcpServers),
    '',
    'Atalho: `mockup setup claude|codex|all` faz o registro (use --print para só ver os comandos).',
  );
  return out.join('\n');
}
