/**
 * Comandos de componentes (criar da seleção, inserir instância, destacar, restaurar, enviar ao
 * principal, props). Os planejadores do core recebem o documento real (`getRawDoc()`); cada
 * comando vai ao daemon numa única chamada (= uma entrada de undo).
 */
import {
  COMPONENT_EDIT_PAGE_ID,
  applyOps,
  createComponentOps,
  detachInstanceOps,
  findInstanceNode,
  getComponent,
  importKitOps,
  instanceNodeFor,
  isVirtualId,
  pushOverridesToMainOps,
  resetInstanceOps,
} from '@mockup/core';
import type { ComponentDef, Document, Node, Op, PropDef, PropValue } from '@mockup/core';
import { daemon } from '../client/daemon';
import { getCanvasRoot } from '../canvas/dom';
import { buildCreateOps, planPlacement } from '../canvas/placement';
import type { Placement } from '../canvas/placement';
import { makeFrame } from '../model/factory';
import { getEntry, getNode, topLevel } from '../model/tree';
import { getRawDoc, useDoc } from '../state/docStore';
import { currentPageId } from '../state/hooks';
import { ui, useUi } from '../state/uiStore';
import { enterComponent } from './editing';
import { fetchKit } from './kits';
import { canInsertInto, isMainRoot } from './model';

const errorText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/* ------------------------------------------------------------------ */
/* criar componente                                                   */
/* ------------------------------------------------------------------ */

/** Motivo para não criar um componente a partir de `id` (`null` = pode). */
export function createComponentBlock(view: Document, id: string): string | null {
  if (isVirtualId(id))
    return 'Nós internos de uma instância não viram componente: destaque a instância antes';
  const e = getEntry(view, id);
  if (!e) return 'Selecione um nó';
  if (e.pageId === COMPONENT_EDIT_PAGE_ID) return 'Crie componentes a partir de nós das páginas';
  if (e.parentId === null)
    return 'Frames raiz não viram componente: selecione um nó dentro do frame';
  if (e.node.componentId !== undefined) return 'O nó já é uma instância de componente';
  return null;
}

/** Ctrl+Alt+K: transforma o nó selecionado num componente (o nó vira a primeira instância). */
export async function createComponentFromSelection(): Promise<boolean> {
  const view = useDoc.getState().doc;
  const raw = getRawDoc();
  if (!view || !raw) return false;
  const sel = topLevel(view, useUi.getState().selection);
  if (sel.length !== 1) {
    ui.toast('Selecione um nó para criar o componente');
    return false;
  }
  const id = sel[0]!;
  const block = createComponentBlock(view, id);
  if (block) {
    ui.toast(block);
    return false;
  }
  let plan: ReturnType<typeof createComponentOps>;
  try {
    plan = createComponentOps(raw, id);
  } catch (e) {
    ui.toast(errorText(e), 'error');
    return false;
  }
  const ack = await daemon.applySafe(plan.ops);
  if (!ack) return false;
  ui.select([plan.instanceId]);
  const name = plan.ops.find((o) => o.type === 'addComponent');
  ui.toast(
    `Componente "${name?.type === 'addComponent' ? name.component.name : ''}" criado (Ctrl+Alt+K)`,
  );
  return true;
}

/* ------------------------------------------------------------------ */
/* inserir instância                                                  */
/* ------------------------------------------------------------------ */

/** Onde inserir sem ponto de soltura: dentro da seleção (se aceitar), ao lado dela ou no frame. */
export function insertTargetFromSelection(
  view: Document,
  selection: readonly string[],
  pageId: string | null,
): { parentId: string; index?: number } | null {
  const sel = topLevel(view, selection);
  const first = sel[0];
  if (first) {
    if (canInsertInto(view, first) && sel.length === 1) return { parentId: first };
    // Sobe até um pai que aceite filhos, inserindo logo depois do nó.
    let cur = getEntry(view, first);
    while (cur && cur.parentId) {
      if (canInsertInto(view, cur.parentId))
        return { parentId: cur.parentId, index: cur.index + 1 };
      cur = getEntry(view, cur.parentId);
    }
  }
  const page = view.pages.find((p) => p.id === pageId) ?? view.pages[0];
  if (!page) return null;
  if (page.id === COMPONENT_EDIT_PAGE_ID) {
    const root = page.frames[0]?.children[0];
    return root && canInsertInto(view, root.id) ? { parentId: root.id } : null;
  }
  const frame = page.frames.find((f) => !f.hidden && !f.locked && canInsertInto(view, f.id));
  return frame ? { parentId: frame.id } : null;
}

export interface InsertInstanceOptions {
  /** Kit de origem: importa o componente (e os tokens que faltam) se ainda não estiver no documento. */
  kit?: string;
  props?: Record<string, PropValue>;
  /** Ponto de soltura (mundo e janela); sem ele, usa a seleção. */
  drop?: { world: { x: number; y: number }; client: { x: number; y: number } };
}

/**
 * Insere uma instância de `componentId` numa única chamada: importa o kit (se preciso) e cria o
 * nó calculado sobre o documento já com o kit aplicado localmente. Devolve o id da instância.
 */
