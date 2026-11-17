import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { readClaudeRegistrations, readCodexRegistration, type FsDeps } from './registry.js';

const home = 'C:\\Users\\eu';
const claudeFile = path.join(home, '.claude.json');
const codexFile = path.join(home, '.codex', 'config.toml');
const srv = (command: string) => ({ mcpServers: { 'mockup-studio': { command, args: ['mcp'] } } });

function deps(files: Record<string, string>, cwd = 'C:\\Users\\eu\\Proj'): FsDeps {
  return { readFile: (p) => files[p] ?? null, home, env: {}, cwd };
}

describe('readClaudeRegistrations', () => {
  it('~/.claude.json missing or invalid: no registration, without throwing', () => {
    expect(readClaudeRegistrations(deps({}))).toEqual([]);
    expect(readClaudeRegistrations(deps({ [claudeFile]: '{ invalid' }))).toEqual([]);
    expect(readClaudeRegistrations(deps({ [claudeFile]: '[]' }))).toEqual([]);
    expect(readClaudeRegistrations(deps({ [claudeFile]: '' }))).toEqual([]);
  });

  it('large file (thousands of projects and history) finds user and local', () => {
    const projects: Record<string, unknown> = {};
    for (let i = 0; i < 5000; i++)
      projects[`C:/Users/eu/p${i}`] = { history: Array(20).fill({ display: 'x'.repeat(100) }) };
    projects['C:/Users/eu/Proj'] = srv('local');
    const text = JSON.stringify({ ...srv('mockup'), projects });
    expect(text.length).toBeGreaterThan(10_000_000);
    const regs = readClaudeRegistrations(deps({ [claudeFile]: text }));
    expect(regs.map((r) => `${r.scope}:${r.server.command}`)).toEqual([
      'user:mockup',
      'local:local',
    ]);
  });

  it('project key with different case, backslash or trailing slash matches the cwd (Windows)', () => {
    for (const key of [
      'c:/users/eu/proj',
      'C:\\Users\\eu\\Proj',
      'C:/Users/eu/Proj/',
      'c:\\USERS\\eu\\proj\\',
    ]) {
      const regs = readClaudeRegistrations(
        deps({ [claudeFile]: JSON.stringify({ projects: { [key]: srv('local') } }) }),
      );
      expect(
        regs.map((r) => r.scope),
        key,
      ).toEqual(['local']);
    }
    const other = readClaudeRegistrations(
      deps({ [claudeFile]: JSON.stringify({ projects: { 'C:/Users/eu/Proj2': srv('x') } }) }),
    );
    expect(other).toEqual([]);
  });

  it('POSIX path is case-sensitive', () => {
    const regs = readClaudeRegistrations(
      deps(
        { [claudeFile]: JSON.stringify({ projects: { '/home/Eu/proj': srv('x') } }) },
        '/home/eu/proj',
      ),
    );
    expect(regs).toEqual([]);
  });

  it('project .mcp.json', () => {
    const cwd = 'C:\\Users\\eu\\Proj';
    const regs = readClaudeRegistrations(
      deps({ [path.join(cwd, '.mcp.json')]: JSON.stringify(srv('p')) }, cwd),
    );
    expect(regs).toEqual([
      {
        scope: 'project',
        origin: path.join(cwd, '.mcp.json'),
        server: { transport: 'stdio', command: 'p', args: ['mcp'], env: {} },
      },
    ]);
  });
});

describe('readCodexRegistration', () => {
  const read = (text: string) => readCodexRegistration(deps({ [codexFile]: text }));

  it('inline env, comments and """', () => {
    const r = read(
      [
        '[mcp_servers.mockup-studio] # server',
        'command = """mockup""" # cmd',
        'args = [ # list',
        '  "mcp", # one',
        ']',
        'env = { ELECTRON_RUN_AS_NODE = "1" }',
        "default_tools_approval_mode = 'approve'",
      ].join('\n'),
    );
    expect(r?.server).toEqual({
      transport: 'stdio',
      command: 'mockup',
      args: ['mcp'],
      env: { ELECTRON_RUN_AS_NODE: '1' },
    });
    expect(r?.approve).toBe('approve');
  });

  it('env and http subtables', () => {
    expect(
      read(
        '[mcp_servers.mockup-studio]\ncommand = "m"\nargs = []\n[mcp_servers.mockup-studio.env]\nA = "1"\n',
      )?.server.env,
    ).toEqual({ A: '1' });
    expect(read('[mcp_servers."mockup-studio"]\nurl = "http://x/mcp"\n')?.server).toEqual({
      transport: 'http',
      url: 'http://x/mcp',
    });
  });

  it('without the section or without a file: null', () => {
    expect(read('[mcp_servers.other]\ncommand = "o"\n')).toBeNull();
    expect(readCodexRegistration(deps({}))).toBeNull();
  });

  it('invalid TOML: registration with error only if the section exists', () => {
    const r = read(
      '[mcp_servers.mockup-studio]\nurl = "u"\nenv = {}\n[mcp_servers.mockup-studio.env]\n',
    );
    expect(r?.error).toMatch(/^line 4/);
    expect(read('a = 1\na = 2\n')).toBeNull();
  });
});
