import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  RENDER_UNAVAILABLE,
  startDaemon,
  type CaptureRequest,
  type DaemonHandle,
} from './index.js';
import type { RenderProvider } from './render.js';
import { ASSET_CSP } from './http.js';
import { makeWorkspace } from './test-utils.js';

const PNG = Buffer.from('89504e470d0a1a0a', 'hex');

function fakeRender(calls: CaptureRequest[]): RenderProvider {
  return {
    async capture(req) {
      calls.push(req);
      if (req.nodeId === 'broken') throw new Error('failed on purpose');
      const jpg = req.format === 'jpg';
      return {
        data: jpg ? Buffer.from([0xff, 0xd8, 0xff]) : PNG,
        mime: jpg ? 'image/jpeg' : 'image/png',
        width: 10,
        height: 10,
        pixelWidth: 10,
        pixelHeight: 10,
      };
    },
    async measure() {
      throw new Error('no layout');
    },
  };
}

describe('/render routes', () => {
  let ws: ReturnType<typeof makeWorkspace>;
  let daemon: DaemonHandle;
  let calls: CaptureRequest[];

  const start = async (render?: RenderProvider): Promise<void> => {
    daemon = await startDaemon({
      port: 0,
      dataDir: ws.dataDir,
      writeInfo: false,
      openFiles: [ws.file],
      render,
    });
  };
  const docId = (): string => daemon.store.list()[0]!.docId;

  beforeEach(() => {
    ws = makeWorkspace();
    calls = [];
  });
  afterEach(async () => {
    await daemon.close();
    ws.cleanup();
  });

  it('PNG with scale and transparent, no cache', async () => {
    await start(fakeRender(calls));
    const r = await fetch(
      `${daemon.url}/render/${docId()}/${ws.frameId}.png?scale=2&transparent=1`,
    );
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toBe('image/png');
    expect(r.headers.get('cache-control')).toBe('no-store');
    expect(Buffer.from(await r.arrayBuffer()).equals(PNG)).toBe(true);
    expect(calls[0]).toMatchObject({ nodeId: ws.frameId, scale: 2, transparent: true });
  });

  it('JPG with quality', async () => {
    await start(fakeRender(calls));
    const r = await fetch(`${daemon.url}/render/${docId()}/${ws.frameId}.jpg?quality=70`);
    expect(r.headers.get('content-type')).toBe('image/jpeg');
    expect(calls[0]).toMatchObject({ format: 'jpg', quality: 70, scale: 1 });
  });

  it('404 for a nonexistent document or node and 400 for invalid parameters', async () => {
    await start(fakeRender(calls));
    expect((await fetch(`${daemon.url}/render/missing/${ws.frameId}.png`)).status).toBe(404);
    expect((await fetch(`${daemon.url}/render/${docId()}/missing.png`)).status).toBe(404);
    expect((await fetch(`${daemon.url}/render/${docId()}/${ws.frameId}.png?scale=5`)).status).toBe(
      400,
    );
    expect((await fetch(`${daemon.url}/render/${docId()}/${ws.frameId}.gif`)).status).toBe(404);
  });

  it('engine error becomes 500 with a message', async () => {
    await start({ ...fakeRender(calls), capture: () => Promise.reject(new Error('boom')) });
    const r = await fetch(`${daemon.url}/render/${docId()}/${ws.frameId}.png`);
    expect(r.status).toBe(500);
    expect(((await r.json()) as { error: string }).error).toBe('boom');
  });

  it('503 without a render engine', async () => {
    await start();
    const r = await fetch(`${daemon.url}/render/${docId()}/${ws.frameId}.png`);
    expect(r.status).toBe(503);
    const err = ((await r.json()) as { error: string }).error;
    expect(err).toContain(RENDER_UNAVAILABLE);
    expect(err).toContain(`pid ${process.pid}`);
  });

  it('SVG with measured layout; a measure failure becomes 500 (does not bring the daemon down)', async () => {
    await start(fakeRender(calls));
    const r = await fetch(`${daemon.url}/render/${docId()}/${ws.frameId}.svg`);
    expect(r.status).toBe(500);
    expect((await fetch(`${daemon.url}/api/health`)).status).toBe(200);
  });

  it('SVG without a render engine falls back to foreignObject, with a restrictive CSP', async () => {
    await start();
    const r = await fetch(`${daemon.url}/render/${docId()}/${ws.frameId}.svg`);
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toContain('image/svg+xml');
    expect(r.headers.get('content-security-policy')).toBe(ASSET_CSP);
    const svg = await r.text();
    expect(svg.startsWith('<svg')).toBe(true);
    expect(svg).toContain('<foreignObject');
  });
});
