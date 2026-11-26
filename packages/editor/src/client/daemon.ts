/**
 * Daemon client: WebSocket with reconnection, Promise-based requests (ack/error by `reqId`),
 * integration of messages into the stores and HTTP helpers (assets, recent).
 *
 * Core rule of the editor: every document mutation goes through `daemon.apply(ops)`.
 */
import type {
  AssistantBackendInfo,
  AssistantConfig,
  AssistantMessage,
  ClientMessage,
  Document,
  EditorCommandMessage,
  EditorCommandResult,
  HistoryState,
  Op,
  OpenDocumentInfo,
  RemixKind,
  RemixResult,
  ScriptFileInfo,
  ScriptRunResult,
  ServerMessage,
} from '@mockup/core';
import {
  enterComponent,
  exitComponent,
  isEditingValid,
  mainOfSelection,
} from '../components/editing';
import { getEntry, getFrameOf } from '../model/tree';
import { runEditorCommand } from '../presentation/editorCommands';
import { usePresentation } from '../presentation/presentationStore';
import { assistantStore } from '../state/assistantStore';
import { NO_HISTORY, mergeDoc, touchedFrameIds, useDoc, withView } from '../state/docStore';
import { ui, useUi } from '../state/uiStore';

/** Client message without `reqId` (generated in `request`), distributed over each member of the union. */
export type NewClientMessage = ClientMessage extends infer M
  ? M extends ClientMessage
    ? Omit<M, 'reqId'>
    : never
  : never;

export interface ApplyAck {
  revision: number;
  /** One item per op: e.g. `{ nodeIds }` for createNode, `{ idMap, nodeIds }` for duplicateNodes. */
  results: (Record<string, unknown> | null)[];
}

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

const REQUEST_TIMEOUT_MS = 15000;
/** Scripts, AI generation and AI remix can take much longer than a regular op. */
export const LONG_REQUEST_TIMEOUT_MS = 120000;
/** Minimum interval between `selection:set` (the marquee changes the selection on every `pointermove`). */
export const SELECTION_SYNC_MS = 100;
/** Agent activity older than this is discarded (the badge disappears well before). */
const AGENT_ACTIVITY_TTL_MS = 10000;

