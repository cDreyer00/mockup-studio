/**
 * State coming from the daemon: connection, open documents, active document, history and agent
 * activity. Only the client (`client/daemon.ts`) writes here, from the WebSocket messages.
 * The document is NEVER mutated locally: every edit becomes an `Op` sent to the daemon.
 */
import { create } from 'zustand';
import { listInstances, splitVirtualId } from '@mockup/core';
import type { Document, HistoryState, OpenDocumentInfo, Op } from '@mockup/core';
import { buildView } from '../components/model';
import { getEntry, getFrameOf } from '../model/tree';
import { shareStructure } from './share';
import { useUi } from './uiStore';

export type ConnectionStatus = 'connecting' | 'online' | 'offline';

export interface DocState {
  status: ConnectionStatus;
  /**
   * Incremented on each `hello` (every connection or reconnection to the daemon): whoever loads data
   * over HTTP (e.g. the home screen file list) reloads when it changes.
   */
  connectionEpoch: number;
  documents: OpenDocumentInfo[];
  activeDocId: string | null;
  /**
   * View of the active document: expanded component instances and, in main component edit
   * mode, the synthetic page (see `components/model.ts`). It is what the canvas, layers, selection and
   * properties use. With structural sharing between versions.
   */
  doc: Document | null;
  /** Active document as the daemon stores it (instances not expanded). For the planners. */
  rawDoc: Document | null;
  revision: number;
  history: HistoryState;
  /** Cache of known documents (by id). */
  docs: Record<string, Document>;
  /** History per document (by id). */
  histories: Record<string, HistoryState>;
  /** frameId → timestamp (ms) of the last MCP op that touched the frame. */
  agentActivity: Record<string, number>;
}

export const NO_HISTORY: HistoryState = { canUndo: false, canRedo: false };

export const useDoc = create<DocState>(() => ({
  status: 'connecting',
  connectionEpoch: 0,
  documents: [],
  activeDocId: null,
  doc: null,
  rawDoc: null,
  revision: 0,
  history: NO_HISTORY,
  docs: {},
  histories: {},
  agentActivity: {},
}));

/* ---------------- view (expanded instances + edit mode) ---------------- */

let memo: { raw: Document; key: string; view: Document } | null = null;

/**
 * View of `raw` for the current UI state (main component being edited). Memoized by the document
 * object and the mode; reuses the objects of the previous view (`prev`) that did not change, so
 * that the nodes' `React.memo` also works in the expanded trees.
 */
export function viewOf(raw: Document, prev: Document | null = useDoc.getState().doc): Document {
  const u = useUi.getState();
  const editing = u.editingComponentId;
  const ce = u.componentEdit;
  const background = ce?.fromPageId
    ? (raw.pages.find((p) => p.id === ce.fromPageId)?.background ?? null)
    : null;
  const key = editing ? `${editing}|${ce?.width ?? ''}|${background ?? ''}` : '';
  if (memo && memo.raw === raw && memo.key === key) return memo.view;
  let view = buildView(
    raw,
    editing ? { componentId: editing, width: ce?.width ?? null, background } : null,
  );
  if (view !== raw && prev && prev !== raw && prev.id === view.id)
    view = shareStructure(prev, view);
  memo = { raw, key, view };
  return view;
}

/** `rawDoc` + `doc` (view) fields to write the active document into the store. */
export function withView(raw: Document | null): Pick<DocState, 'rawDoc' | 'doc'> {
  return { rawDoc: raw, doc: raw ? viewOf(raw) : null };
}

/** Real active document (falls back to the view when only it was set, as in old tests). */
export function getRawDoc(): Document | null {
  const s = useDoc.getState();
  return s.rawDoc ?? s.doc;
}

// Entering/leaving edit mode (or changing its width) recomputes the view.
useUi.subscribe((s, p) => {
  if (s.editingComponentId === p.editingComponentId && s.componentEdit === p.componentEdit) return;
  const raw = useDoc.getState().rawDoc;
  if (raw) useDoc.setState({ doc: viewOf(raw) });
});

/** Active document info (name, path, dirty). */
export function selectActiveInfo(s: DocState): OpenDocumentInfo | undefined {
  return s.documents.find((d) => d.docId === s.activeDocId);
}

/** Ids of nodes touched by an op (for the "agent working" badge). */
export function touchedNodeIds(op: Op): string[] {
  switch (op.type) {
    case 'createNode':
      return [op.node.id, ...(op.parentId ? [op.parentId] : [])];
    case 'deleteNodes':
    case 'duplicateNodes':
      return [
        ...op.nodeIds,
        ...(op.type === 'duplicateNodes' ? Object.values(op.idMap ?? {}) : []),
      ];
    case 'moveNodes':
      return [...op.nodeIds, ...(op.parentId ? [op.parentId] : [])];
    case 'updateStyles':
      return [...(op.changes ?? []).map((c) => c.nodeId), ...(op.nodeIds ?? [])];
    case 'setText':
    case 'setAttrs':
    case 'renameNodes':
    case 'setPosition':
    case 'setNodeFlags':
    case 'setTag':
    case 'setInstanceProps':
    case 'setInstanceOverrides':
      return op.changes.map((c) => c.nodeId);
    case 'replaceNode':
      return [op.nodeId, op.node.id];
    default:
      return [];
  }
}

/** Real ids touched: virtual ids (`in_x/path`) count as the owning instance. */
function realTouchedIds(op: Op, next: Document): string[] {
  const ids = touchedNodeIds(op).map((id) => splitVirtualId(id)?.instanceId ?? id);
  // Changing a main component touches all frames with instances of it.
  if (op.type === 'updateComponent') {
    for (const ref of listInstances(next, op.componentId)) if (ref.pageId) ids.push(ref.node.id);
  }
  return ids;
}

/** Root frames touched by the ops (looked up in the new doc and, for deletions, in the previous one). */
export function touchedFrameIds(ops: Op[], next: Document, prev: Document | null): string[] {
  const frames = new Set<string>();
  for (const op of ops) {
    for (const id of realTouchedIds(op, next)) {
      const doc = getEntry(next, id) ? next : prev && getEntry(prev, id) ? prev : null;
      const frame = doc ? getFrameOf(doc, id) : undefined;
      if (frame && getEntry(next, frame.id)) frames.add(frame.id);
    }
  }
  return [...frames];
}

/** Integrates a document received from the daemon, reusing the structure of the previous version. */
export function mergeDoc(prev: Document | undefined, next: Document): Document {
  return prev && prev.id === next.id ? shareStructure(prev, next) : next;
}
