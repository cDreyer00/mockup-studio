import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import WebSocket from 'ws';
import {
  createDocument,
  createNodeFromTag,
  findNode,
  serializeDocument,
  type AssistantEvent,
  type AssistantMessage,
  type Node,
} from '@mockup/core';
import { startDaemon, type DaemonHandle } from '../index.js';
import type { RenderProvider } from '../render.js';
import { DocumentStore } from '../store.js';
import { AssistantService, assistantSidecarPath } from './assistant.js';
import type { AgentBackend, AgentRunEvent, AgentRunInput, AgentRunResult } from './backend.js';
import { ClaudeCliBackend } from './cli.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const FAKE_CLI = path.resolve(here, '../../test/fixtures/fake-agent-cli.mjs');

interface Work {
  dir: string;
  dataDir: string;
  file: string;
  frameId: string;
  ids: string[];
  cleanup(): void;
}

/** Document with one frame and 3 children (a, b, c). */
function makeWork(): Work {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mockup-assist-'));
  const dataDir = path.join(dir, 'data');
  fs.mkdirSync(dataDir);
  const kids: Node[] = ['A', 'B', 'C'].map((n) =>
    createNodeFromTag('div', { name: `Box ${n}`, styles: { width: '100px', height: '40px' } }),
  );
  const frame = createNodeFromTag('div', {
    isRoot: true,
    name: 'Desktop',
    styles: { width: '800px', height: '600px', background: '#ffffff' },
    position: { x: 0, y: 0 },
    children: kids,
  });
  const doc = createDocument('Test');
  doc.pages[0]!.frames.push(frame);
  const file = path.join(dir, 'test.mockup.json');
  fs.writeFileSync(file, serializeDocument(doc), 'utf8');
  return {
    dir,
    dataDir,
    file,
    frameId: frame.id,
    ids: kids.map((k) => k.id),
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}

interface MemBackend extends AgentBackend {
  calls: AgentRunInput[];
}

function memBackend(
  run: (
    input: AgentRunInput,
    emit: (e: AgentRunEvent) => void,
    signal: AbortSignal,
  ) => Promise<AgentRunResult>,
  opts: { id?: string; available?: boolean } = {},
): MemBackend {
  const calls: AgentRunInput[] = [];
  const id = opts.id ?? 'fake';
  return {
    id,
    name: `Fake ${id}`,
    calls,
    info: () =>
      Promise.resolve({
        id,
        name: `Fake ${id}`,
        available: opts.available ?? true,
        ...(opts.available === false ? { detail: 'not installed' } : {}),
      }),
    run: (input, emit, signal) => {
      calls.push(input);
      return run(input, emit, signal);
    },
  };
}

function abortable(signal: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    const onAbort = () => reject(Object.assign(new Error('cancelled'), { name: 'AbortError' }));
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  });
}

function collect(svc: AssistantService, docId: string): AssistantEvent[] {
  const events: AssistantEvent[] = [];
  svc.onEvent((d, e) => {
    if (d === docId) events.push(e);
  });
  return events;
}

