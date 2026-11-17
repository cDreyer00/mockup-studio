import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { LaunchCommand } from './launch.js';
import type { ToolResult } from './tools.js';
import { findIntegrationsDir, integrationsCandidates, runSetup, type SetupDeps } from './setup.js';
import { tomlError } from './tomlEdit.js';

const ok: ToolResult = { status: 0, stdout: '', stderr: '' };
const bad: ToolResult = { status: 1, stdout: '', stderr: 'client error' };

let home: string;
let cwd: string;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'mockup-setup-'));
  cwd = path.join(home, 'proj');
  fs.mkdirSync(cwd);
});
afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

const claudeJson = () => path.join(home, '.claude.json');
const codexCfg = () => path.join(home, '.codex', 'config.toml');
const agentsMd = () => path.join(home, '.codex', 'AGENTS.md');
const write = (p: string, s: string) => {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, s);
};

function make(opts: {
  installed?: string[];
  failAdd?: boolean;
  removeResult?: ToolResult;
  integrations?: string | null;
  launch?: LaunchCommand;
}) {
  const ran: string[] = [];
  const deps: SetupDeps = {
    findOnPath: (n) => (opts.installed?.includes(n) ? `C:\\bin\\${n}.exe` : null),
    runTool: (n, a) => {
      ran.push(`${n} ${a.join(' ')}`);
      if (a[1] === 'add' && opts.failAdd) return bad;
      if (a[1] === 'remove' && opts.removeResult) return opts.removeResult;
      return ok;
    },
    launch: () => opts.launch ?? { command: 'mockup', args: ['mcp'], kind: 'path' },
    integrationsDir: () => opts.integrations ?? null,
    readFile: (p) => (fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null),
    writeFile: (p, c) => write(p, c),
    home,
    env: {},
    cwd,
    platform: 'win32',
  };
  return { deps, ran };
}

const claudeUser = (command = 'mockup', args = ['mcp']) =>
  JSON.stringify({
    mcpServers: { 'mockup-studio': { type: 'stdio', command, args, env: {} } },
  });

const CODEX_CUSTOM = [
  '# my config',
  'model = "x"',
  '',
  '[mcp_servers.other]',
  'command = "other"',
  '',
  '[mcp_servers.mockup-studio]',
  '# section comment',
  'command = "old"',
  'args = ["a", "b"]',
  'default_tools_approval_mode = "prompt"',
  'startup_timeout_sec = 30',
  '',
  '[mcp_servers.mockup-studio.env]',
  'MOCKUP_PORT = "4747"',
  '',
].join('\n');

