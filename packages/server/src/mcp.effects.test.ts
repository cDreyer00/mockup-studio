import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createDocument, createNodeFromTag, EFFECTS, type Document, type Node } from '@mockup/core';
import { startDaemon, type DaemonHandle } from './index.js';
import { locateFfmpeg } from './encode.js';
import type { CaptureRequest, CaptureResult, FramesRequest, RenderProvider } from './render.js';
import { makeWorkspace } from './test-utils.js';

type Ws = ReturnType<typeof makeWorkspace>;
type Content = { type: string; text?: string };

const textOf = (r: unknown): string =>
  (r as { content: Content[] }).content
    .filter((c) => c.type === 'text')
    .map((c) => c.text)
    .join('\n');
const idOf = (re: RegExp, text: string): string => {
  const id = re.exec(text)?.[1];
  if (!id) throw new Error('id not found in: ' + text);
  return id;
};

/** Valid w x h PNG (semi-transparent gray). */
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
  const raw = Buffer.alloc(h * (1 + w * 4), 0x80);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const MP4_HEAD = Buffer.concat([
  Buffer.from([0, 0, 0, 0x18]),
  Buffer.from('ftypisom', 'ascii'),
  Buffer.alloc(16),
]);
const LOTTIE = JSON.stringify({ v: '5.7.0', fr: 30, ip: 0, op: 60, w: 100, h: 100, layers: [] });
const RIVE = Buffer.concat([Buffer.from('RIVE', 'ascii'), Buffer.alloc(32)]);

function find(node: Node, pred: (n: Node) => boolean): Node | undefined {
  if (pred(node)) return node;
  for (const c of node.children) {
    const f = find(c, pred);
    if (f) return f;
  }
  return undefined;
}

