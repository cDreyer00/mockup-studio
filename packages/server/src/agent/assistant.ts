/**
 * AI assistant service: one chat per document that talks to the canvas through an agent CLI
 * (Claude Code or Codex), using the daemon's own MCP.
 *
 * Each turn is a new subprocess, linked to the daemon through a `/mcp?turn=<token>` URL. The token is
 * only valid while the turn runs and gives the agent's writes a single undo group (`assistant:<turnId>`).
 * Public contract in `services.ts`; backends in `backend.ts` and `cli.ts`.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  findNode,
  getDocumentSummary,
  getTreeSummary,
  type AssistantBackendInfo,
  type AssistantConfig,
  type AssistantEvent,
  type AssistantMessage,
  type AssistantToolCall,
  type ClientMessage,
  type Document,
} from '@mockup/core';
import type { RenderProvider } from '../render.js';
import type { AssistantServiceApi, RunTurnOptions, TurnBinding } from '../services.js';
import type { DocumentStore } from '../store.js';
import type { AgentBackend, AgentImage, AgentRunEvent, AgentRunInput } from './backend.js';
import {
  abortError,
  detectBackends,
  isAbortError,
  isValidSessionId,
  MCP_SERVER_NAME,
} from './cli.js';

export interface AssistantServiceOptions {
  /** Daemon data folder (where `assistant.json` lives); without it the config stays in memory only. */
  dataDir?: string;
  getPort: () => number;
  host?: string;
  render?: RenderProvider;
  /** Backends used instead of the detected ones (tests). */
  backends?: AgentBackend[];
}

/** History messages kept per document. */
export const MAX_HISTORY_MESSAGES = 200;
/** Limit of the tree summary sent as context. */
export const MAX_CONTEXT_CHARS = 6000;
const SCREENSHOT_TIMEOUT_MS = 20_000;
const HISTORY_FILE_VERSION = 1;
const MODEL_RE = /^[\w.:/[\]-]+$/;
/** Concurrent text generations without `docId` (with `docId` the limit is 1 per document). */
const MAX_TEXT_WITHOUT_DOC = 4;

const log = (...args: unknown[]): void => console.error('[mockup-assistant]', ...args);

/**
 * History sidecar file, next to the document: `a.mockup.json` → `a.assistant.json`; any
 * other name just gets the suffix (`a.json` → `a.json.assistant.json`), so two different
 * documents in the same folder never share the same file.
 */
export function assistantSidecarPath(docPath: string): string {
  const dir = path.dirname(docPath);
  const name = path.basename(docPath);
  const base = /\.mockup\.json$/i.test(name) ? name.replace(/\.mockup\.json$/i, '') : name;
  return path.join(dir, `${base}.assistant.json`);
}

/** Session ids accepted by the service; the rest is discarded (see `isValidSessionId`). */
function cleanSessions(raw: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const [k, v] of Object.entries(raw)) {
    if (isValidSessionId(v)) out[k] = v;
  }
  return out;
}

let tmpCounter = 0;

interface SidecarFile {
  version: number;
  messages: AssistantMessage[];
  /** Backend sessionId per backend id (conversation continuation with `--resume`). */
  sessions: Record<string, string>;
}

interface DocChat {
  messages: AssistantMessage[];
  sessions: Record<string, string>;
  /** Sidecar file already loaded (or attempted). */
  loadedFrom: string | null;
}

interface Turn {
  id: string;
  docId: string;
  token: string;
  group: string;
  /** The service owns the group (closes it at the end); false if the caller passed `opts.group`. */
  ownGroup: boolean;
  controller: AbortController;
  backend?: AgentBackend;
  user: AssistantMessage;
  text: string;
  tools: AssistantToolCall[];
  sessionId?: string;
  /** Final assistant message (always resolves; errors become `status: 'error'`). */
  result: Promise<AssistantMessage>;
  /** Active token registration (only after the backend is resolved). */
  active: boolean;
}

