/**
 * Estado vindo do daemon: conexão, documentos abertos, documento ativo, histórico e atividade do
 * agente. Só o cliente (`client/daemon.ts`) escreve aqui, a partir das mensagens do WebSocket.
 * O documento NUNCA é mutado localmente: toda edição vira `Op` enviada ao daemon.
 */
import { create } from 'zustand';
import type { Document, HistoryState, OpenDocumentInfo, Op } from '@mockup/core';
import { getEntry, getFrameOf } from '../model/tree';
import { shareStructure } from './share';

export type ConnectionStatus = 'connecting' | 'online' | 'offline';

export interface DocState {
  status: ConnectionStatus;
  documents: OpenDocumentInfo[];
  activeDocId: string | null;
  /** Documento ativo (com compartilhamento estrutural entre versões). */
  doc: Document | null;
  revision: number;
  history: HistoryState;
  /** Cache dos documentos conhecidos (por id). */
  docs: Record<string, Document>;
  /** Histórico por documento (por id). */
  histories: Record<string, HistoryState>;
  /** frameId → timestamp (ms) da última op do MCP que tocou o frame. */
  agentActivity: Record<string, number>;
}

export const NO_HISTORY: HistoryState = { canUndo: false, canRedo: false };

export const useDoc = create<DocState>(() => ({
  status: 'connecting',
  documents: [],
  activeDocId: null,
  doc: null,
  revision: 0,
  history: NO_HISTORY,
  docs: {},
  histories: {},
  agentActivity: {},
}));

/** Info do documento ativo (nome, caminho, dirty). */
export function selectActiveInfo(s: DocState): OpenDocumentInfo | undefined {
  return s.documents.find((d) => d.docId === s.activeDocId);
}

/** Ids de nós tocados por uma op (para o badge "agente trabalhando"). */
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
      return op.changes.map((c) => c.nodeId);
    default:
      return [];
  }
}

/** Frames raiz tocados pelas ops (procurados no doc novo e, para exclusões, no anterior). */
export function touchedFrameIds(ops: Op[], next: Document, prev: Document | null): string[] {
  const frames = new Set<string>();
  for (const op of ops) {
    for (const id of touchedNodeIds(op)) {
      const doc = getEntry(next, id) ? next : prev && getEntry(prev, id) ? prev : null;
      const frame = doc ? getFrameOf(doc, id) : undefined;
      if (frame && getEntry(next, frame.id)) frames.add(frame.id);
    }
  }
  return [...frames];
}

/** Integra um documento recebido do daemon reaproveitando a estrutura da versão anterior. */
export function mergeDoc(prev: Document | undefined, next: Document): Document {
  return prev && prev.id === next.id ? shareStructure(prev, next) : next;
}
