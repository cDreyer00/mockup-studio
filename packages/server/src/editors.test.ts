import { describe, expect, it } from 'vitest';
import { NO_PRESENTATION, type PresentationState, type ServerMessage } from '@mockup/core';
import { EditorChannel, type EditorConnection } from './editors.js';

function fakeConn(): EditorConnection & { sent: ServerMessage[] } {
  const sent: ServerMessage[] = [];
  return { sent, send: (m) => void sent.push(m) };
}

const active: PresentationState = {
  active: true,
  docId: 'doc_1',
  pageId: 'pg_1',
  index: 0,
  frameId: 'fr_1',
  slides: [{ index: 0, id: 'fr_1', name: 'A' }],
  fullscreen: false,
};

const commandIdOf = (c: { sent: ServerMessage[] }): string => {
  const m = c.sent.at(-1);
  if (m?.type !== 'editor:command') throw new Error('no command sent');
  return m.commandId;
};

const answer = (
  ch: EditorChannel,
  c: ReturnType<typeof fakeConn>,
  result: PresentationState = active,
) =>
  ch.resolve(c, {
    type: 'editor:result',
    reqId: 'r',
    commandId: commandIdOf(c),
    ok: true,
    result,
  });

describe('EditorChannel', () => {
  it('rejects with a clear error when no editor is connected', async () => {
    const ch = new EditorChannel();
    await expect(ch.command({ type: 'presentation:stop' })).rejects.toThrow(
      /No editor window is connected/,
    );
  });

  it('sends the command and resolves with the editor result', async () => {
    const ch = new EditorChannel();
    const a = fakeConn();
    ch.register(a, true);
    const p = ch.command({ type: 'presentation:goto', step: 'next' });
    expect(a.sent[0]).toMatchObject({
      type: 'editor:command',
      command: { type: 'presentation:goto', step: 'next' },
    });
    answer(ch, a);
    await expect(p).resolves.toEqual(active);
  });

  it('rejects with the editor error when ok is false', async () => {
    const ch = new EditorChannel();
    const a = fakeConn();
    ch.register(a, true);
    const p = ch.command({ type: 'presentation:goto', index: 3 });
    ch.resolve(a, {
      type: 'editor:result',
      reqId: 'r',
      commandId: commandIdOf(a),
      ok: false,
      error: 'No presentation is running.',
    });
    await expect(p).rejects.toThrow('No presentation is running.');
  });

  it('targets the most recently focused editor; ties go to the most recently registered', async () => {
    const ch = new EditorChannel();
    const a = fakeConn();
    const b = fakeConn();
    ch.register(a, false);
    ch.register(b, false);
    void ch.command({ type: 'presentation:stop' }).catch(() => undefined);
    expect(a.sent).toHaveLength(0);
    expect(b.sent).toHaveLength(1);
    ch.register(a, true);
    void ch.command({ type: 'presentation:stop' }).catch(() => undefined);
    expect(a.sent).toHaveLength(1);
    ch.register(b, true);
    void ch.command({ type: 'presentation:stop' }).catch(() => undefined);
    expect(b.sent).toHaveLength(2);
    expect(ch.count()).toBe(2);
  });

  it('keeps targeting the editor that reports an active presentation, even if another is focused', async () => {
    const ch = new EditorChannel();
    const a = fakeConn();
    const b = fakeConn();
    ch.register(a, true);
    ch.register(b, false);
    const p = ch.command({ type: 'presentation:start', docId: 'doc_1' });
    answer(ch, a);
    await p;
    expect(ch.isPresenting()).toBe(true);
    ch.register(b, true);
    const q = ch.command({ type: 'presentation:goto', step: 'next' });
    expect(a.sent).toHaveLength(2);
    expect(b.sent).toHaveLength(0);
    answer(ch, a, NO_PRESENTATION);
    await q;
    expect(ch.isPresenting()).toBe(false);
    void ch.command({ type: 'presentation:stop' }).catch(() => undefined);
    expect(b.sent).toHaveLength(1);
  });

  it('follows the presentation state the windows report (e.g. the user pressed Esc)', async () => {
    const ch = new EditorChannel();
    const a = fakeConn();
    const b = fakeConn();
    ch.register(a, true);
    ch.register(b, false, true); // b started presenting on its own (F5)
    expect(ch.isPresenting()).toBe(true);
    void ch.command({ type: 'presentation:goto', step: 'next' }).catch(() => undefined);
    expect(b.sent).toHaveLength(1);
    // Starting goes to the focused window, not to the presenting one.
    void ch.command({ type: 'presentation:start', docId: 'doc_1' }).catch(() => undefined);
    expect(a.sent).toHaveLength(1);
    ch.register(b, false, false); // b left the presentation
    expect(ch.isPresenting()).toBe(false);
    void ch.command({ type: 'presentation:stop' }).catch(() => undefined);
    expect(a.sent).toHaveLength(2);
    expect(b.sent).toHaveLength(1);
  });

  it('navigates the window that started presenting most recently', async () => {
    const ch = new EditorChannel();
    const a = fakeConn();
    const b = fakeConn();
    ch.register(a, true, true);
    ch.register(b, false, true);
    void ch.command({ type: 'presentation:goto', step: 'next' }).catch(() => undefined);
    expect(b.sent).toHaveLength(1);
    ch.register(b, false, false);
    void ch.command({ type: 'presentation:goto', step: 'next' }).catch(() => undefined);
    expect(a.sent).toHaveLength(1);
  });

  it('a late answer to a timed-out start still marks the presenting window', async () => {
    const ch = new EditorChannel({ timeoutMs: 20 });
    const a = fakeConn();
    const b = fakeConn();
    ch.register(a, true);
    ch.register(b, false);
    const p = ch.command({ type: 'presentation:start', docId: 'doc_1' });
    const id = commandIdOf(a);
    await expect(p).rejects.toThrow('did not answer in time');
    expect(ch.isPresenting()).toBe(false);
    // From another connection: ignored.
    ch.resolve(b, { type: 'editor:result', reqId: 'r', commandId: id, ok: true, result: active });
    expect(ch.isPresenting()).toBe(false);
    ch.resolve(a, { type: 'editor:result', reqId: 'r', commandId: id, ok: true, result: active });
    expect(ch.isPresenting()).toBe(true);
    ch.register(b, true);
    void ch.command({ type: 'presentation:goto', step: 'next' }).catch(() => undefined);
    expect(a.sent).toHaveLength(2);
    expect(b.sent).toHaveLength(0);
  });

  it('forgets timed-out commands after a while', async () => {
    const ch = new EditorChannel({ timeoutMs: 10, lateReplyMs: 10 });
    const a = fakeConn();
    ch.register(a, true);
    const p = ch.command({ type: 'presentation:start', docId: 'doc_1' });
    const id = commandIdOf(a);
    await expect(p).rejects.toThrow('did not answer in time');
    await new Promise((r) => setTimeout(r, 30));
    ch.resolve(a, { type: 'editor:result', reqId: 'r', commandId: id, ok: true, result: active });
    expect(ch.isPresenting()).toBe(false);
  });

  it('falls back to the focused editor when the presenting one disconnects', async () => {
    const ch = new EditorChannel();
    const a = fakeConn();
    const b = fakeConn();
    ch.register(a, true);
    ch.register(b, false);
    const p = ch.command({ type: 'presentation:start', docId: 'doc_1' });
    answer(ch, a);
    await p;
    ch.unregister(a);
    void ch.command({ type: 'presentation:stop' }).catch(() => undefined);
    expect(b.sent).toHaveLength(1);
  });

  it('times out when the editor does not answer', async () => {
    const ch = new EditorChannel({ timeoutMs: 20 });
    ch.register(fakeConn(), true);
    await expect(ch.command({ type: 'presentation:stop' })).rejects.toThrow(
      'The editor window did not answer in time.',
    );
  });

  it('unregister rejects the pending commands of that connection', async () => {
    const ch = new EditorChannel();
    const a = fakeConn();
    ch.register(a, true);
    const p = ch.command({ type: 'presentation:stop' });
    ch.unregister(a);
    await expect(p).rejects.toThrow('The editor window was closed before answering.');
    expect(ch.count()).toBe(0);
  });

  it('ignores unknown command ids and results from another connection', async () => {
    const ch = new EditorChannel({ timeoutMs: 30 });
    const a = fakeConn();
    const b = fakeConn();
    ch.register(a, true);
    ch.register(b, false);
    const p = ch.command({ type: 'presentation:stop' });
    ch.resolve(b, {
      type: 'editor:result',
      reqId: 'r',
      commandId: commandIdOf(a),
      ok: true,
      result: active,
    });
    ch.resolve(a, { type: 'editor:result', reqId: 'r', commandId: 'nope', ok: true });
    await expect(p).rejects.toThrow('did not answer in time');
    expect(ch.isPresenting()).toBe(false);
  });
  it('a stop answered with the state from before stopping clears the presenting window', async () => {
    const ch = new EditorChannel();
    const a = fakeConn();
    ch.register(a, true);
    const p = ch.command({ type: 'presentation:start', docId: 'doc_1' });
    answer(ch, a);
    await p;
    expect(ch.isPresenting()).toBe(true);
    const q = ch.command({ type: 'presentation:stop' });
    answer(ch, a, active);
    await expect(q).resolves.toEqual(active);
    expect(ch.isPresenting()).toBe(false);
  });

  it('sends motion:preview to the focused window and does not touch the presenting one', async () => {
    const ch = new EditorChannel();
    const a = fakeConn();
    const b = fakeConn();
    ch.register(a, false, true); // a presents
    ch.register(b, true); // b is focused
    const preview = { frameId: 'fr_1', mode: 'play', time: 0, duration: 1200 } as const;
    const p = ch.command({ type: 'motion:preview', docId: 'doc_1', action: 'play' });
    expect(a.sent).toHaveLength(0);
    expect(b.sent).toHaveLength(1);
    ch.resolve(b, {
      type: 'editor:result',
      reqId: 'r',
      commandId: commandIdOf(b),
      ok: true,
      result: preview,
    });
    await expect(p).resolves.toEqual(preview);
    // a motion answer has no `active`: nobody changes presenting state
    expect(ch.isPresenting()).toBe(true);
  });
});
