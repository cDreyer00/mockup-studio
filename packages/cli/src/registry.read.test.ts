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
  it('~/.claude.json ausente ou inválido: nenhum registro, sem lançar', () => {
    expect(readClaudeRegistrations(deps({}))).toEqual([]);
    expect(readClaudeRegistrations(deps({ [claudeFile]: '{ inválido' }))).toEqual([]);
    expect(readClaudeRegistrations(deps({ [claudeFile]: '[]' }))).toEqual([]);
    expect(readClaudeRegistrations(deps({ [claudeFile]: '' }))).toEqual([]);
  });

  it('arquivo grande (milhares de projetos e histórico) acha user e local', () => {
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

  it('chave de projeto com outra caixa, barra invertida ou barra final casa com o cwd (Windows)', () => {
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

  it('caminho POSIX diferencia caixa', () => {
    const regs = readClaudeRegistrations(
      deps(
        { [claudeFile]: JSON.stringify({ projects: { '/home/Eu/proj': srv('x') } }) },
        '/home/eu/proj',
      ),
    );
    expect(regs).toEqual([]);
  });

  it('.mcp.json do projeto', () => {
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

  it('env em linha, comentários e """', () => {
    const r = read(
      [
        '[mcp_servers.mockup-studio] # servidor',
        'command = """mockup""" # cmd',
        'args = [ # lista',
        '  "mcp", # um',
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

  it('subtabela env e http', () => {
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

  it('sem a seção ou sem arquivo: null', () => {
    expect(read('[mcp_servers.outro]\ncommand = "o"\n')).toBeNull();
    expect(readCodexRegistration(deps({}))).toBeNull();
  });

  it('TOML inválido: registro com erro só se a seção existir', () => {
    const r = read(
      '[mcp_servers.mockup-studio]\nurl = "u"\nenv = {}\n[mcp_servers.mockup-studio.env]\n',
    );
    expect(r?.error).toMatch(/^linha 4/);
    expect(read('a = 1\na = 2\n')).toBeNull();
  });
});
