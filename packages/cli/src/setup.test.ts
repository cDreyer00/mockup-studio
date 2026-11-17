import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ToolResult } from './tools.js';
import { findIntegrationsDir, integrationsCandidates, runSetup, type SetupDeps } from './setup.js';

const ok: ToolResult = { status: 0, stdout: '', stderr: '' };
const bad: ToolResult = { status: 1, stdout: '', stderr: 'erro do cliente' };

let home: string;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'mockup-setup-'));
});
afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

function make(opts: {
  installed?: string[];
  registered?: string[];
  failAdd?: boolean;
  integrations?: string | null;
}) {
  const ran: string[] = [];
  const deps: SetupDeps = {
    findOnPath: (n) => (opts.installed?.includes(n) ? `C:\\bin\\${n}.exe` : null),
    runTool: (n, a) => {
      ran.push(`${n} ${a.join(' ')}`);
      if (a[1] === 'get') return opts.registered?.includes(n) ? ok : bad;
      if (a[1] === 'add' && opts.failAdd) return bad;
      return ok;
    },
    launch: () => ({ command: 'mockup', args: ['mcp'], kind: 'path' }),
    integrationsDir: () => opts.integrations ?? null,
    home,
    platform: 'win32',
  };
  return { deps, ran };
}

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

  it('instalado e não registrado: só adiciona', () => {
    const { deps, ran } = make({ installed: ['claude'] });
    const r = runSetup('claude', {}, deps);
    expect(r.code).toBe(0);
    expect(ran).toEqual([
      'claude mcp get mockup-studio',
      'claude mcp add --scope user mockup-studio -- mockup mcp',
    ]);
    expect(r.lines.join('\n')).toContain('registrado');
  });

  it('registrado: remove e adiciona de novo', () => {
    const { deps, ran } = make({ installed: ['codex'], registered: ['codex'] });
    const r = runSetup('codex', {}, deps);
    expect(ran).toEqual([
      'codex mcp get mockup-studio',
      'codex mcp remove mockup-studio',
      'codex mcp add mockup-studio -- mockup mcp',
    ]);
    expect(r.lines.join('\n')).toContain('atualizado');
  });

  it('claude remove usa -s user', () => {
    const { deps, ran } = make({ installed: ['claude'], registered: ['claude'] });
    runSetup('claude', {}, deps);
    expect(ran[1]).toBe('claude mcp remove mockup-studio -s user');
  });

  it('falha: código 1, stderr e comando manual', () => {
    const { deps } = make({ installed: ['claude'], failAdd: true });
    const r = runSetup('claude', {}, deps);
    expect(r.code).toBe(1);
    const t = r.lines.join('\n');
    expect(t).toContain('erro do cliente');
    expect(t).toContain('rode manualmente: claude mcp add');
  });

  it('--print não executa nada', () => {
    const { deps, ran } = make({ installed: ['claude', 'codex'] });
    expect(runSetup('all', { print: true }, deps).code).toBe(0);
    expect(ran).toEqual([]);
  });

  it('--http usa a URL do daemon', () => {
    const { deps } = make({});
    const t = runSetup('claude', { http: true, print: true, port: 4747 }, deps).lines.join('\n');
    expect(t).toContain('--transport http mockup-studio http://127.0.0.1:4747/mcp');
  });

  it('--skill copia e sobrescreve informando', () => {
    const integ = path.join(home, 'integ');
    fs.mkdirSync(path.join(integ, 'claude-code'), { recursive: true });
    fs.writeFileSync(
      path.join(integ, 'claude-code', 'SKILL.md'),
      '---\nname: mockup-studio\n---\n',
    );
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
