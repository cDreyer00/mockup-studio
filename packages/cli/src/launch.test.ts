import { describe, expect, it } from 'vitest';
import {
  claudeAddArgs,
  codexAddArgs,
  codexToml,
  commandLine,
  mcpServersJson,
  parseLaunchKind,
  resolveLaunchCommand,
  shellQuote,
  tomlString,
  vscodeMcpJson,
  type LaunchCommand,
  type LaunchDeps,
} from './launch.js';
import type { CliRuntime } from './runtime.js';

const nodeRt: CliRuntime = {
  kind: 'node',
  execPath: String.raw`C:\Program Files\nodejs\node.exe`,
  script: String.raw`C:\Users\a b\cli\dist\bin.js`,
  version: '0.1.0',
  nodeVersion: '24.0.0',
};
const electronRt: CliRuntime = { ...nodeRt, kind: 'electron', electronVersion: '40.0.0' };

const deps = (over: Partial<LaunchDeps> = {}): LaunchDeps => ({
  runtime: nodeRt,
  which: () => null,
  shim: String.raw`C:\Users\a\AppData\Local\MockupStudio\bin\mockup.cmd`,
  exists: () => false,
  ...over,
});

describe('resolveLaunchCommand', () => {
  it('mockup no PATH', () => {
    expect(resolveLaunchCommand(deps({ which: () => 'x\\mockup.cmd' }))).toEqual({
      command: 'mockup',
      args: ['mcp'],
      kind: 'path',
    });
  });
  it('shim instalado', () => {
    const l = resolveLaunchCommand(deps({ exists: () => true }));
    expect(l).toMatchObject({ kind: 'shim', args: ['mcp'] });
    expect(l.command).toMatch(/mockup\.cmd$/);
  });
  it('absoluto sob Node', () => {
    expect(resolveLaunchCommand(deps())).toEqual({
      command: nodeRt.execPath,
      args: [nodeRt.script, 'mcp'],
      kind: 'absolute',
    });
  });
  it('absoluto sob Electron leva ELECTRON_RUN_AS_NODE', () => {
    expect(resolveLaunchCommand(deps({ runtime: electronRt })).env).toEqual({
      ELECTRON_RUN_AS_NODE: '1',
    });
  });
  it('--command força o tipo', () => {
    const base = deps({ which: () => 'x', exists: () => true });
    expect(resolveLaunchCommand({ ...base, force: 'absolute' }).kind).toBe('absolute');
    expect(resolveLaunchCommand({ ...base, force: 'shim' }).kind).toBe('shim');
    expect(resolveLaunchCommand({ ...deps(), force: 'path' }).kind).toBe('path');
  });
  it('parseLaunchKind valida', () => {
    expect(parseLaunchKind(undefined)).toBeUndefined();
    expect(parseLaunchKind('shim')).toBe('shim');
    expect(() => parseLaunchKind('x')).toThrow(/--command/);
  });
});

const abs: LaunchCommand = {
  command: nodeRt.execPath,
  args: [nodeRt.script, 'mcp'],
  kind: 'absolute',
};
const absEl: LaunchCommand = { ...abs, env: { ELECTRON_RUN_AS_NODE: '1' } };

describe('formatação', () => {
  it('claudeAddArgs', () => {
    expect(claudeAddArgs({ command: 'mockup', args: ['mcp'], kind: 'path' })).toEqual([
      'mcp',
      'add',
      '--scope',
      'user',
      'mockup-studio',
      '--',
      'mockup',
      'mcp',
    ]);
    expect(claudeAddArgs(absEl).slice(0, 6)).toEqual([
      'mcp',
      'add',
      '--scope',
      'user',
      '-e',
      'ELECTRON_RUN_AS_NODE=1',
    ]);
    expect(claudeAddArgs(abs, { http: true, port: 5000 })).toEqual([
      'mcp',
      'add',
      '--scope',
      'user',
      '--transport',
      'http',
      'mockup-studio',
      'http://127.0.0.1:5000/mcp',
    ]);
  });
  it('codexAddArgs', () => {
    expect(codexAddArgs(absEl)).toEqual([
      'mcp',
      'add',
      'mockup-studio',
      '--env',
      'ELECTRON_RUN_AS_NODE=1',
      '--',
      nodeRt.execPath,
      nodeRt.script,
      'mcp',
    ]);
    expect(codexAddArgs(abs, { http: true, port: 1 })).toEqual([
      'mcp',
      'add',
      'mockup-studio',
      '--url',
      'http://127.0.0.1:1/mcp',
    ]);
  });
  it('TOML escapa caminhos do Windows', () => {
    expect(tomlString(String.raw`C:\a "b"`)).toBe(String.raw`"C:\\a \"b\""`);
    const t = codexToml(absEl);
    expect(t).toContain(String.raw`command = "C:\\Program Files\\nodejs\\node.exe"`);
    expect(t).toContain(String.raw`args = ["C:\\Users\\a b\\cli\\dist\\bin.js", "mcp"]`);
    expect(t).toContain('[mcp_servers.mockup-studio.env]\nELECTRON_RUN_AS_NODE = "1"');
    expect(codexToml({ command: 'mockup', args: ['mcp'], kind: 'path' })).not.toContain('env');
  });
  it('JSON mcpServers e VS Code', () => {
    expect(JSON.parse(mcpServersJson(absEl))).toEqual({
      mcpServers: { 'mockup-studio': { command: abs.command, args: abs.args, env: absEl.env } },
    });
    expect(JSON.parse(vscodeMcpJson(abs)).servers['mockup-studio']).toEqual({
      type: 'stdio',
      command: abs.command,
      args: abs.args,
    });
  });
  it('shellQuote', () => {
    expect(shellQuote('mockup', 'win32')).toBe('mockup');
    expect(shellQuote(String.raw`C:\Program Files\nodejs\node.exe`, 'win32')).toBe(
      String.raw`"C:\Program Files\nodejs\node.exe"`,
    );
    expect(shellQuote("/a b/it's", 'linux')).toBe(String.raw`'/a b/it'\''s'`);
    expect(shellQuote('/usr/bin/node', 'linux')).toBe('/usr/bin/node');
    expect(commandLine('claude', ['mcp', 'add', 'x y'], 'win32')).toBe('claude mcp add "x y"');
  });
});
