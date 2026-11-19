/**
 * WebSocket protocol between the daemon (`@mockup/server`) and the clients (editor).
 * JSON messages, one per frame. Shared by server and editor via `@mockup/core`.
 */
import type { Document } from './types.js';
import type { Op } from './ops.js';
import type { PresentationState, SlideStep } from './presentation.js';

export type OpSource = 'editor' | 'mcp' | 'system';

export interface OpenDocumentInfo {
  docId: string;
  name: string;
  /** Absolute path on disk (or `null` if not saved yet). */
  path: string | null;
  dirty: boolean;
  revision: number;
}

/** State of a document's undo/redo stacks (to enable the editor buttons). */
export interface HistoryState {
  canUndo: boolean;
  canRedo: boolean;
}

/* ---------- server → client ---------- */

export interface HelloEvent {
  type: 'hello';
  documents: OpenDocumentInfo[];
  activeDocId: string | null;
  /** Complete active document (or null). */
  doc: Document | null;
  selection: string[];
  revision: number;
  /** History of the active document (`{ canUndo: false, canRedo: false }` with no document). */
  history: HistoryState;
}
export interface DocOpenedEvent {
  type: 'doc:opened';
  info: OpenDocumentInfo;
  doc: Document;
  history: HistoryState;
}
export interface DocChangedEvent {
  type: 'doc:changed';
  docId: string;
  ops: Op[];
  source: OpSource;
  revision: number;
  /** Complete document after the ops (included in the MVP to simplify clients). */
  doc: Document;
  history: HistoryState;
}
export interface DocSavedEvent {
  type: 'doc:saved';
  docId: string;
  path: string;
}
export interface DocClosedEvent {
  type: 'doc:closed';
  docId: string;
}
export interface SelectionChangedEvent {
  type: 'selection:changed';
  docId: string;
  nodeIds: string[];
  source: OpSource;
}
export interface ActiveChangedEvent {
  type: 'active:changed';
  docId: string | null;
}
/** The agent finished working on the nodes (`finish_working`): the editor clears the "AI" indicator from the frames. */
export interface AgentFinishedEvent {
  type: 'agent:finished';
  docId: string;
  /** Nodes reported by the agent; empty = all frames in the document. */
  nodeIds: string[];
}
export interface AckMessage {
  type: 'ack';
  reqId: string;
  result?: unknown;
}
export interface ErrorMessage {
  type: 'error';
  reqId?: string;
  message: string;
}

/* ---------- AI assistant, scripts and remix (phase 9) ---------- */

/** Agent backend known to the daemon (installed CLI or API). */
export interface AssistantBackendInfo {
  /** `claude`, `codex` (CLIs) or another registered backend (e.g. `fake` in tests). */
  id: string;
  name: string;
  available: boolean;
  /** Executable found on PATH (CLIs). */
  path?: string;
  /** Reason for unavailability, or version. */
  detail?: string;
}

/** Assistant configuration (persisted in the daemon data folder). */
export interface AssistantConfig {
  /** `auto` = the first available (claude, then codex). */
  backend: string;
  /**
   * Model of the configured backend (`backend`), passed to the CLI; empty = CLI default. On read it is a
   * shortcut for `models[backend]`; on write it applies to the backend in the same patch (or the current one).
   */
  model?: string;
  /** Model per backend id (a Claude model does not work with Codex); absent = CLI default. */
  models?: Record<string, string>;
}

export interface AssistantToolCall {
  id: string;
  name: string;
  input?: unknown;
  ok?: boolean;
  /** Short summary of the result (first line, up to ~200 characters). */
  summary?: string;
}

export type AssistantTurnStatus = 'running' | 'done' | 'cancelled' | 'error';

/** Message from a document's assistant history. */
export interface AssistantMessage {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  at: string;
  turnId: string;
  /** Only on assistant messages. */
  tools?: AssistantToolCall[];
  status?: AssistantTurnStatus;
  error?: string;
  backend?: string;
  /** Ops applied by the agent in the turn (all in a single undo group). */
  opsCount?: number;
  /** Selection sent as context (user message). */
  selection?: string[];
}

