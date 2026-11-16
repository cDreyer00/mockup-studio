/**
 * Cliente do daemon: WebSocket com reconexão, requisições com Promise (ack/error por `reqId`),
 * integração das mensagens nos stores e helpers HTTP (assets, recentes).
 *
 * Regra central do editor: toda mutação do documento passa por `daemon.apply(ops)`.
 */
import type {
  ClientMessage,
  Document,
  HistoryState,
  Op,
  OpenDocumentInfo,
  ServerMessage,
} from '@mockup/core';
import { getEntry } from '../model/tree';
import { NO_HISTORY, mergeDoc, touchedFrameIds, useDoc } from '../state/docStore';
import { ui, useUi } from '../state/uiStore';

/** Mensagem do cliente sem `reqId` (gerado em `request`), distribuída por membro da união. */
export type NewClientMessage = ClientMessage extends infer M
  ? M extends ClientMessage
    ? Omit<M, 'reqId'>
    : never
  : never;

export interface ApplyAck {
  revision: number;
  /** Um item por op: ex. `{ nodeIds }` em createNode, `{ idMap, nodeIds }` em duplicateNodes. */
  results: (Record<string, unknown> | null)[];
}

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

const REQUEST_TIMEOUT_MS = 15000;
/** Intervalo mínimo entre `selection:set` (o marquee muda a seleção a cada `pointermove`). */
export const SELECTION_SYNC_MS = 100;
/** Atividade do agente mais antiga que isso é descartada (o selo some bem antes). */
const AGENT_ACTIVITY_TTL_MS = 10000;

function defaultSocketUrl(): string {
  const custom = import.meta.env?.VITE_DAEMON_URL as string | undefined;
  if (custom) return custom;
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  return `${proto}://${location.host}/ws`;
}

function patchInfo(
  docs: OpenDocumentInfo[],
  docId: string,
  patch: Partial<OpenDocumentInfo>,
): OpenDocumentInfo[] {
  return docs.map((d) => (d.docId === docId ? { ...d, ...patch } : d));
}

let reqCounter = 0;
const newReqId = (): string =>
  typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `r${Date.now()}-${++reqCounter}`;

export class DaemonClient {
  private ws: WebSocket | null = null;
  private pending = new Map<string, Pending>();
  private closed = false;
  private delay = 1000;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private unsubSelection: (() => void) | null = null;
  private selectionTimer: ReturnType<typeof setTimeout> | undefined;
  private selectionSentAt = 0;

  constructor(private readonly url: () => string = defaultSocketUrl) {}

  connect(): void {
    this.closed = false;
    this.open();
    // Publica a seleção local no daemon (para `get_selection` do MCP), no máximo uma vez a cada
    // SELECTION_SYNC_MS: a primeira mudança sai logo e as seguintes são agrupadas na última.
    this.unsubSelection ??= useUi.subscribe((s, prev) => {
      if (s.selection !== prev.selection) this.scheduleSelectionSync();
    });
  }

  disconnect(): void {
    this.closed = true;
    clearTimeout(this.timer);
    clearTimeout(this.selectionTimer);
    this.selectionTimer = undefined;
    this.unsubSelection?.();
    this.unsubSelection = null;
    const ws = this.ws;
    this.ws = null;
    // Sem isso o `onclose` (que confere `this.ws`) ignora o socket e as pendentes só expiram em 15 s.
    this.rejectPending();
    ws?.close();
  }

