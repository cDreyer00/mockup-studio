/** Copy, cut and paste nodes via the document's `copy`/`cut`/`paste` events. */
import { useEffect } from 'react';
import type { Node, Op } from '@mockup/core';
import { actions } from '../actions';
import { daemon } from '../client/daemon';
import { canvasApi } from '../canvas/canvasApi';
import { insertImageFile } from '../canvas/imageTool';
import { makeText } from '../model/factory';
import { isLockedDeep, topLevel } from '../model/tree';
import { copyableNode } from '../components/model';
import { useDoc } from '../state/docStore';
import { currentPageId } from '../state/hooks';
import { ui, useUi } from '../state/uiStore';
import { pasteSnapshot } from '../snapshot/pasteSnapshot';
import { isEditableTarget, isInteractionBlocked } from '../shortcuts/guards';
import {
  classifyPaste,
  htmlToPasteNodes,
  looksLikeHtml,
  prepareNodesForPaste,
  resolvePasteTarget,
  serializeNodes,
  withVectors,
} from './paste';

interface InternalClipboard {
  token: string;
  nodes: Node[];
  /** How many times it has already been pasted (shifts each new paste). */
  pastes: number;
}

let internal: InternalClipboard | null = null;

function newToken(): string {
  return (
    globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`
  );
}

/**
 * Copies the top-level selection; `false` if there is nothing to copy. On cut (`editableOnly`), locked
 * nodes are left out: `deleteSelection` does not delete them and pasting later would duplicate them.
 * Exported for tests.
 */
export function copySelection(e: ClipboardEvent, editableOnly = false): boolean {
  const { doc } = useDoc.getState();
  if (!doc) return false;
  let ids = topLevel(doc, useUi.getState().selection);
  if (editableOnly) {
    const total = ids.length;
    ids = ids.filter((id) => !isLockedDeep(doc, id));
    if (total && !ids.length) {
      e.preventDefault();
      ui.toast('Locked nodes cannot be cut');
      return false;
    }
  }
  if (!ids.length) return false;
  const nodes: Node[] = [];
  // Instances are copied as instances (real node); internal nodes, as the concrete tree.
  const raw = useDoc.getState().rawDoc;
  for (const id of ids) {
    const n = copyableNode(raw, doc, id);
    if (n) nodes.push(n);
  }
  if (!nodes.length) return false;
  const token = newToken();
  internal = { token, nodes, pastes: 0 };
  const html = serializeNodes(nodes, token);
  e.clipboardData?.setData('text/html', html);
  e.clipboardData?.setData('text/plain', html);
  e.preventDefault();
  return true;
}

/** Pastes `nodes` (with their original ids) at the target derived from the selection; selects the pasted ones. */
async function pasteNodes(
  nodes: Node[],
  pasteCount: number,
  extraOps: Op[] = [],
): Promise<boolean> {
  const { doc } = useDoc.getState();
  if (!doc || !nodes.length) return false;
  const target = resolvePasteTarget(doc, useUi.getState().selection, currentPageId());
  if (!target) return false;
  const prepared = prepareNodesForPaste(nodes, target, {
    center: canvasApi.viewportCenter(),
    pasteCount,
    measure: (id) => {
      const r = canvasApi.nodeRect(id);
      return r ? { w: r.w, h: r.h } : null;
    },
  });
  const ops: Op[] = prepared.map((node, i) => ({
    type: 'createNode' as const,
    node,
    ...(target.parentId
      ? { parentId: target.parentId }
      : { parentId: null, pageId: target.pageId }),
    ...(target.index !== undefined ? { index: target.index + i } : {}),
  }));
  if (!(await daemon.applySafe([...extraOps, ...ops]))) return false;
  ui.select(prepared.map((n) => n.id));
  return true;
}

async function handlePaste(data: DataTransfer): Promise<void> {
  const html = data.getData('text/html');
  const text = data.getData('text/plain');
  const images = [...(data.files ?? [])].filter((f) => f.type.startsWith('image/'));
  const kind = classifyPaste({ html, text, imageCount: images.length }, internal?.token ?? null);
  try {
    switch (kind) {
      case 'internal':
        if (internal) await pasteNodes(internal.nodes, internal.pastes++);
        return;
      case 'snapshot':
        await pasteSnapshot(text);
        return;
      case 'images':
        for (const file of images) await insertImageFile(file);
        return;
      case 'html': {
        const { doc } = useDoc.getState();
        if (!doc) return;
        const pasted = await htmlToPasteNodes(looksLikeHtml(html) ? html : text, doc);
        if ((await pasteNodes(withVectors(pasted.nodes), 0, pasted.ops)) && pasted.notes.length) {
          ui.toast(pasted.notes.join(' '));
        }
        return;
      }
      case 'text':
        await pasteNodes([makeText({ text })], 0);
        return;
      default:
        return;
    }
  } catch (e) {
    ui.toast(`Could not paste: ${(e as Error).message}`, 'error');
  }
}

export function useClipboard(): void {
  useEffect(() => {
    const skip = (e: Event): boolean => isEditableTarget(e.target) || isInteractionBlocked();
    const onCopy = (e: ClipboardEvent) => {
      if (!skip(e)) copySelection(e);
    };
    const onCut = (e: ClipboardEvent) => {
      if (skip(e)) return;
      if (copySelection(e, true)) void actions.deleteSelection();
    };
    const onPaste = (e: ClipboardEvent) => {
      if (skip(e) || !e.clipboardData) return;
      e.preventDefault();
      void handlePaste(e.clipboardData);
    };
    document.addEventListener('copy', onCopy);
    document.addEventListener('cut', onCut);
    document.addEventListener('paste', onPaste);
    return () => {
      document.removeEventListener('copy', onCopy);
      document.removeEventListener('cut', onCut);
      document.removeEventListener('paste', onPaste);
    };
  }, []);
}
