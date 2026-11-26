import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {
  NO_PRESENTATION,
  type Document,
  type EditorCommand,
  type Node,
  type PresentationState,
} from '@mockup/core';
import { startDaemon, type DaemonHandle } from './index.js';
import { locateFfmpeg } from './encode.js';
import type { CaptureRequest, CaptureResult, FramesRequest, RenderProvider } from './render.js';
import { makeWorkspace } from './test-utils.js';

const textOf = (r: unknown): string =>
  (r as { content: { type: string; text?: string }[] }).content
    .filter((c) => c.type === 'text')
    .map((c) => c.text)
    .join('\n');

function fakePng(w: number, h: number): Buffer {
  const chunk = (type: string, data: Buffer): Buffer => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(zlib.crc32(body) >>> 0);
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(Buffer.alloc(h * (1 + w * 4), 0x80))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

describe('MCP motion', () => {
  let ws: ReturnType<typeof makeWorkspace>;
  let daemon: DaemonHandle;
  let client: Client;
  let captures: CaptureRequest[];
  let frameReqs: FramesRequest[];
  let cards: string[];
  const sockets: WebSocket[] = [];

  const render: RenderProvider = {
    async capture(req): Promise<CaptureResult> {
      captures.push(req);
      return {
        data: fakePng(16, 16),
        mime: 'image/png',
        width: 100,
        height: 100,
        pixelWidth: 16,
        pixelHeight: 16,
      };
    },
    async measure() {
      throw new Error('not used');
    },
    async captureFrames(req, onFrame) {
      frameReqs.push(req);
      const n = Math.round(req.duration * req.fps);
      for (let i = 0; i < n; i++) await onFrame(fakePng(16, 16), i);
      return { frames: n, pixelWidth: 16, pixelHeight: 16 };
    },
  };

  const call = (name: string, args: Record<string, unknown> = {}) =>
    client.callTool({ name, arguments: args });
  const ok = async (name: string, args: Record<string, unknown> = {}): Promise<string> => {
    const r = await call(name, args);
    expect(r.isError, textOf(r)).toBeFalsy();
    return textOf(r);
  };
  const fail = async (name: string, args: Record<string, unknown> = {}): Promise<string> => {
    const r = await call(name, args);
    expect(r.isError, textOf(r)).toBe(true);
    return textOf(r);
  };
  const docId = (): string => daemon.store.resolveDocId();
  const doc = (): Document => daemon.store.get(docId());
  const find = (n: Node, id: string): Node | undefined =>
    n.id === id ? n : n.children.map((c) => find(c, id)).find(Boolean);
  const node = (id: string): Node => find(doc().pages[0]!.frames[0]!, id)!;
  const undoAll = (): number => {
    let n = 0;
    while (daemon.store.undo(docId(), 'mcp')) n++;
    return n;
  };

  /** Fake editor window answering motion and presentation commands. */
  async function connectEditor(
    answer: (cmd: EditorCommand) => unknown,
  ): Promise<{ commands: EditorCommand[] }> {
    const sock = new WebSocket(daemon.wsUrl);
    sockets.push(sock);
    const commands: EditorCommand[] = [];
    let n = 0;
    const send = (m: Record<string, unknown>): void =>
      sock.send(JSON.stringify({ reqId: `e${++n}`, ...m }));
    const ready = new Promise<void>((resolve) => {
      sock.on('message', (data) => {
        const m = JSON.parse(data.toString()) as {
          type: string;
          commandId: string;
          command: EditorCommand;
        };
        if (m.type === 'hello') resolve();
        else if (m.type === 'editor:command') {
          commands.push(m.command);
          send({
            type: 'editor:result',
            commandId: m.commandId,
            ok: true,
            result: answer(m.command),
          });
        }
      });
    });
    await new Promise<void>((resolve) => sock.on('open', () => resolve()));
    await ready;
    send({ type: 'editor:register', focused: true });
    for (let i = 0; i < 100 && daemon.services.editors.count() < sockets.length; i++)
      await new Promise((r) => setTimeout(r, 10));
    return { commands };
  }

  beforeEach(async () => {
    ws = makeWorkspace();
    captures = [];
    frameReqs = [];
    daemon = await startDaemon({ port: 0, dataDir: ws.dataDir, writeInfo: false, render });
    client = new Client({ name: 'test', version: '0.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(daemon.mcpUrl)));
    await client.callTool({ name: 'open_document', arguments: { path: ws.file } });
    cards = [];
    for (const name of ['A', 'B', 'C']) {
      const t = await ok('create_node', { parentId: ws.frameId, tag: 'div', name });
      cards.push(/Node created: (\S+)/.exec(t)![1]!);
    }
  });
  afterEach(async () => {
    await client.close();
    for (const s of sockets.splice(0)) s.terminate();
    await daemon.close();
    ws.cleanup();
  });

  it('list_motion_presets lists presets, easings and transitions', async () => {
    const t = await ok('list_motion_presets');
    expect(t).toContain('MILLISECONDS');
    expect(t).toContain('fade-up');
    expect(t).toContain('float');
    expect(t).toContain('distance=');
    expect(t).toContain('[paint]');
    expect(t).toContain('spring');
    expect(t).toContain('push*');
    expect(t).toContain('magic');
    const emphasis = await ok('list_motion_presets', { kind: 'emphasis' });
    expect(emphasis).toContain('pulse');
    expect(emphasis).not.toContain('fade-up');
  });

  it('animate with cascade sets staggered delays in ONE undo step', async () => {
    const t = await ok('animate', { nodeIds: cards, preset: 'fade-up', delay: 100, cascade: 80 });
    expect(t).toContain('3 node(s)');
    expect(t).toContain('Timeline of');
    expect(t).toContain('get_screenshot');
    expect(node(cards[0]!).animations).toEqual([{ kind: 'in', preset: 'fade-up', delay: 100 }]);
    expect(node(cards[1]!).animations![0]!.delay).toBe(180);
    expect(node(cards[2]!).animations![0]!.delay).toBe(260);
    // one undo removes all the animations (the other undo steps are the create_node calls)
    expect(daemon.store.undo(docId(), 'mcp')).toBeTruthy();
    for (const c of cards) expect(node(c).animations).toBeUndefined();
    expect(undoAll()).toBe(3);
  });

  it('replace swaps the same kind and build; replace false appends', async () => {
    const id = cards[0]!;
    await ok('animate', { nodeIds: [id], preset: 'fade' });
    await ok('animate', { nodeIds: [id], preset: 'pop' });
    expect(node(id).animations!.map((a) => a.preset)).toEqual(['pop']);
    await ok('animate', { nodeIds: [id], preset: 'fade', build: 1 });
    expect(node(id).animations!.map((a) => a.preset)).toEqual(['pop', 'fade']);
    await ok('animate', { nodeIds: [id], preset: 'zoom-in', replace: false });
    expect(node(id).animations!.map((a) => a.preset)).toEqual(['pop', 'fade', 'zoom-in']);
    await ok('animate', { nodeIds: [id], kind: 'emphasis', preset: 'float' });
    expect(node(id).animations).toHaveLength(4);
  });

  it('validation errors come from the core with readable messages', async () => {
    const unknown = await fail('animate', { nodeIds: cards, preset: 'nope' });
    expect(unknown).toContain('unknown preset "nope"');
    expect(unknown).toContain('fade-up');
    const stagger = await fail('animate', { nodeIds: cards, preset: 'fade', stagger: 50 });
    expect(stagger).toContain('"stagger" needs "split"');
    expect(await fail('animate', { nodeIds: ['el_nope0001'], preset: 'fade' })).toContain(
      'Node not found',
    );
    for (const c of cards) expect(node(c).animations).toBeUndefined();
  });

  it('update_animation merges fields, params and clears with null', async () => {
    const id = cards[0]!;
    await ok('animate', { nodeIds: [id], preset: 'fade-up', params: { distance: 60 } });
    await ok('update_animation', { nodeId: id, index: 0, duration: 900, easing: 'spring' });
    expect(node(id).animations![0]).toMatchObject({
      preset: 'fade-up',
      duration: 900,
      easing: 'spring',
      params: { distance: 60 },
    });
    await ok('update_animation', {
      nodeId: id,
      index: 0,
      duration: null,
      params: { distance: null },
    });
    const a = node(id).animations![0]!;
    expect(a.duration).toBeUndefined();
    expect(a.params).toBeUndefined();
    expect(a.easing).toBe('spring');
    const bad = await fail('update_animation', { nodeId: id, index: 3, delay: 10 });
    expect(bad).toContain('no animation at index 3');
    expect(bad).toContain('[0] in fade-up');
    expect(await fail('update_animation', { nodeId: cards[1]!, index: 0, delay: 1 })).toContain(
      'no animations',
    );
  });

  it('remove_animations filters and "nothing to remove" is not an error', async () => {
    const id = cards[0]!;
    await ok('set_animations', {
      nodeId: id,
      animations: [
        { preset: 'fade-up' },
        { kind: 'emphasis', preset: 'float', build: 1 },
        { kind: 'out', preset: 'fade', build: 2 },
      ],
    });
    expect(await ok('remove_animations', { nodeIds: [id], kind: 'emphasis' })).toContain(
      'Removed 1',
    );
    expect(node(id).animations!.map((a) => a.preset)).toEqual(['fade-up', 'fade']);
    expect(await ok('remove_animations', { nodeIds: [id], build: 5 })).toContain(
      'Nothing to remove',
    );
    await ok('remove_animations', { nodeIds: [id], index: 0 });
    expect(node(id).animations!.map((a) => a.preset)).toEqual(['fade']);
    await ok('remove_animations', { nodeIds: [id, cards[1]!] });
    expect(node(id).animations).toBeUndefined();
  });

  it('set_animations replaces the list and [] clears it', async () => {
    const id = cards[0]!;
    const t = await ok('set_animations', {
      nodeId: id,
      animations: [{ preset: 'pop' }, { kind: 'emphasis', preset: 'pulse', build: 1 }],
    });
    expect(t).toContain('2 animation(s)');
    expect(node(id).animations).toHaveLength(2);
    await ok('set_animations', { nodeId: id, animations: [{ preset: 'fade' }] });
    expect(node(id).animations).toEqual([{ kind: 'in', preset: 'fade' }]);
    await ok('set_animations', { nodeId: id, animations: [] });
    expect(node(id).animations).toBeUndefined();
    expect(
      await fail('set_animations', { nodeId: id, animations: [{ preset: 'fade', bogus: 1 }] }),
    ).toContain('unknown field "bogus"');
  });

  it('set_slide_transition by frameIds and pageId, removal and non-root error', async () => {
    const pageId = doc().pages[0]!.id;
    const second = await ok('create_frame', { name: 'Second', width: 100, height: 100 });
    const secondId = /fr_[0-9a-z]+/.exec(second)![0];
    const t = await ok('set_slide_transition', {
      frameIds: [ws.frameId],
      preset: 'push',
      direction: 'up',
      duration: 700,
    });
    expect(t).toContain('push up 700ms');
    expect(doc().pages[0]!.frames[0]!.slideTransition).toEqual({
      preset: 'push',
      direction: 'up',
    });
    await ok('set_slide_transition', { pageId, preset: 'fade' });
    for (const f of doc().pages[0]!.frames) expect(f.slideTransition).toEqual({ preset: 'fade' });
    await ok('set_slide_transition', { frameIds: [secondId], preset: null });
    expect(doc().pages[0]!.frames[1]!.slideTransition).toBeUndefined();
    expect(await fail('set_slide_transition', { frameIds: [cards[0]!], preset: 'fade' })).toContain(
      'not a root frame',
    );
    expect(await fail('set_slide_transition', { preset: 'fade' })).toContain('frameIds');
    expect(await fail('set_slide_transition', { pageId, preset: 'nope' })).toContain(
      'unknown transition',
    );
    expect(
      await fail('set_slide_transition', { pageId, preset: 'fade', direction: 'up' }),
    ).toContain('no direction');
  });

  it('get_timeline prints the frame timeline (also from a node inside it)', async () => {
    await ok('animate', { nodeIds: cards, preset: 'fade-up', cascade: 100 });
    await ok('animate', { nodeIds: [cards[0]!], preset: 'pop', build: 1 });
    const t = await ok('get_timeline', { frameId: cards[2]! });
    expect(t).toContain(`Timeline of "Desktop" (${ws.frameId})`);
    expect(t).toContain('4 animation(s)');
    expect(t).toContain('1 click build(s)');
    expect(t).toContain('Build 1 (click 1)');
    expect(t).toContain('get_screenshot');
    expect(await ok('get_timeline')).toContain('Timeline of');
  });

  it('animate through an instance virtual id creates an override', async () => {
    const t = await ok('insert_component', {
      component: 'shadcn-like/Button',
      parentId: ws.frameId,
      props: { label: 'Save' },
    });
    const inst = /(in_[0-9a-z]+)/.exec(t)![1]!;
    const inner = `${inst}/tx_sbtnlabl`;
    await ok('animate', { nodeIds: [inner], preset: 'pop' });
    expect(node(inst).overrides?.['tx_sbtnlabl']?.animations).toEqual([
      { kind: 'in', preset: 'pop' },
    ]);
    expect(await ok('get_timeline', { frameId: inner })).toContain('pop');
  });

  describe('screenshot and export', () => {
    it('get_screenshot forwards build, times and columns and hints when animated', async () => {
      await ok('animate', { nodeIds: cards, preset: 'fade-up' });
      await ok('animate', { nodeIds: [cards[0]!], preset: 'pop', build: 1 });
      const hint = await ok('get_screenshot', { nodeId: ws.frameId });
      expect(hint).toContain('This frame has 4 animations');
      expect(hint).toContain('1 click build');
      expect(hint).toContain('pass time, build or times');
      expect(captures.at(-1)!.times).toBeUndefined();
      const strip = await ok('get_screenshot', {
        nodeId: ws.frameId,
        times: [0, 0.3, 0.6],
        columns: 3,
        build: 1,
      });
      expect(strip).not.toContain('This frame has');
      expect(captures.at(-1)).toMatchObject({ times: [0, 0.3, 0.6], columns: 3, build: 1 });
      await ok('get_screenshot', { nodeId: ws.frameId, time: 0.5 });
      expect(captures.at(-1)).toMatchObject({ time: 0.5 });
      expect(captures.at(-1)!.build).toBeUndefined();
      expect(await fail('get_screenshot', { times: Array(13).fill(0) })).toContain('times');
    });

    it('get_screenshot has no hint on a frame without animations', async () => {
      expect(await ok('get_screenshot', { nodeId: ws.frameId })).not.toContain('animation');
    });

    const ffmpeg = locateFfmpeg();
    it.skipIf(!ffmpeg)(
      'gif export defaults the duration to the motion timeline + 0.5 s',
      async () => {
        await ok('animate', { nodeIds: [cards[0]!], preset: 'fade-up', duration: 1000 });
        const out = path.join(ws.dir, 'output');
        const t = await ok('export', {
          nodeIds: [ws.frameId],
          format: 'gif',
          fps: 5,
          outputDir: out,
        });
        expect(frameReqs[0]!.duration).toBe(1.5);
        expect(t).toContain('1.5 s (default: motion timeline 1.0 s + 0.5 s)');
        expect(fs.existsSync(path.join(out, 'desktop.gif'))).toBe(true);
        // an explicit duration wins
        await ok('export', {
          nodeIds: [ws.frameId],
          format: 'gif',
          fps: 5,
          duration: 2,
          outputDir: out,
        });
        expect(frameReqs[1]!.duration).toBe(2);
      },
    );
  });

  describe('editor commands', () => {
    it('preview_motion sends motion:preview with ms time and reports the state', async () => {
      const editor = await connectEditor((cmd) =>
        cmd.type === 'motion:preview'
          ? {
              frameId: ws.frameId,
              mode: cmd.action === 'stop' ? 'rest' : cmd.action === 'seek' ? 'seek' : 'play',
              time: cmd.time ?? 0,
              duration: 2400,
            }
          : NO_PRESENTATION,
      );
      const play = await ok('preview_motion', { frameId: cards[0]!, time: 1.25 });
      expect(editor.commands[0]).toEqual({
        type: 'motion:preview',
        docId: docId(),
        frameId: cards[0]!,
        action: 'play',
        time: 1250,
      });
      expect(play).toBe(
        'Previewing "Desktop" on the canvas: playing from 1.25 s (timeline 2.4 s).',
      );
      expect(await ok('preview_motion', { action: 'seek', time: 1 })).toContain('paused at 1 s');
      expect(await ok('preview_motion', { action: 'stop' })).toContain('Preview stopped');
      expect(editor.commands[2]).toEqual({
        type: 'motion:preview',
        docId: docId(),
        action: 'stop',
      });
    });

    it('preview_motion errors without an editor window', async () => {
      expect(await fail('preview_motion')).toContain('No editor window is connected');
    });

    it('presentation_goto accepts build and reports it; start lists click builds', async () => {
      await ok('animate', { nodeIds: [cards[0]!], preset: 'fade', build: 1 });
      await ok('animate', { nodeIds: [cards[1]!], preset: 'fade', build: 2 });
      let state: PresentationState = {
        active: true,
        docId: docId(),
        pageId: doc().pages[0]!.id,
        index: 0,
        frameId: ws.frameId,
        slides: [{ index: 0, id: ws.frameId, name: 'Desktop' }],
        fullscreen: false,
        build: 0,
        builds: 2,
      };
      const editor = await connectEditor((cmd) => {
        if (cmd.type === 'presentation:goto' && cmd.build !== undefined)
          state = { ...state, build: cmd.build };
        return state;
      });
      const started = await ok('start_presentation');
      expect(started).toContain(`0. Desktop (${ws.frameId}) [2 click builds]`);
      expect(started).toContain('build 0 / 2');
      const t = await ok('presentation_goto', { build: 1 });
      expect(t).toBe(`Now at slide 1 / 1 — "Desktop" (${ws.frameId}), build 1 / 2.`);
      expect(editor.commands.at(-1)).toEqual({ type: 'presentation:goto', build: 1 });
      await ok('presentation_goto', { index: 0, build: 2 });
      expect(editor.commands.at(-1)).toEqual({ type: 'presentation:goto', index: 0, build: 2 });
      expect(await fail('presentation_goto', {})).toContain('Pass exactly one');
      expect(await fail('presentation_goto', { index: 0, step: 'next' })).toContain(
        'Pass exactly one',
      );
    });
  });

  it('the motion guide is available as a guide and a resource', async () => {
    const guide = await ok('get_guide', { topic: 'motion' });
    expect(guide).toContain('# Motion');
    expect(guide).toContain('cascade');
    expect(guide).toContain('get_timeline');
    const res = await client.readResource({ uri: 'guide://motion' });
    expect((res.contents[0] as { text: string }).text).toContain('# Motion');
  });

  it('the motion tools are listed with short descriptions', async () => {
    const { tools } = await client.listTools();
    for (const name of [
      'list_motion_presets',
      'animate',
      'update_animation',
      'remove_animations',
      'set_animations',
      'set_slide_transition',
      'get_timeline',
      'preview_motion',
    ]) {
      const t = tools.find((x) => x.name === name);
      expect(t, name).toBeTruthy();
      expect(t!.description!.length, name).toBeLessThanOrEqual(300);
    }
    expect(tools.find((x) => x.name === 'get_timeline')!.annotations?.readOnlyHint).toBe(true);
    expect(tools.find((x) => x.name === 'preview_motion')!.annotations?.readOnlyHint).toBe(false);
  });
});
