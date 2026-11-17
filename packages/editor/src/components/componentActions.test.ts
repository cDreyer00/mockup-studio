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

describe('structure blocking on instance nodes', () => {
  it('deleting, duplicating and moving internal nodes is blocked with a notice (no op)', async () => {
    const f = makeComponentDoc();
    useDoc.setState(withView(f.doc));
    const inner = `${f.instanceIds[0]}/${f.main.textId}`;
    ui.select([inner]);
    await actions.deleteSelection();
    await actions.duplicateSelection();
    await actions.nudge(1, 0);
    expect(apply).not.toHaveBeenCalled();
    expect(useUi.getState().toast?.text).toMatch(/Internal nodes/);
    const view = useDoc.getState().doc!;
    expect(computeDropOps(view, [inner], { id: f.frameId, zone: 'inside' })).toBeNull();
    // Dropping inside the instance (outside the slot) is not allowed either.
    expect(
      computeDropOps(view, [f.instanceIds[2]!], { id: f.instanceIds[0]!, zone: 'inside' }),
    ).toBeNull();
  });

  it('the instance itself can be deleted', async () => {
    const f = makeComponentDoc();
    useDoc.setState(withView(f.doc));
    ui.select([f.instanceIds[1]!]);
    await actions.deleteSelection();
    expect(lastOps()).toEqual([{ type: 'deleteNodes', nodeIds: [f.instanceIds[1]] }]);
  });
});

describe('create component (Ctrl+Alt+K)', () => {
  it('sends replaceNode + addComponent + replaceNode in one call and selects the instance', async () => {
    const { doc, c } = makeDoc();
    useDoc.setState(withView(doc));
    ui.select([c.id]);
    expect(await createComponentFromSelection()).toBe(true);
    const ops = lastOps();
    expect(ops.map((o) => o.type)).toEqual(['replaceNode', 'addComponent', 'replaceNode']);
    const last = ops[2]!;
    const replaced = last.type === 'replaceNode' ? last.node : null;
    expect(replaced?.type).toBe('instance');
    expect(useUi.getState().selection).toEqual([replaced!.id]);
  });

  it('refuses root frames and internal nodes', async () => {
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

describe('insert instance', () => {
  it('with no selection, inserts into the first frame; with an instance selected, right after it', () => {
    const f = makeComponentDoc();
    const view = withView(f.doc).doc!;
    expect(insertTargetFromSelection(view, [], null)).toEqual({ parentId: f.frameId });
    expect(insertTargetFromSelection(view, [f.instanceIds[0]!], null)).toEqual({
      parentId: f.frameId,
      index: 1,
    });
  });

  it('from the document: a createNode with the instance and the slot containers', async () => {
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

  it('from the kit: imports the component and creates the instance in the same call', async () => {
    const kit = JSON.parse(fs.readFileSync(KIT_FILE, 'utf8')) as Document;
    const fetchMock = vi.fn(async (url: string) => ({
      ok: true,
      status: 200,
      json: async () => (url.endsWith('/api/kits/shadcn-like') ? kit : {}),
    }));
    vi.stubGlobal('fetch', fetchMock);
    const { doc } = makeDoc();
    useDoc.setState(withView(doc));
    await insertInstance('cp_sbutton1', { kit: 'shadcn-like', props: { label: 'Save' } });
    const ops = lastOps();
    const types = ops.map((o) => o.type);
    expect(types).toContain('addComponent');
    expect(types).toContain('setTokens');
    const create = ops.at(-1)!;
    expect(create.type).toBe('createNode');
    if (create.type !== 'createNode') return;
    expect(create.node.componentId).toBe('cp_sbutton1');
    expect(create.node.props).toEqual({ label: 'Save' });
    expect(apply).toHaveBeenCalledTimes(1);
  });

  it('from the kit: with the kit already imported, only adds what is missing (the edited main component stays)', async () => {
    const kit = JSON.parse(fs.readFileSync(KIT_FILE, 'utf8')) as Document;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, status: 200, json: async () => kit })),
    );
    const { doc } = makeDoc();
    const imported = applyOps(doc, importKitOps(doc, parseDocument(kit), 'shadcn-like').ops).doc;
    // Button edited and Card deleted (no instances).
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
