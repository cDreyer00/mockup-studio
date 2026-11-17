import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';
import { createNodeFromTag } from '@mockup/core';
import {
  MOCKUP_EXTENSION_ID,
  SNAPSHOT_FORMAT,
  SNAPSHOT_VERSION,
  type SnapshotImportResult,
  type SnapshotPayload,
} from '@mockup/snapshot-core';
import { startDaemon, type DaemonHandle } from './index.js';
import { makeWorkspace } from './test-utils.js';

const EXT = `chrome-extension://${MOCKUP_EXTENSION_ID}`;
/** Valid id (32 letters a-p) that is not the Mockup Studio extension's. */
const OTHER_EXT = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop';

function pngBytes(w: number, h: number, extra = 0): Buffer {
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
    chunk('IDAT', zlib.deflateSync(Buffer.alloc(h * (1 + w * 4)))),
    chunk('IEND', Buffer.alloc(0)),
    Buffer.alloc(extra),
  ]);
}

function payload(extraBytes = 0): SnapshotPayload {
  const dataUrl = `data:image/png;base64,${pngBytes(4, 4, extraBytes).toString('base64')}`;
  return {
    format: SNAPSHOT_FORMAT,
    version: SNAPSHOT_VERSION,
    source: {
      url: 'https://example.com/',
      title: 'Example',
      capturedAt: new Date().toISOString(),
      viewport: { width: 1440, height: 900 },
      devicePixelRatio: 1,
    },
    root: createNodeFromTag('section', {
      name: 'Hero',
      styles: { width: '800px', height: '400px' },
      children: [
        createNodeFromTag('img', { src: 'asset:a1', attrs: { alt: 'x' } }),
        createNodeFromTag('h1', { text: 'Hello' }),
      ],
    }),
    width: 800,
    height: 400,
    assets: [{ id: 'a1', kind: 'image', url: 'https://cdn.example.com/a.png', dataUrl }],
    fonts: [],
    stats: { nodes: 3, truncated: false, warnings: [] },
  };
}

