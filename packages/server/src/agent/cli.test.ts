import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { AgentRunEvent } from './backend.js';
import {
  ClaudeCliBackend,
  ClaudeStreamParser,
  CodexStreamParser,
  findExecutable,
  killTree,
  stripMcpPrefix,
  type LineParser,
} from './cli.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const FAKE_CLI = path.resolve(here, '../../test/fixtures/fake-agent-cli.mjs');

function feed(p: LineParser, lines: unknown[]): AgentRunEvent[] {
  return lines.flatMap((l) => p.parse(typeof l === 'string' ? l : JSON.stringify(l)));
}

describe('ClaudeStreamParser', () => {
  it('mapeia init, texto, ferramenta, resultado da ferramenta e result final', () => {
    const p = new ClaudeStreamParser();
    const ev = feed(p, [
      { type: 'system', subtype: 'init', session_id: 'S1', tools: [], mcp_servers: [] },
      {
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'Vou renomear.' }] },
      },
      {
        type: 'assistant',
        message: {
          content: [
            {
              type: 'tool_use',
              id: 'tu1',
              name: 'mcp__mockup-studio__rename_nodes',
              input: { nodeIds: ['a'], names: ['B'] },
            },
          ],
        },
      },
      {
        type: 'user',
        message: {
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'tu1',
              content: '1 nó(s) renomeado(s).\nresto',
              is_error: false,
            },
          ],
        },
      },
      {
        type: 'user',
        message: {
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'tu2',
              content: [{ type: 'text', text: 'Erro: x' }],
              is_error: true,
            },
          ],
        },
      },
      { type: 'rate_limit_event', rate_limit_info: {} },
      {
        type: 'result',
        subtype: 'success',
        is_error: false,
        result: 'Feito.',
        session_id: 'S1',
        total_cost_usd: 0.01,
      },
    ]);
    expect(ev).toEqual([
      { kind: 'session', sessionId: 'S1' },
      { kind: 'text', text: 'Vou renomear.' },
      { kind: 'tool', id: 'tu1', name: 'rename_nodes', input: { nodeIds: ['a'], names: ['B'] } },
      { kind: 'tool-result', id: 'tu1', ok: true, summary: '1 nó(s) renomeado(s).' },
      { kind: 'tool-result', id: 'tu2', ok: false, summary: 'Erro: x' },
    ]);
    expect(p.result()).toEqual({
      text: 'Feito.',
      sessionId: 'S1',
      costUsd: 0.01,
      isError: false,
      error: undefined,
    });
  });

  it('streaming por deltas não duplica o texto quando chega a mensagem completa', () => {
    const p = new ClaudeStreamParser();
    const delta = (text: string) => ({
      type: 'stream_event',
      event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
    });
    const ev = feed(p, [
      { type: 'stream_event', event: { type: 'message_start', message: { id: 'm1' } } },
      delta('Olá, '),
      delta('mundo'),
      { type: 'assistant', message: { id: 'm1', content: [{ type: 'text', text: 'Olá, mundo' }] } },
      // segunda mensagem do mesmo turno (depois de uma ferramenta): separada por parágrafo
      { type: 'stream_event', event: { type: 'message_start', message: { id: 'm2' } } },
      delta('Pronto.'),
      { type: 'assistant', message: { id: 'm2', content: [{ type: 'text', text: 'Pronto.' }] } },
    ]);
    const text = ev.flatMap((e) => (e.kind === 'text' ? [e.text] : [])).join('');
    expect(text).toBe('Olá, mundo\n\nPronto.');
  });

  it('result com is_error vira erro e linhas inválidas/parciais são ignoradas com log', () => {
    const logs: string[] = [];
    const p = new ClaudeStreamParser((m) => logs.push(m));
    expect(p.parse('')).toEqual([]);
    expect(p.parse('isto não é json')).toEqual([]);
    expect(p.parse('{"type":"assistant","mess')).toEqual([]);
    expect(p.parse('[1,2]')).toEqual([]);
    expect(logs.length).toBe(2);
    p.parse(
      JSON.stringify({
        type: 'result',
        subtype: 'success',
        is_error: true,
        result: 'Not logged in · Please run /login',
        session_id: 'S',
      }),
    );
    expect(p.result()?.isError).toBe(true);
    expect(p.result()?.error).toContain('Not logged in');
    expect(p.lastError()).toContain('Not logged in');
  });

  it('stripMcpPrefix', () => {
    expect(stripMcpPrefix('mcp__mockup-studio__get_screenshot')).toBe('get_screenshot');
    expect(stripMcpPrefix('Bash')).toBe('Bash');
  });
});

