import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { AgentRunEvent } from './backend.js';
import type { AgentRunInput } from './backend.js';
import {
  ClaudeCliBackend,
  ClaudeStreamParser,
  CODEX_DISABLED_FEATURES,
  CodexCliBackend,
  codexIsolationArgs,
  codexTurnServerKey,
  CodexStreamParser,
  findExecutable,
  isValidSessionId,
  killLiveChildren,
  killTree,
  liveChildCount,
  parseCodexFeatures,
  parseCodexMcpList,
  quoteCmdArg,
  stripMcpPrefix,
  type LineParser,
} from './cli.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const FAKE_CLI = path.resolve(here, '../../test/fixtures/fake-agent-cli.mjs');

function feed(p: LineParser, lines: unknown[]): AgentRunEvent[] {
  return lines.flatMap((l) => p.parse(typeof l === 'string' ? l : JSON.stringify(l)));
}

describe('ClaudeStreamParser', () => {
  it('maps init, text, tool, tool result and final result', () => {
    const p = new ClaudeStreamParser();
    const ev = feed(p, [
      { type: 'system', subtype: 'init', session_id: 'S1', tools: [], mcp_servers: [] },
      {
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'Renaming now.' }] },
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
              content: '1 node(s) renamed.\nrest',
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
              content: [{ type: 'text', text: 'Error: x' }],
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
        result: 'Finished.',
        session_id: 'S1',
        total_cost_usd: 0.01,
      },
    ]);
    expect(ev).toEqual([
      { kind: 'session', sessionId: 'S1' },
      { kind: 'text', text: 'Renaming now.' },
      { kind: 'tool', id: 'tu1', name: 'rename_nodes', input: { nodeIds: ['a'], names: ['B'] } },
      { kind: 'tool-result', id: 'tu1', ok: true, summary: '1 node(s) renamed.' },
      { kind: 'tool-result', id: 'tu2', ok: false, summary: 'Error: x' },
    ]);
    expect(p.result()).toEqual({
      text: 'Finished.',
      sessionId: 'S1',
      costUsd: 0.01,
      isError: false,
      error: undefined,
    });
  });

  it('delta streaming does not duplicate the text when the full message arrives', () => {
    const p = new ClaudeStreamParser();
    const delta = (text: string) => ({
      type: 'stream_event',
      event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
    });
    const ev = feed(p, [
      { type: 'stream_event', event: { type: 'message_start', message: { id: 'm1' } } },
      delta('Hello, '),
      delta('world'),
      {
        type: 'assistant',
        message: { id: 'm1', content: [{ type: 'text', text: 'Hello, world' }] },
      },
      // second message of the same turn (after a tool): separated by a paragraph
      { type: 'stream_event', event: { type: 'message_start', message: { id: 'm2' } } },
      delta('Done.'),
      { type: 'assistant', message: { id: 'm2', content: [{ type: 'text', text: 'Done.' }] } },
    ]);
    const text = ev.flatMap((e) => (e.kind === 'text' ? [e.text] : [])).join('');
    expect(text).toBe('Hello, world\n\nDone.');
  });

  it('result with is_error becomes an error and invalid/partial lines are ignored with a log', () => {
    const logs: string[] = [];
    const p = new ClaudeStreamParser((m) => logs.push(m));
    expect(p.parse('')).toEqual([]);
    expect(p.parse('this is not json')).toEqual([]);
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
  it('maps messages, MCP calls and turn.completed', () => {
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
          result: { content: [{ type: 'text', text: '1 node(s) renamed.' }] },
        },
      },
      {
        type: 'item.completed',
        item: {
          id: 'i2',
          type: 'mcp_tool_call',
          tool: 'x',
          status: 'failed',
          error: { message: 'broke' },
        },
      },
      { type: 'item.completed', item: { id: 'i3', type: 'agent_message', text: 'First.' } },
      { type: 'item.completed', item: { id: 'i4', type: 'agent_message', text: 'Second.' } },
      { type: 'turn.completed', usage: { input_tokens: 1 } },
    ]);
    expect(ev).toEqual([
      { kind: 'tool', id: 'i1', name: 'rename_nodes', input: { nodeIds: ['a'] } },
      { kind: 'tool-result', id: 'i1', ok: true, summary: '1 node(s) renamed.' },
      { kind: 'tool', id: 'i2', name: 'x', input: undefined },
      { kind: 'tool-result', id: 'i2', ok: false, summary: 'broke' },
      { kind: 'text', text: 'First.' },
      { kind: 'text', text: '\n\nSecond.' },
    ]);
    expect(p.result()).toEqual({ text: 'Second.', isError: false });
  });

  it('turn.failed becomes an error; a standalone error only serves as the reason', () => {
    const p = new CodexStreamParser();
    feed(p, [{ type: 'error', message: 'Reconnecting... 1/5' }]);
    expect(p.result()).toBeUndefined();
    expect(p.lastError()).toBe('Reconnecting... 1/5');
    feed(p, [{ type: 'turn.failed', error: { message: 'not authenticated' } }]);
    expect(p.result()).toMatchObject({ isError: true, error: 'not authenticated' });
  });
});

