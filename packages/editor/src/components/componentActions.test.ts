import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { applyOps, importKitOps, parseDocument } from '@mockup/core';
import type { Document, Op } from '@mockup/core';
import { actions } from '../actions';
import { daemon } from '../client/daemon';
import { computeDropOps } from '../layers/layersLogic';
import { useDoc, withView } from '../state/docStore';
import { ui, useUi } from '../state/uiStore';
import { makeComponentDoc, makeDoc } from '../test/fixtures';
import {
  createComponentFromSelection,
  insertInstance,
  insertTargetFromSelection,
} from './componentActions';
import { resetKitCache } from './kits';

const KIT_FILE = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../../kits/shadcn-like.mockup.json',
);

let apply: ReturnType<typeof vi.spyOn>;
const lastOps = (): Op[] => apply.mock.calls.at(-1)![0] as Op[];

beforeEach(() => {
  apply = vi.spyOn(daemon, 'applySafe').mockResolvedValue({ revision: 1, results: [] });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  resetKitCache();
  useUi.setState({ selection: [], toast: null, pageId: null });
  useDoc.setState({ doc: null, rawDoc: null });
});

describe('bloqueio de estrutura em nós de instâncias', () => {
  it('excluir, duplicar e mover nós internos é bloqueado com aviso (sem op)', async () => {
    const f = makeComponentDoc();
    useDoc.setState(withView(f.doc));
    const inner = `${f.instanceIds[0]}/${f.main.textId}`;
    ui.select([inner]);
    await actions.deleteSelection();
    await actions.duplicateSelection();
    await actions.nudge(1, 0);
    expect(apply).not.toHaveBeenCalled();
    expect(useUi.getState().toast?.text).toMatch(/internos/);
    const view = useDoc.getState().doc!;
    expect(computeDropOps(view, [inner], { id: f.frameId, zone: 'inside' })).toBeNull();
    // Soltar dentro da instância (fora do slot) também não vale.
    expect(
      computeDropOps(view, [f.instanceIds[2]!], { id: f.instanceIds[0]!, zone: 'inside' }),
    ).toBeNull();
  });

  it('a instância em si pode ser excluída', async () => {
    const f = makeComponentDoc();
    useDoc.setState(withView(f.doc));
    ui.select([f.instanceIds[1]!]);
    await actions.deleteSelection();
    expect(lastOps()).toEqual([{ type: 'deleteNodes', nodeIds: [f.instanceIds[1]] }]);
  });
});

describe('criar componente (Ctrl+Alt+K)', () => {
  it('manda replaceNode + addComponent numa chamada e seleciona a instância', async () => {
    const { doc, c } = makeDoc();
    useDoc.setState(withView(doc));
    ui.select([c.id]);
    expect(await createComponentFromSelection()).toBe(true);
    const ops = lastOps();
    expect(ops.map((o) => o.type)).toEqual(['replaceNode', 'addComponent']);
    const replaced = ops[0]!.type === 'replaceNode' ? ops[0]!.node : null;
    expect(replaced?.type).toBe('instance');
    expect(useUi.getState().selection).toEqual([replaced!.id]);
  });

  it('recusa frame raiz e nós internos', async () => {
    const { doc, frame } = makeDoc();
    useDoc.setState(withView(doc));
    ui.select([frame.id]);
    expect(await createComponentFromSelection()).toBe(false);
    expect(apply).not.toHaveBeenCalled();
    const f = makeComponentDoc();
    useDoc.setState(withView(f.doc));
    ui.select([`${f.instanceIds[0]}/${f.main.textId}`]);
    expect(await createComponentFromSelection()).toBe(false);
    expect(apply).not.toHaveBeenCalled();
  });
});

describe('inserir instância', () => {
  it('sem seleção, insere no primeiro frame; com instância selecionada, logo depois dela', () => {
    const f = makeComponentDoc();
    const view = withView(f.doc).doc!;
    expect(insertTargetFromSelection(view, [], null)).toEqual({ parentId: f.frameId });
    expect(insertTargetFromSelection(view, [f.instanceIds[0]!], null)).toEqual({
      parentId: f.frameId,
      index: 1,
    });
  });

  it('do documento: um createNode com a instância e os contêineres de slot', async () => {
    const f = makeComponentDoc();
    useDoc.setState(withView(f.doc));
    const id = await insertInstance(f.componentId);
    const ops = lastOps();
    expect(ops).toHaveLength(1);
    const op = ops[0]!;
    expect(op.type).toBe('createNode');
    if (op.type !== 'createNode') return;
    expect(op.parentId).toBe(f.frameId);
    expect(op.node.componentId).toBe(f.componentId);
    expect(op.node.children.map((c) => c.attrs['data-slot'])).toEqual(['content']);
    expect(useUi.getState().selection).toEqual([id]);
  });

  it('do kit: importa o componente e cria a instância na mesma chamada', async () => {
    const kit = JSON.parse(fs.readFileSync(KIT_FILE, 'utf8')) as Document;
    const fetchMock = vi.fn(async (url: string) => ({
      ok: true,
      status: 200,
      json: async () => (url.endsWith('/api/kits/shadcn-like') ? kit : {}),
    }));
    vi.stubGlobal('fetch', fetchMock);
    const { doc } = makeDoc();
    useDoc.setState(withView(doc));
    await insertInstance('cp_sbutton1', { kit: 'shadcn-like', props: { label: 'Salvar' } });
    const ops = lastOps();
    const types = ops.map((o) => o.type);
    expect(types).toContain('addComponent');
    expect(types).toContain('setTokens');
    const create = ops.at(-1)!;
    expect(create.type).toBe('createNode');
    if (create.type !== 'createNode') return;
    expect(create.node.componentId).toBe('cp_sbutton1');
    expect(create.node.props).toEqual({ label: 'Salvar' });
    expect(apply).toHaveBeenCalledTimes(1);
  });

  it('do kit: com o kit já importado, só adiciona o que falta (o principal editado fica)', async () => {
    const kit = JSON.parse(fs.readFileSync(KIT_FILE, 'utf8')) as Document;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, status: 200, json: async () => kit })),
    );
    const { doc } = makeDoc();
    const imported = applyOps(doc, importKitOps(doc, parseDocument(kit), 'shadcn-like').ops).doc;
    // Button editado e Card apagado (sem instâncias).
    const raw = applyOps(imported, [
      { type: 'updateStyles', nodeIds: ['el_sbtnroot'], styles: { color: 'red' } },
      { type: 'deleteComponent', componentId: 'cp_scard001' },
    ]).doc;
    useDoc.setState(withView(raw));
    await insertInstance('cp_scard001', { kit: 'shadcn-like' });
    const ops = lastOps();
    expect(ops.map((o) => o.type)).toEqual(['addComponent', 'createNode']);
    const add = ops[0]!;
    expect(add.type === 'addComponent' && add.component.id).toBe('cp_scard001');
  });
});
