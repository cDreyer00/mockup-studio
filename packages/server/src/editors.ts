/**
 * Editor window registry and command channel: the daemon sends commands (presentation mode) to an
 * editor window over its WebSocket and waits for the `editor:result` answer. Connections are
 * abstract so the channel does not depend on `ws`.
 */
import { randomUUID } from 'node:crypto';
import type {
  EditorCommand,
  EditorCommandResult,
  EditorResultRequest,
  MotionPreviewState,
  PresentationState,
  ServerMessage,
} from '@mockup/core';

/** Commands answered with a `PresentationState`. */
export type PresentationCommand = Exclude<EditorCommand, { type: 'motion:preview' }>;
/** Commands answered with a `MotionPreviewState`. */
export type MotionCommand = Extract<EditorCommand, { type: 'motion:preview' }>;

/** An answer that is a presentation state (the only kind that updates the presenting window). */
const isPresentationState = (r: EditorCommandResult): r is PresentationState => 'active' in r;

/** Something the daemon can send messages to (ws.ts adapts a WebSocket). */
export interface EditorConnection {
  send(msg: ServerMessage): void;
}

export const NO_EDITOR_MESSAGE =
  'No editor window is connected. Open the Mockup Studio app (or the editor in the browser) and try again.';

export interface EditorChannelOptions {
  /** How long to wait for the editor's answer (default 8000 ms). */
  timeoutMs?: number;
  /** How long a timed-out command still updates the presenting window if its answer arrives late (default 60 s). */
  lateReplyMs?: number;
}

interface EditorEntry {
  conn: EditorConnection;
  /** Registration order (greater = more recent). */
  seq: number;
  /** Logical time of the last focus report (0 = never focused). */
  focusedAt: number;
  /** Logical time it started presenting (0 = not presenting). */
  presentingAt: number;
}

interface Sent {
  conn: EditorConnection;
  type: EditorCommand['type'];
}

interface Pending extends Sent {
  resolve(state: EditorCommandResult): void;
  reject(err: Error): void;
  timer: NodeJS.Timeout;
}

/** Editor windows and the commands sent to them (one channel per daemon). */
export class EditorChannel {
  private readonly editors = new Map<EditorConnection, EditorEntry>();
  private readonly pending = new Map<string, Pending>();
  /** Commands that timed out: a late answer still tells which window presents. */
  private readonly expired = new Map<string, Sent>();
  private seq = 0;
  private clock = 0;
  private readonly timeoutMs: number;
  private readonly lateReplyMs: number;

  constructor(opts: EditorChannelOptions = {}) {
    this.timeoutMs = opts.timeoutMs ?? 8000;
    this.lateReplyMs = opts.lateReplyMs ?? 60_000;
  }

  /**
   * Adds or updates an editor window. `focused` makes it the most recently focused one; `presenting`
   * (when given) is whether it runs a presentation now (the window reports every change).
   */
  register(conn: EditorConnection, focused: boolean, presenting?: boolean): void {
    let entry = this.editors.get(conn);
    if (!entry) {
      entry = { conn, seq: ++this.seq, focusedAt: 0, presentingAt: 0 };
      this.editors.set(conn, entry);
    }
    // Logical clock (strictly increasing): wall-clock timestamps could tie between quick events.
    if (focused) entry.focusedAt = ++this.clock;
    if (presenting !== undefined) this.setPresenting(conn, presenting, presenting);
  }

  unregister(conn: EditorConnection): void {
    this.editors.delete(conn);
    for (const [id, p] of this.pending) {
      if (p.conn !== conn) continue;
      clearTimeout(p.timer);
      this.pending.delete(id);
      p.reject(new Error('The editor window was closed before answering.'));
    }
    for (const [id, p] of this.expired) if (p.conn === conn) this.expired.delete(id);
  }

  count(): number {
    return this.editors.size;
  }

  /** A connected editor window runs a presentation (as last reported). */
  isPresenting(): boolean {
    return this.presenter() !== null;
  }

  /** The window that most recently started presenting. */
  private presenter(): EditorEntry | null {
    let best: EditorEntry | null = null;
    for (const e of this.editors.values()) {
      if (e.presentingAt > 0 && (!best || e.presentingAt > best.presentingAt)) best = e;
    }
    return best;
  }

  /** The most recently focused window (ties: the most recently registered). */
  private focused(): EditorEntry | null {
    let best: EditorEntry | null = null;
    for (const e of this.editors.values()) {
      if (
        !best ||
        e.focusedAt > best.focusedAt ||
        (e.focusedAt === best.focusedAt && e.seq > best.seq)
      )
        best = e;
    }
    return best;
  }

  /** Starting and motion previews go to the focused window; navigating and stopping to the presenting one. */
  private target(type: EditorCommand['type']): EditorConnection | null {
    // Starting a presentation and previewing motion go to the focused window.
    const entry =
      type === 'presentation:start' || type === 'motion:preview'
        ? this.focused()
        : (this.presenter() ?? this.focused());
    return entry?.conn ?? null;
  }

  /** `restart` = it (re)started presenting just now: it becomes the most recent presenter. */
  private setPresenting(conn: EditorConnection, on: boolean, restart: boolean): void {
    const entry = this.editors.get(conn);
    if (!entry) return;
    if (!on) entry.presentingAt = 0;
    else if (restart || entry.presentingAt === 0) entry.presentingAt = ++this.clock;
  }

  /** Sends a command to the target editor window and waits for its answer. */
  command(cmd: PresentationCommand): Promise<PresentationState>;
  command(cmd: MotionCommand): Promise<MotionPreviewState>;
  command(cmd: EditorCommand): Promise<EditorCommandResult>;
  command(cmd: EditorCommand): Promise<EditorCommandResult> {
    const conn = this.target(cmd.type);
    if (!conn) return Promise.reject(new Error(NO_EDITOR_MESSAGE));
    const commandId = randomUUID();
    return new Promise<EditorCommandResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(commandId);
        this.expired.set(commandId, { conn, type: cmd.type });
        setTimeout(() => this.expired.delete(commandId), this.lateReplyMs).unref();
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

  /**
   * Settles the pending command with the editor's answer (unknown ids and foreign connections are
   * ignored). A late answer to a timed-out command only updates which window presents.
   */
  resolve(conn: EditorConnection, msg: EditorResultRequest): void {
    const late = this.expired.get(msg.commandId);
    if (late) {
      if (late.conn !== conn) return;
      this.expired.delete(msg.commandId);
      this.track(late, msg);
      return;
    }
    const p = this.pending.get(msg.commandId);
    if (!p || p.conn !== conn) return;
    clearTimeout(p.timer);
    this.pending.delete(msg.commandId);
    this.track(p, msg);
    if (msg.ok && msg.result) p.resolve(msg.result);
    else p.reject(new Error(msg.error || 'The editor window could not run the command.'));
  }

  /** Updates the presenting window from a command's answer. */
  private track({ conn, type }: Sent, msg: EditorResultRequest): void {
    // `presentation:stop` answers with the state from before stopping: the window no longer presents.
    if (type === 'presentation:stop') this.setPresenting(conn, false, false);
    else if (msg.result && isPresentationState(msg.result))
      this.setPresenting(conn, msg.result.active, type === 'presentation:start');
  }
}