describe('findExecutable', () => {
  const dirs = 'C:\\a;C:\\b;"C:\\c d"';
  const files = (list: string[]) => (f: string) => list.includes(f);

  it('Windows: prefers .exe over .cmd and honors PATHEXT', () => {
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
    // outside PATHEXT does not count
    expect(
      findExecutable('claude', { ...env, pathExt: '.EXE', isFile: files(['C:\\a\\claude.cmd']) }),
    ).toBeNull();
  });

  it('Windows: name with extension and absolute path', () => {
    const env = { platform: 'win32' as const, pathEnv: dirs, pathExt: '.EXE;.CMD' };
    expect(findExecutable('codex.exe', { ...env, isFile: files(['C:\\b\\codex.exe']) })).toBe(
      'C:\\b\\codex.exe',
    );
    expect(findExecutable('C:\\x\\codex', { ...env, isFile: files(['C:\\x\\codex.cmd']) })).toBe(
      'C:\\x\\codex.cmd',
    );
  });

  it('POSIX: first PATH directory containing the file', () => {
    const env = { platform: 'linux' as const, pathEnv: '/usr/bin:/opt/bin' };
    expect(findExecutable('claude', { ...env, isFile: files(['/opt/bin/claude']) })).toBe(
      '/opt/bin/claude',
    );
    expect(findExecutable('claude', { ...env, isFile: files([]) })).toBeNull();
  });
});

describe('ClaudeCliBackend with the fake CLI', () => {
  const backend = () => new ClaudeCliBackend({ command: process.execPath, prefixArgs: [FAKE_CLI] });

  it('info() returns availability and version', async () => {
    const info = await backend().info();
    expect(info).toMatchObject({ id: 'claude', available: true });
    expect(info.detail).toContain('fake');
  });

  it('missing executable: run() rejects with a clear message', async () => {
    const r = new ClaudeCliBackend({ command: path.join(here, 'does-not-exist.exe') }).run(
      { prompt: 'hi' },
      () => undefined,
      new AbortController().signal,
    );
    await expect(r).rejects.toThrow(/Could not start/);
  });

  it('runs a turn without MCP, emits events and returns the text and the session', async () => {
    const events: AgentRunEvent[] = [];
    const res = await backend().run(
      { prompt: '@@text hello from the agent', system: 'SYSTEM' },
      (e) => events.push(e),
      new AbortController().signal,
    );
    expect(res.text).toBe('hello from the agent');
    expect(res.sessionId).toMatch(/^fake-/);
    expect(events[0]).toMatchObject({ kind: 'session' });
    expect(events).toContainEqual({ kind: 'text', text: 'hello from the agent' });
  });

  it('agent failure rejects with the message and the end of stderr', async () => {
    await expect(
      backend().run(
        { prompt: '@@fail Not logged in' },
        () => undefined,
        new AbortController().signal,
      ),
    ).rejects.toThrow(/Not logged in[\s\S]*signed in/);
  });

  it('cancellation kills the process and rejects with AbortError', async () => {
    const ac = new AbortController();
    const t0 = Date.now();
    const p = backend().run({ prompt: '@@sleep 30000' }, () => undefined, ac.signal);
    setTimeout(() => ac.abort(), 400);
    await expect(p).rejects.toMatchObject({ name: 'AbortError' });
    expect(Date.now() - t0).toBeLessThan(10_000);
  });

  it('turn timeout terminates the process', async () => {
    const b = new ClaudeCliBackend({
      command: process.execPath,
      prefixArgs: [FAKE_CLI],
      timeoutMs: 500,
    });
    await expect(
      b.run({ prompt: '@@sleep 30000' }, () => undefined, new AbortController().signal),
    ).rejects.toThrow(/time limit/);
  });

  it('killTree accepts a process without a pid', () => {
    expect(() => killTree({ pid: undefined } as never)).not.toThrow();
  });
});