describe('runSetup', () => {
  it('not installed: prints instructions (and TOML for Codex)', () => {
    const { deps, ran } = make({});
    const r = runSetup('all', {}, deps);
    expect(r.code).toBe(0);
    expect(ran).toEqual([]);
    const t = r.lines.join('\n');
    expect(t).toContain('claude mcp add --scope user mockup-studio -- mockup mcp');
    expect(t).toContain('codex mcp add mockup-studio -- mockup mcp');
    expect(t).toContain('[mcp_servers.mockup-studio]');
  });

  it('installed and not registered: only adds, without mcp get', () => {
    const { deps, ran } = make({ installed: ['claude'] });
    const r = runSetup('claude', {}, deps);
    expect(r.code).toBe(0);
    expect(ran).toEqual(['claude mcp add --scope user mockup-studio -- mockup mcp']);
    expect(r.lines.join('\n')).toContain('registered');
  });

  it('claude already registered identically: nothing executed', () => {
    write(claudeJson(), claudeUser());
    const { deps, ran } = make({ installed: ['claude'] });
    const r = runSetup('claude', {}, deps);
    expect(ran).toEqual([]);
    expect(r.lines.join('\n')).toContain('nothing to do');
  });

  it('claude registered differently: warns, removes -s user and adds', () => {
    write(claudeJson(), claudeUser('C:\\x\\node.exe', ['bin.js', 'mcp']));
    const { deps, ran } = make({ installed: ['claude'] });
    const r = runSetup('claude', {}, deps);
    expect(ran).toEqual([
      'claude mcp remove mockup-studio -s user',
      'claude mcp add --scope user mockup-studio -- mockup mcp',
    ]);
    expect(r.lines.join('\n')).toContain('discards extra fields');
  });

  it('claude respects CLAUDE_CONFIG_DIR', () => {
    const dir = path.join(home, 'cc');
    write(path.join(dir, '.claude.json'), claudeUser());
    const { deps, ran } = make({ installed: ['claude'] });
    deps.env = { CLAUDE_CONFIG_DIR: dir };
    runSetup('claude', {}, deps);
    expect(ran).toEqual([]);
  });

  it('claude only in local scope: reports it and adds to user without remove', () => {
    write(
      claudeJson(),
      JSON.stringify({
        projects: {
          [cwd.replace(/\\/g, '/')]: { mcpServers: { 'mockup-studio': { command: 'm' } } },
        },
      }),
    );
    const { deps, ran } = make({ installed: ['claude'] });
    const r = runSetup('claude', {}, deps);
    expect(ran).toEqual(['claude mcp add --scope user mockup-studio -- mockup mcp']);
    expect(r.lines.join('\n')).toContain('local scope');
  });

  it('remove with "not found" proceeds to add', () => {
    write(claudeJson(), claudeUser('other', []));
    const { deps, ran } = make({
      installed: ['claude'],
      removeResult: { status: 1, stdout: '', stderr: 'No MCP server found with name' },
    });
    const r = runSetup('claude', {}, deps);
    expect(r.code).toBe(0);
    expect(ran).toHaveLength(2);
  });

  it('--force recreates even if identical (claude)', () => {
    write(claudeJson(), claudeUser());
    const { deps, ran } = make({ installed: ['claude'] });
    const r = runSetup('claude', { force: true }, deps);
    expect(ran.map((x) => x.split(' ')[2])).toEqual(['remove', 'add']);
    expect(r.lines.join('\n')).toContain('discards extra fields');
  });

  it('codex identical: nothing to do', () => {
    write(codexCfg(), '[mcp_servers.mockup-studio]\ncommand = "mockup"\nargs = ["mcp"]\n');
    const { deps, ran } = make({ installed: ['codex'] });
    const r = runSetup('codex', {}, deps);
    expect(ran).toEqual([]);
    expect(r.lines.join('\n')).toContain('nothing to do');
  });

  it('codex different: edits only command/args, without remove', () => {
    write(codexCfg(), CODEX_CUSTOM);
    const { deps, ran } = make({ installed: ['codex'] });
    const r = runSetup('codex', {}, deps);
    expect(r.code).toBe(0);
    expect(ran).toEqual([]);
    const out = fs.readFileSync(codexCfg(), 'utf8');
    expect(out).toBe(
      CODEX_CUSTOM.replace('command = "old"', 'command = "mockup"').replace(
        'args = ["a", "b"]',
        'args = ["mcp"]',
      ),
    );
    expect(out).toContain('default_tools_approval_mode = "prompt"');
    expect(out).toContain('[mcp_servers.mockup-studio.env]');
  });

  it('absolute app command: env ELECTRON_RUN_AS_NODE is part of the comparison', () => {
    const launch: LaunchCommand = {
      command: 'C:\\App\\Mockup Studio.exe',
      args: ['C:\\App\\resources\\cli\\mockup.mjs', 'mcp'],
      env: { ELECTRON_RUN_AS_NODE: '1' },
      kind: 'absolute',
    };
    const section = [
      '[mcp_servers.mockup-studio]',
      `command = ${JSON.stringify(launch.command)}`,
      `args = [${launch.args.map((a) => JSON.stringify(a)).join(', ')}]`,
      'default_tools_approval_mode = "approve"',
      '',
      '[mcp_servers.other]',
      'command = "other"',
      '',
    ].join('\n');
    write(codexCfg(), section);
    const { deps, ran } = make({ installed: ['codex', 'claude'], launch });
    expect(runSetup('codex', {}, deps).code).toBe(0);
    expect(ran).toEqual([]);
    const out = fs.readFileSync(codexCfg(), 'utf8');
    expect(out).toContain(
      'default_tools_approval_mode = "approve"\n\n[mcp_servers.mockup-studio.env]\nELECTRON_RUN_AS_NODE = "1"\n',
    );
    expect(out).toContain('[mcp_servers.other]\ncommand = "other"');
    expect(runSetup('codex', {}, deps).lines.join('\n')).toContain('nothing to do');
    expect(fs.readFileSync(codexCfg(), 'utf8')).toBe(out);

    // Claude with the same command but without the variable: re-registers
    write(claudeJson(), claudeUser(launch.command, launch.args));
    runSetup('claude', {}, deps);
    expect(ran.map((x) => x.split(' ').slice(0, 3).join(' '))).toEqual([
      'claude mcp remove',
      'claude mcp add',
    ]);
  });

  it('codex different: preserves CRLF and accepts a quoted header', () => {
    write(
      codexCfg(),
      '[mcp_servers."mockup-studio"]\r\ncommand = \'C:\\x\\node.exe\'\r\nargs = [\r\n  "a",\r\n]\r\nfoo = 1\r\n',
    );
    const { deps } = make({ installed: ['codex'] });
    runSetup('codex', {}, deps);
    expect(fs.readFileSync(codexCfg(), 'utf8')).toBe(
      '[mcp_servers."mockup-studio"]\r\ncommand = "mockup"\r\nargs = ["mcp"]\r\nfoo = 1\r\n',
    );
  });

  it('codex stdio to http: removes command/args/env (inline and subtable) and warns', () => {
    write(
      codexCfg(),
      CODEX_CUSTOM.replace('startup_timeout_sec = 30', 'startup_timeout_sec = 30\ncwd = "C:/x"'),
    );
    const { deps } = make({ installed: ['codex'] });
    const r = runSetup('codex', { http: true, port: 4747 }, deps);
    expect(r.code).toBe(0);
    const out = fs.readFileSync(codexCfg(), 'utf8');
    expect(tomlError(out)).toBeNull();
    expect(out).toBe(
      [
        '# my config',
        'model = "x"',
        '',
        '[mcp_servers.other]',
        'command = "other"',
        '',
        '[mcp_servers.mockup-studio]',
        '# section comment',
        'default_tools_approval_mode = "prompt"',
        'startup_timeout_sec = 30',
        'url = "http://127.0.0.1:4747/mcp"',
        '',
      ].join('\n'),
    );
    expect(r.lines.join('\n')).toContain(
      'removed because they do not apply to http: command, args, [mcp_servers.mockup-studio.env], cwd.',
    );
    const again = runSetup('codex', { http: true, port: 4747 }, deps);
    expect(again.lines.join('\n')).toContain('nothing to do');
  });

  it('codex packaged app (inline env) to http and back to stdio', () => {
    const launch: LaunchCommand = {
      command: 'C:\\App\\Mockup Studio.exe',
      args: ['C:\\App\\resources\\cli\\mockup.mjs', 'mcp'],
      env: { ELECTRON_RUN_AS_NODE: '1' },
      kind: 'absolute',
    };
    write(
      codexCfg(),
      [
        '[mcp_servers.mockup-studio]',
        'command = "old"',
        'args = []',
        'env = { ELECTRON_RUN_AS_NODE = "0", OTHER = "x" } # vars',
        '',
      ].join('\n'),
    );
    const { deps } = make({ installed: ['codex'], launch });
    expect(runSetup('codex', {}, deps).code).toBe(0);
    let out = fs.readFileSync(codexCfg(), 'utf8');
    expect(out).toContain('env = { ELECTRON_RUN_AS_NODE = "1", OTHER = "x" } # vars\n');
    expect(out).not.toContain('[mcp_servers.mockup-studio.env]');
    expect(tomlError(out)).toBeNull();
    expect(runSetup('codex', {}, deps).lines.join('\n')).toContain('nothing to do');

    expect(runSetup('codex', { http: true, port: 4747 }, deps).code).toBe(0);
    out = fs.readFileSync(codexCfg(), 'utf8');
    expect(out).toBe('[mcp_servers.mockup-studio]\nurl = "http://127.0.0.1:4747/mcp"\n');

    // back to stdio with custom http keys: they are removed
    write(
      codexCfg(),
      [
        '[mcp_servers.mockup-studio]',
        'url = "u"',
        'bearer_token_env_var = "T"',
        '',
        '[mcp_servers.mockup-studio.http_headers]',
        'X = "1"',
        '',
      ].join('\n'),
    );
    const r = runSetup('codex', {}, deps);
    expect(r.code).toBe(0);
    out = fs.readFileSync(codexCfg(), 'utf8');
    expect(tomlError(out)).toBeNull();
    expect(out).not.toMatch(/url|bearer|http_headers/);
    expect(out).toContain('[mcp_servers.mockup-studio.env]\nELECTRON_RUN_AS_NODE = "1"');
    expect(r.lines.join('\n')).toContain(
      'removed because they do not apply to stdio: url, bearer_token_env_var, [mcp_servers.mockup-studio.http_headers].',
    );
  });

  it('codex with an invalid config.toml: does not write and explains', () => {
    const bad = '[mcp_servers.mockup-studio]\ncommand = "x"\ncommand = "y"\n';
    write(codexCfg(), bad);
    const { deps, ran } = make({ installed: ['codex'] });
    const r = runSetup('codex', {}, deps);
    expect(r.code).toBe(1);
    expect(ran).toEqual([]);
    expect(r.lines.join('\n')).toMatch(/is not valid TOML \(line 3/);
    expect(fs.readFileSync(codexCfg(), 'utf8')).toBe(bad);
  });

  it('codex: an edit that does not end up with the expected launch is not written', () => {
    // dotted key env.A is not edited by the line editor: the new subtable would duplicate env
    const cfg = '[mcp_servers.mockup-studio]\ncommand = "x"\nargs = []\nenv.A = "1"\n';
    write(codexCfg(), cfg);
    const launch: LaunchCommand = {
      command: 'm',
      args: ['mcp'],
      env: { B: '2' },
      kind: 'absolute',
    };
    const { deps } = make({ installed: ['codex'], launch });
    const r = runSetup('codex', {}, deps);
    expect(r.code).toBe(1);
    expect(r.lines.join('\n')).toContain('nothing written');
    expect(r.lines.join('\n')).toContain('--force');
    expect(fs.readFileSync(codexCfg(), 'utf8')).toBe(cfg);
  });

  it('codex without a section: uses codex mcp add', () => {
    const { deps, ran } = make({ installed: ['codex'] });
    runSetup('codex', {}, deps);
    expect(ran).toEqual(['codex mcp add mockup-studio -- mockup mcp']);
  });

  it('--force recreates in codex', () => {
    write(codexCfg(), CODEX_CUSTOM);
    const { deps, ran } = make({ installed: ['codex'] });
    runSetup('codex', { force: true }, deps);
    expect(ran).toEqual([
      'codex mcp remove mockup-studio',
      'codex mcp add mockup-studio -- mockup mcp',
    ]);
  });

  it('CODEX_HOME is respected', () => {
    const dir = path.join(home, 'ch');
    write(path.join(dir, 'config.toml'), CODEX_CUSTOM);
    const { deps } = make({ installed: ['codex'] });
    deps.env = { CODEX_HOME: dir };
    runSetup('codex', {}, deps);
    expect(fs.readFileSync(path.join(dir, 'config.toml'), 'utf8')).toContain('command = "mockup"');
  });

  it('failure: code 1, stderr and manual command', () => {
    const { deps } = make({ installed: ['claude'], failAdd: true });
    const r = runSetup('claude', {}, deps);
    expect(r.code).toBe(1);
    const t = r.lines.join('\n');
    expect(t).toContain('client error');
    expect(t).toContain('run manually: claude mcp add');
  });

  it('--print neither executes nor writes anything', () => {
    write(codexCfg(), CODEX_CUSTOM);
    const integ = path.join(home, 'integ');
    write(path.join(integ, 'codex', 'AGENTS.snippet.md'), 'x');
    const { deps, ran } = make({ installed: ['claude', 'codex'], integrations: integ });
    expect(runSetup('all', { print: true, approve: true, agents: true }, deps).code).toBe(0);
    expect(ran).toEqual([]);
    expect(fs.readFileSync(codexCfg(), 'utf8')).toBe(CODEX_CUSTOM);
    expect(fs.existsSync(agentsMd())).toBe(false);
  });

  it('--http uses the daemon URL', () => {
    const { deps } = make({});
    const t = runSetup('claude', { http: true, print: true, port: 4747 }, deps).lines.join('\n');
    expect(t).toContain('--transport http mockup-studio http://127.0.0.1:4747/mcp');
  });

  it('--skill copies and overwrites, reporting it', () => {
    const integ = path.join(home, 'integ');
    write(path.join(integ, 'claude-code', 'SKILL.md'), '---\nname: mockup-studio\n---\n');
    const { deps } = make({ installed: ['claude'], integrations: integ });
    const dest = path.join(home, '.claude', 'skills', 'mockup-studio', 'SKILL.md');
    expect(runSetup('claude', { skill: true }, deps).lines.join('\n')).toContain('installed');
    expect(fs.readFileSync(dest, 'utf8')).toContain('mockup-studio');
    expect(runSetup('claude', { skill: true }, deps).lines.join('\n')).toContain('updated');
  });

  it('--skill without the integrations folder: code 1', () => {
    const { deps } = make({ installed: ['claude'] });
    expect(runSetup('claude', { skill: true }, deps).code).toBe(1);
  });
});

describe('--approve and --agents', () => {
  it('--approve is idempotent and swaps another value', () => {
    write(codexCfg(), CODEX_CUSTOM);
    const { deps } = make({ installed: ['codex'] });
    const r1 = runSetup('codex', { approve: true }, deps);
    expect(r1.lines.join('\n')).toContain('changed from "prompt" to "approve"');
    runSetup('codex', { approve: true }, deps);
    const out = fs.readFileSync(codexCfg(), 'utf8');
    expect(out.match(/default_tools_approval_mode/g)).toHaveLength(1);
    expect(out).toContain('default_tools_approval_mode = "approve"');
    expect(out).toContain('startup_timeout_sec = 30');
  });

  it('--approve without the section: registers and then writes', () => {
    const { deps, ran } = make({ installed: ['codex'] });
    // the fake codex does not write the file: simulates what `codex mcp add` would do
    const real = deps.runTool;
    deps.runTool = (n, a) => {
      if (a[1] === 'add')
        write(codexCfg(), '[mcp_servers.mockup-studio]\ncommand = "mockup"\nargs = ["mcp"]\n');
      return real(n, a);
    };
    runSetup('codex', { approve: true }, deps);
    expect(ran).toEqual(['codex mcp add mockup-studio -- mockup mcp']);
    expect(fs.readFileSync(codexCfg(), 'utf8')).toContain(
      'default_tools_approval_mode = "approve"',
    );
  });

  it('--approve and --agents with a claude target are ignored with a warning', () => {
    write(claudeJson(), claudeUser());
    const { deps } = make({ installed: ['claude'] });
    const t = runSetup('claude', { approve: true, agents: true }, deps).lines.join('\n');
    expect(t).toContain('only apply to Codex');
  });

  it('--agents is idempotent and preserves content outside the markers', () => {
    const integ = path.join(home, 'integ');
    write(
      path.join(integ, 'codex', 'AGENTS.snippet.md'),
      '<!-- Paste this block -->\n\n## Mockup Studio\n\nUse the MCP.\n',
    );
    write(agentsMd(), '# My rules\n\nBe brief.\n');
    const { deps } = make({ installed: ['codex'], integrations: integ });
    const first = runSetup('codex', { agents: true }, deps);
    expect(first.code).toBe(0);
    const after1 = fs.readFileSync(agentsMd(), 'utf8');
    expect(after1).toBe(
      '# My rules\n\nBe brief.\n\n<!-- mockup-studio:start -->\n## Mockup Studio\n\nUse the MCP.\n<!-- mockup-studio:end -->\n',
    );
    const second = runSetup('codex', { agents: true }, deps);
    expect(second.lines.join('\n')).toContain('already up to date');
    expect(fs.readFileSync(agentsMd(), 'utf8')).toBe(after1);

    // snippet changed: replaces between the markers and keeps the rest
    write(path.join(integ, 'codex', 'AGENTS.snippet.md'), '## New\n');
    fs.appendFileSync(agentsMd(), '\nAfter.\n');
    runSetup('codex', { agents: true }, deps);
    const out = fs.readFileSync(agentsMd(), 'utf8');
    expect(out.match(/mockup-studio:start/g)).toHaveLength(1);
    expect(out).toContain('## New');
    expect(out).not.toContain('Use the MCP');
    expect(out).toContain('Be brief.');
    expect(out).toContain('After.');
  });

  it('--agents creates the file; without a snippet: code 1', () => {
    const integ = path.join(home, 'integ');
    write(path.join(integ, 'codex', 'AGENTS.snippet.md'), '## X\n');
    const { deps } = make({ installed: ['codex'], integrations: integ });
    runSetup('codex', { agents: true }, deps);
    expect(fs.readFileSync(agentsMd(), 'utf8')).toContain('## X');
    const none = make({ installed: ['codex'] });
    expect(runSetup('codex', { agents: true }, none.deps).code).toBe(1);
  });
});

describe('integrations', () => {
  it('candidates include env, bundle and resourcesPath', () => {
    const c = integrationsCandidates(
      { MOCKUP_INTEGRATIONS_DIR: 'E' },
      path.resolve('/r/cli'),
      '/res',
    );
    expect(c[0]).toBe('E');
    expect(c).toContain(path.resolve('/r/integrations'));
    expect(c).toContain(path.join('/res', 'integrations'));
  });
  it('finds it via the environment variable', () => {
    const integ = path.join(home, 'i');
    fs.mkdirSync(path.join(integ, 'claude-code'), { recursive: true });
    fs.writeFileSync(path.join(integ, 'claude-code', 'SKILL.md'), 'x');
    expect(findIntegrationsDir(integrationsCandidates({ MOCKUP_INTEGRATIONS_DIR: integ }))).toBe(
      integ,
    );
  });
});
