import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { formatDoctor, runDoctor, type DoctorDeps } from './doctor.js';

const fake = (over: Partial<DoctorDeps> = {}): DoctorDeps => ({
  runtime: {
    kind: 'node',
    execPath: 'node',
    script: 'bin.js',
    version: '0.1.0',
    nodeVersion: '24.1.0',
  },
  platform: 'linux',
  nodeVersion: '24.1.0',
  dataDir: () => '/data',
  fileExists: () => false,
  findDaemon: async () => null,
  resolvePort: () => 4747,
  probePort: async () => 'free',
  locateElectron: () => null,
  listFonts: async () => 120,
  findOnPath: (n) => (n === 'claude' ? '/bin/claude' : null),
  runTool: (_n, a) =>
    a[0] === '--version'
      ? { status: 0, stdout: '1.2.3\n', stderr: '' }
      : { status: 1, stdout: '', stderr: '' },
  launch: () => ({ command: 'mockup', args: ['mcp'], kind: 'path' }),
  readFile: () => null,
  home: '/h',
  env: {},
  cwd: '/proj',
  timeoutMs: 200,
  ...over,
});

/** `readFile` with in-memory files (`path.join` paths). */
const files = (m: Record<string, string>) => (p: string) => m[p] ?? null;
const J = (...s: string[]) => path.join(...s);
const CLAUDE_OK = JSON.stringify({
  mcpServers: { 'mockup-studio': { type: 'stdio', command: 'mockup', args: ['mcp'], env: {} } },
});

const level = (r: Awaited<ReturnType<typeof runDoctor>>, id: string) =>
  r.checks.find((c) => c.id === id)?.level;

describe('runDoctor', () => {
  it('empty scenario: warnings, but ok', async () => {
    const r = await runDoctor({}, fake());
    expect(r.ok).toBe(true);
    expect(level(r, 'daemon')).toBe('warn');
    expect(level(r, 'port')).toBe('ok');
    expect(level(r, 'electron')).toBe('warn');
    expect(level(r, 'fonts')).toBe('ok');
    expect(level(r, 'claude')).toBe('warn');
    expect(level(r, 'codex')).toBe('warn');
    expect(level(r, 'mockupPath')).toBe('warn');
    expect(r.commands.claudeStdio).toBe('claude mcp add --scope user mockup-studio -- mockup mcp');
    expect(JSON.parse(JSON.stringify(r)).checks).toBeInstanceOf(Array);
  });

  it('old Node is an essential error', async () => {
    const r = await runDoctor({}, fake({ nodeVersion: '20.0.0' }));
    expect(r.ok).toBe(false);
  });

  it('daemon running and client registered', async () => {
    const r = await runDoctor(
      {},
      fake({
        findDaemon: async () => ({
          url: 'http://127.0.0.1:4747',
          mcpUrl: '',
          wsUrl: '',
          port: 4747,
          spawned: false,
          pid: 9,
          render: true,
          mode: 'desktop',
        }),
        findOnPath: () => '/bin/x',
        runTool: () => ({ status: 0, stdout: 'v1\n', stderr: '' }),
        readFile: files({
          [J('/h', '.claude.json')]: CLAUDE_OK,
          [J('/h', '.codex', 'config.toml')]:
            '[mcp_servers.mockup-studio]\ncommand = "mockup"\nargs = ["mcp"]\ndefault_tools_approval_mode = "approve"\n',
          [J('/h', '.codex', 'AGENTS.md')]: 'x\n<!-- mockup-studio:start -->\n',
        }),
      }),
    );
    expect(level(r, 'daemon')).toBe('ok');
    expect(level(r, 'claude')).toBe('ok');
    expect(r.checks.find((c) => c.id === 'claude')?.detail).toContain('scope user');
    expect(level(r, 'codex')).toBe('ok');
    expect(level(r, 'codexApprove')).toBe('ok');
    expect(level(r, 'codexAgents')).toBe('ok');
    expect(level(r, 'claudeLaunch')).toBeUndefined();
    expect(r.checks.find((c) => c.id === 'daemon')?.detail).toContain('mode desktop');
  });

  it('Codex without approve and without AGENTS.md; command differs from the current one', async () => {
    const r = await runDoctor(
      {},
      fake({
        findOnPath: () => '/bin/x',
        readFile: files({
          [J('/h', '.claude.json')]: JSON.stringify({
            mcpServers: { 'mockup-studio': { command: 'C:\\old.cmd', args: ['mcp'] } },
          }),
          [J('/h', '.codex', 'config.toml')]:
            '[mcp_servers.mockup-studio]\ncommand = "mockup"\nargs = ["mcp"]\n',
        }),
      }),
    );
    expect(level(r, 'codexApprove')).toBe('warn');
    expect(r.checks.find((c) => c.id === 'codexApprove')?.detail).toContain('--approve');
    expect(level(r, 'codexAgents')).toBe('warn');
    expect(level(r, 'claudeLaunch')).toBe('warn');
  });

  it('Claude only in local scope shows up with the scope; never runs mcp get', async () => {
    const ran: string[] = [];
    const r = await runDoctor(
      {},
      fake({
        runTool: (n, a) => {
          ran.push(`${n} ${a.join(' ')}`);
          return { status: 0, stdout: '1\n', stderr: '' };
        },
        readFile: files({
          [J('/h', '.claude.json')]: JSON.stringify({
            projects: {
              '/proj': { mcpServers: { 'mockup-studio': { command: 'mockup', args: ['mcp'] } } },
            },
          }),
        }),
      }),
    );
    expect(r.checks.find((c) => c.id === 'claude')?.detail).toContain('scope local');
    expect(ran.some((x) => x.includes(' mcp '))).toBe(false);
  });

  it('busy port, no fonts and timeout do not hang', async () => {
    const r = await runDoctor(
      {},
      fake({
        probePort: async () => 'other',
        listFonts: async () => 0,
        findDaemon: () => new Promise(() => undefined),
      }),
    );
    expect(level(r, 'port')).toBe('warn');
    expect(r.checks.find((c) => c.id === 'fonts')?.detail).toContain('no font family');
    expect(r.checks.find((c) => c.id === 'daemon')?.detail).toContain('in time');
    expect(r.ok).toBe(true);
  });

  it('text without ANSI', async () => {
    const t = formatDoctor(await runDoctor({}, fake()));
    expect(t).not.toContain('\u001b[');
    expect(t).toContain('✔ Node 24.1.0');
    expect(t).toContain('mockup setup claude|codex|all');
  });
});