/** Streaming event of an assistant turn. */
export type AssistantEvent =
  | { kind: 'turn-start'; turnId: string; user: AssistantMessage; backend: string }
  | { kind: 'text'; turnId: string; text: string }
  | { kind: 'tool'; turnId: string; tool: AssistantToolCall }
  | { kind: 'tool-result'; turnId: string; toolId: string; ok: boolean; summary?: string }
  | { kind: 'turn-end'; turnId: string; message: AssistantMessage }
  | { kind: 'cleared' };

export interface AssistantEventMessage {
  type: 'assistant:event';
  docId: string;
  event: AssistantEvent;
}

/** Image produced by `doc.screenshot()` in a script. */
export interface ScriptImage {
  nodeId: string;
  mime: string;
  /** Base64. */
  data: string;
  width: number;
  height: number;
}

export interface ScriptRunResult {
  ok: boolean;
  /** Output of `console.log/info/warn/error`, one line per call. */
  logs: string[];
  /** Value returned by the script (serialized as JSON; `undefined` becomes absent). */
  result?: unknown;
  error?: string;
  images: ScriptImage[];
  /** Applied ops (all in a single undo group). */
  opsCount: number;
  durationMs: number;
}

export interface ScriptFileInfo {
  /** File name in `scripts/`, with `.js`. */
  name: string;
  size: number;
  updatedAt: string;
}

/** Remix kinds: local and deterministic, or AI-based. */
export type RemixKind = 'color-scale' | 'font-pairs' | 'spacing' | 'layout' | 'ai';

export interface RemixResult {
  /** Frames created side by side (empty for `ai` until the turn finishes). */
  frameIds: string[];
  /** Name of each variation, parallel to `frameIds`. */
  labels: string[];
  /** Assistant turn (`ai`). */
  turnId?: string;
}

/* ---------- editor window commands (presentation) ---------- */

/** Command the daemon sends to an editor window on behalf of the MCP (presentation mode). */
export type EditorCommand =
  | {
      type: 'presentation:start';
      docId: string;
      /** Default: the page shown in the editor. */
      pageId?: string;
      /** Slide to start from (a root frame of the page). Default: the selection's frame, or the first. */
      frameId?: string;
    }
  | { type: 'presentation:stop' }
  | {
      type: 'presentation:goto';
      /** 0-based slide index. */
      index?: number;
      frameId?: string;
      step?: SlideStep;
    };

/** Command for the editor window; it answers with an `editor:result` request carrying the `commandId`. */
export interface EditorCommandMessage {
  type: 'editor:command';
  commandId: string;
  command: EditorCommand;
}

export type ServerMessage =
  | HelloEvent
  | DocOpenedEvent
  | DocChangedEvent
  | DocSavedEvent
  | DocClosedEvent
  | SelectionChangedEvent
  | ActiveChangedEvent
  | AgentFinishedEvent
  | AssistantEventMessage
  | EditorCommandMessage
  | AckMessage
  | ErrorMessage;

/* ---------- client → server ---------- */

export interface OpApplyRequest {
  type: 'op:apply';
  reqId: string;
  docId: string;
  ops: Op[];
}
export interface SelectionSetRequest {
  type: 'selection:set';
  reqId: string;
  docId: string;
  nodeIds: string[];
}
export interface DocOpenRequest {
  type: 'doc:open';
  reqId: string;
  path: string;
}
export interface DocSaveRequest {
  type: 'doc:save';
  reqId: string;
  docId?: string;
}
export interface UndoRequest {
  type: 'undo';
  reqId: string;
  docId?: string;
}
export interface RedoRequest {
  type: 'redo';
  reqId: string;
  docId?: string;
}
export interface ActiveSetRequest {
  type: 'active:set';
  reqId: string;
  docId: string;
}

export interface DocNewRequest {
  type: 'doc:new';
  reqId: string;
  /** File path (normalized to `.mockup.json`; never overwrites). */
  path: string;
  name: string;
}
export interface DocCloseRequest {
  type: 'doc:close';
  reqId: string;
  docId: string;
}