describe('quoteCmdArg', () => {
  it('rejects %, quotes and line breaks (cannot be safely quoted in a .cmd)', () => {
    expect(() => quoteCmdArg('a%PATH%b')).toThrow(/Unsupported argument/);
    expect(() => quoteCmdArg('say "hi"')).toThrow(/Unsupported argument/);
    expect(() => quoteCmdArg('a\nb')).toThrow(/Unsupported argument/);
    expect(() => quoteCmdArg('a\rb')).toThrow(/Unsupported argument/);
  });

  it('quotes only what needs it', () => {
    expect(quoteCmdArg('simple')).toBe('simple');
    expect(quoteCmdArg('')).toBe('""');
    expect(quoteCmdArg('C:\\Program Files\\x')).toBe('"C:\\Program Files\\x"');
    expect(quoteCmdArg('a&b')).toBe('"a&b"');
    expect(quoteCmdArg('mcp_servers.x.url=http://h/mcp?turn=ab')).toBe(
      '"mcp_servers.x.url=http://h/mcp?turn=ab"',
    );
  });
});

describe('isValidSessionId and --resume', () => {
  it('accepts only [A-Za-z0-9_-]{1,128} not starting with a hyphen', () => {
    for (const ok of ['abc', 'a-b_C9', '0f8fad5b-d9cb-469f-a165-70867728950e', 'x'.repeat(128)]) {
      expect(isValidSessionId(ok)).toBe(true);
    }
    for (const bad of [
      '',
      'x'.repeat(129),
      '--settings={"a":1}',
      '-x',
      'a b',
      'a=b',
      'a;b',
      '../x',
      42,
      null,
      undefined,
    ]) {
      expect(isValidSessionId(bad)).toBe(false);
    }
  });

  class Peek extends ClaudeCliBackend {
    peek(input: AgentRunInput, dir: string) {
      return Promise.resolve(this.plan(input, dir, dir));
    }
  }

  it('Claude: --resume=<id> is a single argument; an invalid id does not even reach the args', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mockup-cli-test-'));
    try {
      const b = new Peek({ command: process.execPath });
      const good = (await b.peek({ prompt: 'x', resumeSession: 'abc-123' }, dir)).args;
      expect(good).toContain('--resume=abc-123');
      expect(good).not.toContain('--resume');
      for (const evil of ['--settings={"hooks":{}}', '--dangerously-skip-permissions', 'a b']) {
        const args = (await b.peek({ prompt: 'x', resumeSession: evil }, dir)).args;
        expect(args.some((a) => a.includes('--resume'))).toBe(false);
        expect(args.join(' ')).not.toContain(evil);
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('with the fake CLI: the resume reaches the CLI as --resume=<id>', async () => {
    const b = new ClaudeCliBackend({ command: process.execPath, prefixArgs: [FAKE_CLI] });
    const res = await b.run(
      { prompt: '@@echo', resumeSession: 'sess-42' },
      () => undefined,
      new AbortController().signal,
    );
    expect(res.text).toContain('ECHO-RESUME: sess-42');
    expect(res.text).toContain('"--resume=sess-42"');
  });
});

describe('Codex isolation', () => {
  it('parseCodexMcpList: server names; garbage becomes an empty list', () => {
    expect(
      parseCodexMcpList(
        JSON.stringify([{ name: 'mockup-studio', enabled: true }, { name: 'other' }, { x: 1 }, 3]),
      ),
    ).toEqual(['mockup-studio', 'other']);
    expect(parseCodexMcpList('not json')).toEqual([]);
    expect(parseCodexMcpList('{"name":"x"}')).toEqual([]);
    expect(parseCodexMcpList('[]')).toEqual([]);
  });

  it('parseCodexFeatures: names, without the removed ones', () => {
    const out = [
      'apps                                     stable             true',
      'shell_tool                               stable             true',
      'apply_patch_freeform                     removed            false',
      'goals                                    under development  false',
      '',
      'Error: garbage with spaces',
    ].join('\r\n');
    expect(parseCodexFeatures(out)).toEqual(['apps', 'shell_tool', 'goals']);
  });

  it('codexIsolationArgs: -c enabled=false per server and --disable only for existing features', () => {
    const logs: string[] = [];
    const args = codexIsolationArgs(
      {
        servers: ['mockup-studio', 'github', 'with.dot', 'with space'],
        features: ['shell_tool', 'apps', 'goals', 'browser_use'],
      },
      (m) => logs.push(m),
    );
    expect(args).toEqual([
      '-c',
      'mcp_servers.mockup-studio.enabled=false',
      '-c',
      'mcp_servers.github.enabled=false',
      '--disable',
      'shell_tool',
      '--disable',
      'apps',
      '--disable',
      'browser_use',
    ]);
    expect(logs).toHaveLength(2); // names that cannot be turned off are logged
    expect(CODEX_DISABLED_FEATURES).toEqual([
      'shell_tool',
      'unified_exec',
      'apps',
      'browser_use',
      'computer_use',
      'in_app_browser',
    ]);
    expect(codexIsolationArgs({ servers: [], features: [] })).toEqual([]);
  });

  it('codexTurnServerKey does not collide with a user server', () => {
    expect(codexTurnServerKey('mockup-studio', ['mockup-studio'])).toBe('mockup_studio');
    expect(codexTurnServerKey('mockup-studio', ['mockup_studio'])).toBe('mockup_studio_turn');
  });

  class Peek extends CodexCliBackend {
    peek(input: AgentRunInput, dir: string) {
      return this.plan(input, dir, dir);
    }
  }
  const mcp = { name: 'mockup-studio', url: 'http://127.0.0.1:1/mcp?turn=tok' };
  const quiet = () => undefined;

  it('plan: turns off the user MCPs and features, keeps read-only and only the turn MCP', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mockup-cli-test-'));
    try {
      const b = new Peek({
        command: process.execPath,
        log: quiet,
        listMcpServers: () => Promise.resolve(['mockup-studio', 'mockup_studio', 'github']),
        listFeatures: () => Promise.resolve(['shell_tool', 'unified_exec', 'apps', 'goals']),
      });
      const { args } = await b.peek({ prompt: 'x', mcp, model: 'gpt-5' }, dir);
      expect(args.slice(0, 1)).toEqual(['exec']);
      expect(args[args.indexOf('-s') + 1]).toBe('read-only');
      expect(args).toContain('mcp_servers.mockup-studio.enabled=false');
      expect(args).toContain('mcp_servers.mockup_studio.enabled=false');
      expect(args).toContain('mcp_servers.github.enabled=false');
      // the turn server uses a key that does not collide with the user's
      expect(args).toContain('mcp_servers.mockup_studio_turn.url=' + mcp.url);
      expect(args).toContain('mcp_servers.mockup_studio_turn.default_tools_approval_mode=approve');
      expect(args.filter((a) => a === '--disable')).toHaveLength(3);
      for (const f of ['shell_tool', 'unified_exec', 'apps']) {
        expect(args[args.indexOf(f) - 1]).toBe('--disable');
      }
      expect(args).not.toContain('goals');
      // text-only turn: also isolated, with no turn server
      const text = (await b.peek({ prompt: 'x' }, dir)).args;
      expect(text).toContain('mcp_servers.github.enabled=false');
      expect(text.some((a) => a.includes('.url='))).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a listing failure becomes an empty list (no isolation), is not cached and a success is cached', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mockup-cli-test-'));
    try {
      let mcpCalls = 0;
      let failing = true;
      const b = new Peek({
        command: process.execPath,
        log: quiet,
        listMcpServers: () => {
          mcpCalls++;
          return failing
            ? Promise.reject(new Error('codex vanished'))
            : Promise.resolve(['github']);
        },
        listFeatures: () => Promise.resolve(['shell_tool']),
      });
      const a1 = (await b.peek({ prompt: 'x', mcp }, dir)).args;
      expect(a1.some((a) => a.endsWith('.enabled=false'))).toBe(false);
      expect(a1).toContain('--disable'); // listed features still apply
      failing = false;
      const a2 = (await b.peek({ prompt: 'x', mcp }, dir)).args;
      expect(a2).toContain('mcp_servers.github.enabled=false'); // the previous failure was not cached
      await b.peek({ prompt: 'x', mcp }, dir);
      await b.peek({ prompt: 'x', mcp }, dir);
      expect(mcpCalls).toBe(2); // 1 failure + 1 success; the rest comes from the cache
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('live children and daemon exit', () => {
  it('tracks the child, installs/removes the exit listener and killLiveChildren kills them', async () => {
    const before = process.listenerCount('exit');
    expect(liveChildCount()).toBe(0);
    const b = new ClaudeCliBackend({ command: process.execPath, prefixArgs: [FAKE_CLI] });
    const p = b.run({ prompt: '@@sleep 30000' }, () => undefined, new AbortController().signal);
    const outcome = p.then(
      () => 'ok',
      (e: unknown) => (e instanceof Error ? e.message : String(e)),
    );
    const t0 = Date.now();
    while (liveChildCount() === 0) {
      if (Date.now() - t0 > 10_000) throw new Error('the child was not registered');
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(process.listenerCount('exit')).toBe(before + 1);
    killLiveChildren();
    expect(await outcome).not.toBe('ok');
    const t1 = Date.now();
    while (liveChildCount() > 0 && Date.now() - t1 < 5000) {
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(liveChildCount()).toBe(0);
    expect(process.listenerCount('exit')).toBe(before);
  });

  it('killLiveChildren with no children does nothing', () => {
    expect(() => killLiveChildren()).not.toThrow();
  });
});
