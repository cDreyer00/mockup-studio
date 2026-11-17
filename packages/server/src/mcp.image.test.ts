import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { buildPlaceholder } from './placeholder.js';
import { startDaemon, type DaemonHandle } from './index.js';
import { makeWorkspace } from './test-utils.js';

type Ws = ReturnType<typeof makeWorkspace>;
const textOf = (r: unknown): string =>
  (r as { content: { type: string; text?: string }[] }).content
    .filter((c) => c.type === 'text')
    .map((c) => c.text)
    .join('\n');

const SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 32"><rect width="48" height="32"/></svg>';

describe('MCP: set_image and generate_placeholder', () => {
  let ws: Ws;
  let daemon: DaemonHandle;
  let client: Client;

  beforeEach(async () => {
    ws = makeWorkspace();
    daemon = await startDaemon({ port: 0, dataDir: ws.dataDir, writeInfo: false });
    client = new Client({ name: 'test', version: '0.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(daemon.mcpUrl)));
    await client.callTool({ name: 'open_document', arguments: { path: ws.file } });
  });
  afterEach(async () => {
    await client.close();
    await daemon.close();
    ws.cleanup();
  });

  const call = (name: string, args: Record<string, unknown> = {}) =>
    client.callTool({ name, arguments: args });
  const docId = () => daemon.store.resolveDocId();
  const doc = () => daemon.store.get(docId());
  const frame = () => doc().pages[0]!.frames[0]!;
  const assets = () => path.join(ws.dir, 'assets');

  async function makeImage(): Promise<string> {
    const file = path.join(ws.dir, 'photo.svg');
    fs.writeFileSync(file, SVG);
    const r = await call('insert_image', { parentId: ws.frameId, source: file });
    expect(r.isError, textOf(r)).toBeFalsy();
    return frame().children[0]!.id;
  }
  const imgNode = () => frame().children[0]!;

  describe('set_image', () => {
    it('fit, position by preset, merged filters (keeps drop-shadow), crop and clipPath', async () => {
      const id = await makeImage();
      await call('update_styles', {
        nodeIds: [id],
        styles: { filter: 'blur(2px) drop-shadow(0 0 2px rgba(0,0,0,.5))' },
      });
      const r = await call('set_image', {
        nodeId: id,
        fit: 'cover',
        position: 'top-left',
        filters: { grayscale: 100, blur: null, hueRotate: 30 },
        crop: { top: 10, bottom: 5 },
        clipPath: 'circle',
        alt: 'Photo',
      });
      expect(r.isError, textOf(r)).toBeFalsy();
      const s = imgNode().style;
      expect(s['object-fit']).toBe('cover');
      expect(s['object-position']).toBe('0% 0%');
      expect(s['filter']).toContain('grayscale(100%)');
      expect(s['filter']).toContain('hue-rotate(30deg)');
      expect(s['filter']).toContain('drop-shadow(0 0 2px rgba(0,0,0,.5))');
      expect(s['filter']).not.toContain('blur');
      expect(s['object-view-box']).toBe('inset(10% 0% 5% 0%)');
      expect(s['clip-path']).toBe('circle(50% at 50% 50%)');
      expect(imgNode().attrs['alt']).toBe('Photo');
      expect(textOf(r)).toContain('object-view-box');

      // remove: crop null, clipPath none, neutral filters
      const r2 = await call('set_image', {
        nodeId: id,
        crop: null,
        clipPath: 'none',
        filters: { grayscale: null, 'hue-rotate': null },
      });
      expect(r2.isError, textOf(r2)).toBeFalsy();
      const s2 = imgNode().style;
      expect(s2['object-view-box']).toBeUndefined();
      expect(s2['clip-path']).toBeUndefined();
      expect(s2['filter']).toBe('drop-shadow(0 0 2px rgba(0,0,0,.5))');
    });

    it('clipPath with an external url() is rejected; url(#id) is accepted', async () => {
      const id = await makeImage();
      for (const bad of [
        'url(http://evil.test/x.svg#m)',
        "url( 'https://x.test/m' )",
        'url(m.svg)',
      ]) {
        const r = await call('set_image', { nodeId: id, clipPath: bad });
        expect(r.isError, bad).toBe(true);
        expect(textOf(r)).toContain('url(#id)');
      }
      expect(imgNode().style['clip-path']).toBeUndefined();
      const ok = await call('set_image', { nodeId: id, clipPath: 'url(#mask)' });
      expect(ok.isError, textOf(ok)).toBeFalsy();
      expect(imgNode().style['clip-path']).toBe('url(#mask)');
    });

    it('is a single undo entry', async () => {
      const id = await makeImage();
      const before = JSON.stringify(imgNode());
      await call('set_image', {
        nodeId: id,
        fit: 'contain',
        filters: { sepia: 50 },
        crop: { left: 5 },
      });
      expect(imgNode().style['object-fit']).toBe('contain');
      await call('undo');
      expect(JSON.stringify(imgNode())).toBe(before);
    });

    it('relative source (file in assets/) and absolute', async () => {
      const id = await makeImage();
      fs.writeFileSync(path.join(assets(), 'other.svg'), SVG.replace('48', '60'));
      const r = await call('set_image', { nodeId: id, source: 'other.svg' });
      expect(r.isError, textOf(r)).toBeFalsy();
      expect(imgNode().src).toBe('other.svg');

      const abs = path.join(ws.dir, 'third.svg');
      fs.writeFileSync(abs, SVG.replace('48', '70'));
      const r2 = await call('set_image', { nodeId: id, source: abs });
      expect(r2.isError, textOf(r2)).toBeFalsy();
      expect(imgNode().src).toBe('third.svg');
      expect(fs.existsSync(path.join(assets(), 'third.svg'))).toBe(true);

      const miss = await call('set_image', { nodeId: id, source: 'does-not-exist.png' });
      expect(miss.isError).toBe(true);
      expect(textOf(miss)).toContain('assets/');
    });

    it('errors: node that is not an image, nothing to adjust, unknown filter', async () => {
      const id = await makeImage();
      const notImg = await call('set_image', { nodeId: ws.frameId, fit: 'cover' });
      expect(notImg.isError).toBe(true);
      expect(textOf(notImg)).toContain('not an image');
      const none = await call('set_image', { nodeId: id });
      expect(none.isError).toBe(true);
      const bad = await call('set_image', { nodeId: id, filters: { shadow: 3 } });
      expect(bad.isError).toBe(true);
    });
  });

  describe('generate_placeholder', () => {
    it('container gets an img child; same seed = same file and bytes; different seeds = different files', async () => {
      const r = await call('generate_placeholder', {
        nodeId: ws.frameId,
        kind: 'avatar',
        seed: 'ana',
      });
      expect(r.isError, textOf(r)).toBeFalsy();
      const img = frame().children[0]!;
      expect(img.type).toBe('image');
      expect(img.src).toMatch(/^placeholders\/avatar-ana-256x256\.svg$/);
      expect(img.style['width']).toBe('100%');
      expect(img.style['object-fit']).toBe('cover');
      expect(img.style['aspect-ratio']).toBe('256 / 256');
      const file = path.join(assets(), img.src!);
      const bytes = fs.readFileSync(file);

      const r2 = await call('generate_placeholder', {
        nodeId: ws.frameId,
        kind: 'avatar',
        seed: 'ana',
      });
      expect(r2.isError, textOf(r2)).toBeFalsy();
      const img2 = frame().children[1]!;
      expect(img2.src).toBe(img.src);
      expect(fs.readFileSync(file).equals(bytes)).toBe(true);
      expect(fs.readdirSync(path.join(assets(), 'placeholders'))).toHaveLength(1);

      await call('generate_placeholder', { nodeId: img2.id, kind: 'avatar', seed: 'bia' });
      expect(frame().children[1]!.src).toBe('placeholders/avatar-bia-256x256.svg');
      expect(fs.readdirSync(path.join(assets(), 'placeholders'))).toHaveLength(2);
      const other = fs.readFileSync(path.join(assets(), 'placeholders', 'avatar-bia-256x256.svg'));
      expect(other.equals(bytes)).toBe(false);
    });

    it('image node swaps the src; never overwrites different content', async () => {
      const id = await makeImage();
      fs.mkdirSync(path.join(assets(), 'placeholders'), { recursive: true });
      fs.writeFileSync(path.join(assets(), 'placeholders', 'logo-x-480x160.svg'), 'my file');
      const r = await call('generate_placeholder', { nodeId: id, kind: 'logo', seed: 'x' });
      expect(r.isError, textOf(r)).toBeFalsy();
      expect(imgNode().src).toBe('placeholders/logo-x-480x160-1.svg');
      expect(
        fs.readFileSync(path.join(assets(), 'placeholders', 'logo-x-480x160.svg'), 'utf8'),
      ).toBe('my file');
    });

    it('fails on text', async () => {
      await call('write_html', { parentId: ws.frameId, html: '<p>hi</p>' });
      const p = frame().children[0]!;
      const bad = await call('generate_placeholder', { nodeId: p.id, kind: 'avatar' });
      expect(bad.isError).toBe(true);
    });

    it('document without a path uses a data URL', async () => {
      const r = await buildPlaceholder(doc(), null, {
        nodeId: ws.frameId,
        kind: 'logo',
        seed: 'a',
      });
      expect(r.src.startsWith('data:image/svg+xml')).toBe(true);
      expect(r.ops[0]!.type).toBe('createNode');
    });

    it('HTTP route /api/placeholder writes and applies the src', async () => {
      const id = await makeImage();
      const res = await fetch(`${daemon.url}/api/placeholder/${docId()}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ nodeId: id, kind: 'product', seed: '7', width: 300, height: 200 }),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { src: string; nodeId: string };
      expect(body.nodeId).toBe(id);
      expect(body.src).toBe('placeholders/product-7-300x200.svg');
      expect(imgNode().src).toBe(body.src);
      expect(fs.existsSync(path.join(assets(), body.src))).toBe(true);
      const bad = await fetch(`${daemon.url}/api/placeholder/${docId()}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ nodeId: id, kind: 'cat' }),
      });
      expect(bad.status).toBe(400);
    });
  });
});
