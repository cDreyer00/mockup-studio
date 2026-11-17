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

/** Simula um `doc:changed`: aplica a op, passa pelo JSON e integra como o cliente faz. */
function receive(prev: Document, op: Parameters<typeof applyOp>[1]): Document {
  const next = JSON.parse(JSON.stringify(applyOp(prev, op).doc)) as Document;
  const merged = mergeDoc(prev, next);
  useDoc.setState(withView(merged));
  return merged;
}

describe('visão do documento (instâncias expandidas)', () => {
  it('sem instâncias, a visão é o próprio documento', () => {
    const { doc } = makeDoc();
    expect(buildView(doc, null)).toBe(doc);
    useDoc.setState(withView(doc));
    expect(useDoc.getState().doc).toBe(doc);
    expect(useDoc.getState().rawDoc).toBe(doc);
  });

  it('expande as instâncias com props e ids virtuais; o documento real fica intacto', () => {
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
    // No documento real a instância continua instância (filhos = contêineres de slot).
    expect(getNode(doc, instanceIds[0]!)?.type).toBe('instance');
  });

  it('mantém a identidade das instâncias que não mudaram entre versões', () => {
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

  it('editar o principal propaga para todas as instâncias da visão', () => {
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

describe('modo de edição do principal', () => {
  it('a visão ganha a página sintética com o quadro e a raiz do principal', () => {
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
    // O quadro sintético não é selecionável nem aceita filhos.
    ui.select([COMPONENT_FRAME_ID]);
    expect(useUi.getState().selection).toEqual([]);
    expect(canInsertInto(view, COMPONENT_FRAME_ID)).toBe(false);
    expect(structureBlock(view, [main.rootId])).toMatch(/raiz do principal/);

    exitComponent();
    expect(useUi.getState().editingComponentId).toBeNull();
    expect(useDoc.getState().doc!.pages.some((p) => p.id === COMPONENT_EDIT_PAGE_ID)).toBe(false);
  });

  it('concluir volta à página e seleciona a instância de origem', () => {
    const { doc, instanceIds } = makeComponentDoc();
    useDoc.setState(withView(doc));
    const pageId = doc.pages[0]!.id;
    useUi.setState({ pageId });
    enterComponent('cp_card0001', instanceIds[1]!);
    exitComponent();
    expect(useUi.getState().pageId).toBe(pageId);
    expect(useUi.getState().selection).toEqual([instanceIds[1]]);
  });

  it('trocar de página sai do modo de edição', () => {
    const { doc } = makeComponentDoc();
    useDoc.setState(withView(doc));
    enterComponent('cp_card0001');
    ui.setPage(doc.pages[0]!.id);
    expect(useUi.getState().editingComponentId).toBeNull();
  });
});

describe('papéis e bloqueios', () => {
  it('classifica instância, nó interno, contêiner de slot e conteúdo de slot', () => {
    const { doc, instanceIds, main } = makeComponentDoc();
    const view = buildView(doc, null);
    const inst = getNode(doc, instanceIds[0]!)!;
    const slotId = inst.children[0]!.id;
    expect(componentRole(view, instanceIds[0]!)).toBe('instance');
    expect(componentRole(view, `${instanceIds[0]}/${main.textId}`)).toBe('internal');
    expect(componentRole(view, slotId)).toBe('slot');
    expect(componentRole(view, getEntry(view, instanceIds[0]!)!.parentId!)).toBeNull();
  });

  it('nós internos e contêineres de slot não se movem; inserir só no slot', () => {
    const { doc, instanceIds, main, frameId } = makeComponentDoc();
    const view = buildView(doc, null);
    const slotId = getNode(doc, instanceIds[0]!)!.children[0]!.id;
    expect(structureBlock(view, [`${instanceIds[0]}/${main.textId}`])).toMatch(/internos/);
    expect(structureBlock(view, [slotId])).toMatch(/slot/);
    expect(structureBlock(view, [instanceIds[0]!])).toBeNull();
    expect(canInsertInto(view, instanceIds[0]!)).toBe(false);
    expect(canInsertInto(view, `${instanceIds[0]}/${main.textId}`)).toBe(false);
    expect(canInsertInto(view, slotId)).toBe(true);
    expect(canInsertInto(view, frameId)).toBe(true);
  });

  it('copiar uma instância copia o nó real; um nó interno sai concreto', () => {
    const { doc, instanceIds, main } = makeComponentDoc();
    const view = buildView(doc, null);
    expect(copyableNode(doc, view, instanceIds[1]!)?.type).toBe('instance');
    const inner = copyableNode(doc, view, `${instanceIds[1]}/${main.textId}`)!;
    expect(inner.text).toBe('B');
    expect(inner.componentId).toBeUndefined();
  });
});
