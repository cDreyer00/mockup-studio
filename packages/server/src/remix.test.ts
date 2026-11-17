import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createNode,
  findNode,
  newNodeId,
  type AssistantMessage,
  type ClientMessage,
} from '@mockup/core';
import { RemixService } from './remix.js';
import type { AssistantServiceApi, RunTurnOptions } from './services.js';
import { DocumentStore } from './store.js';
import { makeWorkspace } from './test-utils.js';

describe('RemixService', () => {
  let ws: ReturnType<typeof makeWorkspace>;
  let store: DocumentStore;
  let docId: string;
  let service: RemixService;

  beforeEach(async () => {
    ws = makeWorkspace();
    store = new DocumentStore({ dataDir: ws.dataDir, autosaveMs: 60_000 });
    docId = (await store.open(ws.file)).docId;
    // Content: a frame with a color, a heading and a button with padding.
    store.applyOps(
      docId,
      [
        { type: 'updateStyles', nodeIds: [ws.frameId], styles: { background: '#3b82f6' } },
        {
          type: 'createNode',
          parentId: ws.frameId,
          node: createNode({
            id: 'tx_title001',
            tag: 'h1',
            text: 'Hello',
            style: { 'font-size': '32px' },
          }),
        },
        {
          type: 'createNode',
          parentId: ws.frameId,
          node: createNode({ id: 'el_btn00001', tag: 'button', style: { padding: '12px 20px' } }),
        },
      ],
      { source: 'mcp' },
    );
    service = new RemixService(store, {
      systemFonts: async () => [{ family: 'Georgia' }, { family: 'Verdana' }],
    });
  });
  afterEach(async () => {
    await store.closeAll();
    ws.cleanup();
  });

  const frames = () => store.get(docId).pages[0]!.frames;

  it('color-scale: 10 frames in a single undo entry and selection on the new frames', async () => {
    const r = await service.run(docId, ws.frameId, 'color-scale');
    expect(r.frameIds).toHaveLength(10);
    expect(r.labels).toHaveLength(10);
    expect(r.labels[0]).toBe('shade 50');
    expect(frames()).toHaveLength(11);
    expect(store.getSelection(docId)).toEqual(r.frameIds);
    expect(findNode(store.get(docId), r.frameIds[3]!)!.node.name).toBe('Desktop — shade 300');

    // A single undo removes the 10 and leaves the rest (the setup) intact.
    expect(store.undo(docId, 'editor')).not.toBeNull();
    expect(frames()).toHaveLength(1);
    expect(frames()[0]!.style['background']).toBe('#3b82f6');
    expect(store.redo(docId, 'editor')).not.toBeNull();
    expect(frames()).toHaveLength(11);
  });

  it('count: limits the amount and validates 1..10', async () => {
    const r = await service.run(docId, ws.frameId, 'color-scale', { count: 3 });
    expect(r.frameIds).toHaveLength(3);
    for (const count of [0, 11, 2.5]) {
      await expect(service.run(docId, ws.frameId, 'color-scale', { count })).rejects.toThrow(
        /Invalid count/,
      );
    }
    expect(frames()).toHaveLength(4);
  });

  it('the given group joins remixes into the same undo entry and the source goes in the events', async () => {
    const sources: string[] = [];
    store.on('doc:changed', (e) => sources.push(e.source));
    await service.run(docId, 'el_btn00001', 'spacing', { count: 2, group: 'g1', source: 'mcp' });
    await service.run(docId, ws.frameId, 'color-scale', { count: 3, group: 'g1', source: 'mcp' });
    expect(sources).toEqual(['mcp', 'mcp']);
    expect(frames()).toHaveLength(6);
    store.undo(docId, 'mcp');
    expect(frames()).toHaveLength(1);
  });

  it('font-pairs uses the available local fonts (system + document)', async () => {
    const r = await service.run(docId, ws.frameId, 'font-pairs');
    expect(r.labels).toEqual(['Georgia + Verdana']);
    const clone = findNode(store.get(docId), r.frameIds[0]!)!.node;
    expect(clone.children[0]!.style['font-family']).toBe('"Georgia", serif');

    // Fonts embedded in the document count too.
    store.applyOps(
      docId,
      [{ type: 'setFonts', fonts: [{ family: 'Playfair Display' }, { family: 'Inter' }] }],
      { source: 'mcp' },
    );
    const r2 = await service.run(docId, ws.frameId, 'font-pairs');
    expect(r2.labels).toEqual(['Playfair Display + Inter', 'Georgia + Verdana']);
  });

  it('planner errors reach the caller without changing the document', async () => {
    const rev = store.getRevision(docId);
    await expect(service.run(docId, 'tx_title001', 'layout')).rejects.toThrow(/flex/);
    await expect(service.run(docId, 'el_none0001', 'spacing')).rejects.toThrow(/not found/);
    await expect(service.run(docId, 'tx_title001', 'spacing')).rejects.toThrow(/spacing/);
    await expect(service.run(docId, ws.frameId, 'xyz' as never)).rejects.toThrow(/Invalid/);
    expect(store.getRevision(docId)).toBe(rev);
  });

  it('handle(msg) handles the remix WS message with editor source', async () => {
    const msg: ClientMessage = {
      type: 'remix',
      reqId: 'r1',
      docId,
      nodeId: 'el_btn00001',
      kind: 'spacing',
      count: 2,
    };
    const r = (await service.handle(msg)) as { frameIds: string[]; labels: string[] };
    expect(r.labels).toEqual(['compact', 'grid 8']);
    expect(store.getSelection(docId)).toEqual(r.frameIds);
    await expect(
      service.handle({ type: 'selection:set', docId, nodeIds: [] } as unknown as ClientMessage),
    ).rejects.toThrow(/not handled/);
  });

  describe('kind ai', () => {
    /** Fake assistant: duplicates the frame `n` times inside the given group. */
    function fakeAssistant(n: number, status: AssistantMessage['status'] = 'done') {
      const calls: { prompt: string; opts?: RunTurnOptions }[] = [];
      const api = {
        async runTurn(
          id: string,
          prompt: string,
          opts?: RunTurnOptions,
        ): Promise<AssistantMessage> {
          calls.push({ prompt, opts });
          const frame = frames()[0]!;
          for (let i = 1; i <= n; i++) {
            const idMap = { [frame.id]: newNodeId('frame') };
            store.applyOps(
              id,
              [
                { type: 'duplicateNodes', nodeIds: [frame.id], idMap },
                {
                  type: 'renameNodes',
                  changes: [{ nodeId: idMap[frame.id]!, name: `${frame.name} — variation ${i}` }],
                },
              ],
              { source: 'mcp', group: opts?.group ?? 'fake-turn' },
            );
          }
          return { id: 'm1', role: 'assistant', text: 'ok', at: '', turnId: 't-42', status };
        },
      };
      return { api: api as unknown as AssistantServiceApi, calls };
    }

    it('returns the new frames, the turnId and selects the variations', async () => {
      const { api, calls } = fakeAssistant(2);
      const ai = new RemixService(store, { assistant: api });
      const r = await ai.run(docId, 'tx_title001', 'ai', {
        prompt: 'bolder',
        count: 2,
        group: 'group-x',
        source: 'mcp',
      });
      expect(r.turnId).toBe('t-42');
      expect(r.frameIds).toHaveLength(2);
      expect([...r.labels].sort()).toEqual(['Desktop — variation 1', 'Desktop — variation 2']);
      expect(store.getSelection(docId)).toEqual(r.frameIds);
      expect(frames()).toHaveLength(3);

      expect(calls).toHaveLength(1);
      expect(calls[0]!.prompt).toBe('bolder');
      expect(calls[0]!.opts?.selection).toEqual(['tx_title001']);
      expect(calls[0]!.opts?.group).toBe('group-x');
      const ins = calls[0]!.opts?.instructions ?? '';
      expect(ins).toContain(ws.frameId);
      expect(ins).toContain('2 variation');
      expect(ins).toContain('duplicate_nodes');
      expect(ins).toContain('set_position');
      expect(ins).toContain('get_screenshot');

      // The turn's ops stayed in the same group: one undo reverts both variations.
      store.undo(docId, 'mcp');
      expect(frames()).toHaveLength(1);
    });

    it('a frame created by the user during the turn is not part of the variations', async () => {
      const { api } = fakeAssistant(1);
      const wrapped = {
        ...api,
        async runTurn(id: string, prompt: string, opts?: RunTurnOptions) {
          // the user creates a frame in the editor in the middle of the turn (no group)
          store.applyOps(
            id,
            [
              {
                type: 'createNode',
                pageId: store.get(id).pages[0]!.id,
                node: {
                  id: 'fr_user0001',
                  type: 'frame',
                  name: 'User frame',
                  tag: 'div',
                  attrs: {},
                  style: { width: '100px', height: '100px' },
                  children: [],
                },
              },
            ],
            { source: 'editor' },
          );
          return api.runTurn(id, prompt, opts);
        },
      } as unknown as AssistantServiceApi;
      const ai = new RemixService(store, { assistant: wrapped });
      const r = await ai.run(docId, 'tx_title001', 'ai', { prompt: 'x', count: 1 });
      expect(r.frameIds).toHaveLength(1);
      expect(r.frameIds).not.toContain('fr_user0001');
      expect(r.labels).toEqual(['Desktop — variation 1']);
    });

    it('default count 3 in the instructions and an error when the turn fails without creating anything', async () => {
      const { api, calls } = fakeAssistant(0, 'error');
      const ai = new RemixService(store, { assistant: api });
      await expect(ai.run(docId, ws.frameId, 'ai', { prompt: 'x' })).rejects.toThrow(/failed/);
      expect(calls[0]!.opts?.instructions).toContain('3 variation');
    });

    it('requires prompt, assistant and a real node', async () => {
      const { api } = fakeAssistant(1);
      const ai = new RemixService(store, { assistant: api });
      await expect(ai.run(docId, ws.frameId, 'ai')).rejects.toThrow(/prompt/);
      await expect(ai.run(docId, ws.frameId, 'ai', { prompt: '   ' })).rejects.toThrow(/prompt/);
      await expect(ai.run(docId, 'el_none0001', 'ai', { prompt: 'x' })).rejects.toThrow(
        /not found/,
      );
      await expect(ai.run(docId, 'in_a0000001/el_b0000001', 'ai', { prompt: 'x' })).rejects.toThrow(
        /instance/,
      );
      await expect(service.run(docId, ws.frameId, 'ai', { prompt: 'x' })).rejects.toThrow(
        /assistant/,
      );
      expect(frames()).toHaveLength(1);
    });
  });
});