describe('CodexStreamParser', () => {
  it('mapeia mensagens, chamadas MCP e turn.completed', () => {
    const p = new CodexStreamParser();
    const ev = feed(p, [
      { type: 'thread.started', thread_id: 'T' },
      { type: 'turn.started' },
      {
        type: 'item.started',
        item: {
          id: 'i1',
          type: 'mcp_tool_call',
          server: 'mockup_studio',
          tool: 'rename_nodes',
          arguments: { nodeIds: ['a'] },
          status: 'in_progress',
        },
      },
      {
        type: 'item.completed',
        item: {
          id: 'i1',
          type: 'mcp_tool_call',
          tool: 'rename_nodes',
          status: 'completed',
          result: { content: [{ type: 'text', text: '1 nó(s) renomeado(s).' }] },
        },
      },
      {
        type: 'item.completed',
        item: {
          id: 'i2',
          type: 'mcp_tool_call',
          tool: 'x',
          status: 'failed',
          error: { message: 'quebrou' },
        },
      },
      { type: 'item.completed', item: { id: 'i3', type: 'agent_message', text: 'Primeira.' } },
      { type: 'item.completed', item: { id: 'i4', type: 'agent_message', text: 'Segunda.' } },
      { type: 'turn.completed', usage: { input_tokens: 1 } },
    ]);
    expect(ev).toEqual([
      { kind: 'tool', id: 'i1', name: 'rename_nodes', input: { nodeIds: ['a'] } },
      { kind: 'tool-result', id: 'i1', ok: true, summary: '1 nó(s) renomeado(s).' },
      { kind: 'tool', id: 'i2', name: 'x', input: undefined },
      { kind: 'tool-result', id: 'i2', ok: false, summary: 'quebrou' },
      { kind: 'text', text: 'Primeira.' },
      { kind: 'text', text: '\n\nSegunda.' },
    ]);
    expect(p.result()).toEqual({ text: 'Segunda.', isError: false });
  });

  it('turn.failed vira erro; error isolado só serve de motivo', () => {
    const p = new CodexStreamParser();
    feed(p, [{ type: 'error', message: 'Reconnecting... 1/5' }]);
    expect(p.result()).toBeUndefined();
    expect(p.lastError()).toBe('Reconnecting... 1/5');
    feed(p, [{ type: 'turn.failed', error: { message: 'não autenticado' } }]);
    expect(p.result()).toMatchObject({ isError: true, error: 'não autenticado' });
  });
});