export async function insertInstance(
  componentId: string,
  opts: InsertInstanceOptions = {},
): Promise<string | null> {
  const view = useDoc.getState().doc;
  const raw = getRawDoc();
  const pageId = currentPageId();
  if (!view || !raw || !pageId) return null;
  const ops: Op[] = [];
  let base = raw;
  try {
    if (opts.kit && !getComponent(raw, componentId)) {
      const kit = await fetchKit(opts.kit);
      const imported = importKitOps(raw, kit, opts.kit).ops;
      ops.push(...imported);
      base = applyOps(raw, imported).doc;
    }
    if (!getComponent(base, componentId))
      throw new Error(`Componente "${componentId}" não encontrado`);

    let placement: Placement | null = null;
    if (opts.drop) {
      placement = getCanvasRoot() ? planPlacement(view, opts.drop.world, opts.drop.client) : null;
      if (placement && placement.parentId === null) {
        if (pageId === COMPONENT_EDIT_PAGE_ID) placement = null;
      }
    }
    if (!placement) {
      const t = insertTargetFromSelection(view, useUi.getState().selection, pageId);
      if (!t) {
        ui.toast('Crie um frame (F) para inserir o componente');
        return null;
      }
      placement = {
        parentId: t.parentId,
        flow: true,
        ...(t.index !== undefined ? { index: t.index } : {}),
        x: 0,
        y: 0,
        parentNeedsRelative: false,
      };
    }
    const style: Record<string, string> = {};
    if (placement.parentId && !placement.flow) {
      style.position = 'absolute';
      style.left = `${placement.x}px`;
      style.top = `${placement.y}px`;
    }
    const node = instanceNodeFor(base, componentId, { props: opts.props, style });
    if (placement.parentId === null) {
      // Solto fora de qualquer frame: um frame novo em volta da instância.
      const frame = makeFrame(
        placement.x,
        placement.y,
        480,
        320,
        getComponent(base, componentId)!.name,
      );
      frame.style.padding = '24px';
      frame.children = [node];
      ops.push({ type: 'createNode', pageId, node: frame });
    } else {
      ops.push(...buildCreateOps(pageId, placement, node));
    }
    const ack = await daemon.applySafe(ops);
    if (!ack) return null;
    ui.select([node.id]);
    return node.id;
  } catch (e) {
    ui.toast(errorText(e), 'error');
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* instância selecionada                                              */
/* ------------------------------------------------------------------ */

/** Componente da instância (raiz expandida na visão) ou `undefined`. */
export function componentOfNode(
  raw: Document | null,
  node: Node | undefined,
): ComponentDef | undefined {
  return raw && node?.componentId ? getComponent(raw, node.componentId) : undefined;
}

/** Overrides guardados na instância real (ou `{}`). */
export function instanceOverrides(raw: Document | null, id: string): Record<string, unknown> {
  if (!raw || isVirtualId(id)) return {};
  return findInstanceNode(raw, id)?.overrides ?? {};
}

async function runPlan(plan: () => Op[]): Promise<boolean> {
  let ops: Op[];
  try {
    ops = plan();
  } catch (e) {
    ui.toast(errorText(e), 'error');
    return false;
  }
  if (!ops.length) return false;
  return !!(await daemon.applySafe(ops));
}

/** "Ir para principal": entra no modo de edição do componente da instância. */
export function goToMain(id: string): boolean {
  const view = useDoc.getState().doc;
  const node = view ? getNode(view, id) : undefined;
  if (!node?.componentId) {
    ui.toast('Selecione uma instância de componente');
    return false;
  }
  return enterComponent(node.componentId, id);
}

/** "Destacar": a instância vira nós comuns (seleciona o nó resultante). */
export async function detachInstance(id: string): Promise<boolean> {
  const raw = getRawDoc();
  if (!raw) return false;
  let newId: string | null = null;
  const ok = await runPlan(() => {
    const ops = detachInstanceOps(raw, id);
    const op = ops[0];
    if (op?.type === 'replaceNode') newId = op.node.id;
    return ops;
  });
  if (ok && newId) ui.select([newId]);
  return ok;
}

/** "Restaurar": remove os overrides da instância. */
export function resetInstance(id: string): Promise<boolean> {
  const raw = getRawDoc();
  return raw ? runPlan(() => resetInstanceOps(raw, id)) : Promise.resolve(false);
}

/** "Enviar ao principal": grava os overrides no principal e limpa os da instância. */
export function pushToMain(id: string): Promise<boolean> {
  const raw = getRawDoc();
  return raw ? runPlan(() => pushOverridesToMainOps(raw, id)) : Promise.resolve(false);
}

/** Valor efetivo da prop na instância (o da instância ou o padrão). */
export function propValueOf(node: Node, p: PropDef): PropValue | undefined {
  return node.props?.[p.name] ?? p.default;
}

/** Op que define a prop (ou remove, quando volta ao padrão). */
export function setPropOp(nodeId: string, p: PropDef, value: PropValue): Op {
  if (p.default !== undefined && String(p.default) === String(value)) {
    return { type: 'setInstanceProps', changes: [{ nodeId, unset: [p.name] }] };
  }
  return { type: 'setInstanceProps', changes: [{ nodeId, set: { [p.name]: value } }] };
}

export function setInstanceProp(nodeId: string, p: PropDef, value: PropValue): Promise<boolean> {
  return daemon.applySafe([setPropOp(nodeId, p, value)]).then((a) => !!a);
}

/** Principal em edição cujo nó raiz é `id` (ou `undefined`). */
export function editedComponentOf(view: Document, id: string): ComponentDef | undefined {
  const raw = getRawDoc();
  const cid = useUi.getState().editingComponentId;
  if (!raw || !cid || !isMainRoot(view, id)) return undefined;
  return getComponent(raw, cid);
}

/** Atualiza nome/descrição/props do principal. */
export function updateComponent(
  componentId: string,
  patch: { name?: string; description?: string | null; props?: PropDef[] },
): Promise<boolean> {
  return daemon.applySafe([{ type: 'updateComponent', componentId, ...patch }]).then((a) => !!a);
}