const NO_BACKEND =
  'No AI agent available. Install and sign in to Claude Code (`claude`) or Codex (`codex`) and try again.';

const SYSTEM_TEXT_ONLY =
  "Reply only with the requested text, in the user's language, without using tools and without extra explanations.";

function systemPrompt(docId: string, selection: string[], extra?: string): string {
  const lines = [
    'You are the design assistant built into Mockup Studio, a visual HTML/CSS mockup editor. The user talks to you in an editor panel and you edit their document through the MCP tools of the "mockup-studio" server.',
    '',
    'Rules:',
    '- Use ONLY the mockup-studio MCP tools. Do not use shell, files or the web.',
    `- The turn's document is ${docId}: always pass docId="${docId}" to the tools.`,
    selection.length
      ? `- Work on the user's selection (${selection.join(', ')}); only touch anything outside it if the request requires it.`
      : '- There is no selection: the request applies to the document; check the frames before editing.',
    '- If in doubt about tools, styles or layout, read get_guide (e.g. get_guide("getting-started")).',
    '- After editing, check the result with get_screenshot (when there is a render) and fix it with the editing tools.',
    '- Do not call undo or redo: all your changes in this turn form a single undo step, which the user triggers in the editor.',
    '- When you are done, call finish_working.',
    "- Reply and write design content in the user's language; keep the reply short: say in 1 to 3 sentences what you did (without repeating the code).",
  ];
  if (extra?.trim()) lines.push('', extra.trim());
  return lines.join('\n');
}

