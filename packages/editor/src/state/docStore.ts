/**
 * Estado vindo do daemon: conexão, documentos abertos, documento ativo, histórico e atividade do
 * agente. Só o cliente (`client/daemon.ts`) escreve aqui, a partir das mensagens do WebSocket.
 * O documento NUNCA é mutado localmente: toda edição vira `Op` enviada ao daemon.
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
  documents: OpenDocumentInfo[];
  activeDocId: string | null;
  /**
   * Visão do documento ativo: instâncias de componentes expandidas e, no modo de edição do
   * principal, a página sintética (ver `components/model.ts`). É o que canvas, camadas, seleção e
   * propriedades usam. Com compartilhamento estrutural entre versões.
   */
  doc: Document | null;
  /** Documento ativo como o daemon o guarda (instâncias não expandidas). Para os planejadores. */
  rawDoc: Document | null;
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
  rawDoc: null,
  revision: 0,
  history: NO_HISTORY,
  docs: {},
  histories: {},
  agentActivity: {},
}));

/* ---------------- visão (instâncias expandidas + modo de edição) ---------------- */

let memo: { raw: Document; key: string; view: Document } | null = null;

/**
 * Visão de `raw` para o estado atual da interface (principal em edição). Memoizada pelo objeto do
 * documento e pelo modo; reaproveita os objetos da visão anterior (`prev`) que não mudaram, para
 * que o `React.memo` dos nós funcione também nas árvores expandidas.
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

/** Campos `rawDoc` + `doc` (visão) para gravar o documento ativo no store. */
export function withView(raw: Document | null): Pick<DocState, 'rawDoc' | 'doc'> {
  return { rawDoc: raw, doc: raw ? viewOf(raw) : null };
}

/** Documento real ativo (cai na visão quando só ela foi definida, como em testes antigos). */
export function getRawDoc(): Document | null {
  const s = useDoc.getState();
  return s.rawDoc ?? s.doc;
}

// Entrar/sair do modo de edição (ou mudar a largura dele) recalcula a visão.
useUi.subscribe((s, p) => {
  if (s.editingComponentId === p.editingComponentId && s.componentEdit === p.componentEdit) return;
  const raw = useDoc.getState().rawDoc;
  if (raw) useDoc.setState({ doc: viewOf(raw) });
});

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
    case 'setInstanceProps':
    case 'setInstanceOverrides':
      return op.changes.map((c) => c.nodeId);
    case 'replaceNode':
      return [op.nodeId, op.node.id];
    default:
      return [];
  }
}

/** Ids reais tocados: ids virtuais (`in_x/caminho`) contam como a instância dona. */
function realTouchedIds(op: Op, next: Document): string[] {
  const ids = touchedNodeIds(op).map((id) => splitVirtualId(id)?.instanceId ?? id);
  // Mudar um principal toca todos os frames com instâncias dele.
  if (op.type === 'updateComponent') {
    for (const ref of listInstances(next, op.componentId)) if (ref.pageId) ids.push(ref.node.id);
  }
  return ids;
}

/** Frames raiz tocados pelas ops (procurados no doc novo e, para exclusões, no anterior). */
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

/** Integra um documento recebido do daemon reaproveitando a estrutura da versão anterior. */
export function mergeDoc(prev: Document | undefined, next: Document): Document {
  return prev && prev.id === next.id ? shareStructure(prev, next) : next;
}
