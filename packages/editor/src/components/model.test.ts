import { afterEach, describe, expect, it } from 'vitest';
import { COMPONENT_EDIT_PAGE_ID, applyOp } from '@mockup/core';
import type { Document } from '@mockup/core';
import { getEntry, getNode } from '../model/tree';
import { mergeDoc, useDoc, withView } from '../state/docStore';
import { ui, useUi } from '../state/uiStore';
import { makeComponentDoc, makeDoc } from '../test/fixtures';
import {
  COMPONENT_FRAME_ID,
  buildView,
  canInsertInto,
  componentRole,
  copyableNode,
  structureBlock,
} from './model';
import { enterComponent, exitComponent } from './editing';

afterEach(() => {
  useUi.setState({
    editingComponentId: null,
    componentEdit: null,
    pageId: null,
    selection: [],
  });
  useDoc.setState({ doc: null, rawDoc: null });
});

/** Simulates a `doc:changed`: applies the op, round-trips through JSON and merges like the client does. */
function receive(prev: Document, op: Parameters<typeof applyOp>[1]): Document {
  const next = JSON.parse(JSON.stringify(applyOp(prev, op).doc)) as Document;
  const merged = mergeDoc(prev, next);
  useDoc.setState(withView(merged));
  return merged;
}

describe('document view (expanded instances)', () => {
  it('without instances, the view is the document itself', () => {
    const { doc } = makeDoc();
    expect(buildView(doc, null)).toBe(doc);
    useDoc.setState(withView(doc));
    expect(useDoc.getState().doc).toBe(doc);
    expect(useDoc.getState().rawDoc).toBe(doc);
  });

  it('expands instances with props and virtual ids; the real document stays intact', () => {
    const { doc, instanceIds, main } = makeComponentDoc();
    useDoc.setState(withView(doc));
    const view = useDoc.getState().doc!;
    expect(useDoc.getState().rawDoc).toBe(doc);
    const [i1, i2, i3] = instanceIds.map((id) => getNode(view, id)!);
    expect(i1!.componentId).toBe('cp_card0001');
    expect(i1!.type).toBe('element');
    expect(getNode(view, `${instanceIds[1]}/${main.textId}`)?.text).toBe('B');
    expect(getNode(view, `${instanceIds[2]}/${main.textId}`)?.text).toBe('C');
    expect(i2!.props).toEqual({ label: 'B' });
    expect(i3!.children.length).toBe(2);
    // In the real document the instance is still an instance (children = slot containers).
    expect(getNode(doc, instanceIds[0]!)?.type).toBe('instance');
  });

  it('keeps the identity of instances that did not change between versions', () => {
    const { doc, instanceIds, main } = makeComponentDoc();
    useDoc.setState(withView(doc));
    const before = useDoc.getState().doc!;
    receive(doc, {
      type: 'setInstanceProps',
      changes: [{ nodeId: instanceIds[1]!, set: { label: 'B2' } }],
    });
    const after = useDoc.getState().doc!;
    expect(getNode(after, instanceIds[0]!)).toBe(getNode(before, instanceIds[0]!));
    expect(getNode(after, instanceIds[2]!)).toBe(getNode(before, instanceIds[2]!));
    expect(getNode(after, instanceIds[1]!)).not.toBe(getNode(before, instanceIds[1]!));
    expect(getNode(after, `${instanceIds[1]}/${main.textId}`)?.text).toBe('B2');
  });

  it('editing the main component propagates to all instances in the view', () => {
    const { doc, instanceIds, main } = makeComponentDoc();
    useDoc.setState(withView(doc));
    receive(doc, {
      type: 'updateStyles',
      changes: [{ nodeId: main.rootId, set: { background: '#ff0000' } }],
    });
    const view = useDoc.getState().doc!;
    for (const id of instanceIds) expect(getNode(view, id)?.style.background).toBe('#ff0000');
  });
});

