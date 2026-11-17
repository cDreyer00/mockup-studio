import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { LaunchCommand } from './launch.js';
import type { ToolResult } from './tools.js';
import { findIntegrationsDir, integrationsCandidates, runSetup, type SetupDeps } from './setup.js';
import { tomlError } from './tomlEdit.js';

const ok: ToolResult = { status: 0, stdout: '', stderr: '' };
const bad: ToolResult = { status: 1, stdout: '', stderr: 'erro do cliente' };

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
  '# meu config',
  'model = "x"',
  '',
  '[mcp_servers.outro]',
  'command = "outro"',
  '',
  '[mcp_servers.mockup-studio]',
  '# comentário da seção',
  'command = "antigo"',
  'args = ["a", "b"]',
  'default_tools_approval_mode = "prompt"',
  'startup_timeout_sec = 30',
  '',
  '[mcp_servers.mockup-studio.env]',
  'MOCKUP_PORT = "4747"',
  '',
].join('\n');

describe('runSetup', () => {
  it('não instalado: imprime instruções (e TOML no Codex)', () => {
    const { deps, ran } = make({});
    const r = runSetup('all', {}, deps);
    expect(r.code).toBe(0);
    expect(ran).toEqual([]);
    const t = r.lines.join('\n');
    expect(t).toContain('claude mcp add --scope user mockup-studio -- mockup mcp');
    expect(t).toContain('codex mcp add mockup-studio -- mockup mcp');
    expect(t).toContain('[mcp_servers.mockup-studio]');
  });

  it('instalado e não registrado: só adiciona, sem mcp get', () => {
    const { deps, ran } = make({ installed: ['claude'] });
    const r = runSetup('claude', {}, deps);
    expect(r.code).toBe(0);
    expect(ran).toEqual(['claude mcp add --scope user mockup-studio -- mockup mcp']);
    expect(r.lines.join('\n')).toContain('registrado');
  });

  it('claude já registrado igual: nada executado', () => {
    write(claudeJson(), claudeUser());
    const { deps, ran } = make({ installed: ['claude'] });
    const r = runSetup('claude', {}, deps);
    expect(ran).toEqual([]);
    expect(r.lines.join('\n')).toContain('nada a fazer');
  });

  it('claude registrado diferente: avisa, remove -s user e adiciona', () => {
    write(claudeJson(), claudeUser('C:\\x\\node.exe', ['bin.js', 'mcp']));
    const { deps, ran } = make({ installed: ['claude'] });
    const r = runSetup('claude', {}, deps);
    expect(ran).toEqual([
      'claude mcp remove mockup-studio -s user',
      'claude mcp add --scope user mockup-studio -- mockup mcp',
    ]);
    expect(r.lines.join('\n')).toContain('descarta campos extras');
  });

  it('claude respeita CLAUDE_CONFIG_DIR', () => {
    const dir = path.join(home, 'cc');
    write(path.join(dir, '.claude.json'), claudeUser());
    const { deps, ran } = make({ installed: ['claude'] });
    deps.env = { CLAUDE_CONFIG_DIR: dir };
    runSetup('claude', {}, deps);
    expect(ran).toEqual([]);
  });

  it('claude só em escopo local: informa e adiciona no user sem remove', () => {
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
    expect(r.lines.join('\n')).toContain('escopo local');
  });

  it('remove com "not found" segue para o add', () => {
    write(claudeJson(), claudeUser('outro', []));
    const { deps, ran } = make({
      installed: ['claude'],
      removeResult: { status: 1, stdout: '', stderr: 'No MCP server found with name' },
    });
    const r = runSetup('claude', {}, deps);
    expect(r.code).toBe(0);
    expect(ran).toHaveLength(2);
  });

  it('--force recria mesmo igual (claude)', () => {
    write(claudeJson(), claudeUser());
    const { deps, ran } = make({ installed: ['claude'] });
    const r = runSetup('claude', { force: true }, deps);
    expect(ran.map((x) => x.split(' ')[2])).toEqual(['remove', 'add']);
    expect(r.lines.join('\n')).toContain('descarta campos extras');
  });

  it('codex igual: nada a fazer', () => {
    write(codexCfg(), '[mcp_servers.mockup-studio]\ncommand = "mockup"\nargs = ["mcp"]\n');
    const { deps, ran } = make({ installed: ['codex'] });
    const r = runSetup('codex', {}, deps);
    expect(ran).toEqual([]);
    expect(r.lines.join('\n')).toContain('nada a fazer');
  });

  it('codex diferente: edita só command/args, sem remove', () => {
    write(codexCfg(), CODEX_CUSTOM);
    const { deps, ran } = make({ installed: ['codex'] });
    const r = runSetup('codex', {}, deps);
    expect(r.code).toBe(0);
    expect(ran).toEqual([]);
    const out = fs.readFileSync(codexCfg(), 'utf8');
    expect(out).toBe(
      CODEX_CUSTOM.replace('command = "antigo"', 'command = "mockup"').replace(
        'args = ["a", "b"]',
        'args = ["mcp"]',
      ),
    );
    expect(out).toContain('default_tools_approval_mode = "prompt"');
    expect(out).toContain('[mcp_servers.mockup-studio.env]');
  });

  it('comando absoluto do app: env ELECTRON_RUN_AS_NODE faz parte da comparação', () => {
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
      '[mcp_servers.outro]',
      'command = "outro"',
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
    expect(out).toContain('[mcp_servers.outro]\ncommand = "outro"');
    expect(runSetup('codex', {}, deps).lines.join('\n')).toContain('nada a fazer');
    expect(fs.readFileSync(codexCfg(), 'utf8')).toBe(out);

    // Claude com o mesmo comando, mas sem a variável: re-registra
    write(claudeJson(), claudeUser(launch.command, launch.args));
    runSetup('claude', {}, deps);
    expect(ran.map((x) => x.split(' ').slice(0, 3).join(' '))).toEqual([
      'claude mcp remove',
      'claude mcp add',
    ]);
  });

  it('codex diferente: preserva CRLF e aceita cabeçalho com aspas', () => {
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

  it('codex stdio para http: remove command/args/env (em linha e subtabela) e avisa', () => {
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
        '# meu config',
        'model = "x"',
        '',
        '[mcp_servers.outro]',
        'command = "outro"',
        '',
        '[mcp_servers.mockup-studio]',
        '# comentário da seção',
        'default_tools_approval_mode = "prompt"',
        'startup_timeout_sec = 30',
        'url = "http://127.0.0.1:4747/mcp"',
        '',
      ].join('\n'),
    );
    expect(r.lines.join('\n')).toContain(
      'removidas por não valerem para http: command, args, [mcp_servers.mockup-studio.env], cwd.',
    );
    const again = runSetup('codex', { http: true, port: 4747 }, deps);
    expect(again.lines.join('\n')).toContain('nada a fazer');
  });

  it('codex app empacotado (env em linha) para http e de volta para stdio', () => {
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
        'command = "antigo"',
        'args = []',
        'env = { ELECTRON_RUN_AS_NODE = "0", OUTRA = "x" } # vars',
        '',
      ].join('\n'),
    );
    const { deps } = make({ installed: ['codex'], launch });
    expect(runSetup('codex', {}, deps).code).toBe(0);
    let out = fs.readFileSync(codexCfg(), 'utf8');
    expect(out).toContain('env = { ELECTRON_RUN_AS_NODE = "1", OUTRA = "x" } # vars\n');
    expect(out).not.toContain('[mcp_servers.mockup-studio.env]');
    expect(tomlError(out)).toBeNull();
    expect(runSetup('codex', {}, deps).lines.join('\n')).toContain('nada a fazer');

    expect(runSetup('codex', { http: true, port: 4747 }, deps).code).toBe(0);
    out = fs.readFileSync(codexCfg(), 'utf8');
    expect(out).toBe('[mcp_servers.mockup-studio]\nurl = "http://127.0.0.1:4747/mcp"\n');

    // volta para stdio com chaves de http personalizadas: são removidas
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
      'removidas por não valerem para stdio: url, bearer_token_env_var, [mcp_servers.mockup-studio.http_headers].',
    );
  });

  it('codex com config.toml inválido: não grava e explica', () => {
    const bad = '[mcp_servers.mockup-studio]\ncommand = "x"\ncommand = "y"\n';
    write(codexCfg(), bad);
    const { deps, ran } = make({ installed: ['codex'] });
    const r = runSetup('codex', {}, deps);
    expect(r.code).toBe(1);
    expect(ran).toEqual([]);
    expect(r.lines.join('\n')).toMatch(/não é TOML válido \(linha 3/);
    expect(fs.readFileSync(codexCfg(), 'utf8')).toBe(bad);
  });

  it('codex: edição que não fica com o lançamento esperado não é gravada', () => {
    // chave pontilhada env.A não é editada pelo editor de linhas: a subtabela nova duplicaria env
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
    expect(r.lines.join('\n')).toContain('nada gravado');
    expect(r.lines.join('\n')).toContain('--force');
    expect(fs.readFileSync(codexCfg(), 'utf8')).toBe(cfg);
  });

  it('codex sem seção: usa codex mcp add', () => {
    const { deps, ran } = make({ installed: ['codex'] });
    runSetup('codex', {}, deps);
    expect(ran).toEqual(['codex mcp add mockup-studio -- mockup mcp']);
  });

  it('--force recria no codex', () => {
    write(codexCfg(), CODEX_CUSTOM);
    const { deps, ran } = make({ installed: ['codex'] });
    runSetup('codex', { force: true }, deps);
    expect(ran).toEqual([
      'codex mcp remove mockup-studio',
      'codex mcp add mockup-studio -- mockup mcp',
    ]);
  });

  it('CODEX_HOME é respeitado', () => {
    const dir = path.join(home, 'ch');
    write(path.join(dir, 'config.toml'), CODEX_CUSTOM);
    const { deps } = make({ installed: ['codex'] });
    deps.env = { CODEX_HOME: dir };
    runSetup('codex', {}, deps);
    expect(fs.readFileSync(path.join(dir, 'config.toml'), 'utf8')).toContain('command = "mockup"');
  });

  it('falha: código 1, stderr e comando manual', () => {
    const { deps } = make({ installed: ['claude'], failAdd: true });
    const r = runSetup('claude', {}, deps);
    expect(r.code).toBe(1);
    const t = r.lines.join('\n');
    expect(t).toContain('erro do cliente');
    expect(t).toContain('rode manualmente: claude mcp add');
  });

  it('--print não executa nem grava nada', () => {
    write(codexCfg(), CODEX_CUSTOM);
    const integ = path.join(home, 'integ');
    write(path.join(integ, 'codex', 'AGENTS.snippet.md'), 'x');
    const { deps, ran } = make({ installed: ['claude', 'codex'], integrations: integ });
    expect(runSetup('all', { print: true, approve: true, agents: true }, deps).code).toBe(0);
    expect(ran).toEqual([]);
    expect(fs.readFileSync(codexCfg(), 'utf8')).toBe(CODEX_CUSTOM);
    expect(fs.existsSync(agentsMd())).toBe(false);
  });

  it('--http usa a URL do daemon', () => {
    const { deps } = make({});
    const t = runSetup('claude', { http: true, print: true, port: 4747 }, deps).lines.join('\n');
    expect(t).toContain('--transport http mockup-studio http://127.0.0.1:4747/mcp');
  });

  it('--skill copia e sobrescreve informando', () => {
    const integ = path.join(home, 'integ');
    write(path.join(integ, 'claude-code', 'SKILL.md'), '---\nname: mockup-studio\n---\n');
    const { deps } = make({ installed: ['claude'], integrations: integ });
    const dest = path.join(home, '.claude', 'skills', 'mockup-studio', 'SKILL.md');
    expect(runSetup('claude', { skill: true }, deps).lines.join('\n')).toContain('instalada');
    expect(fs.readFileSync(dest, 'utf8')).toContain('mockup-studio');
    expect(runSetup('claude', { skill: true }, deps).lines.join('\n')).toContain('atualizada');
  });

  it('--skill sem a pasta integrations: código 1', () => {
    const { deps } = make({ installed: ['claude'] });
    expect(runSetup('claude', { skill: true }, deps).code).toBe(1);
  });
});