describe('AssistantService (in-memory backend)', () => {
  let w: Work;
  let store: DocumentStore;
  let docId: string;

  beforeEach(async () => {
    w = makeWork();
    store = new DocumentStore({ dataDir: w.dataDir });
    docId = (await store.open(w.file)).docId;
  });
  afterEach(async () => {
    await store.closeAll();
    w.cleanup();
  });

  const svcWith = (backends: AgentBackend[], extra: { render?: RenderProvider } = {}) =>
    new AssistantService(store, {
      dataDir: w.dataDir,
      getPort: () => 4747,
      backends,
      ...extra,
    });

  it('turn: events in order, final message and context with the selection', async () => {
    const be = memBackend((_input, emit) => {
      emit({ kind: 'session', sessionId: 'S1' });
      emit({ kind: 'text', text: 'Going to ' });
      emit({ kind: 'text', text: 'rename.' });
      emit({ kind: 'tool', id: 't1', name: 'rename_nodes', input: { nodeIds: ['x'] } });
      emit({ kind: 'tool-result', id: 't1', ok: true, summary: 'ok' });
      return Promise.resolve({ text: 'Renamed everything.', sessionId: 'S1' });
    });
    const svc = svcWith([be]);
    const events = collect(svc, docId);
    store.setSelection(docId, [w.ids[0]!, w.ids[1]!], 'editor');

    const msg = await svc.runTurn(docId, 'Rename the boxes', { instructions: 'EXTRA-INSTR' });

    expect(events.map((e) => e.kind)).toEqual([
      'turn-start',
      'text',
      'text',
      'tool',
      'tool-result',
      'turn-end',
    ]);
    const start = events[0] as Extract<AssistantEvent, { kind: 'turn-start' }>;
    expect(start.user).toMatchObject({
      role: 'user',
      text: 'Rename the boxes',
      selection: [w.ids[0], w.ids[1]],
    });
    expect(start.backend).toBe('fake');
    expect(msg).toMatchObject({
      role: 'assistant',
      text: 'Renamed everything.',
      status: 'done',
      backend: 'fake',
      opsCount: 0,
    });
    expect(msg.tools).toEqual([
      { id: 't1', name: 'rename_nodes', input: { nodeIds: ['x'] }, ok: true, summary: 'ok' },
    ]);
    expect((events[5] as { message: AssistantMessage }).message).toEqual(msg);

    const input = be.calls[0]!;
    expect(input.mcp?.name).toBe('mockup-studio');
    expect(input.mcp?.url).toMatch(/^http:\/\/127\.0\.0\.1:4747\/mcp\?turn=[0-9a-f]{32}$/);
    expect(input.prompt).toContain(`docId: ${docId}`);
    expect(input.prompt).toContain(`Selection: ${w.ids[0]}, ${w.ids[1]}`);
    expect(input.prompt).toContain('Box A');
    expect(input.prompt).not.toContain('Box C');
    expect(input.prompt).toContain('Rename the boxes');
    expect(input.system).toContain('EXTRA-INSTR');
    expect(input.system).toContain(docId);
    expect(input.cwd).toBeTruthy();
    expect(await svc.history(docId)).toHaveLength(2);
  });

  it('without a selection it lists the frames; with a render it attaches the screenshot and tolerates its failure', async () => {
    const captured: unknown[] = [];
    let fail = false;
    const render: RenderProvider = {
      capture: (req) => {
        captured.push({ nodeId: req.nodeId, scale: req.scale, maxWidth: req.maxWidth });
        if (fail) return Promise.reject(new Error('no render'));
        return Promise.resolve({
          data: Buffer.from('PNG'),
          mime: 'image/png',
          width: 1,
          height: 1,
          pixelWidth: 1,
          pixelHeight: 1,
        });
      },
      measure: () => Promise.reject(new Error('n/a')),
    };
    const be = memBackend(() => Promise.resolve({ text: 'ok' }));
    const svc = svcWith([be], { render });
    await svc.runTurn(docId, 'hi');
    expect(be.calls[0]!.prompt).toContain('Selection: (none)');
    expect(be.calls[0]!.prompt).toContain('Desktop');
    expect(be.calls[0]!.images).toEqual([
      { mime: 'image/png', data: Buffer.from('PNG').toString('base64') },
    ]);
    expect(captured[0]).toEqual({ nodeId: w.frameId, scale: 1, maxWidth: 1024 });

    fail = true;
    store.setSelection(docId, [w.ids[2]!], 'editor');
    const m = await svc.runTurn(docId, 'again');
    expect(m.status).toBe('done');
    expect(be.calls[1]!.images).toEqual([]);
    expect(captured[1]).toMatchObject({ nodeId: w.ids[2] });
  });

  it('resolveTurn is valid during the turn and becomes null afterwards; closes the group', async () => {
    let urlToken = '';
    let binding: unknown;
    const svc: AssistantService = svcWith([
      memBackend((input) => {
        urlToken = new URL(input.mcp!.url).searchParams.get('turn')!;
        binding = svc.resolveTurn(urlToken);
        // two applications of the same group become one undo entry
        const g = (binding as { group: string }).group;
        store.applyOps(
          docId,
          [{ type: 'renameNodes', changes: [{ nodeId: w.ids[0]!, name: 'X1' }] }],
          { source: 'mcp', group: g },
        );
        store.applyOps(
          docId,
          [{ type: 'renameNodes', changes: [{ nodeId: w.ids[1]!, name: 'X2' }] }],
          { source: 'mcp', group: g },
        );
        return Promise.resolve({ text: 'ok' });
      }),
    ]);
    const msg = await svc.runTurn(docId, 'x');
    expect(binding).toMatchObject({ docId, group: expect.stringMatching(/^assistant:turn_/) });
    expect(svc.resolveTurn(urlToken)).toBeNull();
    expect(msg.opsCount).toBe(2);
    // one undo reverts both
    store.undo(docId, 'editor');
    expect(findNode(store.get(docId), w.ids[0]!)!.node.name).toBe('Box A');
    expect(findNode(store.get(docId), w.ids[1]!)!.node.name).toBe('Box B');
  });

  it('a second concurrent send is rejected; cancel produces a cancelled turn', async () => {
    const be = memBackend((_i, emit, signal) => {
      emit({ kind: 'text', text: 'partial' });
      return abortable(signal);
    });
    const svc = svcWith([be]);
    const events = collect(svc, docId);
    const { turnId } = await svc.send(docId, 'long');
    await expect(svc.send(docId, 'other')).rejects.toThrow(/in progress/);
    expect(svc.cancel(docId)).toBe(true);
    await svc.close();
    const end = events.find((e) => e.kind === 'turn-end') as Extract<
      AssistantEvent,
      { kind: 'turn-end' }
    >;
    expect(end.turnId).toBe(turnId);
    expect(end.message).toMatchObject({ status: 'cancelled', text: 'partial' });
    expect(svc.cancel(docId)).toBe(false);
    await expect(svc.send(docId, 'after closing')).rejects.toThrow(/shut down/);
  });

  it('a backend error becomes status error with the message', async () => {
    const svc = svcWith([memBackend(() => Promise.reject(new Error('CLI not signed in')))]);
    const m = await svc.runTurn(docId, 'hi');
    expect(m).toMatchObject({ status: 'error', error: 'CLI not signed in' });
    expect(svc.resolveTurn('any')).toBeNull();
    // the document is free for another turn
    await expect(svc.runTurn(docId, 'again')).resolves.toMatchObject({ status: 'error' });
  });

  it('the backend session is reused (resume) and, if it fails, retried without resume', async () => {
    let n = 0;
    const be = memBackend((input) => {
      n++;
      if (n === 3 && input.resumeSession)
        return Promise.reject(new Error('session does not exist'));
      return Promise.resolve({ text: `r${n}`, sessionId: `S${n}` });
    });
    const svc = svcWith([be]);
    await svc.runTurn(docId, 'one');
    await svc.runTurn(docId, 'two');
    expect(be.calls[0]!.resumeSession).toBeUndefined();
    expect(be.calls[1]!.resumeSession).toBe('S1');
    // without resume (no session), the recent history goes summarized in the prompt
    expect(be.calls[0]!.prompt).not.toContain('Previous conversation');
    await svc.runTurn(docId, 'three');
    expect(be.calls.map((c) => c.resumeSession)).toEqual([undefined, 'S1', 'S2', undefined]);
    expect(be.calls[3]!.prompt).toContain('Previous conversation');
    expect(be.calls[3]!.prompt).toContain('one');
  });

  it('a failed resume with text or tool already emitted does not redo the turn', async () => {
    let n = 0;
    const be = memBackend((_input, emit) => {
      n++;
      if (n === 1) return Promise.resolve({ text: 'r1', sessionId: 'S1' });
      emit({ kind: 'text', text: 'already said' });
      return Promise.reject(new Error('broke midway'));
    });
    const svc = svcWith([be]);
    await svc.runTurn(docId, 'one');
    const m = await svc.runTurn(docId, 'two');
    expect(m).toMatchObject({ status: 'error', error: 'broke midway' });
    expect(be.calls).toHaveLength(2); // no second attempt
    expect(be.calls[1]!.resumeSession).toBe('S1');
  });

  it('no backend available: clear error; unknown id; auto picks the first available', async () => {
    const off = memBackend(() => Promise.resolve({ text: '' }), { id: 'claude', available: false });
    const on = memBackend(() => Promise.resolve({ text: 'from codex' }), { id: 'codex' });
    await expect(svcWith([off]).runTurn(docId, 'hi')).rejects.toThrow(
      /No AI agent available[\s\S]*Claude Code[\s\S]*Codex/,
    );
    const svc = svcWith([off, on]);
    expect((await svc.runTurn(docId, 'hi')).backend).toBe('codex');
    await expect(svc.runTurn(docId, 'hi', { backend: 'xyz' })).rejects.toThrow(/[Uu]nknown/);
    await expect(svc.runTurn(docId, 'hi', { backend: 'claude' })).rejects.toThrow(/unavailable/);
    // the document does not get stuck after a backend error
    expect((await svc.runTurn(docId, 'hi')).status).toBe('done');
  });

  it('configuration persisted in assistant.json and validated', async () => {
    const a = memBackend(() => Promise.resolve({ text: '' }), { id: 'claude' });
    const b = memBackend(() => Promise.resolve({ text: 'cx' }), { id: 'codex' });
    const svc = svcWith([a, b]);
    expect(svc.getConfig()).toEqual({ backend: 'auto' });
    const r = (await svc.handle({
      type: 'assistant:config',
      reqId: '1',
      config: { backend: 'codex', model: ' gpt-5 ' },
    })) as { config: unknown; backends: Array<{ id: string }> };
    expect(r.config).toEqual({ backend: 'codex', model: 'gpt-5', models: { codex: 'gpt-5' } });
    expect(r.backends.map((x) => x.id)).toEqual(['claude', 'codex']);
    expect(JSON.parse(fs.readFileSync(path.join(w.dataDir, 'assistant.json'), 'utf8'))).toEqual({
      backend: 'codex',
      models: { codex: 'gpt-5' },
    });
    await expect(
      svc.handle({ type: 'assistant:config', reqId: '2', config: { backend: 'nothing' } }),
    ).rejects.toThrow(/[Uu]nknown/);
    await expect(
      svc.handle({ type: 'assistant:config', reqId: '3', config: { model: 'a b;c' } }),
    ).rejects.toThrow(/[Ii]nvalid/);
    // a new service reads the file; the model goes to the turn's backend
    const svc2 = svcWith([a, b]);
    expect(svc2.getConfig()).toEqual({
      backend: 'codex',
      model: 'gpt-5',
      models: { codex: 'gpt-5' },
    });
    await svc2.runTurn(docId, 'hi');
    expect(b.calls[0]!.model).toBe('gpt-5');
    // clear the model
    await svc2.handle({ type: 'assistant:config', reqId: '4', config: { model: '' } });
    expect(svc2.getConfig()).toEqual({ backend: 'codex' });
  });

  it('model per backend: the claude one does not go to codex in auto; models and the model shortcut', async () => {
    const claude = memBackend(() => Promise.reject(new Error('offline')), {
      id: 'claude',
      available: false,
    });
    const codex = memBackend(() => Promise.resolve({ text: 'cx' }), { id: 'codex' });
    const svc = svcWith([claude, codex]);
    await svc.handle({
      type: 'assistant:config',
      reqId: '1',
      config: { models: { claude: 'opus', codex: 'gpt-5' } },
    });
    expect(svc.getConfig()).toEqual({
      backend: 'auto',
      models: { claude: 'opus', codex: 'gpt-5' },
    });
    await svc.runTurn(docId, 'hi'); // auto → codex (claude unavailable)
    expect(codex.calls[0]!.model).toBe('gpt-5');
    // no model for the chosen backend: CLI default, never another backend's
    await svc.handle({ type: 'assistant:config', reqId: '2', config: { models: { codex: '' } } });
    await svc.runTurn(docId, 'again');
    expect(codex.calls[1]!.model).toBeUndefined();
    // with backend auto, the model shortcut does not say which backend it applies to
    await expect(
      svc.handle({ type: 'assistant:config', reqId: '3', config: { model: 'x' } }),
    ).rejects.toThrow(/auto/);
    await expect(
      svc.handle({ type: 'assistant:config', reqId: '4', config: { models: { nothing: 'x' } } }),
    ).rejects.toThrow(/[Uu]nknown/);
    // the shortcut applies to the backend of the same patch
    await svc.handle({
      type: 'assistant:config',
      reqId: '5',
      config: { backend: 'claude', model: 'sonnet' },
    });
    expect(svc.getConfig()).toEqual({
      backend: 'claude',
      model: 'sonnet',
      models: { claude: 'sonnet' },
    });
  });

  it('old assistant.json with a single model: applies to the configured backend (or claude in auto)', () => {
    const a = memBackend(() => Promise.resolve({ text: '' }), { id: 'claude' });
    const b = memBackend(() => Promise.resolve({ text: '' }), { id: 'codex' });
    const file = path.join(w.dataDir, 'assistant.json');
    fs.writeFileSync(file, JSON.stringify({ backend: 'codex', model: 'gpt-5' }));
    expect(svcWith([a, b]).getConfig()).toEqual({
      backend: 'codex',
      model: 'gpt-5',
      models: { codex: 'gpt-5' },
    });
    fs.writeFileSync(file, JSON.stringify({ backend: 'auto', model: 'opus' }));
    expect(svcWith([a, b]).getConfig()).toEqual({ backend: 'auto', models: { claude: 'opus' } });
  });

  it('history in a sidecar file, reloaded by a new service; clear deletes it', async () => {
    const be = memBackend((_i, emit) => {
      emit({ kind: 'session', sessionId: 'SESS' });
      return Promise.resolve({ text: 'reply', sessionId: 'SESS' });
    });
    const svc = svcWith([be]);
    await svc.runTurn(docId, 'first');
    await svc.runTurn(docId, 'ephemeral', { ephemeral: true });

    const side = assistantSidecarPath(w.file);
    expect(side).toBe(path.join(w.dir, 'test.assistant.json'));
    const saved = JSON.parse(fs.readFileSync(side, 'utf8')) as {
      version: number;
      messages: AssistantMessage[];
      sessions: Record<string, string>;
    };
    expect(saved.version).toBe(1);
    expect(saved.messages.map((m) => [m.role, m.text])).toEqual([
      ['user', 'first'],
      ['assistant', 'reply'],
    ]);
    expect(saved.sessions).toEqual({ fake: 'SESS' });

    const be2 = memBackend(() => Promise.resolve({ text: 'second' }));
    const svc2 = svcWith([be2]);
    const events2 = collect(svc2, docId);
    const hist = (await svc2.handle({
      type: 'assistant:history',
      reqId: 'h',
      docId,
    })) as {
      messages: AssistantMessage[];
      running: string | null;
      backends: unknown[];
      config: unknown;
    };
    expect(hist.messages).toHaveLength(2);
    expect(hist.running).toBeNull();
    expect(hist.backends).toHaveLength(1);
    // the persisted session comes back too
    await svc2.runTurn(docId, 'continue');
    expect(be2.calls[0]!.resumeSession).toBe('SESS');
    expect(await svc2.history(docId)).toHaveLength(4);

    await svc2.handle({ type: 'assistant:clear', reqId: 'c', docId });
    expect(await svc2.history(docId)).toEqual([]);
    expect(fs.existsSync(side)).toBe(false);
    expect(events2.at(-1)?.kind).toBe('cleared');
  });

  it('malicious/invalid sessionId in the sidecar file never reaches the backend', async () => {
    const side = assistantSidecarPath(w.file);
    const bad: unknown[] = [
      '--settings={"hooks":{"x":1}}',
      '--dangerously-skip-permissions',
      'a b',
      'x'.repeat(129),
      '',
      '../../etc',
      'ok;rm',
      42,
      null,
    ];
    for (const value of bad) {
      fs.writeFileSync(
        side,
        JSON.stringify({ version: 1, messages: [], sessions: { fake: value } }),
        'utf8',
      );
      const be = memBackend(() => Promise.resolve({ text: 'ok' }));
      await svcWith([be]).runTurn(docId, 'hi', { ephemeral: true });
      expect(be.calls[0]!.resumeSession).toBeUndefined();
    }
    // a valid one still works
    fs.writeFileSync(
      side,
      JSON.stringify({ version: 1, messages: [], sessions: { fake: 'abc-DEF_123' } }),
    );
    const ok = memBackend(() => Promise.resolve({ text: 'ok' }));
    await svcWith([ok]).runTurn(docId, 'hi', { ephemeral: true });
    expect(ok.calls[0]!.resumeSession).toBe('abc-DEF_123');
    // sessions that is not an object is also discarded without error
    fs.writeFileSync(side, JSON.stringify({ version: 1, messages: [], sessions: ['--x'] }));
    const arr = memBackend(() => Promise.resolve({ text: 'ok' }));
    await svcWith([arr]).runTurn(docId, 'hi', { ephemeral: true });
    expect(arr.calls[0]!.resumeSession).toBeUndefined();
  });

  it('an invalid session event (or result sessionId) is ignored and not saved', async () => {
    const be = memBackend((_i, emit) => {
      emit({ kind: 'session', sessionId: '--settings=x' });
      return Promise.resolve({ text: 'ok', sessionId: '--model evil' });
    });
    const svc = svcWith([be]);
    await svc.runTurn(docId, 'one');
    await svc.runTurn(docId, 'two');
    expect(be.calls[1]!.resumeSession).toBeUndefined();
    const saved = JSON.parse(fs.readFileSync(assistantSidecarPath(w.file), 'utf8')) as {
      sessions: Record<string, string>;
    };
    expect(saved.sessions).toEqual({});
    // a valid event after the invalid one counts
    const be2 = memBackend((_i, emit) => {
      emit({ kind: 'session', sessionId: '--x' });
      emit({ kind: 'session', sessionId: 'GOOD-1' });
      return Promise.resolve({ text: 'ok' });
    });
    const svc2 = svcWith([be2]);
    await svc2.runTurn(docId, 'three');
    await svc2.runTurn(docId, 'four');
    expect(be2.calls[1]!.resumeSession).toBe('GOOD-1');
  });

  it('sidecar file name does not collide between a.json and a.mockup.json', () => {
    const p = (n: string) => assistantSidecarPath(path.join('x', n));
    expect(p('a.mockup.json')).toBe(path.join('x', 'a.assistant.json'));
    expect(p('a.json')).toBe(path.join('x', 'a.json.assistant.json'));
    expect(p('a.MOCKUP.JSON')).toBe(path.join('x', 'a.assistant.json'));
    expect(p('noext')).toBe(path.join('x', 'noext.assistant.json'));
  });

  it('history writes: unique temp file, one at a time per file, no leftovers', async () => {
    const be = memBackend(() => Promise.resolve({ text: 'r' }));
    const svc = svcWith([be]);
    await svc.runTurn(docId, 'one');
    const tmps: string[] = [];
    let inFlight = 0;
    let maxInFlight = 0;
    const realWrite = fs.promises.writeFile.bind(fs.promises);
    const spy = vi.spyOn(fs.promises, 'writeFile').mockImplementation(async (...args) => {
      tmps.push(String(args[0]));
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 15));
      try {
        return await realWrite(...(args as Parameters<typeof realWrite>));
      } finally {
        inFlight--;
      }
    });
    try {
      const persist = (svc as unknown as { persist(id: string): Promise<void> }).persist.bind(svc);
      await Promise.all([1, 2, 3, 4, 5].map(() => persist(docId)));
    } finally {
      spy.mockRestore();
    }
    expect(tmps).toHaveLength(5);
    expect(new Set(tmps).size).toBe(5);
    expect(tmps.every((t) => t.endsWith('.tmp'))).toBe(true);
    expect(maxInFlight).toBe(1);
    expect(fs.readdirSync(w.dir).filter((n) => n.endsWith('.tmp'))).toEqual([]);
    JSON.parse(fs.readFileSync(assistantSidecarPath(w.file), 'utf8'));
  });

  it('a document open under the sidecar file name is not overwritten by the history', async () => {
    const other = path.join(w.dir, 'test.assistant.json'); // = sidecar of test.mockup.json
    fs.writeFileSync(other, serializeDocument(createDocument('Other')), 'utf8');
    const before = fs.readFileSync(other, 'utf8');
    await store.open(other);
    const svc = svcWith([memBackend(() => Promise.resolve({ text: 'r' }))]);
    await svc.runTurn(docId, 'hi');
    expect(fs.readFileSync(other, 'utf8')).toBe(before);
  });

  it('caps the history at 200 messages', async () => {
    const svc = svcWith([memBackend(() => Promise.resolve({ text: 'r' }))]);
    for (let i = 0; i < 101; i++) await svc.runTurn(docId, `p${i}`, {});
    const h = await svc.history(docId);
    expect(h).toHaveLength(200);
    expect(h.at(-2)?.text).toBe('p100');
  }, 60_000);

  it('history during the turn includes the request and the in-progress message', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const be = memBackend(async (_i, emit) => {
      emit({ kind: 'text', text: 'partial' });
      await gate;
      return { text: 'end' };
    });
    const svc = svcWith([be]);
    const { turnId } = await svc.send(docId, 'request');
    await new Promise((r) => setTimeout(r, 50));
    const r = (await svc.handle({ type: 'assistant:history', reqId: 'h', docId })) as {
      messages: AssistantMessage[];
      running: string | null;
    };
    expect(r.running).toBe(turnId);
    expect(r.messages.map((m) => [m.role, m.text, m.status])).toEqual([
      ['user', 'request', undefined],
      ['assistant', 'partial', 'running'],
    ]);
    await expect(svc.handle({ type: 'assistant:clear', reqId: 'c', docId })).rejects.toThrow(
      /in progress/,
    );
    release();
    await svc.close();
  });

  it('generateText: without MCP, returns the final text', async () => {
    const be = memBackend((input) =>
      Promise.resolve({ text: input.mcp ? 'WITH MCP' : `  reply to: ${input.prompt}  ` }),
    );
    const svc = svcWith([be]);
    expect(await svc.generateText('do X', { system: 'SYS' })).toBe('reply to: do X');
    expect(be.calls[0]).toMatchObject({ system: 'SYS' });
    expect(be.calls[0]!.mcp).toBeUndefined();
    const empty = svcWith([memBackend(() => Promise.resolve({ text: '  ' }))]);
    await expect(empty.generateText('x')).rejects.toThrow(/returned no text/);
  });

  it('generateText: one per document, cancellable by cancel(docId) and by signal', async () => {
    const be = memBackend((_i, _emit, signal) => abortable(signal));
    const svc = svcWith([be]);
    const firstErr = svc.generateText('x', { docId }).catch((e: unknown) => e as Error);
    await expect(svc.generateText('y', { docId })).rejects.toThrow(/in progress in this document/);
    expect(svc.cancel(docId)).toBe(true);
    expect(await firstErr).toMatchObject({ name: 'AbortError' });
    // released: a new generation in the same document works
    const ok = svcWith([memBackend(() => Promise.resolve({ text: 'end' }))]);
    expect(await ok.generateText('x', { docId })).toBe('end');
    // signal
    const ac = new AbortController();
    const pErr = svc
      .generateText('x', { docId, signal: ac.signal })
      .catch((e: unknown) => e as Error);
    ac.abort();
    expect(await pErr).toMatchObject({ name: 'AbortError' });
    await expect(svc.generateText('x', { signal: AbortSignal.abort() })).rejects.toMatchObject({
      name: 'AbortError',
    });
    // nonexistent document: clear error
    await expect(svc.generateText('x', { docId: 'doc_nope' })).rejects.toThrow(/not found/);
    // without docId: cap on concurrent generations
    const many = Array.from({ length: 4 }, () =>
      svc.generateText('x').catch((e: unknown) => e as Error),
    );
    await expect(svc.generateText('x')).rejects.toThrow(/Too many/);
    await svc.close();
    for (const r of await Promise.all(many)) expect(r).toMatchObject({ name: 'AbortError' });
  });

  it('assistant:cancel/history/clear validate the docId with a clear error', async () => {
    const svc = svcWith([memBackend(() => Promise.resolve({ text: 'x' }))]);
    for (const type of ['assistant:cancel', 'assistant:history', 'assistant:clear'] as const) {
      for (const bad of [undefined, '', 5, null]) {
        await expect(
          svc.handle({ type, reqId: '1', docId: bad as unknown as string }),
        ).rejects.toThrow(/requires "docId"/);
      }
      await expect(svc.handle({ type, reqId: '1', docId: 'doc_nope' })).rejects.toThrow(
        /Document not found/,
      );
    }
  });

  it('invalid messages and nonexistent document', async () => {
    const svc = svcWith([memBackend(() => Promise.resolve({ text: 'x' }))]);
    await expect(
      svc.handle({ type: 'assistant:send', reqId: '1', docId, prompt: '  ' }),
    ).rejects.toThrow(/prompt/);
    await expect(
      svc.handle({ type: 'assistant:send', reqId: '1', docId: 'doc_nope', prompt: 'hi' }),
    ).rejects.toThrow(/not found/);
    expect(await svc.handle({ type: 'assistant:cancel', reqId: '1', docId })).toEqual({
      cancelled: false,
    });
  });
});

