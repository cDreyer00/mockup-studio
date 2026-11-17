/**
 * Component commands (create from selection, insert instance, detach, reset, push to main,
 * props). The core planners receive the real document (`getRawDoc()`); each command goes to the
 * daemon in a single call (= one undo entry).
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
/* create component                                                   */
/* ------------------------------------------------------------------ */

/** Reason for not creating a component from `id` (`null` = allowed). */
export function createComponentBlock(view: Document, id: string): string | null {
  if (isVirtualId(id))
    return 'Internal nodes of an instance cannot become a component: detach the instance first';
  const e = getEntry(view, id);
  if (!e) return 'Select a node';
  if (e.pageId === COMPONENT_EDIT_PAGE_ID) return 'Create components from nodes on the pages';
  if (e.parentId === null)
    return 'Root frames cannot become a component: select a node inside the frame';
  if (e.node.componentId !== undefined) return 'The node is already a component instance';
  return null;
}

/** Ctrl+Alt+K: turns the selected node into a component (the node becomes the first instance). */
export async function createComponentFromSelection(): Promise<boolean> {
  const view = useDoc.getState().doc;
  const raw = getRawDoc();
  if (!view || !raw) return false;
  const sel = topLevel(view, useUi.getState().selection);
  if (sel.length !== 1) {
    ui.toast('Select a node to create the component');
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
    `Component "${name?.type === 'addComponent' ? name.component.name : ''}" created (Ctrl+Alt+K)`,
  );
  return true;
}

/* ------------------------------------------------------------------ */
/* insert instance                                                    */
/* ------------------------------------------------------------------ */

/** Where to insert without a drop point: inside the selection (if it accepts), next to it or in the frame. */
export function insertTargetFromSelection(
  view: Document,
  selection: readonly string[],
  pageId: string | null,
): { parentId: string; index?: number } | null {
  const sel = topLevel(view, selection);
  const first = sel[0];
  if (first) {
    if (canInsertInto(view, first) && sel.length === 1) return { parentId: first };
    // Walks up to a parent that accepts children, inserting right after the node.
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
  /** Source kit: imports the component (and the missing tokens) if it is not yet in the document. */
  kit?: string;
  props?: Record<string, PropValue>;
  /** Drop point (world and window); without it, uses the selection. */
  drop?: { world: { x: number; y: number }; client: { x: number; y: number } };
}

/**
 * Inserts an instance of `componentId` in a single call: imports the kit (if needed) and creates
 * the node computed on the document with the kit already applied locally. Returns the instance id.
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
      // Only the missing components (by kit id): main components already imported, edited or
      // renamed stay as they are.
      const imported = importKitOps(raw, kit, opts.kit, { onlyMissing: true }).ops;
      ops.push(...imported);
      base = applyOps(raw, imported).doc;
    }
    if (!getComponent(base, componentId)) throw new Error(`Component "${componentId}" not found`);

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
        ui.toast('Create a frame (F) to insert the component');
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
      // Dropped outside any frame: a new frame around the instance.
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
/* selected instance                                                  */
/* ------------------------------------------------------------------ */

/** Component of the instance (expanded root in the view) or `undefined`. */
export function componentOfNode(
  raw: Document | null,
  node: Node | undefined,
): ComponentDef | undefined {
  return raw && node?.componentId ? getComponent(raw, node.componentId) : undefined;
}

/** Overrides stored on the real instance (or `{}`). */
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

/** "Go to main": enters edit mode of the instance component. */
export function goToMain(id: string): boolean {
  const view = useDoc.getState().doc;
  const node = view ? getNode(view, id) : undefined;
  if (!node?.componentId) {
    ui.toast('Select a component instance');
    return false;
  }
  return enterComponent(node.componentId, id);
}

/** "Detach": the instance becomes regular nodes (selects the resulting node). */
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

/** "Reset": removes the instance overrides. */
export function resetInstance(id: string): Promise<boolean> {
  const raw = getRawDoc();
  return raw ? runPlan(() => resetInstanceOps(raw, id)) : Promise.resolve(false);
}

/** "Push to main": writes the overrides to the main component and clears the instance ones. */
export function pushToMain(id: string): Promise<boolean> {
  const raw = getRawDoc();
  return raw ? runPlan(() => pushOverridesToMainOps(raw, id)) : Promise.resolve(false);
}

/** Effective prop value on the instance (the instance one or the default). */
export function propValueOf(node: Node, p: PropDef): PropValue | undefined {
  return node.props?.[p.name] ?? p.default;
}

/** Op that sets the prop (or removes it, when it goes back to the default). */
export function setPropOp(nodeId: string, p: PropDef, value: PropValue): Op {
  if (p.default !== undefined && String(p.default) === String(value)) {
    return { type: 'setInstanceProps', changes: [{ nodeId, unset: [p.name] }] };
  }
  return { type: 'setInstanceProps', changes: [{ nodeId, set: { [p.name]: value } }] };
}

export function setInstanceProp(nodeId: string, p: PropDef, value: PropValue): Promise<boolean> {
  return daemon.applySafe([setPropOp(nodeId, p, value)]).then((a) => !!a);
}

/** Main component being edited whose root node is `id` (or `undefined`). */
export function editedComponentOf(view: Document, id: string): ComponentDef | undefined {
  const raw = getRawDoc();
  const cid = useUi.getState().editingComponentId;
  if (!raw || !cid || !isMainRoot(view, id)) return undefined;
  return getComponent(raw, cid);
}

/** Updates the name/description/props of the main component. */
export function updateComponent(
  componentId: string,
  patch: { name?: string; description?: string | null; props?: PropDef[] },
): Promise<boolean> {
  return daemon.applySafe([{ type: 'updateComponent', componentId, ...patch }]).then((a) => !!a);
}
