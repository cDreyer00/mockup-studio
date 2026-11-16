import { useCallback, useEffect, useReducer, useRef } from 'react';
import type { ClientMessage, Document, OpenDocumentInfo, ServerMessage } from '@mockup/core';

export type ConnectionStatus = 'connecting' | 'online' | 'offline';

export interface DaemonState {
  status: ConnectionStatus;
  documents: OpenDocumentInfo[];
  activeDocId: string | null;
  doc: Document | null;
  selection: string[];
  revision: number;
  /** Cache dos documentos conhecidos, para trocar o ativo sem novo fetch. */
  docs: Record<string, Document>;
}

const initial: DaemonState = {
  status: 'connecting',
  documents: [],
  activeDocId: null,
  doc: null,
  selection: [],
  revision: 0,
  docs: {},
};

type Action = { kind: 'status'; status: ConnectionStatus } | { kind: 'msg'; msg: ServerMessage };

/** Mensagem do cliente sem `reqId` (gerado em `send`), distribuída por membro da união. */
export type NewClientMessage = ClientMessage extends infer M
  ? M extends ClientMessage
    ? Omit<M, 'reqId'>
    : never
  : never;

function patchInfo(
  docs: OpenDocumentInfo[],
  docId: string,
  patch: Partial<OpenDocumentInfo>,
): OpenDocumentInfo[] {
  return docs.map((d) => (d.docId === docId ? { ...d, ...patch } : d));
}

function reducer(state: DaemonState, action: Action): DaemonState {
  if (action.kind === 'status') {
    return { ...state, status: action.status };
  }
  const msg = action.msg;
  switch (msg.type) {
    case 'hello':
      return {
        ...state,
        documents: msg.documents,
        activeDocId: msg.activeDocId,
        doc: msg.doc,
        selection: msg.selection,
        revision: msg.revision,
        docs: msg.doc ? { ...state.docs, [msg.doc.id]: msg.doc } : state.docs,
      };
    case 'doc:opened': {
      const documents = [...state.documents.filter((d) => d.docId !== msg.info.docId), msg.info];
      const docs = { ...state.docs, [msg.info.docId]: msg.doc };
      const isActive = state.activeDocId === msg.info.docId;
      return { ...state, documents, docs, doc: isActive ? msg.doc : state.doc };
    }
    case 'doc:changed': {
      const docs = { ...state.docs, [msg.docId]: msg.doc };
      const isActive = state.activeDocId === msg.docId;
      return {
        ...state,
        docs,
        documents: patchInfo(state.documents, msg.docId, { dirty: true, revision: msg.revision }),
        doc: isActive ? msg.doc : state.doc,
        revision: isActive ? msg.revision : state.revision,
      };
    }
    case 'doc:saved':
      return {
        ...state,
        documents: patchInfo(state.documents, msg.docId, { dirty: false, path: msg.path }),
      };
    case 'doc:closed': {
      const docs = { ...state.docs };
      delete docs[msg.docId];
      const wasActive = state.activeDocId === msg.docId;
      return {
        ...state,
        docs,
        documents: state.documents.filter((d) => d.docId !== msg.docId),
        activeDocId: wasActive ? null : state.activeDocId,
        doc: wasActive ? null : state.doc,
        selection: wasActive ? [] : state.selection,
      };
    }
    case 'selection:changed':
      return msg.docId === state.activeDocId ? { ...state, selection: msg.nodeIds } : state;
    case 'active:changed':
      return {
        ...state,
        activeDocId: msg.docId,
        doc: msg.docId ? (state.docs[msg.docId] ?? null) : null,
        selection: [],
      };
    default:
      return state;
  }
}

function socketUrl(): string {
  const custom = import.meta.env.VITE_DAEMON_URL as string | undefined;
  if (custom) return custom;
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  return `${proto}://${location.host}/ws`;
}

/** Conecta ao daemon, reconecta com backoff (1 s → 10 s) e reduz as mensagens em estado. */
export function useDaemon() {
  const [state, dispatch] = useReducer(reducer, initial);
  const wsRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    let closed = false;
    let delay = 1000;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const connect = () => {
      dispatch({ kind: 'status', status: 'connecting' });
      const ws = new WebSocket(socketUrl());
      wsRef.current = ws;
      ws.onopen = () => {
        delay = 1000;
        dispatch({ kind: 'status', status: 'online' });
      };
      ws.onmessage = (ev) => {
        try {
          dispatch({ kind: 'msg', msg: JSON.parse(String(ev.data)) as ServerMessage });
        } catch {
          /* mensagem inválida: ignora */
        }
      };
      ws.onclose = () => {
        if (closed) return;
        dispatch({ kind: 'status', status: 'offline' });
        timer = setTimeout(connect, delay);
        delay = Math.min(delay * 2, 10000);
      };
      ws.onerror = () => ws.close();
    };

    connect();
    return () => {
      closed = true;
      clearTimeout(timer);
      wsRef.current?.close();
    };
  }, []);

  // `hello` traz só o documento ativo: ao trocar para um documento que ainda não está no cache,
  // busca o completo em `/api/docs/:id` e injeta como `doc:opened`.
  const { activeDocId, doc, status } = state;
  useEffect(() => {
    if (!activeDocId || doc || status !== 'online') return;
    let cancelled = false;
    fetch(`/api/docs/${encodeURIComponent(activeDocId)}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((data: { info: OpenDocumentInfo; doc: Document } | null) => {
        if (!cancelled && data?.doc) {
          dispatch({ kind: 'msg', msg: { type: 'doc:opened', info: data.info, doc: data.doc } });
        }
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [activeDocId, doc, status]);

  /** Envia uma mensagem ao daemon, gerando o `reqId`. */
  const send = useCallback((msg: NewClientMessage) => {
    const ws = wsRef.current;
    if (ws?.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({ ...msg, reqId: crypto.randomUUID() }));
  }, []);

  return { ...state, send };
}