describe('Assistant with the daemon and the fake CLI', () => {
  let w: Work;
  let daemon: DaemonHandle;
  let docId: string;

  beforeEach(async () => {
    w = makeWork();
    daemon = await startDaemon({
      port: 0,
      dataDir: w.dataDir,
      writeInfo: false,
      openFiles: [w.file],
      agentBackends: [new ClaudeCliBackend({ command: process.execPath, prefixArgs: [FAKE_CLI] })],
    });
    docId = daemon.store.list()[0]!.docId;
  });
  afterEach(async () => {
    await daemon.close();
    w.cleanup();
  });

  const nameOf = (id: string) => findNode(daemon.store.get(docId), id)!.node.name;
  const styleOf = (id: string, prop: string) =>
    findNode(daemon.store.get(docId), id)!.node.style[prop];

  it('3 nodes edited via MCP become a single undo; event order, opsCount and context', async () => {
    const [a, b, c] = w.ids as [string, string, string];
    daemon.store.setSelection(docId, [a, b, c], 'editor');
    const events = collect(daemon.services.assistant as AssistantService, docId);
    const msg = await daemon.services.assistant.runTurn(
      docId,
      [
        `@@rename ${a} Alpha`,
        `@@style ${b} background #ff0000`,
        `@@rename ${c} Gamma`,
        '@@echo',
      ].join('\n'),
    );
    expect(msg.status).toBe('done');
    expect(msg.opsCount).toBe(3);
    expect(msg.backend).toBe('claude');
    expect(msg.tools?.map((t) => [t.name, t.ok])).toEqual([
      ['rename_nodes', true],
      ['update_styles', true],
      ['rename_nodes', true],
    ]);
    expect(nameOf(a)).toBe('Alpha');
    expect(styleOf(b, 'background')).toBe('#ff0000');
    expect(nameOf(c)).toBe('Gamma');

    // context that reached the agent
    expect(msg.text).toContain(`Selection: ${a}, ${b}, ${c}`);
    expect(msg.text).toContain('Box A');
    expect(msg.text).toContain('Use ONLY the mockup-studio MCP tools');
    expect(msg.text).toMatch(/ECHO-MCP: http:\/\/127\.0\.0\.1:\d+\/mcp\?turn=[0-9a-f]{32}/);

    // order: turn-start, then tool/tool-result of each call, text and turn-end
    const kinds = events.map((e) => e.kind);
    expect(kinds[0]).toBe('turn-start');
    expect(kinds.at(-1)).toBe('turn-end');
    expect(kinds.filter((k) => k === 'tool')).toHaveLength(3);
    expect(kinds.filter((k) => k === 'tool-result')).toHaveLength(3);
    expect(kinds.indexOf('tool')).toBeLessThan(kinds.indexOf('tool-result'));
    expect(kinds).toContain('text');
    expect(kinds.filter((k) => k === 'turn-start' || k === 'turn-end')).toHaveLength(2);

    // a single undo reverts everything
    expect(daemon.store.undo(docId, 'editor')).not.toBeNull();
    expect(nameOf(a)).toBe('Box A');
    expect(styleOf(b, 'background')).toBeUndefined();
    expect(nameOf(c)).toBe('Box C');
    expect(daemon.store.undo(docId, 'editor')).toBeNull();
    // and a redo redoes everything
    daemon.store.redo(docId, 'editor');
    expect(nameOf(a)).toBe('Alpha');
    expect(nameOf(c)).toBe('Gamma');
  });

  it('after the turn the token does not open a session (403); undo inside the turn is rejected', async () => {
    const msg = await daemon.services.assistant.runTurn(
      docId,
      [`@@rename ${w.ids[0]} One`, '@@undo', '@@echo'].join('\n'),
    );
    expect(msg.status).toBe('done');
    expect(msg.text).toContain('undo: rejected');
    expect(nameOf(w.ids[0]!)).toBe('One'); // the rejected undo reverted nothing
    const url = /ECHO-MCP: (\S+)/.exec(msg.text)![1]!;
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-03-26',
          capabilities: {},
          clientInfo: { name: 't', version: '0' },
        },
      }),
    });
    expect(res.status).toBe(403);
  });

  it('a session opened during the turn no longer writes after it', async () => {
    let held: Client | undefined;
    let during = '';
    const be = memBackend(async (input) => {
      held = new Client({ name: 'agent', version: '0' });
      await held.connect(new StreamableHTTPClientTransport(new URL(input.mcp!.url)));
      const ok = await held.callTool({
        name: 'rename_nodes',
        arguments: { docId, nodeIds: [w.ids[0]!], names: ['Inside'] },
      });
      during = JSON.stringify(ok);
      return { text: 'ok' };
    });
    // own service over the same store/daemon for the in-memory backend
    const svc = new AssistantService(daemon.store, {
      getPort: () => daemon.port,
      backends: [be],
    });
    const bridge = daemon.services.assistant;
    // links the daemon resolutions to the test service: temporary swap of resolveTurn
    const original = bridge.resolveTurn.bind(bridge);
    bridge.resolveTurn = (t) => svc.resolveTurn(t) ?? original(t);
    try {
      const m = await svc.runTurn(docId, 'hi');
      expect(m.status).toBe('done');
      expect(during).not.toContain('"isError":true');
      expect(nameOf(w.ids[0]!)).toBe('Inside');
      const after = (await held!.callTool({
        name: 'rename_nodes',
        arguments: { docId, nodeIds: [w.ids[1]!], names: ['Outside'] },
      })) as { isError?: boolean; content: Array<{ text: string }> };
      expect(after.isError).toBe(true);
      expect(after.content[0]!.text).toMatch(/assistant turn[\s\S]*(ended|finished)/);
      expect(nameOf(w.ids[1]!)).toBe('Box B');
    } finally {
      await held?.close();
      bridge.resolveTurn = original;
      await svc.close();
    }
  });

  it('cancellation kills the process; the ops already done stay in a single undo', async () => {
    const svc = daemon.services.assistant;
    const events = collect(svc as AssistantService, docId);
    const { turnId } = await svc.send(
      docId,
      [`@@rename ${w.ids[0]} Before`, `@@style ${w.ids[1]} color red`, '@@sleep 30000'].join('\n'),
    );
    await expect(svc.send(docId, 'concurrent')).rejects.toThrow(/in progress/);
    // wait for both edits to arrive
    const t0 = Date.now();
    while (nameOf(w.ids[0]!) !== 'Before' || styleOf(w.ids[1]!, 'color') !== 'red') {
      if (Date.now() - t0 > 15_000) throw new Error('the edits did not arrive');
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(svc.cancel(docId)).toBe(true);
    const end = await waitEnd(events, turnId);
    expect(end.message.status).toBe('cancelled');
    expect(end.message.opsCount).toBe(2);
    expect(svc.resolveTurn('x')).toBeNull();
    daemon.store.undo(docId, 'editor');
    expect(nameOf(w.ids[0]!)).toBe('Box A');
    expect(styleOf(w.ids[1]!, 'color')).toBeUndefined();
    expect(daemon.store.undo(docId, 'editor')).toBeNull();
    // document released
    const next = await svc.runTurn(docId, '@@text after');
    expect(next.status).toBe('done');
  });

  it('agent failure (@@fail) → status error with the message', async () => {
    const msg = await daemon.services.assistant.runTurn(docId, '@@fail agent broke');
    expect(msg.status).toBe('error');
    expect(msg.error).toContain('agent broke');
    // the history keeps the error
    const h = await daemon.services.assistant.history(docId);
    expect(h.at(-1)).toMatchObject({ status: 'error' });
  });

  it('continues the session (--resume) in the next turn', async () => {
    const first = await daemon.services.assistant.runTurn(docId, '@@echo');
    expect(first.text).toContain('ECHO-RESUME: (none)');
    const second = await daemon.services.assistant.runTurn(docId, '@@echo');
    expect(second.text).toMatch(/ECHO-RESUME: fake-/);
  });

  it('generateText through the CLI: without MCP', async () => {
    const text = await daemon.services.assistant.generateText('@@echo', { system: 'SYSTEM-GEN' });
    expect(text).toContain('ECHO-MCP: (no mcp)');
    expect(text).toContain('SYSTEM-GEN');
  });

  it('history in the sidecar file and reloaded by a new AssistantService', async () => {
    await daemon.services.assistant.runTurn(docId, '@@text hello');
    const side = assistantSidecarPath(w.file);
    expect(fs.existsSync(side)).toBe(true);
    const fresh = new AssistantService(daemon.store, {
      getPort: () => daemon.port,
      backends: [],
    });
    const h = await fresh.history(docId);
    expect(h.map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(h[1]!.text).toBe('hello');
  });

  it('WS assistant:* messages from a real client', async () => {
    const sock = new WebSocket(daemon.wsUrl);
    const msgs: Array<Record<string, unknown>> = [];
    const waiters: Array<() => void> = [];
    sock.on('message', (d) => {
      msgs.push(JSON.parse(d.toString()) as Record<string, unknown>);
      waiters.splice(0).forEach((x) => x());
    });
    const waitFor = async (pred: (m: Record<string, unknown>) => boolean) => {
      for (;;) {
        const m = msgs.find(pred);
        if (m) return m;
        await new Promise<void>((r) => waiters.push(r));
      }
    };
    await waitFor((m) => m['type'] === 'hello');
    const ask = async (m: Record<string, unknown>) => {
      const reqId = `r${Math.random().toString(16).slice(2)}`;
      sock.send(JSON.stringify({ ...m, reqId }));
      const r = await waitFor((x) => x['reqId'] === reqId);
      if (r['type'] === 'error') throw new Error(String(r['message']));
      return r['result'] as Record<string, unknown>;
    };

    const cfg = await ask({ type: 'assistant:config' });
    expect(cfg['config']).toEqual({ backend: 'auto' });
    expect((cfg['backends'] as Array<{ id: string; available: boolean }>)[0]).toMatchObject({
      id: 'claude',
      available: true,
    });

    const { turnId } = (await ask({
      type: 'assistant:send',
      docId,
      prompt: `@@rename ${w.ids[2]} Via WS`,
      selection: [w.ids[2]],
    })) as { turnId: string };
    const end = await waitFor(
      (m) =>
        m['type'] === 'assistant:event' &&
        (m['event'] as { kind: string; turnId?: string }).kind === 'turn-end' &&
        (m['event'] as { turnId: string }).turnId === turnId,
    );
    expect(end['docId']).toBe(docId);
    expect((end['event'] as { message: AssistantMessage }).message).toMatchObject({
      status: 'done',
      opsCount: 1,
    });
    const kinds = msgs
      .filter((m) => m['type'] === 'assistant:event')
      .map((m) => (m['event'] as { kind: string }).kind);
    expect(kinds[0]).toBe('turn-start');
    expect(kinds).toContain('tool');
    expect(nameOf(w.ids[2]!)).toBe('Via WS');

    const hist = await ask({ type: 'assistant:history', docId });
    expect((hist['messages'] as unknown[]).length).toBe(2);
    expect(hist['running']).toBeNull();

    expect(await ask({ type: 'assistant:cancel', docId })).toEqual({ cancelled: false });
    await ask({ type: 'assistant:clear', docId });
    await waitFor(
      (m) => m['type'] === 'assistant:event' && (m['event'] as { kind: string }).kind === 'cleared',
    );
    expect(
      ((await ask({ type: 'assistant:history', docId }))['messages'] as unknown[]).length,
    ).toBe(0);
    await expect(ask({ type: 'assistant:send', docId, prompt: '' })).rejects.toThrow(/prompt/);
    sock.close();
  });
});

async function waitEnd(
  events: AssistantEvent[],
  turnId: string,
): Promise<Extract<AssistantEvent, { kind: 'turn-end' }>> {
  const t0 = Date.now();
  for (;;) {
    const e = events.find((x) => x.kind === 'turn-end' && x.turnId === turnId);
    if (e) return e as Extract<AssistantEvent, { kind: 'turn-end' }>;
    if (Date.now() - t0 > 15_000) throw new Error('turn-end did not arrive');
    await new Promise((r) => setTimeout(r, 25));
  }
}
