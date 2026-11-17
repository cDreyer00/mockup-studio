import { describe, expect, it } from 'vitest';
import { findOnPath, pickWindowsExecutable, runTool, type SpawnSyncFn } from './tools.js';

describe('tools', () => {
  it('escolhe o primeiro .exe/.cmd/.bat do where', () => {
    expect(pickWindowsExecutable('C:\\a\\claude\r\nC:\\a\\claude.cmd\r\nC:\\b\\claude.exe')).toBe(
      'C:\\a\\claude.cmd',
    );
    expect(pickWindowsExecutable('C:\\a\\claude')).toBeNull();
  });
  it('findOnPath no Windows usa where', () => {
    const spawn: SpawnSyncFn = (cmd, args) => ({
      status: 0,
      stdout: cmd === 'where' && args[0] === 'x' ? 'C:\\x.exe\r\n' : '',
    });
    expect(findOnPath('x', { platform: 'win32', spawn })).toBe('C:\\x.exe');
    expect(findOnPath('x', { platform: 'win32', spawn: () => ({ status: 1 }) })).toBeNull();
  });
  it('runTool roda .cmd via cmd.exe com quoting', () => {
    const calls: { cmd: string; args: string[]; verbatim?: boolean }[] = [];
    const spawn: SpawnSyncFn = (cmd, args, o) => {
      calls.push({ cmd, args, verbatim: o.windowsVerbatimArguments });
      return { status: 0, stdout: 'ok' };
    };
    const r = runTool('claude', ['mcp', 'add', 'a b'], {
      platform: 'win32',
      spawn,
      resolve: () => 'C:\\Program Files\\c.cmd',
    });
    expect(r.status).toBe(0);
    expect(calls[0].args.slice(0, 3)).toEqual(['/d', '/s', '/c']);
    expect(calls[0].args[3]).toBe('""C:\\Program Files\\c.cmd" "mcp" "add" "a b""');
    expect(calls[0].verbatim).toBe(true);
  });
  it('runTool executa .exe direto e reporta ausência', () => {
    const calls: string[] = [];
    runTool('c', ['--version'], {
      platform: 'win32',
      spawn: (cmd) => {
        calls.push(cmd);
        return { status: 0 };
      },
      resolve: () => 'C:\\c.exe',
    });
    expect(calls).toEqual(['C:\\c.exe']);
    expect(runTool('c', [], { resolve: () => null }).error).toMatch(/não encontrado/);
  });
});
