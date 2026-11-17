/** Copiar, recortar e colar nós via eventos `copy`/`cut`/`paste` do documento. */
import { useEffect } from 'react';
import { htmlToNodes } from '@mockup/core';
import type { Node } from '@mockup/core';
import { actions } from '../actions';
import { daemon } from '../client/daemon';
import { canvasApi } from '../canvas/canvasApi';
import { insertImageFile } from '../canvas/imageTool';
import { makeText } from '../model/factory';
import { getNode, isLockedDeep, topLevel } from '../model/tree';
import { useDoc } from '../state/docStore';
import { currentPageId } from '../state/hooks';
import { ui, useUi } from '../state/uiStore';
import { pasteSnapshot } from '../snapshot/pasteSnapshot';
import { isEditableTarget, isInteractionBlocked } from '../shortcuts/guards';
import {
  classifyPaste,
  looksLikeHtml,
  prepareNodesForPaste,
  resolvePasteTarget,
  serializeNodes,
  withVectors,
} from './paste';

interface InternalClipboard {
  token: string;
  nodes: Node[];
  /** Quantas vezes já foi colado (desloca cada nova colagem). */
  pastes: number;
}

let internal: InternalClipboard | null = null;

function newToken(): string {
  return (
    globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`
  );
}

/**
 * Copia a seleção de topo; `false` se não há nada a copiar. No recorte (`editableOnly`), nós
 * travados ficam de fora: o `deleteSelection` não os exclui e colar depois os duplicaria.
 * Exportada para testes.
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
      ui.toast('Nós travados não podem ser recortados');
      return false;
    }
  }
  if (!ids.length) return false;
  const nodes: Node[] = [];
  for (const id of ids) {
    const n = getNode(doc, id);
    if (n) nodes.push(structuredClone(n));
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

/** Cola `nodes` (já com ids originais) no alvo derivado da seleção; seleciona os colados. */
async function pasteNodes(nodes: Node[], pasteCount: number): Promise<void> {
  const { doc } = useDoc.getState();
  if (!doc || !nodes.length) return;
  const target = resolvePasteTarget(doc, useUi.getState().selection, currentPageId());
  if (!target) return;
  const prepared = prepareNodesForPaste(nodes, target, {
    center: canvasApi.viewportCenter(),
    pasteCount,
    measure: (id) => {
      const r = canvasApi.nodeRect(id);
      return r ? { w: r.w, h: r.h } : null;
    },
  });
  const ops = prepared.map((node, i) => ({
    type: 'createNode' as const,
    node,
    ...(target.parentId
      ? { parentId: target.parentId }
      : { parentId: null, pageId: target.pageId }),
    ...(target.index !== undefined ? { index: target.index + i } : {}),
  }));
  if (await daemon.applySafe(ops)) ui.select(prepared.map((n) => n.id));
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
        await pasteNodes(withVectors(htmlToNodes(looksLikeHtml(html) ? html : text)), 0);
        return;
      }
      case 'text':
        await pasteNodes([makeText({ text })], 0);
        return;
      default:
        return;
    }
  } catch (e) {
    ui.toast(`Não foi possível colar: ${(e as Error).message}`, 'error');
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