describe('main component edit mode', () => {
  it('the view gets the synthetic page with the frame and the main component root', () => {
    const { doc, main } = makeComponentDoc();
    useDoc.setState(withView(doc));
    expect(enterComponent('cp_card0001')).toBe(true);
    const view = useDoc.getState().doc!;
    const page = view.pages.find((p) => p.id === COMPONENT_EDIT_PAGE_ID)!;
    expect(page.frames[0]!.id).toBe(COMPONENT_FRAME_ID);
    expect(page.frames[0]!.children[0]!.id).toBe(main.rootId);
    expect(useUi.getState().pageId).toBe(COMPONENT_EDIT_PAGE_ID);
    expect(useUi.getState().selection).toEqual([main.rootId]);
    expect(componentRole(view, main.rootId)).toBe('main');
    // The synthetic frame is not selectable nor does it accept children.
    ui.select([COMPONENT_FRAME_ID]);
    expect(useUi.getState().selection).toEqual([]);
    expect(canInsertInto(view, COMPONENT_FRAME_ID)).toBe(false);
    expect(structureBlock(view, [main.rootId])).toMatch(/main component root/);

    exitComponent();
    expect(useUi.getState().editingComponentId).toBeNull();
    expect(useDoc.getState().doc!.pages.some((p) => p.id === COMPONENT_EDIT_PAGE_ID)).toBe(false);
  });

  it('done returns to the page and selects the origin instance', () => {
    const { doc, instanceIds } = makeComponentDoc();
    useDoc.setState(withView(doc));
    const pageId = doc.pages[0]!.id;
    useUi.setState({ pageId });
    enterComponent('cp_card0001', instanceIds[1]!);
    exitComponent();
    expect(useUi.getState().pageId).toBe(pageId);
    expect(useUi.getState().selection).toEqual([instanceIds[1]]);
  });

  it('switching page leaves edit mode', () => {
    const { doc } = makeComponentDoc();
    useDoc.setState(withView(doc));
    enterComponent('cp_card0001');
    ui.setPage(doc.pages[0]!.id);
    expect(useUi.getState().editingComponentId).toBeNull();
  });
});

describe('roles and blocks', () => {
  it('classifies instance, internal node, slot container and slot content', () => {
    const { doc, instanceIds, main } = makeComponentDoc();
    const view = buildView(doc, null);
    const inst = getNode(doc, instanceIds[0]!)!;
    const slotId = inst.children[0]!.id;
    expect(componentRole(view, instanceIds[0]!)).toBe('instance');
    expect(componentRole(view, `${instanceIds[0]}/${main.textId}`)).toBe('internal');
    expect(componentRole(view, slotId)).toBe('slot');
    expect(componentRole(view, getEntry(view, instanceIds[0]!)!.parentId!)).toBeNull();
  });

  it('internal nodes and slot containers do not move; insert only into the slot', () => {
    const { doc, instanceIds, main, frameId } = makeComponentDoc();
    const view = buildView(doc, null);
    const slotId = getNode(doc, instanceIds[0]!)!.children[0]!.id;
    expect(structureBlock(view, [`${instanceIds[0]}/${main.textId}`])).toMatch(/Internal nodes/);
    expect(structureBlock(view, [slotId])).toMatch(/slot/);
    expect(structureBlock(view, [instanceIds[0]!])).toBeNull();
    expect(canInsertInto(view, instanceIds[0]!)).toBe(false);
    expect(canInsertInto(view, `${instanceIds[0]}/${main.textId}`)).toBe(false);
    expect(canInsertInto(view, slotId)).toBe(true);
    expect(canInsertInto(view, frameId)).toBe(true);
  });

  it('copying an instance copies the real node; an internal node comes out concrete', () => {
    const { doc, instanceIds, main } = makeComponentDoc();
    const view = buildView(doc, null);
    expect(copyableNode(doc, view, instanceIds[1]!)?.type).toBe('instance');
    const inner = copyableNode(doc, view, `${instanceIds[1]}/${main.textId}`)!;
    expect(inner.text).toBe('B');
    expect(inner.componentId).toBeUndefined();
  });
});
