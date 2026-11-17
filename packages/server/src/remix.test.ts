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
    // Conteúdo: frame com cor, um título e um botão com padding.
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
            text: 'Olá',
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

  it('color-scale: 10 frames numa única entrada de undo e seleção nos novos frames', async () => {
    const r = await service.run(docId, ws.frameId, 'color-scale');
    expect(r.frameIds).toHaveLength(10);
    expect(r.labels).toHaveLength(10);
    expect(r.labels[0]).toBe('tom 50');
    expect(frames()).toHaveLength(11);
    expect(store.getSelection(docId)).toEqual(r.frameIds);
    expect(findNode(store.get(docId), r.frameIds[3]!)!.node.name).toBe('Desktop — tom 300');

    // Um único undo remove os 10 e deixa o restante (o setup) intacto.
    expect(store.undo(docId, 'editor')).not.toBeNull();
    expect(frames()).toHaveLength(1);
    expect(frames()[0]!.style['background']).toBe('#3b82f6');
    expect(store.redo(docId, 'editor')).not.toBeNull();
    expect(frames()).toHaveLength(11);
  });

  it('count: limita a quantidade e valida 1..10', async () => {
    const r = await service.run(docId, ws.frameId, 'color-scale', { count: 3 });
    expect(r.frameIds).toHaveLength(3);
    for (const count of [0, 11, 2.5]) {
      await expect(service.run(docId, ws.frameId, 'color-scale', { count })).rejects.toThrow(
        /count inválido/,
      );
    }
    expect(frames()).toHaveLength(4);
  });

  it('o grupo recebido junta remixes na mesma entrada de undo e a origem vai nos eventos', async () => {
    const sources: string[] = [];
    store.on('doc:changed', (e) => sources.push(e.source));
    await service.run(docId, 'el_btn00001', 'spacing', { count: 2, group: 'g1', source: 'mcp' });
    await service.run(docId, ws.frameId, 'color-scale', { count: 3, group: 'g1', source: 'mcp' });
    expect(sources).toEqual(['mcp', 'mcp']);
    expect(frames()).toHaveLength(6);
    store.undo(docId, 'mcp');
    expect(frames()).toHaveLength(1);
  });

  it('font-pairs usa as fontes locais disponíveis (sistema + documento)', async () => {
    const r = await service.run(docId, ws.frameId, 'font-pairs');
    expect(r.labels).toEqual(['Georgia + Verdana']);
    const clone = findNode(store.get(docId), r.frameIds[0]!)!.node;
    expect(clone.children[0]!.style['font-family']).toBe('"Georgia", serif');

    // Fontes embutidas no documento também contam.
    store.applyOps(
      docId,
      [{ type: 'setFonts', fonts: [{ family: 'Playfair Display' }, { family: 'Inter' }] }],
      { source: 'mcp' },
    );
    const r2 = await service.run(docId, ws.frameId, 'font-pairs');
    expect(r2.labels).toEqual(['Playfair Display + Inter', 'Georgia + Verdana']);
  });

  it('erros do planejador chegam ao chamador sem alterar o documento', async () => {
    const rev = store.getRevision(docId);
    await expect(service.run(docId, 'tx_title001', 'layout')).rejects.toThrow(/flex/);
    await expect(service.run(docId, 'el_nada0001', 'spacing')).rejects.toThrow(/não encontrado/);
    await expect(service.run(docId, 'tx_title001', 'spacing')).rejects.toThrow(/espaçamento/);
    await expect(service.run(docId, ws.frameId, 'xyz' as never)).rejects.toThrow(/inválido/);
    expect(store.getRevision(docId)).toBe(rev);
  });

  it('handle(msg) trata a mensagem WS remix com origem editor', async () => {
    const msg: ClientMessage = {
      type: 'remix',
      reqId: 'r1',
      docId,
      nodeId: 'el_btn00001',
      kind: 'spacing',
      count: 2,
    };
    const r = (await service.handle(msg)) as { frameIds: string[]; labels: string[] };
    expect(r.labels).toEqual(['compacto', 'grade 4']);
    expect(store.getSelection(docId)).toEqual(r.frameIds);
    await expect(
      service.handle({ type: 'selection:set', docId, nodeIds: [] } as unknown as ClientMessage),
    ).rejects.toThrow(/não tratada/);
  });

  describe('kind ai', () => {
    /** Assistente falso: duplica o frame `n` vezes dentro do grupo recebido. */
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
                  changes: [{ nodeId: idMap[frame.id]!, name: `${frame.name} — variação ${i}` }],
                },
              ],
              { source: 'mcp', group: opts?.group ?? 'turno-falso' },
            );
          }
          return { id: 'm1', role: 'assistant', text: 'ok', at: '', turnId: 't-42', status };
        },
      };
      return { api: api as unknown as AssistantServiceApi, calls };
    }

    it('devolve os frames novos, o turnId e seleciona as variações', async () => {
      const { api, calls } = fakeAssistant(2);
      const ai = new RemixService(store, { assistant: api });
      const r = await ai.run(docId, 'tx_title001', 'ai', {
        prompt: 'mais ousado',
        count: 2,
        group: 'grupo-x',
        source: 'mcp',
      });
      expect(r.turnId).toBe('t-42');
      expect(r.frameIds).toHaveLength(2);
      expect([...r.labels].sort()).toEqual(['Desktop — variação 1', 'Desktop — variação 2']);
      expect(store.getSelection(docId)).toEqual(r.frameIds);
      expect(frames()).toHaveLength(3);

      expect(calls).toHaveLength(1);
      expect(calls[0]!.prompt).toBe('mais ousado');
      expect(calls[0]!.opts?.selection).toEqual(['tx_title001']);
      expect(calls[0]!.opts?.group).toBe('grupo-x');
      const ins = calls[0]!.opts?.instructions ?? '';
      expect(ins).toContain(ws.frameId);
      expect(ins).toContain('2 variação');
      expect(ins).toContain('duplicate_nodes');
      expect(ins).toContain('set_position');
      expect(ins).toContain('get_screenshot');

      // As ops do turno ficaram no mesmo grupo: um undo desfaz as duas variações.
      store.undo(docId, 'mcp');
      expect(frames()).toHaveLength(1);
    });

    it('count padrão 3 nas instruções e erro quando o turno falha sem criar nada', async () => {
      const { api, calls } = fakeAssistant(0, 'error');
      const ai = new RemixService(store, { assistant: api });
      await expect(ai.run(docId, ws.frameId, 'ai', { prompt: 'x' })).rejects.toThrow(/falhou/);
      expect(calls[0]!.opts?.instructions).toContain('3 variação');
    });

    it('exige prompt, assistente e nó real', async () => {
      const { api } = fakeAssistant(1);
      const ai = new RemixService(store, { assistant: api });
      await expect(ai.run(docId, ws.frameId, 'ai')).rejects.toThrow(/prompt/);
      await expect(ai.run(docId, ws.frameId, 'ai', { prompt: '   ' })).rejects.toThrow(/prompt/);
      await expect(ai.run(docId, 'el_nada0001', 'ai', { prompt: 'x' })).rejects.toThrow(
        /não encontrado/,
      );
      await expect(ai.run(docId, 'in_a0000001/el_b0000001', 'ai', { prompt: 'x' })).rejects.toThrow(
        /instância/,
      );
      await expect(service.run(docId, ws.frameId, 'ai', { prompt: 'x' })).rejects.toThrow(
        /assistente/,
      );
      expect(frames()).toHaveLength(1);
    });
  });
});