describe('findExecutable', () => {
  const dirs = 'C:\\a;C:\\b;"C:\\c d"';
  const files = (list: string[]) => (f: string) => list.includes(f);

  it('Windows: prefere .exe a .cmd e respeita o PATHEXT', () => {
    const env = {
      platform: 'win32' as const,
      pathEnv: dirs,
      pathExt: '.COM;.EXE;.BAT;.CMD',
    };
    expect(
      findExecutable('claude', {
        ...env,
        isFile: files(['C:\\a\\claude.cmd', 'C:\\b\\claude.exe']),
      }),
    ).toBe('C:\\b\\claude.exe');
    expect(
      findExecutable('claude', {
        ...env,
        isFile: files(['C:\\a\\claude.cmd', 'C:\\b\\claude.bat']),
      }),
    ).toBe('C:\\a\\claude.cmd');
    expect(findExecutable('claude', { ...env, isFile: files(['C:\\c d\\claude.bat']) })).toBe(
      'C:\\c d\\claude.bat',
    );
    expect(findExecutable('claude', { ...env, isFile: files([]) })).toBeNull();
    // fora do PATHEXT não vale
    expect(
      findExecutable('claude', { ...env, pathExt: '.EXE', isFile: files(['C:\\a\\claude.cmd']) }),
    ).toBeNull();
  });

  it('Windows: nome com extensão e caminho absoluto', () => {
    const env = { platform: 'win32' as const, pathEnv: dirs, pathExt: '.EXE;.CMD' };
    expect(findExecutable('codex.exe', { ...env, isFile: files(['C:\\b\\codex.exe']) })).toBe(
      'C:\\b\\codex.exe',
    );
    expect(findExecutable('C:\\x\\codex', { ...env, isFile: files(['C:\\x\\codex.cmd']) })).toBe(
      'C:\\x\\codex.cmd',
    );
  });

  it('POSIX: primeiro diretório do PATH com o arquivo', () => {
    const env = { platform: 'linux' as const, pathEnv: '/usr/bin:/opt/bin' };
    expect(findExecutable('claude', { ...env, isFile: files(['/opt/bin/claude']) })).toBe(
      '/opt/bin/claude',
    );
    expect(findExecutable('claude', { ...env, isFile: files([]) })).toBeNull();
  });
});

describe('ClaudeCliBackend com a CLI falsa', () => {
  const backend = () => new ClaudeCliBackend({ command: process.execPath, prefixArgs: [FAKE_CLI] });

  it('info() devolve disponibilidade e versão', async () => {
    const info = await backend().info();
    expect(info).toMatchObject({ id: 'claude', available: true });
    expect(info.detail).toContain('fake');
  });

  it('executável inexistente: run() rejeita com mensagem clara', async () => {
    const r = new ClaudeCliBackend({ command: path.join(here, 'nao-existe.exe') }).run(
      { prompt: 'oi' },
      () => undefined,
      new AbortController().signal,
    );
    await expect(r).rejects.toThrow(/Não foi possível iniciar/);
  });

  it('roda um turno sem MCP, emite eventos e devolve o texto e a sessão', async () => {
    const events: AgentRunEvent[] = [];
    const res = await backend().run(
      { prompt: '@@text olá do agente', system: 'SISTEMA' },
      (e) => events.push(e),
      new AbortController().signal,
    );
    expect(res.text).toBe('olá do agente');
    expect(res.sessionId).toMatch(/^fake-/);
    expect(events[0]).toMatchObject({ kind: 'session' });
    expect(events).toContainEqual({ kind: 'text', text: 'olá do agente' });
  });

  it('falha do agente rejeita com a mensagem e o fim do stderr', async () => {
    await expect(
      backend().run(
        { prompt: '@@fail Not logged in' },
        () => undefined,
        new AbortController().signal,
      ),
    ).rejects.toThrow(/Not logged in[\s\S]*logado/);
  });

  it('cancelamento mata o processo e rejeita com AbortError', async () => {
    const ac = new AbortController();
    const t0 = Date.now();
    const p = backend().run({ prompt: '@@sleep 30000' }, () => undefined, ac.signal);
    setTimeout(() => ac.abort(), 400);
    await expect(p).rejects.toMatchObject({ name: 'AbortError' });
    expect(Date.now() - t0).toBeLessThan(10_000);
  });

  it('timeout do turno encerra o processo', async () => {
    const b = new ClaudeCliBackend({
      command: process.execPath,
      prefixArgs: [FAKE_CLI],
      timeoutMs: 500,
    });
    await expect(
      b.run({ prompt: '@@sleep 30000' }, () => undefined, new AbortController().signal),
    ).rejects.toThrow(/tempo limite/);
  });

  it('killTree aceita processo sem pid', () => {
    expect(() => killTree({ pid: undefined } as never)).not.toThrow();
  });
});
