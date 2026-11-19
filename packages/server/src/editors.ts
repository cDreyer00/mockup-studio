/**
 * Editor window registry and command channel: the daemon sends commands (presentation mode) to an
 * editor window over its WebSocket and waits for the `editor:result` answer. Connections are
 * abstract so the channel does not depend on `ws`.
 */
import { randomUUID } from 'node:crypto';
import type {
  EditorCommand,
  EditorResultRequest,
  PresentationState,
  ServerMessage,
} from '@mockup/core';

/** Something the daemon can send messages to (ws.ts adapts a WebSocket). */
export interface EditorConnection {
  send(msg: ServerMessage): void;
}

export const NO_EDITOR_MESSAGE =
  'No editor window is connected. Open the Mockup Studio app (or the editor in the browser) and try again.';

/** No editor window is connected (usage error: the caller must open one). */
export class NoEditorError extends Error {
  constructor() {
    super(NO_EDITOR_MESSAGE);
    this.name = 'NoEditorError';
  }
}

export interface EditorChannelOptions {
  /** How long to wait for the editor's answer (default 5000 ms). */
  timeoutMs?: number;
}

interface EditorEntry {
  conn: EditorConnection;
  /** Registration order (greater = more recent). */
  seq: number;
  /** Logical time of the last focus report (0 = never focused). */
  focusedAt: number;
}

interface Pending {
  conn: EditorConnection;
  type: EditorCommand['type'];
  resolve(state: PresentationState): void;
  reject(err: Error): void;
  timer: NodeJS.Timeout;
}

export class EditorChannel {
  private readonly editors = new Map<EditorConnection, EditorEntry>();
  private readonly pending = new Map<string, Pending>();
  private presenter: EditorConnection | null = null;
  private seq = 0;
  private clock = 0;
  private readonly timeoutMs: number;

  constructor(opts: EditorChannelOptions = {}) {
    this.timeoutMs = opts.timeoutMs ?? 5000;
  }

  /** Adds or updates an editor window; `focused` makes it the most recently focused one. */
  register(conn: EditorConnection, focused: boolean): void {
    let entry = this.editors.get(conn);
    if (!entry) {
      entry = { conn, seq: ++this.seq, focusedAt: 0 };
      this.editors.set(conn, entry);
    }
    // Logical clock (strictly increasing): wall-clock timestamps could tie between quick events.
    if (focused) entry.focusedAt = ++this.clock;
  }

  unregister(conn: EditorConnection): void {
    this.editors.delete(conn);
    if (this.presenter === conn) this.presenter = null;
    for (const [id, p] of this.pending) {
      if (p.conn !== conn) continue;
      clearTimeout(p.timer);
      this.pending.delete(id);
      p.reject(new Error('The editor window was closed before answering.'));
    }
  }

  count(): number {
    return this.editors.size;
  }

  /** An editor window last reported a running presentation (and is still connected). */
  isPresenting(): boolean {
    return this.presenter !== null && this.editors.has(this.presenter);
  }

  /** Window that receives the next command. */
  private target(): EditorConnection | null {
    if (this.presenter && this.editors.has(this.presenter)) return this.presenter;
    let best: EditorEntry | null = null;
    for (const e of this.editors.values()) {
      if (
        !best ||
        e.focusedAt > best.focusedAt ||
        (e.focusedAt === best.focusedAt && e.seq > best.seq)
      )
        best = e;
    }
    return best?.conn ?? null;
  }

  /** Sends a command to the target editor window and waits for its answer. */
  command(cmd: EditorCommand): Promise<PresentationState> {
    const conn = this.target();
    if (!conn) return Promise.reject(new NoEditorError());
    const commandId = randomUUID();
    return new Promise<PresentationState>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(commandId);
        reject(new Error('The editor window did not answer in time.'));
      }, this.timeoutMs);
      this.pending.set(commandId, { conn, type: cmd.type, resolve, reject, timer });
      try {
        conn.send({ type: 'editor:command', commandId, command: cmd });
      } catch (e) {
        clearTimeout(timer);
        this.pending.delete(commandId);
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    });
  }

  /** Settles the pending command with the editor's answer (unknown ids and foreign connections are ignored). */
  resolve(conn: EditorConnection, msg: EditorResultRequest): void {
    const p = this.pending.get(msg.commandId);
    if (!p || p.conn !== conn) return;
    clearTimeout(p.timer);
    this.pending.delete(msg.commandId);
    // `presentation:stop` answers with the state from before stopping: the window no longer presents.
    if (p.type === 'presentation:stop') {
      if (this.presenter === conn) this.presenter = null;
    } else if (msg.result) {
      if (msg.result.active) this.presenter = conn;
      else if (this.presenter === conn) this.presenter = null;
    }
    if (msg.ok && msg.result) p.resolve(msg.result);
    else p.reject(new Error(msg.error || 'The editor window could not run the command.'));
  }
}