  private rejectPending(): void {
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error('Conexão com o daemon perdida'));
      this.pending.delete(id);
    }
  }

  private scheduleSelectionSync(): void {
    if (this.selectionTimer !== undefined) return;
    const wait = Math.max(0, SELECTION_SYNC_MS - (Date.now() - this.selectionSentAt));
    this.selectionTimer = setTimeout(() => {
      this.selectionTimer = undefined;
      this.selectionSentAt = Date.now();
      const docId = useDoc.getState().activeDocId;
      if (!docId) return;
      const nodeIds = useUi.getState().selection;
      void this.request({ type: 'selection:set', docId, nodeIds }).catch(() => undefined);
    }, wait);
  }

  private open(): void {
    useDoc.setState({ status: 'connecting' });
    const ws = new WebSocket(this.url());
    this.ws = ws;
    ws.onopen = () => {
      this.delay = 1000;
      useDoc.setState({ status: 'online' });
    };
    ws.onmessage = (ev) => {
      let msg: ServerMessage;
      try {
        msg = JSON.parse(String(ev.data)) as ServerMessage;
      } catch {
        return;
      }
      this.handle(msg);
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.rejectPending();
      if (this.closed) return;
      useDoc.setState({ status: 'offline' });
      this.timer = setTimeout(() => this.open(), this.delay);
      this.delay = Math.min(this.delay * 2, 10000);
    };
    ws.onerror = () => ws.close();
  }

  /** Envia uma requisição e resolve com o `result` do ack (rejeita com a mensagem do `error`). */
  request<T = unknown>(msg: NewClientMessage): Promise<T> {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error('Sem conexão com o daemon'));
    }
    const reqId = newReqId();
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(reqId);
        reject(new Error('O daemon não respondeu a tempo'));
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(reqId, { resolve: resolve as (v: unknown) => void, reject, timer });
      ws.send(JSON.stringify({ ...msg, reqId }));
    });
  }

  /**
   * Aplica ops no documento ativo (ou em `docId`). Uma chamada = uma entrada no histórico.
   * Quando a Promise resolve, o `doc:changed` correspondente já foi integrado ao store.
   * Erros viram toast e a Promise rejeita.
   */
  async apply(ops: Op[], docId?: string): Promise<ApplyAck> {
    const id = docId ?? useDoc.getState().activeDocId;
    if (!id) throw new Error('Nenhum documento aberto');
    if (ops.length === 0) return { revision: useDoc.getState().revision, results: [] };
    try {
      return await this.request<ApplyAck>({ type: 'op:apply', docId: id, ops });
    } catch (e) {
      ui.toast(e instanceof Error ? e.message : String(e), 'error');
      throw e;
    }
  }

  /** Igual a `apply`, mas sem propagar o erro (já exibido como toast). */
  applySafe(ops: Op[], docId?: string): Promise<ApplyAck | null> {
    return this.apply(ops, docId).catch(() => null);
  }

  undo(): Promise<unknown> {
    return this.request({ type: 'undo', docId: useDoc.getState().activeDocId ?? undefined });
  }
  redo(): Promise<unknown> {
    return this.request({ type: 'redo', docId: useDoc.getState().activeDocId ?? undefined });
  }
  save(): Promise<{ path: string }> {
    return this.request({ type: 'doc:save', docId: useDoc.getState().activeDocId ?? undefined });
  }
  openDoc(path: string): Promise<OpenDocumentInfo> {
    return this.request({ type: 'doc:open', path });
  }
  newDoc(path: string, name: string): Promise<OpenDocumentInfo> {
    return this.request({ type: 'doc:new', path, name });
  }
  closeDoc(docId: string): Promise<unknown> {
    return this.request({ type: 'doc:close', docId });
  }
  setActive(docId: string): Promise<unknown> {
    return this.request({ type: 'active:set', docId });
  }

  /** Envia uma imagem para `assets/` do documento; devolve o `src` relativo. */
  async uploadAsset(file: Blob, name: string, docId?: string): Promise<string> {
    const id = docId ?? useDoc.getState().activeDocId;
    if (!id) throw new Error('Nenhum documento aberto');
    const res = await fetch(
      `/api/assets/${encodeURIComponent(id)}?name=${encodeURIComponent(name)}`,
      {
        method: 'POST',
        headers: { 'Content-Type': file.type || 'application/octet-stream' },
        body: file,
      },
    );
    const body = (await res.json().catch(() => ({}))) as { src?: string; error?: string };
    if (!res.ok || !body.src) throw new Error(body.error ?? `Falha no upload (${res.status})`);
    return body.src;
  }

  /** Caminhos recentes (mais recente primeiro). */
  async recent(): Promise<string[]> {
    const res = await fetch('/api/recent');
    if (!res.ok) return [];
    const body = (await res.json().catch(() => ({}))) as { recent?: string[] };
    return Array.isArray(body.recent) ? body.recent : [];
  }

  /* ------------------------------------------------------------------ */

  /** Integra uma mensagem do servidor nos stores. Público para testes. */
  handle(msg: ServerMessage): void {
    const s = useDoc.getState();
    switch (msg.type) {
      case 'ack':
      case 'error': {
        const reqId = msg.reqId;
        const p = reqId ? this.pending.get(reqId) : undefined;
        if (p && reqId) {
          clearTimeout(p.timer);
          this.pending.delete(reqId);
          if (msg.type === 'ack') p.resolve(msg.result);
          else p.reject(new Error(msg.message));
        } else if (msg.type === 'error') {
          ui.toast(msg.message, 'error');
        }
        return;
      }
      case 'hello': {
        const history = msg.history ?? NO_HISTORY;
        useDoc.setState({
          documents: msg.documents,
          activeDocId: msg.activeDocId,
          doc: msg.doc,
          revision: msg.revision,
          history,
          docs: msg.doc ? { [msg.doc.id]: msg.doc } : {},
          histories: msg.doc ? { [msg.doc.id]: history } : {},
        });
        if (msg.doc) this.pruneUi(msg.doc);
        else ui.setPage(null);
        return;
      }
      case 'doc:opened': {
        const documents = [...s.documents.filter((d) => d.docId !== msg.info.docId), msg.info];
        const doc = mergeDoc(s.docs[msg.info.docId], msg.doc);
        const history = msg.history ?? NO_HISTORY;
        const isActive = s.activeDocId === msg.info.docId;
        useDoc.setState({
          documents,
          docs: { ...s.docs, [msg.info.docId]: doc },
          histories: { ...s.histories, [msg.info.docId]: history },
          ...(isActive ? { doc, history, revision: msg.info.revision } : {}),
        });
        return;
      }
      case 'doc:changed': {
        const prev = s.docs[msg.docId] ?? null;
        const doc = mergeDoc(prev ?? undefined, msg.doc);
        const history: HistoryState = msg.history ?? NO_HISTORY;
        const isActive = s.activeDocId === msg.docId;
        let agentActivity = s.agentActivity;
        if (msg.source === 'mcp') {
          const now = Date.now();
          agentActivity = Object.fromEntries(
            Object.entries(agentActivity).filter(([, at]) => now - at < AGENT_ACTIVITY_TTL_MS),
          );
          for (const f of touchedFrameIds(msg.ops, doc, prev)) agentActivity[f] = now;
        }
        useDoc.setState({
          docs: { ...s.docs, [msg.docId]: doc },
          histories: { ...s.histories, [msg.docId]: history },
          documents: patchInfo(s.documents, msg.docId, { dirty: true, revision: msg.revision }),
          agentActivity,
          ...(isActive ? { doc, history, revision: msg.revision } : {}),
        });
        if (isActive) this.pruneUi(doc);
        return;
      }
      case 'doc:saved':
        useDoc.setState({
          documents: patchInfo(s.documents, msg.docId, { dirty: false, path: msg.path }),
        });
        return;
      case 'doc:closed': {
        const docs = { ...s.docs };
        delete docs[msg.docId];
        const histories = { ...s.histories };
        delete histories[msg.docId];
        const wasActive = s.activeDocId === msg.docId;
        useDoc.setState({
          docs,
          histories,
          documents: s.documents.filter((d) => d.docId !== msg.docId),
          ...(wasActive ? { activeDocId: null, doc: null, history: NO_HISTORY } : {}),
        });
        if (wasActive) ui.setPage(null);
        return;
      }
      case 'selection:changed': {
        if (msg.docId !== s.activeDocId || msg.source === 'editor') return;
        const doc = s.doc;
        const ids = doc ? msg.nodeIds.filter((id) => getEntry(doc, id)) : [];
        // Seleção vinda do MCP: troca de página se preciso e enquadra os nós.
        if (doc && ids.length) {
          const pageId = getEntry(doc, ids[0]!)!.pageId;
          if (pageId !== (useUi.getState().pageId ?? doc.pages[0]?.id)) ui.setPage(pageId);
        }
        ui.select(ids);
        if (ids.length) ui.focus(ids, true);
        return;
      }
      case 'active:changed': {
        const doc = msg.docId ? (s.docs[msg.docId] ?? null) : null;
        const info = msg.docId ? s.documents.find((d) => d.docId === msg.docId) : undefined;
        useDoc.setState({
          activeDocId: msg.docId,
          doc,
          revision: info?.revision ?? 0,
          history: msg.docId ? (s.histories[msg.docId] ?? NO_HISTORY) : NO_HISTORY,
        });
        ui.setPage(null);
        if (msg.docId && !doc) void this.fetchDoc(msg.docId);
        return;
      }
      default:
        return;
    }
  }

  /** Busca um documento que não está no cache (ex.: ativo trocado para um doc não recebido). */
  private async fetchDoc(docId: string): Promise<void> {
    try {
      const res = await fetch(`/api/docs/${encodeURIComponent(docId)}`);
      if (!res.ok) return;
      const data = (await res.json()) as { info: OpenDocumentInfo; doc: Document };
      if (useDoc.getState().activeDocId !== docId) return;
      useDoc.setState((s) => ({
        doc: data.doc,
        revision: data.info.revision,
        docs: { ...s.docs, [docId]: data.doc },
      }));
    } catch {
      /* ignorado */
    }
  }

  /** Remove da UI referências a nós/páginas que não existem mais. */
  private pruneUi(doc: Document): void {
    const u = useUi.getState();
    if (u.pageId && !doc.pages.some((p) => p.id === u.pageId)) ui.setPage(null);
    const sel = u.selection.filter((id) => getEntry(doc, id));
    if (sel.length !== u.selection.length) ui.select(sel);
    if (u.hoverId && !getEntry(doc, u.hoverId)) ui.hover(null);
    if (u.editingTextId && !getEntry(doc, u.editingTextId)) ui.editText(null);
  }
}

/** Instância única usada pelo app. */
export const daemon = new DaemonClient();
