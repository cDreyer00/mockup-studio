/**
 * Contracts of the phase 9 services (assistant, scripts and remix) shared by the WebSocket, the
 * MCP and the services themselves. The implementations live in `agent/`, `scripts/` and `remix.ts`.
 */
import type {
  AssistantBackendInfo,
  AssistantConfig,
  AssistantEvent,
  AssistantMessage,
  ClientMessage,
  RemixKind,
  RemixResult,
  ScriptFileInfo,
  ScriptRunResult,
  ServerMessage,
} from '@mockup/core';
import type { EditorChannel } from './editors.js';

/** Link between an MCP session and an assistant turn (the CLI agent connects with `?turn=<token>`). */
export interface TurnBinding {
  turnId: string;
  docId: string;
  /** Undo group of the turn: all the agent's ops in the turn become a single entry. */
  group: string;
}

/**
 * Resolves the turn token of an MCP session. `undefined` = regular session (no turn); `null` = the
 * token belongs to a turn that has already finished or was cancelled (writes must be refused).
 */
export type TurnResolver = () => TurnBinding | null | undefined;

export interface RunTurnOptions {
  /** Selection used as context (default: the daemon's selection). */
  selection?: string[];
  /** Backend of the turn (default: the configured one). */
  backend?: string;
  /**
   * Undo group to use (e.g. an AI remix called from inside another turn reuses that turn's
   * group). Default: a new group per turn.
   */
  group?: string;
  /** Extra instruction text (e.g. the remix's variations request). */
  instructions?: string;
  /** Does not record the turn in the document's history. */
  ephemeral?: boolean;
}

export interface AssistantServiceApi {
  /** WS `assistant:*` messages. */
  handle(msg: ClientMessage): Promise<unknown>;
  /** Starts a turn and returns the id right away; the result arrives through events. */
  send(docId: string, prompt: string, opts?: RunTurnOptions): Promise<{ turnId: string }>;
  /** Runs a whole turn and returns the assistant's final message. */
  runTurn(docId: string, prompt: string, opts?: RunTurnOptions): Promise<AssistantMessage>;
  /** Cancels the document's turn in progress. */
  cancel(docId: string): boolean;
  /**
   * Text-only question, with no MCP and no tools (e.g. generating a script). With `docId`: at most
   * one per document and cancellable via `cancel(docId)`; `signal` cancels in any case.
   */
  generateText(
    prompt: string,
    opts?: { backend?: string; system?: string; docId?: string; signal?: AbortSignal },
  ): Promise<string>;
  resolveTurn(token: string): TurnBinding | null;
  backends(): Promise<AssistantBackendInfo[]>;
  getConfig(): AssistantConfig;
  history(docId: string): Promise<AssistantMessage[]>;
  onEvent(fn: (docId: string, event: AssistantEvent) => void): () => void;
  close(): Promise<void>;
}

export interface ScriptRunOptions {
  /** Selection seen by `doc.selection()`. */
  selection?: string[];
  /** Undo group (default: a new group per run). */
  group?: string;
  /** Who originated the ops (`editor` from the panel, `mcp` from run_script). */
  source?: 'editor' | 'mcp';
  timeoutMs?: number;
  /**
   * Watchdog from whoever triggered the run (e.g. the assistant turn): checked before each
   * write and every ~100 ms; once it turns false the run is interrupted and nothing more is written.
   */
  alive?: () => boolean;
  /** External cancellation: the worker is terminated immediately and the run returns `ok: false`. */
  signal?: AbortSignal;
}

export interface ScriptServiceApi {
  /** WS `script:*` messages. */
  handle(msg: ClientMessage): Promise<unknown>;
  run(docId: string, code: string, opts?: ScriptRunOptions): Promise<ScriptRunResult>;
  list(docId: string): Promise<{ dir: string | null; scripts: ScriptFileInfo[] }>;
  read(docId: string, name: string): Promise<{ name: string; code: string }>;
  save(docId: string, name: string, code: string): Promise<{ name: string }>;
  remove(docId: string, name: string): Promise<void>;
  generate(docId: string, prompt: string): Promise<{ code: string }>;
}

export interface RemixOptions {
  count?: number;
  prompt?: string;
  group?: string;
  source?: 'editor' | 'mcp';
}

export interface RemixServiceApi {
  /** WS `remix` message. */
  handle(msg: ClientMessage): Promise<unknown>;
  run(docId: string, nodeId: string, kind: RemixKind, opts?: RemixOptions): Promise<RemixResult>;
}

/** Optional daemon services, passed to the WS and the MCP. */
export interface DaemonServices {
  assistant?: AssistantServiceApi;
  scripts?: ScriptServiceApi;
  remix?: RemixServiceApi;
  /** Editor windows: commands from the MCP (presentation mode). */
  editors?: EditorChannel;
}

/** Routes the phase 9 WS messages to the right service (`undefined` = not in this group). */
export function routeServiceMessage(
  services: DaemonServices,
  msg: ClientMessage,
): Promise<unknown> | undefined {
  const t = msg.type;
  const missing = (name: string): never => {
    throw new Error(`${name} is unavailable in this daemon.`);
  };
  if (t.startsWith('assistant:')) return (services.assistant ?? missing('Assistant')).handle(msg);
  if (t.startsWith('script:')) return (services.scripts ?? missing('Scripts')).handle(msg);
  if (t === 'remix') return (services.remix ?? missing('Remix')).handle(msg);
  return undefined;
}

/** Service events forwarded to all WS clients. */
export function attachServiceEvents(
  services: DaemonServices,
  broadcast: (msg: ServerMessage) => void,
): () => void {
  const off = services.assistant?.onEvent((docId, event) =>
    broadcast({ type: 'assistant:event', docId, event }),
  );
  return () => off?.();
}
