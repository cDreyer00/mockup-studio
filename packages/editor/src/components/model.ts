/**
 * Components in the editor (see `docs/COMPONENTS.md`, Editor section): the document view with
 * instances expanded, the synthetic page of the main component edit mode, the role of each node
 * (instance, internal node, slot, main) and the rules for what can be moved/inserted.
 *
 * The canvas, layers, selection and properties work on the view (`useDoc().doc`); the core
 * planners (`createComponentOps`, `instanceNodeFor`, `detachInstanceOps`...) receive the real
 * document (`useDoc().rawDoc`).
 */
import {
  COMPONENT_EDIT_PAGE_ID,
  SLOT_ATTR,
  expandDocument,
  expandNodeTree,
  findComponentNode,
  findNode,
  getComponent,
  isVirtualId,
} from '@mockup/core';
import type { Document, Node, Page } from '@mockup/core';
import { canHaveChildren, getEntry, getNode } from '../model/tree';

/** Synthetic (non-editable) frame that wraps the main component root in edit mode. */
export const COMPONENT_FRAME_ID = 'fr__component';
/** Padding between the edit mode frame and the main component root. */
export const COMPONENT_FRAME_PADDING = 48;

/** Parameters of the isolated edit mode of the main component. */
export interface ComponentEditView {
  componentId: string;
  /** Width (px) of the main component area: that of the origin instance, when known. */
  width: number | null;
  /** Background of the synthetic page (that of the page it was entered from). */
  background: string | null;
}

/** Synthetic frame with the main component root (nested instances expanded). */
function componentFrame(raw: Document, root: Node, name: string, width: number | null): Node {
  const pad = COMPONENT_FRAME_PADDING;
  return {
    id: COMPONENT_FRAME_ID,
    type: 'frame',
    name: `Component ${name}`,
    tag: 'div',
    attrs: { 'data-component-frame': '' },
    style: {
      width: width ? `${Math.round(width + pad * 2)}px` : 'max-content',
      'min-width': '240px',
      padding: `${pad}px`,
      'box-sizing': 'border-box',
      display: 'flex',
      'flex-direction': 'column',
      'align-items': width ? 'stretch' : 'flex-start',
      overflow: 'visible',
      'box-shadow': 'none',
      background: 'transparent',
    },
    children: [expandNodeTree(raw, root)],
    locked: false,
    hidden: false,
    position: { x: 0, y: 0 },
  };
}

/**
 * Document view: expanded instances (`expandDocument`, cached) and, in edit mode, a synthetic
 * page `COMPONENT_EDIT_PAGE_ID` with the main component. With no instances and no editing,
 * returns `raw` itself.
 */
export function buildView(raw: Document, edit: ComponentEditView | null): Document {
  const expanded = expandDocument(raw);
  const def = edit ? getComponent(raw, edit.componentId) : undefined;
  if (!edit || !def) return expanded;
  const page: Page = {
    id: COMPONENT_EDIT_PAGE_ID,
    name: def.name,
    frames: [componentFrame(raw, def.root, def.name, edit.width)],
    background: edit.background ?? raw.pages[0]?.background ?? '',
  };
  return { ...expanded, pages: [...expanded.pages, page] };
}

/* ------------------------------------------------------------------ */
/* node roles                                                         */
/* ------------------------------------------------------------------ */

/**
 * - `instance`: root of an instance (`componentId` marker in the expanded tree);
 * - `internal`: node coming from the tree of a main component (virtual id): style/text become overrides;
 * - `slot`: slot container of an instance (real node; its content is regular);
 * - `main`: node of the main component being edited (synthetic page);
 * - `frame`: the synthetic edit mode frame.
 */
export type ComponentRole = 'instance' | 'internal' | 'slot' | 'main' | 'frame';

export function componentRole(doc: Document | null, id: string): ComponentRole | null {
  if (!doc) return null;
  if (id === COMPONENT_FRAME_ID) return 'frame';
  const e = getEntry(doc, id);
  if (!e) return null;
  if (isVirtualId(id)) return 'internal';
  if (e.node.componentId !== undefined) return 'instance';
  if (e.pageId === COMPONENT_EDIT_PAGE_ID) return 'main';
  if (e.node.attrs[SLOT_ATTR] !== undefined && e.parentId) {
    const parent = getNode(doc, e.parentId);
    if (isVirtualId(e.parentId) || parent?.componentId !== undefined) return 'slot';
  }
  return null;
}

/** Roles drawn in purple on the canvas (hover/selection outline). */
export function isPurpleRole(role: ComponentRole | null): boolean {
  return role === 'instance' || role === 'internal' || role === 'main' || role === 'slot';
}

/** Root of the main component being edited (child of the synthetic frame). */
export function isMainRoot(doc: Document, id: string): boolean {
  const e = getEntry(doc, id);
  return !!e && e.pageId === COMPONENT_EDIT_PAGE_ID && e.parentId === COMPONENT_FRAME_ID;
}

/** Real instance (expanded root with a real id) in the view. */
export function isRealInstance(doc: Document, id: string): boolean {
  return !isVirtualId(id) && getNode(doc, id)?.componentId !== undefined;
}

/**
 * Message when move, reorder, delete, duplicate or group does not apply to one of the nodes;
 * `null` when it is allowed.
 */
export function structureBlock(doc: Document, ids: readonly string[]): string | null {
  for (const id of ids) {
    if (id === COMPONENT_FRAME_ID) return 'The component frame is not editable';
    if (isVirtualId(id)) {
      return 'Internal nodes of an instance cannot be moved, duplicated or deleted: edit the main component or detach the instance';
    }
    if (isMainRoot(doc, id)) return 'The main component root cannot be moved or deleted';
    if (componentRole(doc, id) === 'slot') {
      return 'The slot container is part of the instance: move or delete its content';
    }
  }
  return null;
}

/**
 * Does the node accept new children (create, paste, drop)? No: internal nodes, instance roots (they
 * only accept content inside a slot) and the synthetic frame.
 */
export function canInsertInto(doc: Document, id: string): boolean {
  if (id === COMPONENT_FRAME_ID || isVirtualId(id)) return false;
  const n = getNode(doc, id);
  if (!n || n.componentId !== undefined) return false;
  return canHaveChildren(n);
}

/** Removes instance markers from concrete nodes (copied expanded tree). */
function stripMarkers(n: Node): Node {
  const out: Node = { ...n, children: n.children.map(stripMarkers) };
  if (out.type !== 'instance') {
    delete out.componentId;
    delete out.props;
    delete out.overrides;
  }
  return out;
}

/**
 * Node to copy: the real document node when it exists (instances stay instances); internal
 * nodes come out as the concrete tree of the view (without markers).
 */
export function copyableNode(raw: Document | null, view: Document, id: string): Node | undefined {
  if (raw && !isVirtualId(id)) {
    const real = findNode(raw, id)?.node ?? findComponentNode(raw, id)?.node;
    if (real) return structuredClone(real);
  }
  const n = getNode(view, id);
  return n ? structuredClone(stripMarkers(n)) : undefined;
}