describe('--approve e --agents', () => {
  it('--approve é idempotente e troca outro valor', () => {
    write(codexCfg(), CODEX_CUSTOM);
    const { deps } = make({ installed: ['codex'] });
    const r1 = runSetup('codex', { approve: true }, deps);
    expect(r1.lines.join('\n')).toContain('trocado de "prompt" para "approve"');
    runSetup('codex', { approve: true }, deps);
    const out = fs.readFileSync(codexCfg(), 'utf8');
    expect(out.match(/default_tools_approval_mode/g)).toHaveLength(1);
    expect(out).toContain('default_tools_approval_mode = "approve"');
    expect(out).toContain('startup_timeout_sec = 30');
  });

  it('--approve sem a seção: registra e depois grava', () => {
    const { deps, ran } = make({ installed: ['codex'] });
    // o codex falso não escreve o arquivo: simula o que o `codex mcp add` faria
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

  it('--approve e --agents com alvo claude são ignorados com aviso', () => {
    write(claudeJson(), claudeUser());
    const { deps } = make({ installed: ['claude'] });
    const t = runSetup('claude', { approve: true, agents: true }, deps).lines.join('\n');
    expect(t).toContain('só valem para o Codex');
  });

  it('--agents é idempotente e preserva o conteúdo fora dos marcadores', () => {
    const integ = path.join(home, 'integ');
    write(
      path.join(integ, 'codex', 'AGENTS.snippet.md'),
      '<!-- Cole este bloco -->\n\n## Mockup Studio\n\nUse o MCP.\n',
    );
    write(agentsMd(), '# Minhas regras\n\nSeja breve.\n');
    const { deps } = make({ installed: ['codex'], integrations: integ });
    const first = runSetup('codex', { agents: true }, deps);
    expect(first.code).toBe(0);
    const after1 = fs.readFileSync(agentsMd(), 'utf8');
    expect(after1).toBe(
      '# Minhas regras\n\nSeja breve.\n\n<!-- mockup-studio:start -->\n## Mockup Studio\n\nUse o MCP.\n<!-- mockup-studio:end -->\n',
    );
    const second = runSetup('codex', { agents: true }, deps);
    expect(second.lines.join('\n')).toContain('já atualizado');
    expect(fs.readFileSync(agentsMd(), 'utf8')).toBe(after1);

    // snippet mudou: substitui entre os marcadores e mantém o resto
    write(path.join(integ, 'codex', 'AGENTS.snippet.md'), '## Novo\n');
    fs.appendFileSync(agentsMd(), '\nDepois.\n');
    runSetup('codex', { agents: true }, deps);
    const out = fs.readFileSync(agentsMd(), 'utf8');
    expect(out.match(/mockup-studio:start/g)).toHaveLength(1);
    expect(out).toContain('## Novo');
    expect(out).not.toContain('Use o MCP');
    expect(out).toContain('Seja breve.');
    expect(out).toContain('Depois.');
  });

  it('--agents cria o arquivo; sem snippet: código 1', () => {
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
  it('candidatos incluem env, bundle e resourcesPath', () => {
    const c = integrationsCandidates(
      { MOCKUP_INTEGRATIONS_DIR: 'E' },
      path.resolve('/r/cli'),
      '/res',
    );
    expect(c[0]).toBe('E');
    expect(c).toContain(path.resolve('/r/integrations'));
    expect(c).toContain(path.join('/res', 'integrations'));
  });
  it('acha pela variável de ambiente', () => {
    const integ = path.join(home, 'i');
    fs.mkdirSync(path.join(integ, 'claude-code'), { recursive: true });
    fs.writeFileSync(path.join(integ, 'claude-code', 'SKILL.md'), 'x');
    expect(findIntegrationsDir(integrationsCandidates({ MOCKUP_INTEGRATIONS_DIR: integ }))).toBe(
      integ,
    );
  });
});
