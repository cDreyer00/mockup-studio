/**
 * Component reading and rendering in the daemon: resolves ids that do not exist as "loose" nodes on
 * the pages (virtual ids `in_x/path`, nodes of a main component tree and `cp_...`) and builds the
 * documents consumed by the renderer and the exporters (instances already expanded).
 */
import {
  COMPONENT_EDIT_PAGE_ID,
  createNodeFromTag,
  expandDocument,
  expandNodeTree,
  findComponentNode,
  findNode,
  getComponent,
  instanceNodeFor,
  type ComponentDef,
  type Document,
  type NodePath,
} from '@mockup/core';

const tempDocs = new WeakMap<Document, Map<string, Document>>();

/**
 * Temporary document just to READ a main component tree: one page with the main component root
 * (nested instances expanded, `{{prop}}` intact). Cached per document.
 */
export function componentTempDoc(doc: Document, def: ComponentDef): Document {
  let byId = tempDocs.get(doc);
  if (!byId) {
    byId = new Map();
    tempDocs.set(doc, byId);
  }
  const hit = byId.get(def.id);
  if (hit) return hit;
  const temp: Document = {
    ...doc,
    pages: [
      {
        id: COMPONENT_EDIT_PAGE_ID,
        name: `Main ${def.name}`,
        background: '#ffffff',
        frames: [expandNodeTree(doc, def.root)],
      },
    ],
  };
  byId.set(def.id, temp);
  return temp;
}

export interface ReadResolution {
  path: NodePath;
  /** Document where `path` lives: the expanded one, or a main component's temporary one. */
  doc: Document;
  /** Main component owning the node, when the id belongs to a node of a main component tree. */
  component?: ComponentDef;
}

/**
 * Finds the node for READING: first in the expanded document (real nodes, expanded instances and
 * virtual ids), then among the nodes of a main component tree.
 */
export function resolveRead(doc: Document, id: string): ReadResolution | undefined {
  const expanded = expandDocument(doc);
  const p = findNode(expanded, id);
  if (p) return { path: p, doc: expanded };
  // `cp_...` counts as the main component root
  const nodeId = getComponent(doc, id)?.root.id ?? id;
  const c = findComponentNode(doc, nodeId);
  if (!c) return undefined;
  const temp = componentTempDoc(doc, c.component);
  const path = findNode(temp, nodeId);
  return path ? { path, doc: temp, component: c.component } : undefined;
}

/**
 * Document where the nodes `ids` exist, for callers that build ops by reading the node (data,
 * placeholder, outlines, boolean ops): the document itself (real nodes), the expanded one (virtual
 * ids `in_x/...`; the ops route to overrides) or a main component's temporary one (the ops edit
 * the main component).
 */
export function docWithNodes(doc: Document, ids: readonly string[]): Document {
  if (ids.every((id) => findNode(doc, id))) return doc;
  const expanded = expandDocument(doc);
  const missing = ids.find((id) => !findNode(expanded, id));
  if (missing === undefined) return expanded;
  return resolveRead(doc, missing)?.doc ?? doc;
}

const PREVIEW_INSTANCE_ID = 'in_preview0';
const PREVIEW_FRAME_ID = 'fr_preview0';

/**
 * Preview document of a main component: one page with a frame containing a default instance
 * (default props, empty slots), already expanded. `instanceId` is the instance id in the preview.
 */
export function componentPreviewDoc(
  doc: Document,
  def: ComponentDef,
): { doc: Document; instanceId: string } {
  const instance = instanceNodeFor(doc, def.id, { id: PREVIEW_INSTANCE_ID });
  const frame = createNodeFromTag('div', {
    isRoot: true,
    name: `Preview ${def.name}`,
    styles: {
      width: '960px',
      display: 'flex',
      'flex-direction': 'column',
      'align-items': 'flex-start',
      padding: '24px',
      background: '#ffffff',
    },
    position: { x: 0, y: 0 },
  });
  frame.id = PREVIEW_FRAME_ID;
  frame.children = [instance];
  const preview: Document = {
    ...doc,
    pages: [{ id: 'pg_preview', name: 'Preview', background: '#ffffff', frames: [frame] }],
  };
  return { doc: expandDocument(preview), instanceId: PREVIEW_INSTANCE_ID };
}

export interface RenderTarget {
  /** Document to hand to the `RenderProvider` (instances expanded). */
  doc: Document;
  nodeId: string;
  name: string;
}

/**
 * Screenshot/measure target: real nodes and virtual ids come from the expanded document; a main
 * component (`cp_...`) or a node of its tree is rendered as a default instance in a temporary document.
 */
export function renderTargetFor(doc: Document, ref: string): RenderTarget | undefined {
  const expanded = expandDocument(doc);
  const p = findNode(expanded, ref);
  if (p) return { doc: expanded, nodeId: ref, name: p.node.name };
  const def = getComponent(doc, ref);
  if (def) {
    const prev = componentPreviewDoc(doc, def);
    return { doc: prev.doc, nodeId: prev.instanceId, name: def.name };
  }
  const c = findComponentNode(doc, ref);
  if (!c) return undefined;
  const prev = componentPreviewDoc(doc, c.component);
  return {
    doc: prev.doc,
    nodeId: c.parent ? `${prev.instanceId}/${ref}` : prev.instanceId,
    name: c.node.name,
  };
}