describe('MCP effects, video and embeds', () => {
  let ws: Ws;
  let daemon: DaemonHandle;
  let client: Client;
  let captures: CaptureRequest[];
  let frameReqs: FramesRequest[];

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
  const renderBasic: RenderProvider = { capture: render.capture, measure: render.measure };

  const start = async (mode: 'none' | 'basic' | 'frames') => {
    ws = makeWorkspace();
    captures = [];
    frameReqs = [];
    daemon = await startDaemon({
      port: 0,
      dataDir: ws.dataDir,
      writeInfo: false,
      render: mode === 'none' ? undefined : mode === 'basic' ? renderBasic : render,
    });
    client = new Client({ name: 'test', version: '0.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(daemon.mcpUrl)));
    await client.callTool({ name: 'open_document', arguments: { path: ws.file } });
  };
  const stop = async () => {
    await client.close();
    await daemon.close();
    ws.cleanup();
  };
  const call = (name: string, args: Record<string, unknown> = {}) =>
    client.callTool({ name, arguments: args });
  const docId = () => daemon.store.list()[0]!.docId;
  const doc = (): Document => daemon.store.get(docId());
  const frame = (): Node => doc().pages[0]!.frames[0]!;
  const byId = (id: string): Node => find(frame(), (n) => n.id === id)!;

  describe('effects', () => {
    beforeEach(() => start('basic'));
    afterEach(stop);

    it('list_effects lists effects with params and presets', async () => {
      const t = textOf(await call('list_effects'));
      expect(t).toContain(`${EFFECTS.length} effect(s)`);
      for (const e of EFFECTS) expect(t).toContain(`- ${e.kind} [${e.category}]`);
      expect(t).toContain('params:');
      expect(t).toContain('color1:color="#0d1b4c"');
      expect(t).toContain('distortion:number 0..1=0.5');
      expect(t).toContain('direction:select {up|down|left|right|random}="up"');
      expect(t).toMatch(/presets: aurora, sunset/);
    });

    it('add_effect as background: first child, parent relative/isolate and one undo reverts everything', async () => {
      await call('create_node', { parentId: ws.frameId, tag: 'div', name: 'Content' });
      const before = frame().children.length;
      const r = await call('add_effect', {
        nodeId: ws.frameId,
        kind: 'mesh-gradient',
        preset: 'sunset',
        params: { speed: 0.5 },
      });
      expect(r.isError, textOf(r)).toBeFalsy();
      const fr = frame();
      expect(fr.children).toHaveLength(before + 1);
      const ef = fr.children[0]!;
      expect(ef.type).toBe('effect');
      expect(ef.effect!.kind).toBe('mesh-gradient');
      expect(ef.effect!.params).toMatchObject({ color1: '#ff5e62', swirl: 0.45, speed: 0.5 });
      expect(ef.style).toMatchObject({ position: 'absolute', inset: '0' });
      expect(fr.style['position']).toBe('relative');
      expect(fr.style['isolation']).toBe('isolate');
      expect(textOf(r)).toContain(ef.id);

      await call('undo');
      const after = frame();
      expect(after.children).toHaveLength(before);
      expect(find(after, (n) => n.type === 'effect')).toBeUndefined();
      expect(after.style['position']).toBeUndefined();
      expect(after.style['isolation']).toBeUndefined();
    });

    it('add_effect placement child uses 100% x 240px, index and name', async () => {
      await call('create_node', { parentId: ws.frameId, tag: 'div', name: 'A' });
      await call('create_node', { parentId: ws.frameId, tag: 'div', name: 'B' });
      const r = await call('add_effect', {
        nodeId: ws.frameId,
        kind: 'particles',
        placement: 'child',
        index: 1,
        name: 'Snow',
        styles: { height: '320px' },
      });
      expect(r.isError, textOf(r)).toBeFalsy();
      const ef = frame().children[1]!;
      expect(ef.type).toBe('effect');
      expect(ef.name).toBe('Snow');
      expect(ef.style).toMatchObject({ width: '100%', height: '320px' });
      expect(ef.style['position']).toBeUndefined();
      expect(frame().style['isolation']).toBeUndefined();
    });

    it('add_effect: invalid kind, preset and params give an error with the problems', async () => {
      const badKind = await call('add_effect', { nodeId: ws.frameId, kind: 'does-not-exist' });
      expect(badKind.isError).toBe(true);
      expect(textOf(badKind)).toContain('unknown effect');
      expect(textOf(badKind)).toContain('list_effects');

      const badPreset = await call('add_effect', {
        nodeId: ws.frameId,
        kind: 'mesh-gradient',
        preset: 'xyz',
      });
      expect(badPreset.isError).toBe(true);
      expect(textOf(badPreset)).toContain('aurora');

      const badParams = await call('add_effect', {
        nodeId: ws.frameId,
        kind: 'particles',
        params: { count: 'lots', color: 'bluish', foo: 1, direction: 'sideways' },
      });
      expect(badParams.isError).toBe(true);
      const t = textOf(badParams);
      expect(t).toContain('Invalid params');
      expect(t).toContain('"count"');
      expect(t).toContain('"color"');
      expect(t).toContain('unknown param');
      expect(t).toContain('"direction"');
      expect(t).toContain('list_effects');
      expect(find(frame(), (n) => n.type === 'effect')).toBeUndefined();
    });

    it('add_effect rejects a missing node and a leaf node', async () => {
      const missing = await call('add_effect', { nodeId: 'el_missing00', kind: 'grain' });
      expect(missing.isError).toBe(true);
      const eff = await call('add_effect', { nodeId: ws.frameId, kind: 'grain' });
      const efId = idOf(/(fx_[0-9a-z]+)/, textOf(eff));
      const leaf = await call('add_effect', { nodeId: efId, kind: 'grain' });
      expect(leaf.isError).toBe(true);
      expect(textOf(leaf)).toContain('does not accept children');
    });

    it('update_effect merges params, switches kind and resets', async () => {
      const r = await call('add_effect', {
        nodeId: ws.frameId,
        kind: 'mesh-gradient',
        params: { speed: 2, grain: 0.9 },
      });
      const id = idOf(/(fx_[0-9a-z]+)/, textOf(r));
      const eff = () => byId(id).effect!;

      await call('update_effect', { nodeId: id, params: { distortion: 0.1 } });
      expect(eff().params).toMatchObject({ speed: 2, grain: 0.9, distortion: 0.1 });

      const preset = await call('update_effect', { nodeId: id, preset: 'ocean' });
      expect(preset.isError, textOf(preset)).toBeFalsy();
      expect(eff().params).toMatchObject({ color1: '#03045e', speed: 1 });

      await call('update_effect', { nodeId: id, reset: true, params: { swirl: 0.9 } });
      expect(eff().params).toMatchObject({ swirl: 0.9, grain: 0.15, color1: '#0d1b4c' });

      const sw = await call('update_effect', { nodeId: id, kind: 'particles' });
      expect(sw.isError, textOf(sw)).toBeFalsy();
      expect(eff().kind).toBe('particles');
      expect(eff().params).toMatchObject({ count: 120, direction: 'up' });
      expect(eff().params).not.toHaveProperty('color1');
      expect(eff().params).not.toHaveProperty('grain');
    });

    it('update_effect: errors (node that is not an effect, invalid params, kind and preset)', async () => {
      const notEffect = await call('update_effect', { nodeId: ws.frameId, params: {} });
      expect(notEffect.isError).toBe(true);
      expect(textOf(notEffect)).toContain('not an effect');
      const r = await call('add_effect', { nodeId: ws.frameId, kind: 'grain' });
      const id = idOf(/(fx_[0-9a-z]+)/, textOf(r));
      const bad = await call('update_effect', { nodeId: id, params: { foo: 1 } });
      expect(bad.isError).toBe(true);
      expect(textOf(bad)).toContain('unknown param');
      expect((await call('update_effect', { nodeId: id, kind: 'nothing' })).isError).toBe(true);
      expect((await call('update_effect', { nodeId: id, preset: 'nothing' })).isError).toBe(true);
    });
  });

  describe('video', () => {
    beforeEach(() => start('basic'));
    afterEach(stop);

    it('insert_video with an absolute path copies to assets/videos/', async () => {
      const src = path.join(ws.dir, 'My Clip.mp4');
      fs.writeFileSync(src, MP4_HEAD);
      const r = await call('insert_video', { parentId: ws.frameId, source: src, name: 'Clip' });
      expect(r.isError, textOf(r)).toBeFalsy();
      const v = find(frame(), (n) => n.type === 'video')!;
      expect(v.video).toMatchObject({
        src: 'videos/My-Clip.mp4',
        autoplay: true,
        loop: true,
        muted: true,
        controls: false,
      });
      expect(v.name).toBe('Clip');
      expect(v.style).toMatchObject({ width: '640px', height: '360px', 'object-fit': 'cover' });
      expect(fs.readFileSync(path.join(ws.dir, 'assets', 'videos', 'My-Clip.mp4'))).toEqual(
        MP4_HEAD,
      );
      await call('insert_video', { parentId: ws.frameId, source: src });
      expect(fs.readdirSync(path.join(ws.dir, 'assets', 'videos')).sort()).toEqual([
        'My-Clip-1.mp4',
        'My-Clip.mp4',
      ]);
    });

    it('insert_video with a URL references it directly, without copying, and applies options', async () => {
      const r = await call('insert_video', {
        parentId: ws.frameId,
        source: 'https://example.com/v.mp4',
        autoplay: false,
        loop: false,
        controls: true,
        index: 0,
      });
      expect(r.isError, textOf(r)).toBeFalsy();
      expect(frame().children[0]!.video).toMatchObject({
        src: 'https://example.com/v.mp4',
        autoplay: false,
        loop: false,
        controls: true,
      });
      expect(fs.existsSync(path.join(ws.dir, 'assets', 'videos'))).toBe(false);
    });

    it('insert_video with a PNG poster copies the image to assets/', async () => {
      const poster = path.join(ws.dir, 'cover.png');
      fs.writeFileSync(poster, fakePng(4, 4));
      const r = await call('insert_video', {
        parentId: ws.frameId,
        source: 'https://example.com/v.mp4',
        poster,
      });
      expect(r.isError, textOf(r)).toBeFalsy();
      const v = find(frame(), (n) => n.type === 'video')!;
      expect(v.video!.poster).toBeTruthy();
      expect(fs.existsSync(path.join(ws.dir, 'assets', v.video!.poster!))).toBe(true);
    });

    it('insert_video rejects invalid content/extension, relative path, missing file and ftp scheme', async () => {
      const txt = path.join(ws.dir, 'nota.txt');
      fs.writeFileSync(txt, 'hi');
      const a = await call('insert_video', { parentId: ws.frameId, source: txt });
      expect(a.isError).toBe(true);
      expect(textOf(a)).toContain('not a recognized video');
      const fake = path.join(ws.dir, 'fake.mp4');
      fs.writeFileSync(fake, 'this is not a video');
      expect((await call('insert_video', { parentId: ws.frameId, source: fake })).isError).toBe(
        true,
      );
      const rel = await call('insert_video', { parentId: ws.frameId, source: 'v.mp4' });
      expect(rel.isError).toBe(true);
      expect(textOf(rel)).toContain('absolute path');
      const none = await call('insert_video', {
        parentId: ws.frameId,
        source: path.join(ws.dir, 'does-not-exist.mp4'),
      });
      expect(none.isError).toBe(true);
      expect(textOf(none)).toContain('not found');
      const ftp = await call('insert_video', { parentId: ws.frameId, source: 'ftp://x/v.mp4' });
      expect(ftp.isError).toBe(true);
      expect(find(frame(), (n) => n.type === 'video')).toBeUndefined();
    });

    it('a document without a path on disk only accepts URLs', async () => {
      const mem = createDocument('Memory');
      const fr = createNodeFromTag('div', {
        isRoot: true,
        name: 'F',
        styles: { width: '100px', height: '100px' },
        position: { x: 0, y: 0 },
      });
      mem.pages[0]!.frames.push(fr);
      (daemon.store as unknown as { register(d: Document, p: string | null): unknown }).register(
        mem,
        null,
      );
      const src = path.join(ws.dir, 'c.mp4');
      fs.writeFileSync(src, MP4_HEAD);
      const local = await call('insert_video', { parentId: fr.id, source: src, docId: mem.id });
      expect(local.isError).toBe(true);
      expect(textOf(local)).toContain('path on disk');
      const url = await call('insert_video', {
        parentId: fr.id,
        source: 'https://example.com/v.webm',
        docId: mem.id,
      });
      expect(url.isError, textOf(url)).toBeFalsy();
    });

    it('update_media changes a video: flags, time, poster and poster removal', async () => {
      const r = await call('insert_video', {
        parentId: ws.frameId,
        source: 'https://example.com/v.mp4',
      });
      const id = idOf(/(vd_[0-9a-z]+)/, textOf(r));
      const vid = () => byId(id).video!;
      const u = await call('update_media', {
        nodeId: id,
        loop: false,
        controls: true,
        muted: false,
        autoplay: false,
        time: 2.5,
      });
      expect(u.isError, textOf(u)).toBeFalsy();
      expect(vid()).toMatchObject({
        loop: false,
        controls: true,
        muted: false,
        autoplay: false,
        time: 2.5,
        src: 'https://example.com/v.mp4',
      });
      const poster = path.join(ws.dir, 'p.png');
      fs.writeFileSync(poster, fakePng(2, 2));
      await call('update_media', { nodeId: id, poster });
      expect(vid().poster).toBeTruthy();
      await call('update_media', { nodeId: id, poster: '' });
      expect(vid().poster).toBeUndefined();
      expect(vid().time).toBe(2.5);
    });

    it('update_media rejects a node that is neither video nor embed', async () => {
      const r = await call('update_media', { nodeId: ws.frameId, loop: true });
      expect(r.isError).toBe(true);
      expect(textOf(r)).toContain('update_effect');
    });
  });

  describe('embeds', () => {
    beforeEach(() => start('basic'));
    afterEach(stop);

    it('YouTube: detects the provider and uses start from ?t=', async () => {
      const r = await call('insert_embed', {
        parentId: ws.frameId,
        url: 'https://youtu.be/dQw4w9WgXcQ?t=42',
      });
      expect(r.isError, textOf(r)).toBeFalsy();
      const e = find(frame(), (n) => n.type === 'embed')!;
      expect(e.embed).toMatchObject({
        provider: 'youtube',
        url: 'https://youtu.be/dQw4w9WgXcQ?t=42',
        params: { start: 42 },
      });
      expect(e.style).toMatchObject({ width: '560px', height: '315px' });
    });

    it('YouTube: explicit start takes precedence; invalid URL gives an error', async () => {
      await call('insert_embed', {
        parentId: ws.frameId,
        url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=10',
        params: { start: 5 },
      });
      expect(find(frame(), (n) => n.type === 'embed')!.embed!.params).toMatchObject({ start: 5 });
      const bad = await call('insert_embed', {
        parentId: ws.frameId,
        url: 'https://youtube.com/',
        provider: 'youtube',
      });
      expect(bad.isError).toBe(true);
      expect(textOf(bad)).toContain('YouTube');
    });

    it('Local Lottie: validates and copies to assets/lottie/', async () => {
      const f = path.join(ws.dir, 'Loader Anim.json');
      fs.writeFileSync(f, LOTTIE);
      const r = await call('insert_embed', { parentId: ws.frameId, url: f });
      expect(r.isError, textOf(r)).toBeFalsy();
      const e = find(frame(), (n) => n.type === 'embed')!;
      expect(e.embed).toMatchObject({ provider: 'lottie', src: 'lottie/Loader-Anim.json' });
      expect(
        fs.readFileSync(path.join(ws.dir, 'assets', 'lottie', 'Loader-Anim.json'), 'utf8'),
      ).toBe(LOTTIE);
    });

    it('Lottie: JSON that is not Lottie is rejected; src works as an alternative to url', async () => {
      const bad = path.join(ws.dir, 'x.json');
      fs.writeFileSync(bad, '{"a":1}');
      const r = await call('insert_embed', { parentId: ws.frameId, url: bad });
      expect(r.isError).toBe(true);
      expect(textOf(r)).toContain('Lottie');
      const good = path.join(ws.dir, 'ok.json');
      fs.writeFileSync(good, LOTTIE);
      const r2 = await call('insert_embed', { parentId: ws.frameId, src: good });
      expect(r2.isError, textOf(r2)).toBeFalsy();
    });

    it('Local Rive: requires the RIVE signature and copies to assets/rive/', async () => {
      const f = path.join(ws.dir, 'hero.riv');
      fs.writeFileSync(f, RIVE);
      const r = await call('insert_embed', { parentId: ws.frameId, url: f });
      expect(r.isError, textOf(r)).toBeFalsy();
      const e = find(frame(), (n) => n.type === 'embed')!;
      expect(e.embed).toMatchObject({ provider: 'rive', src: 'rive/hero.riv' });
      expect(fs.existsSync(path.join(ws.dir, 'assets', 'rive', 'hero.riv'))).toBe(true);
      const fake = path.join(ws.dir, 'fake.riv');
      fs.writeFileSync(fake, 'not-rive');
      const bad = await call('insert_embed', { parentId: ws.frameId, url: fake });
      expect(bad.isError).toBe(true);
      expect(textOf(bad)).toContain('RIVE');
    });

    it('another URL becomes an iframe; no url, video, unknown and three give an error', async () => {
      const r = await call('insert_embed', {
        parentId: ws.frameId,
        url: 'https://example.com/widget',
        styles: { width: '300px' },
      });
      expect(r.isError, textOf(r)).toBeFalsy();
      const e = find(frame(), (n) => n.type === 'embed')!;
      expect(e.embed).toMatchObject({ provider: 'iframe', url: 'https://example.com/widget' });
      expect(e.style).toMatchObject({ width: '300px', height: '320px' });

      expect((await call('insert_embed', { parentId: ws.frameId })).isError).toBe(true);
      const vid = await call('insert_embed', {
        parentId: ws.frameId,
        url: 'https://example.com/v.mp4',
      });
      expect(vid.isError).toBe(true);
      expect(textOf(vid)).toContain('insert_video');
      const unknown = await call('insert_embed', { parentId: ws.frameId, url: 'anything at all' });
      expect(unknown.isError).toBe(true);
      const three = await call('insert_embed', {
        parentId: ws.frameId,
        url: 'https://example.com',
        provider: 'three',
      });
      expect(three.isError).toBe(true);
      expect(textOf(three)).toContain('insert_three');
    });

    it('insert_three without code uses the default; with code and params it writes to node.embed', async () => {
      const a = await call('insert_three', { parentId: ws.frameId });
      expect(a.isError, textOf(a)).toBeFalsy();
      expect(textOf(a)).toContain('default code');
      const e1 = find(frame(), (n) => n.type === 'embed')!;
      expect(e1.embed!.provider).toBe('three');
      expect(e1.embed!.code).toContain('THREE');
      expect(e1.style).toMatchObject({ width: '480px', height: '320px' });

      const code = 'return { scene: new THREE.Scene(), camera: null, update() {} };';
      const b = await call('insert_three', {
        parentId: ws.frameId,
        code,
        params: { color: '#ff6b6b', speed: 2 },
        index: 0,
      });
      expect(textOf(b)).toContain('custom code');
      expect(frame().children[0]!.embed).toMatchObject({
        provider: 'three',
        code,
        params: { color: '#ff6b6b', speed: 2 },
      });
    });

    it('insert_three rejects code that is too large', async () => {
      const r = await call('insert_three', { parentId: ws.frameId, code: 'x'.repeat(200_001) });
      expect(r.isError).toBe(true);
      expect(textOf(r)).toContain('limit');
    });

    it('update_media changes embed: url, merged params, code and src', async () => {
      const yt = await call('insert_embed', {
        parentId: ws.frameId,
        url: 'https://youtu.be/dQw4w9WgXcQ?t=7',
        params: { mute: true },
      });
      const ytId = idOf(/(eb_[0-9a-z]+)/, textOf(yt));
      await call('update_media', {
        nodeId: ytId,
        url: 'https://youtu.be/abcdefghijk',
        params: { start: 9 },
      });
      expect(byId(ytId).embed).toMatchObject({
        url: 'https://youtu.be/abcdefghijk',
        params: { mute: true, start: 9 },
      });
      const noSrc = await call('update_media', { nodeId: ytId, src: '/x.json' });
      expect(noSrc.isError).toBe(true);
      expect(textOf(noSrc)).toContain('lottie and rive');

      const th = await call('insert_three', { parentId: ws.frameId });
      const thId = idOf(/(eb_[0-9a-z]+)/, textOf(th));
      await call('update_media', { nodeId: thId, code: 'return 1;' });
      expect(byId(thId).embed!.code).toBe('return 1;');
      const big = await call('update_media', { nodeId: thId, code: 'x'.repeat(200_001) });
      expect(big.isError).toBe(true);

      const f = path.join(ws.dir, 'a.json');
      fs.writeFileSync(f, LOTTIE);
      const lo = await call('insert_embed', { parentId: ws.frameId, url: f });
      const loId = idOf(/(eb_[0-9a-z]+)/, textOf(lo));
      const f2 = path.join(ws.dir, 'b.json');
      fs.writeFileSync(f2, LOTTIE);
      await call('update_media', { nodeId: loId, src: f2 });
      expect(byId(loId).embed!.src).toBe('lottie/b.json');
    });
  });

  describe('get_screenshot with time', () => {
    beforeEach(() => start('basic'));
    afterEach(stop);

    it('passes time to the render and omits it when not given', async () => {
      await call('get_screenshot', { nodeId: ws.frameId, time: 1.5 });
      expect(captures[0]).toMatchObject({ nodeId: ws.frameId, time: 1.5 });
      await call('get_screenshot', { nodeId: ws.frameId, time: 0 });
      expect(captures[1]!.time).toBe(0);
      await call('get_screenshot', { nodeId: ws.frameId });
      expect(captures[2]).not.toHaveProperty('time');
      const neg = await call('get_screenshot', { nodeId: ws.frameId, time: -1 });
      expect(neg.isError).toBe(true);
      expect(captures).toHaveLength(3);
    });
  });

  describe('animated export and static react', () => {
    afterEach(stop);

    for (const format of ['mp4', 'webm', 'gif'] as const) {
      it(`${format} without render returns render unavailable`, async () => {
        await start('none');
        const r = await call('export', { nodeIds: [ws.frameId], format });
        expect(r.isError).toBe(true);
        expect(textOf(r)).toContain('render engine is not available');
      });

      it(`${format} with render but no captureFrames explains why`, async () => {
        await start('basic');
        const r = await call('export', { nodeIds: [ws.frameId], format });
        expect(r.isError).toBe(true);
        expect(textOf(r)).toContain('does not capture animated frames');
      });
    }

    const ffmpeg = locateFfmpeg();
    for (const format of ['mp4', 'webm', 'gif'] as const) {
      it.skipIf(!ffmpeg)(
        `${format} with captureFrames and ffmpeg produces a non-empty file`,
        async () => {
          await start('frames');
          const out = path.join(ws.dir, 'output');
          const r = await call('export', {
            nodeIds: [ws.frameId],
            format,
            fps: 5,
            duration: 1,
            start: 0.5,
            scale: 2,
            maxWidth: 64,
            outputDir: out,
          });
          expect(r.isError, textOf(r)).toBeFalsy();
          const file = path.join(out, `desktop.${format}`);
          expect(fs.statSync(file).size).toBeGreaterThan(0);
          expect(textOf(r)).toContain('5 frame(s) at 5 fps');
          expect(frameReqs[0]).toMatchObject({
            nodeId: ws.frameId,
            fps: 5,
            duration: 1,
            start: 0.5,
            scale: 2,
            maxWidth: 64,
          });
          const head = fs.readFileSync(file).subarray(0, 12);
          if (format === 'gif') expect(head.toString('ascii', 0, 3)).toBe('GIF');
          if (format === 'mp4') expect(head.toString('ascii', 4, 8)).toBe('ftyp');
          if (format === 'webm') expect([...head.subarray(0, 4)]).toEqual([0x1a, 0x45, 0xdf, 0xa3]);
        },
        60_000,
      );
    }

    it('gif uses 15 fps by default, caps at 30 and an ffmpeg failure leaves no file', async () => {
      await start('frames');
      const old = process.env['MOCKUP_FFMPEG'];
      process.env['MOCKUP_FFMPEG'] = path.join(ws.dir, 'ffmpeg-missing.exe');
      try {
        const out = path.join(ws.dir, 'output');
        const r = await call('export', {
          nodeIds: [ws.frameId],
          format: 'gif',
          duration: 1,
          outputDir: out,
        });
        expect(r.isError).toBe(true);
        expect(textOf(r)).toContain('Failed to export gif');
        expect(frameReqs[0]!.fps).toBe(15);
        expect(fs.existsSync(path.join(out, 'desktop.gif'))).toBe(false);
        await call('export', {
          nodeIds: [ws.frameId],
          format: 'gif',
          fps: 60,
          duration: 1,
          outputDir: out,
        });
        expect(frameReqs[1]!.fps).toBe(30);
      } finally {
        if (old === undefined) delete process.env['MOCKUP_FFMPEG'];
        else process.env['MOCKUP_FFMPEG'] = old;
      }
    });

    it('export rejects duration above 30 s and fps above 60', async () => {
      await start('frames');
      const a = await call('export', { nodeIds: [ws.frameId], format: 'mp4', duration: 31 });
      const b = await call('export', { nodeIds: [ws.frameId], format: 'mp4', fps: 61 });
      expect(a.isError).toBe(true);
      expect(b.isError).toBe(true);
      expect(frameReqs).toHaveLength(0);
    });

    it('react with effects "static" uses the render and writes a PNG to assets/effects/', async () => {
      await start('basic');
      const r = await call('add_effect', { nodeId: ws.frameId, kind: 'mesh-gradient' });
      const efId = idOf(/(fx_[0-9a-z]+)/, textOf(r));
      const out = path.join(ws.dir, 'output');
      const e = await call('export', {
        nodeIds: [ws.frameId],
        format: 'react',
        effects: 'static',
        outputDir: out,
      });
      expect(e.isError, textOf(e)).toBeFalsy();
      const png = path.join(out, 'assets', 'effects', `${efId}.png`);
      expect(fs.statSync(png).size).toBeGreaterThan(0);
      expect(fs.readFileSync(png).subarray(1, 4).toString('ascii')).toBe('PNG');
      expect(captures).toHaveLength(1);
      expect(captures[0]).toMatchObject({ nodeId: efId, format: 'png', time: 0 });
      expect(textOf(e)).toContain('Static effects: 1 PNG');
      const tsx = fs.readdirSync(out).find((f) => f.endsWith('.tsx'))!;
      const code = fs.readFileSync(path.join(out, tsx), 'utf8');
      expect(code).toContain(`assets/effects/${efId}.png`);
      expect(code).not.toContain('MockupEffect');
      expect(fs.existsSync(path.join(out, 'mockup-effects.js'))).toBe(false);
    });

    it('react with effects "live" (default) does not use the render or write a PNG', async () => {
      await start('basic');
      await call('add_effect', { nodeId: ws.frameId, kind: 'grain' });
      const out = path.join(ws.dir, 'output');
      const e = await call('export', { nodeIds: [ws.frameId], format: 'react', outputDir: out });
      expect(e.isError, textOf(e)).toBeFalsy();
      expect(captures).toHaveLength(0);
      expect(fs.existsSync(path.join(out, 'assets', 'effects'))).toBe(false);
      const tsx = fs.readdirSync(out).find((f) => f.endsWith('.tsx'))!;
      expect(fs.readFileSync(path.join(out, tsx), 'utf8')).toContain('<MockupEffect');
      expect(fs.statSync(path.join(out, 'mockup-effects.js')).size).toBeGreaterThan(1000);
      expect(fs.existsSync(path.join(out, 'mockup-effects.d.ts'))).toBe(true);
    });

    it('static react without render gives a render-unavailable error', async () => {
      await start('none');
      await call('add_effect', { nodeId: ws.frameId, kind: 'grain' });
      const e = await call('export', {
        nodeIds: [ws.frameId],
        format: 'react',
        effects: 'static',
        outputDir: path.join(ws.dir, 'output'),
      });
      expect(e.isError).toBe(true);
      expect(textOf(e)).toContain('render engine is not available');
    });
  });
});