function clip(text: string, max: number): string {
  return text.length > max ? text.slice(0, max - 20) + '\n...(truncated)' : text;
}

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${what}: timed out`)), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e: unknown) => {
        clearTimeout(t);
        reject(e instanceof Error ? e : new Error(String(e)));
      },
    );
  });
}

function requireDocId(docId: unknown, type: string): string {
  if (typeof docId !== 'string' || !docId)
    throw new Error(`${type} requires "docId" (non-empty string).`);
  return docId;
}

export class AssistantService implements AssistantServiceApi {
  private readonly list: AgentBackend[];
  private config: AssistantConfig = { backend: 'auto' };
  private readonly chats = new Map<string, DocChat>();
  private readonly turnsByDoc = new Map<string, Turn>();
  private readonly byToken = new Map<string, Turn>();
  private readonly listeners = new Set<(docId: string, event: AssistantEvent) => void>();
  /** Text generations in progress per document (at most one) and those without a document. */
  private readonly textsByDoc = new Map<string, AbortController>();
  private readonly textsNoDoc = new Set<AbortController>();
  /** History writes in progress, per file (to serialize them). */
  private readonly writes = new Map<string, Promise<void>>();
  private closed = false;

  constructor(
    readonly store: DocumentStore,
    readonly opts: AssistantServiceOptions,
  ) {
    this.list = opts.backends ?? detectBackends();
    this.loadConfig();
  }

  /* ---------- configuration ---------- */

  private get configFile(): string | undefined {
    return this.opts.dataDir ? path.join(this.opts.dataDir, 'assistant.json') : undefined;
  }

  private loadConfig(): void {
    const file = this.configFile;
    if (!file) return;
    try {
      const raw: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (raw && typeof raw === 'object') {
        const r = raw as Record<string, unknown>;
        if (typeof r['backend'] === 'string' && r['backend']) this.config.backend = r['backend'];
        const models: Record<string, string> = {};
        const rawModels = r['models'];
        if (rawModels && typeof rawModels === 'object' && !Array.isArray(rawModels)) {
          for (const [k, v] of Object.entries(rawModels)) {
            if (typeof v === 'string' && MODEL_RE.test(v)) models[k] = v;
          }
        }
        // Old file (single `model`): applies to the configured backend; in `auto`, to claude
        // (the first one `auto` picks).
        const legacy = r['model'];
        if (typeof legacy === 'string' && MODEL_RE.test(legacy) && rawModels === undefined) {
          models[this.config.backend === 'auto' ? 'claude' : this.config.backend] = legacy;
        }
        if (Object.keys(models).length) this.config.models = models;
      }
    } catch {
      /* no file or invalid: default */
    }
  }

  private saveConfig(): void {
    const file = this.configFile;
    if (!file) return;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify(this.config, null, 2) + '\n', 'utf8');
    } catch (e) {
      log('could not write the configuration:', e instanceof Error ? e.message : e);
    }
  }

  /** `model` is the configured backend's model (read shortcut); the real data lives in `models`. */
  getConfig(): AssistantConfig {
    const { backend, models } = this.config;
    const model = backend === 'auto' ? undefined : models?.[backend];
    return {
      backend,
      ...(models && Object.keys(models).length ? { models: { ...models } } : {}),
      ...(model ? { model } : {}),
    };
  }

  /** Backend model (each has its own: a Claude model id does not work for Codex). */
  private modelFor(backendId: string): string | undefined {
    return this.config.models?.[backendId];
  }

  private async setConfig(patch: Partial<AssistantConfig>): Promise<void> {
    const next: AssistantConfig = { ...this.config };
    if (patch.backend !== undefined) {
      if (typeof patch.backend !== 'string' || !patch.backend)
        throw new Error('backend must be "auto" or a backend id.');
      if (patch.backend !== 'auto' && !this.list.some((b) => b.id === patch.backend)) {
        throw new Error(
          `Unknown backend: ${patch.backend}. Use "auto" or ${this.list.map((b) => b.id).join(', ')}.`,
        );
      }
      next.backend = patch.backend;
    }
    const models: Record<string, string> = { ...next.models };
    const setModel = (id: string, value: unknown): void => {
      const m = typeof value === 'string' ? value.trim() : '';
      if (m && !MODEL_RE.test(m)) throw new Error(`Invalid model name: ${m}`);
      if (m) models[id] = m;
      else delete models[id];
    };
    if (patch.models !== undefined) {
      if (!patch.models || typeof patch.models !== 'object' || Array.isArray(patch.models))
        throw new Error('models must be an object { <backend>: <model> }.');
      for (const [id, value] of Object.entries(patch.models)) {
        if (!this.list.some((b) => b.id === id)) {
          throw new Error(
            `Unknown backend in models: ${id}. Use ${this.list.map((b) => b.id).join(', ')}.`,
          );
        }
        setModel(id, value);
      }
    }
    if (patch.model !== undefined) {
      // Shortcut: the configured backend's model (already with the `backend` from this same patch).
      const typed = typeof patch.model === 'string' ? patch.model.trim() : '';
      if (next.backend === 'auto') {
        if (typed) {
          throw new Error(
            'With backend "auto" use models: { <backend>: <model> } or pick a backend.',
          );
        }
      } else {
        setModel(next.backend, patch.model);
      }
    }
    if (Object.keys(models).length) next.models = models;
    else delete next.models;
    delete next.model;
    this.config = next;
    this.saveConfig();
  }

  /* ---------- backends ---------- */

  backends(): Promise<AssistantBackendInfo[]> {
    return Promise.all(this.list.map((b) => b.info()));
  }

  private async resolveBackend(requested?: string): Promise<AgentBackend> {
    const want = requested ?? this.config.backend;
    if (want === 'auto') {
      const infos: AssistantBackendInfo[] = [];
      for (const b of this.list) {
        const info = await b.info();
        if (info.available) return b;
        infos.push(info);
      }
      const why = infos.map((i) => `${i.name}: ${i.detail ?? 'unavailable'}`).join('\n');
      throw new Error(why ? `${NO_BACKEND}\n${why}` : NO_BACKEND);
    }
    const b = this.list.find((x) => x.id === want);
    if (!b) {
      throw new Error(
        `Unknown backend: ${want}. Available: ${this.list.map((x) => x.id).join(', ') || '(none)'}.`,
      );
    }
    const info = await b.info();
    if (!info.available) {
      throw new Error(
        `${info.name} unavailable${info.detail ? `: ${info.detail}` : '.'}\n${NO_BACKEND}`,
      );
    }
    return b;
  }

  /* ---------- events ---------- */

  onEvent(fn: (docId: string, event: AssistantEvent) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(docId: string, event: AssistantEvent): void {
    for (const fn of [...this.listeners]) {
      try {
        fn(docId, event);
      } catch (e) {
        log('error in an event listener:', e instanceof Error ? e.message : e);
      }
    }
  }

  /* ---------- history ---------- */

  private sidecar(docId: string): string | null {
    try {
      const p = this.store.getInfo(docId).path;
      if (!p) return null;
      const side = assistantSidecarPath(p);
      // A document open under that name (e.g. `a.assistant.json`) never becomes a history file.
      const norm = (x: string): string => path.resolve(x).toLowerCase();
      const clash = this.store.list().some((d) => d.path && norm(d.path) === norm(side));
      return clash ? null : side;
    } catch {
      return null;
    }
  }

  private chatOf(docId: string): DocChat {
    let c = this.chats.get(docId);
    if (!c) {
      c = { messages: [], sessions: {}, loadedFrom: null };
      this.chats.set(docId, c);
    }
    const file = this.sidecar(docId);
    if (file && c.loadedFrom !== file) {
      c.loadedFrom = file;
      if (c.messages.length === 0) {
        try {
          const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<SidecarFile>;
          if (Array.isArray(raw.messages)) c.messages = raw.messages.slice(-MAX_HISTORY_MESSAGES);
          // The id becomes a CLI argument (`--resume`): ids outside the expected format are discarded.
          c.sessions = cleanSessions(raw.sessions);
        } catch {
          /* no sidecar file or unreadable: empty history */
        }
      }
    }
    return c;
  }

  /** Writes the document history; writes to the same file run one at a time, in order. */
  private persist(docId: string): Promise<void> {
    const file = this.sidecar(docId);
    if (!file) return Promise.resolve();
    const prev = this.writes.get(file) ?? Promise.resolve();
    const next = prev.then(() => this.writeSidecar(docId, file));
    this.writes.set(file, next);
    void next.finally(() => {
      if (this.writes.get(file) === next) this.writes.delete(file);
    });
    return next;
  }

  private async writeSidecar(docId: string, file: string): Promise<void> {
    const c = this.chats.get(docId);
    if (!c) return;
    // Unique name per write: never two writers on the same temp file.
    const tmp = `${file}.${process.pid}.${++tmpCounter}.${randomBytes(4).toString('hex')}.tmp`;
    try {
      if (c.messages.length === 0 && Object.keys(c.sessions).length === 0) {
        await fs.promises.rm(file, { force: true });
        return;
      }
      const data: SidecarFile = {
        version: HISTORY_FILE_VERSION,
        messages: c.messages.slice(-MAX_HISTORY_MESSAGES),
        sessions: c.sessions,
      };
      await fs.promises.writeFile(tmp, JSON.stringify(data, null, 2) + '\n', 'utf8');
      await fs.promises.rename(tmp, file);
    } catch (e) {
      await fs.promises.rm(tmp, { force: true }).catch(() => undefined);
      log('could not write the assistant history:', e instanceof Error ? e.message : e);
    }
  }

  async history(docId: string): Promise<AssistantMessage[]> {
    this.store.getInfo(docId);
    const c = this.chatOf(docId);
    const out = [...c.messages];
    const t = this.turnsByDoc.get(docId);
    if (t) {
      // Turn in progress: the user message and what the assistant has produced so far.
      out.push(t.user, {
        id: `${t.id}-running`,
        role: 'assistant',
        text: t.text,
        at: t.user.at,
        turnId: t.id,
        status: 'running',
        tools: t.tools.map((x) => ({ ...x })),
        ...(t.backend ? { backend: t.backend.id } : {}),
      });
    }
    return out;
  }

  private async clear(docId: string): Promise<void> {
    this.store.getInfo(docId);
    if (this.turnsByDoc.has(docId)) {
      throw new Error(
        'A turn is in progress in this document. Cancel it before clearing the conversation.',
      );
    }
    const c = this.chatOf(docId);
    c.messages = [];
    c.sessions = {};
    await this.persist(docId);
    this.emit(docId, { kind: 'cleared' });
  }

  /* ---------- turns ---------- */

  resolveTurn(token: string): TurnBinding | null {
    const t = this.byToken.get(token);
    return t ? { turnId: t.id, docId: t.docId, group: t.group } : null;
  }

  /** Cancels the document's turn and any text generation in progress. */
  cancel(docId: string): boolean {
    const t = this.turnsByDoc.get(docId);
    const g = this.textsByDoc.get(docId);
    t?.controller.abort();
    g?.abort();
    return Boolean(t || g);
  }

  async send(
    docId: string,
    prompt: string,
    opts: RunTurnOptions = {},
  ): Promise<{ turnId: string }> {
    const t = await this.start(docId, prompt, opts);
    return { turnId: t.id };
  }

  async runTurn(
    docId: string,
    prompt: string,
    opts: RunTurnOptions = {},
  ): Promise<AssistantMessage> {
    const t = await this.start(docId, prompt, opts);
    return t.result;
  }

  private async start(docId: string, prompt: string, opts: RunTurnOptions): Promise<Turn> {
    if (this.closed) throw new Error('The assistant was shut down.');
    if (typeof prompt !== 'string' || !prompt.trim())
      throw new Error('Write a request for the assistant.');
    this.store.getInfo(docId); // 404 if the document does not exist
    if (this.turnsByDoc.has(docId)) {
      throw new Error(
        'An assistant turn is already in progress in this document. Wait for it to finish or cancel it.',
      );
    }
    const id = `turn_${randomUUID().slice(0, 8)}`;
    const selection = (opts.selection ?? this.store.getSelection(docId)).filter(
      (s) => typeof s === 'string',
    );
    const user: AssistantMessage = {
      id: `msg_${randomUUID().slice(0, 8)}`,
      role: 'user',
      text: prompt,
      at: new Date().toISOString(),
      turnId: id,
      ...(selection.length ? { selection } : {}),
    };
    let finish!: (m: AssistantMessage) => void;
    const result = new Promise<AssistantMessage>((r) => (finish = r));
    const turn: Turn = {
      id,
      docId,
      token: randomBytes(16).toString('hex'),
      group: opts.group ?? `assistant:${id}`,
      ownGroup: opts.group === undefined,
      controller: new AbortController(),
      user,
      text: '',
      tools: [],
      result,
      active: false,
    };
    // Reserve the document right away (before any await) to reject a second concurrent `send`.
    this.turnsByDoc.set(docId, turn);
    try {
      turn.backend = await this.resolveBackend(opts.backend);
    } catch (e) {
      this.turnsByDoc.delete(docId);
      // Release whoever was already waiting on the turn (e.g. `close()` during backend resolution).
      finish({ ...user, id: `${id}-error`, role: 'assistant', text: '', status: 'error' });
      throw e;
    }
    this.byToken.set(turn.token, turn);
    turn.active = true;
    void this.execute(turn, prompt, selection, opts).then(finish);
    return turn;
  }

  private mcpUrl(token: string): string {
    const h = this.opts.host ?? '127.0.0.1';
    const host = h === '0.0.0.0' || h === '::' ? '127.0.0.1' : h === '::1' ? '[::1]' : h;
    return `http://${host}:${this.opts.getPort()}/mcp?turn=${token}`;
  }

  /** Stable working folder per document (the CLI keeps the session per folder; `--resume` needs it). */
  private cwdFor(key: string): string {
    return path.join(os.tmpdir(), 'mockup-studio-assistant', key.replace(/[^\w.-]/g, '_'));
  }

  /** Runs the whole turn; never rejects. */
  private async execute(
    turn: Turn,
    prompt: string,
    selection: string[],
    opts: RunTurnOptions,
  ): Promise<AssistantMessage> {
    const { docId } = turn;
    const backend = turn.backend!;
    this.emit(docId, { kind: 'turn-start', turnId: turn.id, user: turn.user, backend: backend.id });
    let status: 'done' | 'cancelled' | 'error' = 'done';
    let error: string | undefined;
    let finalText = '';
    try {
      const signal = turn.controller.signal;
      if (signal.aborted) throw Object.assign(new Error('Turn cancelled.'), { name: 'AbortError' });
      const ctx = await this.buildContext(docId, selection, signal);
      if (signal.aborted) throw Object.assign(new Error('Turn cancelled.'), { name: 'AbortError' });
      const chat = this.chatOf(docId);
      const model = this.modelFor(backend.id);
      const base: AgentRunInput = {
        prompt: '',
        system: systemPrompt(docId, ctx.selection, opts.instructions),
        images: ctx.images,
        mcp: { name: MCP_SERVER_NAME, url: this.mcpUrl(turn.token) },
        model,
        cwd: this.cwdFor(docId),
      };
      const handler = (ev: AgentRunEvent): void => this.onBackendEvent(turn, ev);
      const stored = chat.sessions[backend.id];
      const resumeId = isValidSessionId(stored) ? stored : undefined;
      const withPrompt = (resume: string | undefined): AgentRunInput => ({
        ...base,
        // With no session to continue, the recent history goes summarized in the prompt.
        prompt: this.composePrompt(ctx.header, prompt, resume ? [] : chat.messages),
        resumeSession: resume,
      });
      let res;
      try {
        res = await backend.run(withPrompt(resumeId), handler, signal);
      } catch (e) {
        // Resume failed before any tool or text: try again without continuing the session.
        if (
          resumeId &&
          !signal.aborted &&
          !isAbortError(e) &&
          turn.tools.length === 0 &&
          turn.text === ''
        ) {
          log(
            `session resume failed (${e instanceof Error ? e.message : e}); retrying without resume`,
          );
          delete chat.sessions[backend.id];
          res = await backend.run(withPrompt(undefined), handler, signal);
        } else {
          throw e;
        }
      }
      if (isValidSessionId(res.sessionId)) turn.sessionId = res.sessionId;
      finalText = res.text?.trim() || turn.text.trim() || 'Done.';
    } catch (e) {
      if (turn.controller.signal.aborted || isAbortError(e)) {
        status = 'cancelled';
      } else {
        status = 'error';
        error = e instanceof Error ? e.message : String(e);
      }
      finalText = turn.text.trim();
    } finally {
      this.byToken.delete(turn.token);
      turn.active = false;
    }

    const opsCount = this.safe(() => this.store.groupOpsCount(docId, turn.group)) ?? 0;
    if (turn.ownGroup) {
      this.safe(() => this.store.closeGroup(docId, turn.group));
      this.safe(() => this.store.finishWorking(docId, []));
    }
    const message: AssistantMessage = {
      id: `msg_${randomUUID().slice(0, 8)}`,
      role: 'assistant',
      text: finalText,
      at: new Date().toISOString(),
      turnId: turn.id,
      tools: turn.tools,
      status,
      ...(error ? { error } : {}),
      backend: backend.id,
      opsCount,
    };
    if (!opts.ephemeral) {
      const chat = this.chatOf(docId);
      chat.messages.push(turn.user, message);
      if (chat.messages.length > MAX_HISTORY_MESSAGES) {
        chat.messages = chat.messages.slice(-MAX_HISTORY_MESSAGES);
      }
      if (turn.sessionId) chat.sessions[backend.id] = turn.sessionId;
      await this.persist(docId);
    }
    this.turnsByDoc.delete(docId);
    this.emit(docId, { kind: 'turn-end', turnId: turn.id, message });
    return message;
  }

  private safe<T>(fn: () => T): T | undefined {
    try {
      return fn();
    } catch {
      return undefined; // e.g. the document was closed during the turn
    }
  }

  private onBackendEvent(turn: Turn, ev: AgentRunEvent): void {
    switch (ev.kind) {
      case 'text':
        turn.text += ev.text;
        this.emit(turn.docId, { kind: 'text', turnId: turn.id, text: ev.text });
        break;
      case 'tool': {
        const tool: AssistantToolCall = {
          id: ev.id,
          name: ev.name,
          ...(ev.input !== undefined ? { input: ev.input } : {}),
        };
        turn.tools.push(tool);
        this.emit(turn.docId, { kind: 'tool', turnId: turn.id, tool: { ...tool } });
        break;
      }
      case 'tool-result': {
        const t = turn.tools.find((x) => x.id === ev.id);
        if (t) {
          t.ok = ev.ok;
          if (ev.summary) t.summary = ev.summary;
        }
        this.emit(turn.docId, {
          kind: 'tool-result',
          turnId: turn.id,
          toolId: ev.id,
          ok: ev.ok,
          ...(ev.summary ? { summary: ev.summary } : {}),
        });
        break;
      }
      case 'session':
        if (isValidSessionId(ev.sessionId)) turn.sessionId = ev.sessionId;
        else log('invalid backend session id ignored');
        break;
    }
  }

  /* ---------- context ---------- */

  private async buildContext(
    docId: string,
    selection: string[],
    signal: AbortSignal,
  ): Promise<{ header: string; selection: string[]; images: AgentImage[] }> {
    const doc: Document = this.store.get(docId);
    const valid = selection.filter((id) => findNode(doc, id));
    const lines = [`Document: ${doc.name} (docId: ${docId})`];
    let body: string;
    if (valid.length) {
      lines.push(`Selection: ${valid.join(', ')}`);
      const parts = valid.map((id) => getTreeSummary(findNode(doc, id)!.node, 3, { doc }));
      body = clip(parts.join('\n'), MAX_CONTEXT_CHARS);
    } else {
      lines.push('Selection: (none)');
      body = clip(`Document frames:\n${getDocumentSummary(doc, 1)}`, MAX_CONTEXT_CHARS);
    }
    lines.push(body);

    const images: AgentImage[] = [];
    const render = this.opts.render;
    if (render && !signal.aborted) {
      const target = valid[0] ?? doc.pages.flatMap((p) => p.frames)[0]?.id;
      if (target) {
        try {
          const shot = await withTimeout(
            render.capture({
              doc,
              docId,
              nodeId: target,
              assetsDir: this.safe(() => this.store.assetsDir(docId)) ?? null,
              scale: 1,
              format: 'png',
              maxWidth: 1024,
            }),
            SCREENSHOT_TIMEOUT_MS,
            'screenshot',
          );
          images.push({ mime: shot.mime, data: shot.data.toString('base64') });
          lines.push(`(Screenshot attached: ${target})`);
        } catch (e) {
          log('context screenshot unavailable:', e instanceof Error ? e.message : e);
        }
      }
    }
    return { header: lines.join('\n'), selection: valid, images };
  }

  private composePrompt(header: string, prompt: string, previous: AssistantMessage[]): string {
    const parts = [header];
    const recent = previous.slice(-6);
    if (recent.length) {
      parts.push(
        'Previous conversation (summary):\n' +
          recent
            .map((m) => `- ${m.role === 'user' ? 'User' : 'Assistant'}: ${clip(m.text, 300)}`)
            .join('\n'),
      );
    }
    parts.push(`User request:\n${prompt}`);
    return parts.join('\n\n');
  }

  /* ---------- plain text ---------- */

  /**
   * Text-only question. With `docId`: at most one generation per document, cancellable by
   * `cancel(docId)`. Without `docId`: up to `MAX_TEXT_WITHOUT_DOC` at the same time. `signal` cancels too.
   */
  async generateText(
    prompt: string,
    opts: { backend?: string; system?: string; docId?: string; signal?: AbortSignal } = {},
  ): Promise<string> {
    if (this.closed) throw new Error('The assistant was shut down.');
    const { docId, signal } = opts;
    if (docId !== undefined) {
      if (typeof docId !== 'string' || !docId) throw new Error('docId must be a non-empty string.');
      this.store.getInfo(docId); // clear error if the document is not open
      if (this.textsByDoc.has(docId)) {
        throw new Error('A text generation is already in progress in this document.');
      }
    } else if (this.textsNoDoc.size >= MAX_TEXT_WITHOUT_DOC) {
      throw new Error('Too many text generations at once. Wait for one to finish.');
    }
    if (signal?.aborted) throw abortError();
    // Reserve right away (before any await) to reject a second concurrent request.
    const controller = new AbortController();
    if (docId !== undefined) this.textsByDoc.set(docId, controller);
    else this.textsNoDoc.add(controller);
    const onAbort = (): void => controller.abort();
    signal?.addEventListener('abort', onAbort, { once: true });
    let streamed = '';
    try {
      const backend = await this.resolveBackend(opts.backend);
      if (controller.signal.aborted) throw abortError();
      const res = await backend.run(
        {
          prompt,
          system: opts.system ?? SYSTEM_TEXT_ONLY,
          model: this.modelFor(backend.id),
          cwd: this.cwdFor('_text'),
        },
        (ev) => {
          if (ev.kind === 'text') streamed += ev.text;
        },
        controller.signal,
      );
      const text = (res.text || streamed).trim();
      if (!text) throw new Error('The agent returned no text.');
      return text;
    } finally {
      signal?.removeEventListener('abort', onAbort);
      if (docId !== undefined) {
        if (this.textsByDoc.get(docId) === controller) this.textsByDoc.delete(docId);
      } else {
        this.textsNoDoc.delete(controller);
      }
    }
  }

  /* ---------- WS messages ---------- */

  async handle(msg: ClientMessage): Promise<unknown> {
    switch (msg.type) {
      case 'assistant:send': {
        if (typeof msg.docId !== 'string' || !msg.docId)
          throw new Error('assistant:send requires "docId" (string).');
        if (typeof msg.prompt !== 'string' || !msg.prompt.trim())
          throw new Error('assistant:send requires "prompt" (non-empty text).');
        if (msg.selection !== undefined && !Array.isArray(msg.selection))
          throw new Error('"selection" must be a list of ids.');
        return this.send(msg.docId, msg.prompt, {
          selection: msg.selection,
          backend: typeof msg.backend === 'string' && msg.backend ? msg.backend : undefined,
        });
      }
      case 'assistant:cancel': {
        const docId = requireDocId(msg.docId, msg.type);
        // A turn of an already closed document can still be cancelled; with no turn, the document must exist.
        if (!this.turnsByDoc.has(docId) && !this.textsByDoc.has(docId)) this.store.getInfo(docId);
        return { cancelled: this.cancel(docId) };
      }
      case 'assistant:history': {
        const docId = requireDocId(msg.docId, msg.type);
        const [messages, backends] = await Promise.all([this.history(docId), this.backends()]);
        return {
          messages,
          running: this.turnsByDoc.get(docId)?.id ?? null,
          backends,
          config: this.getConfig(),
        };
      }
      case 'assistant:clear':
        await this.clear(requireDocId(msg.docId, msg.type));
        return {};
      case 'assistant:config': {
        if (msg.config) await this.setConfig(msg.config);
        return { config: this.getConfig(), backends: await this.backends() };
      }
      default:
        throw new Error(`Unknown assistant message: ${(msg as { type: string }).type}`);
    }
  }

  /* ---------- shutdown ---------- */

  async close(): Promise<void> {
    this.closed = true;
    for (const c of this.textsByDoc.values()) c.abort();
    for (const c of this.textsNoDoc) c.abort();
    const turns = [...this.turnsByDoc.values()];
    for (const t of turns) t.controller.abort();
    await Promise.allSettled(turns.map((t) => t.result));
  }
}
