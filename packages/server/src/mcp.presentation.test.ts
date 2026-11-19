import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {
  NO_PRESENTATION,
  createNode,
  createNodeFromTag,
  navigateSlide,
  presentationSlides,
  slideIndexOfNode,
  type Document,
  type EditorCommand,
  type PresentationState,
} from '@mockup/core';
import { startDaemon, type DaemonHandle } from './index.js';
import { makeWorkspace } from './test-utils.js';

const textOf = (r: unknown): string =>
  (r as { content: { type: string; text?: string }[] }).content
    .filter((c) => c.type === 'text')
    .map((c) => c.text)
    .join('\n');

interface FakeEditor {
  sock: WebSocket;
  commands: EditorCommand[];
  focus(): void;
  close(): Promise<void>;
}

describe('MCP presentation', () => {
  let ws: ReturnType<typeof makeWorkspace>;
  let daemon: DaemonHandle;
  let client: Client;
  let docId: string;
  let mobileId: string;
  let hiddenId: string;
  const editors: FakeEditor[] = [];
  const nested = 'el_nest0001';

  /** Fake editor window: simulates the presentation state with the core helpers. */
  async function connectEditor(opts: { answer?: boolean; focused?: boolean } = {}) {
    const answer = opts.answer !== false;
    const sock = new WebSocket(daemon.wsUrl);
    let doc: Document | null = null;
    let state: PresentationState = NO_PRESENTATION;
    const commands: FakeEditor['commands'] = [];
    let n = 0;
    const send = (m: Record<string, unknown>): void =>
      sock.send(JSON.stringify({ reqId: `e${++n}`, ...m }));
    const ready = new Promise<void>((resolve) => {
      sock.on('message', (data) => {
        const m = JSON.parse(data.toString()) as Record<string, unknown> & {
          commandId: string;
          command: EditorCommand;
          doc: Document;
        };
        if (m.type === 'hello' || m.type === 'doc:changed') {
          doc = m.doc as Document;
          if (m.type === 'hello') resolve();
        } else if (m.type === 'editor:command') {
          const cmd = m.command as EditorCommand;
          commands.push(cmd);
          if (!answer) return;
          const reply = (ok: boolean, result?: PresentationState, error?: string): void =>
            send({ type: 'editor:result', commandId: m.commandId, ok, result, error });
          if (cmd.type === 'presentation:stop') {
            // Like the editor: answers with the state from before stopping.
            const before = state;
            state = NO_PRESENTATION;
            return reply(true, before);
          }
          if (cmd.type === 'presentation:start') {
            const page = doc!.pages.find((p) => p.id === cmd.pageId) ?? doc!.pages[0]!;
            const slides = presentationSlides(page);
            const i = cmd.frameId ? slideIndexOfNode(page, slides, cmd.frameId) : 0;
            state = {
              active: true,
              docId: cmd.docId,
              pageId: page.id,
              index: Math.max(i, 0),
              frameId: slides[Math.max(i, 0)]?.id ?? null,
              slides,
              fullscreen: false,
            };
            return reply(true, state);
          }
          if (!state.active) return reply(false, undefined, 'No presentation is running.');
          const page = doc!.pages.find((p) => p.id === state.pageId);
          let index = state.index;
          if (cmd.step) index = navigateSlide(index, state.slides.length, { type: cmd.step });
          else if (cmd.index !== undefined)
            index = navigateSlide(index, state.slides.length, { type: 'goto', index: cmd.index });
          else if (cmd.frameId) {
            const i = slideIndexOfNode(page, state.slides, cmd.frameId);
            if (i < 0) return reply(false, undefined, `Frame not found: ${cmd.frameId}`);
            index = i;
          }
          state = { ...state, index, frameId: state.slides[index]?.id ?? null };
          reply(true, state);
        }
      });
    });
    await new Promise<void>((resolve) => sock.on('open', () => resolve()));
    await ready;
    send({ type: 'editor:register', focused: opts.focused ?? true });
    const editor: FakeEditor = {
      sock,
      commands,
      focus: () => send({ type: 'editor:register', focused: true }),
      close: () =>
        new Promise<void>((resolve) => {
          sock.once('close', () => resolve());
          sock.close();
        }),
    };
    editors.push(editor);
    // wait until the daemon has registered it
    for (
      let i = 0;
      i < 100 &&
      daemon.services.editors.count() <
        editors.filter((e) => e.sock.readyState === WebSocket.OPEN).length;
      i++
    )
      await new Promise((r) => setTimeout(r, 10));
    return editor;
  }

  beforeEach(async () => {
    ws = makeWorkspace();
    daemon = await startDaemon({ port: 0, dataDir: ws.dataDir, writeInfo: false });
    client = new Client({ name: 'test', version: '0.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(daemon.mcpUrl)));
    await client.callTool({ name: 'open_document', arguments: { path: ws.file } });
    docId = daemon.store.resolveDocId();
    const mobile = createNodeFromTag('div', {
      isRoot: true,
      name: 'Mobile',
      styles: { width: '390px', height: '844px' },
      position: { x: 1600, y: 0 },
    });
    mobile.children.push(createNode({ id: nested, tag: 'button', name: 'Buy' }));
    const hidden = createNodeFromTag('div', {
      isRoot: true,
      name: 'Draft',
      styles: { width: '390px', height: '844px' },
      position: { x: 2200, y: 0 },
    });
    hidden.hidden = true;
    mobileId = mobile.id;
    hiddenId = hidden.id;
    const pageId = daemon.store.get(docId).pages[0]!.id;
    daemon.store.applyOps(
      docId,
      [
        { type: 'createNode', parentId: null, pageId, node: mobile },
        { type: 'createNode', parentId: null, pageId, node: hidden },
        { type: 'createPage', pageId: 'pg_empty001', name: 'Empty' },
      ],
      { source: 'mcp' },
    );
    const emptyHidden = createNodeFromTag('div', { isRoot: true, name: 'Only hidden' });
    emptyHidden.hidden = true;
    daemon.store.applyOps(
      docId,
      [{ type: 'createNode', parentId: null, pageId: 'pg_empty001', node: emptyHidden }],
      { source: 'mcp' },
    );
  });
  afterEach(async () => {
    await client.close();
    for (const e of editors.splice(0)) e.sock.terminate();
    await daemon.close();
    ws.cleanup();
  });

  const call = (name: string, args: Record<string, unknown> = {}) =>
    client.callTool({ name, arguments: args });

  it('the tools are listed with short descriptions and no read-only hint', async () => {
    const { tools } = await client.listTools();
    for (const name of ['start_presentation', 'presentation_goto', 'stop_presentation']) {
      const t = tools.find((x) => x.name === name);
      expect(t, name).toBeTruthy();
      expect(t!.description!.length).toBeLessThanOrEqual(300);
      expect(t!.annotations?.readOnlyHint).toBe(false);
    }
  });

  it('without an editor window every tool reports a clear error', async () => {
    for (const [name, args] of [
      ['start_presentation', {}],
      ['presentation_goto', { step: 'next' }],
      ['stop_presentation', {}],
    ] as const) {
      const r = await call(name, args);
      expect(r.isError, name).toBe(true);
      expect(textOf(r)).toContain('No editor window is connected');
    }
  });

  it('start returns the slide order with ids and names, skipping hidden frames', async () => {
    const editor = await connectEditor();
    const r = await call('start_presentation');
    expect(r.isError, textOf(r)).toBeFalsy();
    const text = textOf(r);
    expect(text).toContain('slide 1 / 2 — "Desktop"');
    expect(text).toContain(`0. Desktop (${ws.frameId})  <- current`);
    expect(text).toContain(`1. Mobile (${mobileId})`);
    expect(text).not.toContain(hiddenId);
    expect(text).toContain('inside its window');
    expect(text).toContain('presentation_goto');
    expect(editor.commands[0]).toMatchObject({ type: 'presentation:start', docId });
  });

  it('start with the id of a nested node begins at its frame', async () => {
    const editor = await connectEditor();
    const r = await call('start_presentation', { frameId: nested });
    expect(r.isError, textOf(r)).toBeFalsy();
    expect(textOf(r)).toContain(`slide 2 / 2 — "Mobile" (${mobileId})`);
    const pageId = daemon.store.get(docId).pages[0]!.id;
    expect(editor.commands[0]).toEqual({
      type: 'presentation:start',
      docId,
      pageId,
      frameId: mobileId,
    });
  });

  it('rejects an unknown page, an unknown or hidden frame and a page without visible frames', async () => {
    const editor = await connectEditor();
    const pageId = daemon.store.get(docId).pages[0]!.id;
    const bad = await call('start_presentation', { pageId: 'pg_nope' });
    expect(bad.isError).toBe(true);
    expect(textOf(bad)).toContain('Page not found: "pg_nope"');
    const noFrame = await call('start_presentation', { pageId, frameId: 'fr_nope0001' });
    expect(noFrame.isError).toBe(true);
    expect(textOf(noFrame)).toContain('Frame not found');
    const noNode = await call('start_presentation', { frameId: 'fr_nope0001' });
    expect(noNode.isError).toBe(true);
    const hidden = await call('start_presentation', { pageId, frameId: hiddenId });
    expect(hidden.isError).toBe(true);
    const empty = await call('start_presentation', { pageId: 'pg_empty001' });
    expect(empty.isError).toBe(true);
    expect(textOf(empty)).toContain('Page "Empty" has no visible frames to present.');
    expect(editor.commands).toHaveLength(0);
  });

  it('goto by step, index and frameId; invalid arguments and not running are errors', async () => {
    await connectEditor();
    const idle = await call('presentation_goto', { step: 'next' });
    expect(idle.isError).toBe(true);
    expect(textOf(idle)).toContain('No presentation is running.');
    await call('start_presentation');
    const next = await call('presentation_goto', { step: 'next' });
    expect(textOf(next)).toContain(`slide 2 / 2 — "Mobile" (${mobileId})`);
    const first = await call('presentation_goto', { index: 0 });
    expect(textOf(first)).toContain('slide 1 / 2 — "Desktop"');
    const byFrame = await call('presentation_goto', { frameId: nested });
    expect(textOf(byFrame)).toContain('slide 2 / 2 — "Mobile"');
    const last = await call('presentation_goto', { step: 'first' });
    expect(textOf(last)).toContain('slide 1 / 2');
    const none = await call('presentation_goto', {});
    expect(none.isError).toBe(true);
    expect(textOf(none)).toContain('exactly one');
    const two = await call('presentation_goto', { index: 1, step: 'next' });
    expect(two.isError).toBe(true);
  });

  it('stop ends a running presentation and is not an error when none is running', async () => {
    await connectEditor();
    const none = await call('stop_presentation');
    expect(none.isError).toBeFalsy();
    expect(textOf(none)).toBe('No presentation was running.');
    await call('start_presentation');
    const stopped = await call('stop_presentation');
    expect(stopped.isError).toBeFalsy();
    expect(textOf(stopped)).toBe('Presentation stopped.');
    expect(textOf(await call('stop_presentation'))).toBe('No presentation was running.');
  });

  it('an editor that disconnects while a command is pending turns into an error', async () => {
    const editor = await connectEditor({ answer: false });
    const pending = call('start_presentation');
    for (let i = 0; i < 100 && editor.commands.length === 0; i++)
      await new Promise((r) => setTimeout(r, 10));
    expect(editor.commands).toHaveLength(1);
    await editor.close();
    const r = await pending;
    expect(r.isError).toBe(true);
    expect(textOf(r)).toContain('The editor window was closed before answering.');
  });

  it('sends the command to the most recently focused editor window', async () => {
    const a = await connectEditor({ focused: false });
    const b = await connectEditor({ focused: false });
    a.focus();
    await new Promise((r) => setTimeout(r, 50));
    await call('start_presentation');
    expect(a.commands).toHaveLength(1);
    expect(b.commands).toHaveLength(0);
    b.focus();
    await new Promise((r) => setTimeout(r, 50));
    // the window that is presenting keeps receiving the navigation commands
    await call('presentation_goto', { step: 'next' });
    expect(a.commands).toHaveLength(2);
    expect(b.commands).toHaveLength(0);
  });

  it('makes the requested document active before starting', async () => {
    await connectEditor();
    const other = await call('create_document', {
      path: ws.dir,
      name: 'Other',
    });
    expect(other.isError, textOf(other)).toBeFalsy();
    const otherId = daemon.store.resolveDocId();
    expect(otherId).not.toBe(docId);
    const r = await call('start_presentation', { docId });
    expect(r.isError, textOf(r)).toBeFalsy();
    expect(daemon.store.resolveDocId()).toBe(docId);
  });
});