const hasFocus = (): boolean => typeof document !== 'undefined' && document.hasFocus();

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
  private offFocus: (() => void) | null = null;
  private unsubPresentation: (() => void) | null = null;

  constructor(private readonly url: () => string = defaultSocketUrl) {}

  connect(): void {
    this.closed = false;
    this.open();
    // Publishes the local selection to the daemon (for the MCP's `get_selection`), at most once per
    // SELECTION_SYNC_MS: the first change goes out right away and the following ones are grouped into the last.
    this.unsubSelection ??= useUi.subscribe((s, prev) => {
      if (s.selection !== prev.selection) this.scheduleSelectionSync();
    });
    // The daemon sends `presentation:start` to the most recently focused window and the other
    // presentation commands to the one presenting: report focus and every start / end.
    if (!this.offFocus && typeof window !== 'undefined') {
      const onFocus = (): void => this.registerEditor(true);
      window.addEventListener('focus', onFocus);
      this.offFocus = () => window.removeEventListener('focus', onFocus);
    }
    this.unsubPresentation ??= usePresentation.subscribe((s, prev) => {
      if (s.active !== prev.active) this.registerEditor(hasFocus());
    });
  }

  /** Tells the daemon this connection is an editor window (best effort; only while connected). */
  private registerEditor(focused: boolean): void {
    const presenting = usePresentation.getState().active;
    void this.request({ type: 'editor:register', focused, presenting }).catch(() => undefined);
  }

  disconnect(): void {
    this.closed = true;
    clearTimeout(this.timer);
    clearTimeout(this.selectionTimer);
    this.selectionTimer = undefined;
    this.unsubSelection?.();
    this.unsubSelection = null;
    this.offFocus?.();
    this.offFocus = null;
    this.unsubPresentation?.();
    this.unsubPresentation = null;
    const ws = this.ws;
    this.ws = null;
    // Without this, `onclose` (which checks `this.ws`) ignores the socket and the pending ones only expire after 15 s.
    this.rejectPending();
    ws?.close();
  }

  private rejectPending(): void {
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error('Connection to the daemon lost'));
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
      this.registerEditor(hasFocus());
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

  /** Sends a request and resolves with the ack's `result` (rejects with the `error` message). */
  request<T = unknown>(msg: NewClientMessage, timeoutMs = REQUEST_TIMEOUT_MS): Promise<T> {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error('No connection to the daemon'));
    }
    const reqId = newReqId();
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(reqId);
        reject(new Error('The daemon did not respond in time'));
      }, timeoutMs);
      this.pending.set(reqId, { resolve: resolve as (v: unknown) => void, reject, timer });
      ws.send(JSON.stringify({ ...msg, reqId }));
    });
  }

  /**
   * Applies ops to the active document (or to `docId`). One call = one history entry.
   * When the Promise resolves, the corresponding `doc:changed` has already been integrated into the store.
   * Errors become a toast and the Promise rejects.
   */
  async apply(ops: Op[], docId?: string): Promise<ApplyAck> {
    const id = docId ?? useDoc.getState().activeDocId;
    if (!id) throw new Error('No document open');
    if (ops.length === 0) return { revision: useDoc.getState().revision, results: [] };
    try {
      return await this.request<ApplyAck>({ type: 'op:apply', docId: id, ops });
    } catch (e) {
      ui.toast(e instanceof Error ? e.message : String(e), 'error');
      throw e;
    }
  }

  /** Same as `apply`, but without propagating the error (already shown as a toast). */
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
  saveAs(path: string): Promise<OpenDocumentInfo> {
    return this.request({
      type: 'doc:saveAs',
      docId: useDoc.getState().activeDocId ?? undefined,
      path,
    });
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

  /** Uploads an image to the document's `assets/`; returns the relative `src`. */
  async uploadAsset(file: Blob, name: string, docId?: string): Promise<string> {
    const id = docId ?? useDoc.getState().activeDocId;
    if (!id) throw new Error('No document open');
    const res = await fetch(
      `/api/assets/${encodeURIComponent(id)}?name=${encodeURIComponent(name)}`,
      {
        method: 'POST',
        headers: { 'Content-Type': file.type || 'application/octet-stream' },
        body: file,
      },
    );
    const body = (await res.json().catch(() => ({}))) as { src?: string; error?: string };
    if (!res.ok || !body.src) throw new Error(body.error ?? `Upload failed (${res.status})`);
    return body.src;
  }

  /** Asks the daemon to download a Lottie/Rive and store it in assets/lottie|rive/; returns the relative src. */
  async fetchAsset(url: string, kind: 'lottie' | 'rive', docId?: string): Promise<string> {
    const id = docId ?? useDoc.getState().activeDocId;
    if (!id) throw new Error('No document open');
    const res = await fetch(`/api/assets/${encodeURIComponent(id)}/fetch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url, kind }),
    });
    const body = (await res.json().catch(() => ({}))) as { src?: string; error?: string };
    if (!res.ok || !body.src) throw new Error(body.error ?? `Copy failed (${res.status})`);
    return body.src;
  }

  /** Recent paths (most recent first). */
  async recent(): Promise<string[]> {
    const res = await fetch('/api/recent');
    if (!res.ok) return [];
    const body = (await res.json().catch(() => ({}))) as { recent?: string[] };
    return Array.isArray(body.recent) ? body.recent : [];
  }

  /* ---------------- assistant, scripts and remix ---------------- */

  private activeDoc(docId?: string): string {
    const id = docId ?? useDoc.getState().activeDocId;
    if (!id) throw new Error('No document open');
    return id;
  }

  /** Starts an assistant turn. Only waits for the ack; the rest arrives through `assistant:event`. */
  async assistantSend(
    prompt: string,
    opts: { selection?: string[]; backend?: string; docId?: string } = {},
  ): Promise<{ turnId: string }> {
    return this.request({
      type: 'assistant:send',
      docId: this.activeDoc(opts.docId),
      prompt,
      ...(opts.selection ? { selection: opts.selection } : {}),
      ...(opts.backend ? { backend: opts.backend } : {}),
    });
  }
  async assistantCancel(docId?: string): Promise<{ cancelled: boolean }> {
    return this.request({ type: 'assistant:cancel', docId: this.activeDoc(docId) });
  }
  /** Loads history, backends and settings and writes them to the `assistantStore`. */
  async assistantHistory(docId?: string): Promise<{
    messages: AssistantMessage[];
    running: string | null;
    backends: AssistantBackendInfo[];
    config: AssistantConfig;
  }> {
    const id = this.activeDoc(docId);
    const res = await this.request<{
      messages: AssistantMessage[];
      running: string | null;
      backends: AssistantBackendInfo[];
      config: AssistantConfig;
    }>({ type: 'assistant:history', docId: id });
    assistantStore.setHistory(id, res);
    return res;
  }
  async assistantClear(docId?: string): Promise<unknown> {
    return this.request({ type: 'assistant:clear', docId: this.activeDoc(docId) });
  }
  /** Reads (without an argument) or writes the settings; updates the `assistantStore`. */
  async assistantConfig(
    config?: Partial<AssistantConfig>,
  ): Promise<{ config: AssistantConfig; backends: AssistantBackendInfo[] }> {
    const res = await this.request<{ config: AssistantConfig; backends: AssistantBackendInfo[] }>({
      type: 'assistant:config',
      ...(config ? { config } : {}),
    });
    assistantStore.setConfig(res.config, res.backends);
    return res;
  }

  async scriptRun(
    code: string,
    opts: { selection?: string[]; docId?: string } = {},
  ): Promise<ScriptRunResult> {
    return this.request(
      {
        type: 'script:run',
        docId: this.activeDoc(opts.docId),
        code,
        ...(opts.selection ? { selection: opts.selection } : {}),
      },
      LONG_REQUEST_TIMEOUT_MS,
    );
  }
  async scriptList(docId?: string): Promise<{ dir: string | null; scripts: ScriptFileInfo[] }> {
    return this.request({ type: 'script:list', docId: this.activeDoc(docId) });
  }
  async scriptRead(name: string, docId?: string): Promise<{ name: string; code: string }> {
    return this.request({ type: 'script:read', docId: this.activeDoc(docId), name });
  }
  async scriptSave(name: string, code: string, docId?: string): Promise<{ name: string }> {
    return this.request({ type: 'script:save', docId: this.activeDoc(docId), name, code });
  }
  async scriptDelete(name: string, docId?: string): Promise<unknown> {
    return this.request({ type: 'script:delete', docId: this.activeDoc(docId), name });
  }
  async scriptGenerate(prompt: string, docId?: string): Promise<{ code: string }> {
    return this.request(
      { type: 'script:generate', docId: this.activeDoc(docId), prompt },
      LONG_REQUEST_TIMEOUT_MS,
    );
  }

  /** Generates variations side by side (the daemon selects the created frames). `ai` can take a while. */
  async remix(
    nodeId: string,
    kind: RemixKind,
    opts: { count?: number; prompt?: string; docId?: string } = {},
  ): Promise<RemixResult> {
    return this.request(
      {
        type: 'remix',
        docId: this.activeDoc(opts.docId),
        nodeId,
        kind,
        ...(opts.count !== undefined ? { count: opts.count } : {}),
        ...(opts.prompt !== undefined ? { prompt: opts.prompt } : {}),
      },
      kind === 'ai' ? LONG_REQUEST_TIMEOUT_MS : REQUEST_TIMEOUT_MS,
    );
  }

  /* ------------------------------------------------------------------ */

  /** Integrates a server message into the stores. Public for tests. */
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
          connectionEpoch: s.connectionEpoch + 1,
          documents: msg.documents,
          activeDocId: msg.activeDocId,
          ...withView(msg.doc),
          revision: msg.revision,
          history,
          docs: msg.doc ? { [msg.doc.id]: msg.doc } : {},
          histories: msg.doc ? { [msg.doc.id]: history } : {},
        });
        const view = useDoc.getState().doc;
        if (view) this.pruneUi(view);
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
          ...(isActive ? { ...withView(doc), history, revision: msg.info.revision } : {}),
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
          ...(isActive ? { ...withView(doc), history, revision: msg.revision } : {}),
        });
        if (isActive) this.pruneUi(useDoc.getState().doc ?? doc);
        return;
      }
      case 'assistant:event':
        assistantStore.applyEvent(msg.docId, msg.event);
        return;
      case 'editor:command':
        void this.runCommand(msg);
        return;
      case 'agent:finished': {
        const doc = s.docs[msg.docId];
        if (!doc) return;
        const frames = new Set<string>();
        if (msg.nodeIds.length === 0) {
          for (const page of doc.pages) for (const f of page.frames) frames.add(f.id);
        } else {
          for (const id of msg.nodeIds) {
            const f = getFrameOf(doc, id);
            if (f) frames.add(f.id);
          }
        }
        if (!Object.keys(s.agentActivity).some((id) => frames.has(id))) return;
        useDoc.setState({
          agentActivity: Object.fromEntries(
            Object.entries(s.agentActivity).filter(([id]) => !frames.has(id)),
          ),
        });
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
        assistantStore.drop(msg.docId);
        const wasActive = s.activeDocId === msg.docId;
        useDoc.setState({
          docs,
          histories,
          documents: s.documents.filter((d) => d.docId !== msg.docId),
          ...(wasActive ? { activeDocId: null, ...withView(null), history: NO_HISTORY } : {}),
        });
        if (wasActive) ui.setPage(null);
        return;
      }
      case 'selection:changed': {
        if (msg.docId !== s.activeDocId || msg.source === 'editor') return;
        // Node of a main component (e.g. the MCP's `go_to_main`): enters its edit mode.
        const main = s.rawDoc ? mainOfSelection(s.rawDoc, msg.nodeIds) : null;
        if (main && main !== useUi.getState().editingComponentId) enterComponent(main);
        const doc = useDoc.getState().doc;
        const ids = doc ? msg.nodeIds.filter((id) => getEntry(doc, id)) : [];
        // Selection coming from the MCP: switches page if needed and frames the nodes.
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
        ui.setPage(null);
        useDoc.setState({
          activeDocId: msg.docId,
          ...withView(doc),
          revision: info?.revision ?? 0,
          history: msg.docId ? (s.histories[msg.docId] ?? NO_HISTORY) : NO_HISTORY,
        });
        if (msg.docId && !doc) void this.fetchDoc(msg.docId);
        return;
      }
      default:
        return;
    }
  }

  /** Runs a command from the daemon (MCP presentation tools) and answers with its result. */
  private async runCommand({ commandId, command }: EditorCommandMessage): Promise<void> {
    let reply: { ok: true; result: EditorCommandResult } | { ok: false; error: string };
    try {
      reply = { ok: true, result: await runEditorCommand(command) };
    } catch (e) {
      reply = { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
    await this.request({ type: 'editor:result', commandId, ...reply }).catch(() => undefined);
  }

  /** Fetches a document that is not in the cache (e.g. active switched to a document not yet received). */
  private async fetchDoc(docId: string): Promise<void> {
    try {
      const res = await fetch(`/api/docs/${encodeURIComponent(docId)}`);
      if (!res.ok) return;
      const data = (await res.json()) as { info: OpenDocumentInfo; doc: Document };
      if (useDoc.getState().activeDocId !== docId) return;
      useDoc.setState((s) => ({
        ...withView(data.doc),
        revision: data.info.revision,
        docs: { ...s.docs, [docId]: data.doc },
      }));
    } catch {
      /* ignored */
    }
  }

  /** Removes from the UI references to nodes/pages that no longer exist. */
  private pruneUi(doc: Document): void {
    // The main component being edited no longer exists (e.g. undoing its creation): goes back to the page.
    if (useUi.getState().editingComponentId && !isEditingValid()) {
      exitComponent();
      doc = useDoc.getState().doc ?? doc;
    }
    const u = useUi.getState();
    if (u.pageId && !doc.pages.some((p) => p.id === u.pageId)) ui.setPage(null);
    const sel = u.selection.filter((id) => getEntry(doc, id));
    if (sel.length !== u.selection.length) ui.select(sel);
    if (u.hoverId && !getEntry(doc, u.hoverId)) ui.hover(null);
    if (u.editingTextId && !getEntry(doc, u.editingTextId)) ui.editText(null);
    if (u.editingVectorId && !getEntry(doc, u.editingVectorId)) ui.editVector(null);
  }
}

/** Single instance used by the app. */
export const daemon = new DaemonClient();