/** Saves the document to another path (overwrites; the native dialog already confirmed) and copies `assets/`. */
export interface DocSaveAsRequest {
  type: 'doc:saveAs';
  reqId: string;
  docId?: string;
  path: string;
}

/** Sends a prompt to the assistant (one turn). Ack: `{ turnId }`; the rest arrives via `assistant:event`. */
export interface AssistantSendRequest {
  type: 'assistant:send';
  reqId: string;
  docId: string;
  prompt: string;
  /** Selection used as context (default: the daemon's selection). */
  selection?: string[];
  /** Backend of the turn (default: the one from the config). */
  backend?: string;
}
/** Cancels the document's in-progress turn. Ack: `{ cancelled }`. */
export interface AssistantCancelRequest {
  type: 'assistant:cancel';
  reqId: string;
  docId: string;
}
/** History and state. Ack: `{ messages, running, backends, config }`. */
export interface AssistantHistoryRequest {
  type: 'assistant:history';
  reqId: string;
  docId: string;
}
export interface AssistantClearRequest {
  type: 'assistant:clear';
  reqId: string;
  docId: string;
}
/** Reads (with no fields) or writes the configuration. Ack: `{ config, backends }`. */
export interface AssistantConfigRequest {
  type: 'assistant:config';
  reqId: string;
  config?: Partial<AssistantConfig>;
}

/** Runs a script (one undo group). Ack: `ScriptRunResult`. */
export interface ScriptRunRequest {
  type: 'script:run';
  reqId: string;
  docId: string;
  code: string;
  /** Selection seen by `doc.selection()` (default: the daemon's). */
  selection?: string[];
}
/** `scripts/*.js` library next to the document. Ack: `{ dir, scripts: ScriptFileInfo[] }`. */
export interface ScriptListRequest {
  type: 'script:list';
  reqId: string;
  docId: string;
}
/** Ack: `{ name, code }`. */
export interface ScriptReadRequest {
  type: 'script:read';
  reqId: string;
  docId: string;
  name: string;
}
/** Ack: `{ name }` (normalized name, with `.js`). */
export interface ScriptSaveRequest {
  type: 'script:save';
  reqId: string;
  docId: string;
  name: string;
  code: string;
}
export interface ScriptDeleteRequest {
  type: 'script:delete';
  reqId: string;
  docId: string;
  name: string;
}
/** Generates a script from a prompt (via the assistant backend). Ack: `{ code }`. */
export interface ScriptGenerateRequest {
  type: 'script:generate';
  reqId: string;
  docId: string;
  prompt: string;
}

/** Generates variations of a node side by side. Ack: `RemixResult`. */
export interface RemixRequest {
  type: 'remix';
  reqId: string;
  docId: string;
  nodeId: string;
  kind: RemixKind;
  count?: number;
  /** Required for `ai`. */
  prompt?: string;
}

/**
 * Registers the connection as an editor window (it can receive `editor:command`). Sent on connect and
 * again when the window gets focus: the daemon targets the most recently focused editor. Ack: `{}`.
 */
export interface EditorRegisterRequest {
  type: 'editor:register';
  reqId: string;
  /** The window has focus. */
  focused: boolean;
}

/** Answer to an `editor:command`. Ack: `{}`. */
export interface EditorResultRequest {
  type: 'editor:result';
  reqId: string;
  commandId: string;
  ok: boolean;
  /** Presentation state after the command (presentation commands). */
  result?: PresentationState;
  /** Why the command failed (`ok: false`). */
  error?: string;
}

export type ClientMessage =
  | OpApplyRequest
  | SelectionSetRequest
  | DocOpenRequest
  | DocSaveRequest
  | UndoRequest
  | RedoRequest
  | ActiveSetRequest
  | DocNewRequest
  | DocCloseRequest
  | DocSaveAsRequest
  | AssistantSendRequest
  | AssistantCancelRequest
  | AssistantHistoryRequest
  | AssistantClearRequest
  | AssistantConfigRequest
  | ScriptRunRequest
  | ScriptListRequest
  | ScriptReadRequest
  | ScriptSaveRequest
  | ScriptDeleteRequest
  | ScriptGenerateRequest
  | RemixRequest
  | EditorRegisterRequest
  | EditorResultRequest;