describe('import routes', () => {
  let ws: ReturnType<typeof makeWorkspace>;
  let daemon: DaemonHandle;

  const start = async (open = true): Promise<void> => {
    ws = makeWorkspace();
    daemon = await startDaemon({
      port: 0,
      dataDir: ws.dataDir,
      writeInfo: false,
      openFiles: open ? [ws.file] : [],
    });
  };
  afterEach(async () => {
    await daemon.close();
    ws.cleanup();
  });

  const post = (route: string, body: unknown, headers: Record<string, string> = {}) =>
    fetch(`${daemon.url}${route}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    });

  it('POST /api/snapshot accepts the SnapshotImportRequest body and the bare payload', async () => {
    await start();
    const r = await post('/api/snapshot', { payload: payload(), name: 'My frame', x: 10, y: 20 });
    expect(r.status).toBe(200);
    const body = (await r.json()) as SnapshotImportResult;
    expect(body.method).toBe('snapshot');
    expect(body.nodes).toBe(3);
    expect(body.images).toBe(1);
    const doc = daemon.store.get(body.docId);
    const frame = doc.pages[0]!.frames.find((f) => f.id === body.frameId)!;
    expect(frame.name).toBe('My frame');
    expect(frame.position).toEqual({ x: 10, y: 20 });

    const pure = await post('/api/snapshot', payload());
    expect(pure.status).toBe(200);
    expect(daemon.store.get(body.docId).pages[0]!.frames).toHaveLength(3);
  });

  it('uses the editor source for changes (no AI badge)', async () => {
    await start();
    const sources: string[] = [];
    daemon.store.on('doc:changed', (e) => sources.push(e.source));
    expect((await post('/api/snapshot', payload())).status).toBe(200);
    expect(sources).toEqual(['editor']);
  });

  it('accepts a body above 20 MB (own limit of 64 MB)', async () => {
    await start();
    const r = await post('/api/snapshot', payload(18 * 1024 * 1024));
    expect(r.status).toBe(200);
    expect(fs.existsSync(path.join(ws.dir, 'assets'))).toBe(true);
  });

  describe('extension origin (chrome-extension://)', () => {
    it('is accepted on POST /api/snapshot, with CORS reflecting the origin', async () => {
      await start();
      const r = await post('/api/snapshot', payload(), { origin: EXT });
      expect(r.status).toBe(200);
      expect(r.headers.get('access-control-allow-origin')).toBe(EXT);
    });

    it('OPTIONS preflight of /api/snapshot answers with the origin and content-type', async () => {
      await start();
      const r = await fetch(`${daemon.url}/api/snapshot`, {
        method: 'OPTIONS',
        headers: {
          origin: EXT,
          'access-control-request-method': 'POST',
          'access-control-request-headers': 'content-type',
        },
      });
      expect(r.status).toBe(204);
      expect(r.headers.get('access-control-allow-origin')).toBe(EXT);
      expect(r.headers.get('access-control-allow-headers')?.toLowerCase()).toContain(
        'content-type',
      );
      expect(r.headers.get('access-control-allow-methods')).toContain('POST');
    });

    it('is rejected on the other routes (and on their preflight)', async () => {
      await start();
      for (const route of [
        '/api/open',
        '/api/save',
        '/api/import/url',
        '/api/import/html',
        '/api/new',
      ]) {
        const r = await post(
          route,
          { path: ws.file, url: 'https://x.com', html: '<p>x</p>' },
          { origin: EXT },
        );
        expect(r.status, route).toBe(403);
      }
      const mcp = await post('/mcp', {}, { origin: EXT });
      expect(mcp.status).toBe(403);
      const pre = await fetch(`${daemon.url}/api/open`, {
        method: 'OPTIONS',
        headers: { origin: EXT, 'access-control-request-method': 'POST' },
      });
      expect(pre.headers.get('access-control-allow-origin')).toBeNull();
      const other = await fetch(`${daemon.url}/api/import/url`, {
        method: 'OPTIONS',
        headers: { origin: EXT, 'access-control-request-method': 'POST' },
      });
      expect(other.headers.get('access-control-allow-origin')).toBeNull();
    });

    it('another extension id is rejected, but passes if it is in MOCKUP_EXTENSION_IDS', async () => {
      await start();
      const denied = await post('/api/snapshot', payload(), { origin: OTHER_EXT });
      expect(denied.status).toBe(403);
      const prev = process.env.MOCKUP_EXTENSION_IDS;
      process.env.MOCKUP_EXTENSION_IDS = `xyz, ${OTHER_EXT.slice('chrome-extension://'.length)}`;
      try {
        const ok = await post('/api/snapshot', payload(), { origin: OTHER_EXT });
        expect(ok.status).toBe(200);
        expect(ok.headers.get('access-control-allow-origin')).toBe(OTHER_EXT);
      } finally {
        if (prev === undefined) delete process.env.MOCKUP_EXTENSION_IDS;
        else process.env.MOCKUP_EXTENSION_IDS = prev;
      }
    });

    it('invalid id format and regular sites are still rejected on /api/snapshot', async () => {
      await start();
      for (const origin of [
        'chrome-extension://abc',
        'chrome-extension://ABCDEFGHIJKLMNOPABCDEFGHIJKLMNOP',
        'chrome-extension://abcdefghijklmnopabcdefghijklmnopq',
        'https://evil.com',
        'null',
        'moz-extension://abcdefghijklmnopabcdefghijklmnop',
        OTHER_EXT,
      ]) {
        const r = await post('/api/snapshot', payload(), { origin });
        expect(r.status, origin).toBe(403);
      }
      // other methods from the extension origin do not pass
      const put = await fetch(`${daemon.url}/api/snapshot`, {
        method: 'PUT',
        headers: { origin: EXT, 'content-type': 'application/json' },
        body: '{}',
      });
      expect(put.status).toBe(403);
    });

    it('local origin (editor on another port) also gets CORS on the three routes', async () => {
      await start();
      for (const route of ['/api/snapshot', '/api/import/html']) {
        const r = await post(route, route === '/api/snapshot' ? payload() : { html: '<p>hi</p>' }, {
          origin: 'http://localhost:5173',
        });
        expect(r.status, route).toBe(200);
        expect(r.headers.get('access-control-allow-origin')).toBe('http://localhost:5173');
      }
    });
  });

  describe('errors', () => {
    it('400 for invalid payload, non-object body and wrong version', async () => {
      await start();
      const bad = await post('/api/snapshot', { payload: { format: 'other' } });
      expect(bad.status).toBe(400);
      expect(((await bad.json()) as { error: string }).error).toContain('Invalid snapshot');
      expect((await post('/api/snapshot', '[1,2]')).status).toBe(400);
      expect((await post('/api/snapshot', '{"a":')).status).toBe(400);
      const v = await post('/api/snapshot', { ...payload(), version: 9 });
      expect(v.status).toBe(400);
      expect(((await v.json()) as { error: string }).error).toContain('version');
      const placement = await post('/api/snapshot', { payload: payload(), x: 'a' });
      expect(placement.status).toBe(400);
    });

    it('404 for a nonexistent document/page and 409 with no open document', async () => {
      await start();
      expect(
        (await post('/api/snapshot', { payload: payload(), docId: 'doc_missing' })).status,
      ).toBe(404);
      expect(
        (await post('/api/snapshot', { payload: payload(), pageId: 'pg_missing' })).status,
      ).toBe(404);
      await daemon.close();
      ws.cleanup();
      await start(false);
      const r = await post('/api/snapshot', { payload: payload() });
      expect(r.status).toBe(409);
      expect(((await r.json()) as { error: string }).error).toContain('No document is open');
    });

    it('/api/import/url: 503 without render (the message guides the user), 400 for non-http(s) protocols and invalid viewport', async () => {
      await start();
      const r = await post('/api/import/url', { url: 'https://example.com' });
      expect(r.status).toBe(503);
      const msg = ((await r.json()) as { error: string }).error;
      expect(msg).toContain('desktop app');
      expect(msg).toContain('mockup serve --render');
      for (const url of [
        'file:///etc/passwd',
        'data:text/html,<h1>x</h1>',
        'javascript:alert(1)',
        'chrome://settings',
        'ftp://x.com/a',
      ]) {
        const bad = await post('/api/import/url', { url });
        expect(bad.status, url).toBe(400);
        expect(((await bad.json()) as { error: string }).error).toContain('http');
      }
      expect((await post('/api/import/url', {})).status).toBe(400);
      expect(
        (await post('/api/import/url', { url: 'https://x.com', viewport: { width: 100 } })).status,
      ).toBe(400);
      expect(
        (await post('/api/import/url', { url: 'https://x.com', viewport: { height: 9000 } }))
          .status,
      ).toBe(400);
      expect((await post('/api/import/url', { url: 'https://x.com', timeoutMs: -1 })).status).toBe(
        400,
      );
    });

    it('/api/import/html falls back to the core conversion without render (method html, with warning)', async () => {
      await start();
      const r = await post('/api/import/html', {
        html: '<section><h1>Hello</h1><p>text</p></section>',
        css: 'h1{color:red}',
        viewport: { width: 1024 },
        name: 'Card',
      });
      expect(r.status).toBe(200);
      const body = (await r.json()) as SnapshotImportResult;
      expect(body.method).toBe('html');
      expect(body.warnings.join('\n')).toContain('lower fidelity');
      const frame = daemon.store
        .get(body.docId)
        .pages[0]!.frames.find((f) => f.id === body.frameId)!;
      expect(frame.name).toBe('Card');
      expect(frame.style.width).toBe('1024px');
      expect(frame.children.length).toBeGreaterThan(0);
      expect((await post('/api/import/html', { html: '' })).status).toBe(400);
      expect(
        (await post('/api/import/html', { html: '<p>x</p>', assetsBaseUrl: 'file:///x' })).status,
      ).toBe(400);
    });
  });
});
