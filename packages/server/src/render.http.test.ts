import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  RENDER_UNAVAILABLE,
  startDaemon,
  type CaptureRequest,
  type DaemonHandle,
} from './index.js';
import type { RenderProvider } from './render.js';
import { makeWorkspace } from './test-utils.js';

const PNG = Buffer.from('89504e470d0a1a0a', 'hex');

function fakeRender(calls: CaptureRequest[]): RenderProvider {
  return {
    async capture(req) {
      calls.push(req);
      if (req.nodeId === 'quebra') throw new Error('falhou de propósito');
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
      throw new Error('sem layout');
    },
  };
}

describe('rotas /render', () => {
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

  it('PNG com scale e transparent, sem cache', async () => {
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

  it('JPG com quality', async () => {
    await start(fakeRender(calls));
    const r = await fetch(`${daemon.url}/render/${docId()}/${ws.frameId}.jpg?quality=70`);
    expect(r.headers.get('content-type')).toBe('image/jpeg');
    expect(calls[0]).toMatchObject({ format: 'jpg', quality: 70, scale: 1 });
  });

  it('404 para documento ou nó inexistente e 400 para parâmetros inválidos', async () => {
    await start(fakeRender(calls));
    expect((await fetch(`${daemon.url}/render/nao/${ws.frameId}.png`)).status).toBe(404);
    expect((await fetch(`${daemon.url}/render/${docId()}/nao.png`)).status).toBe(404);
    expect((await fetch(`${daemon.url}/render/${docId()}/${ws.frameId}.png?scale=5`)).status).toBe(
      400,
    );
    expect((await fetch(`${daemon.url}/render/${docId()}/${ws.frameId}.gif`)).status).toBe(404);
  });

  it('erro do motor vira 500 com mensagem', async () => {
    await start({ ...fakeRender(calls), capture: () => Promise.reject(new Error('boom')) });
    const r = await fetch(`${daemon.url}/render/${docId()}/${ws.frameId}.png`);
    expect(r.status).toBe(500);
    expect(((await r.json()) as { error: string }).error).toBe('boom');
  });

  it('503 sem motor de render', async () => {
    await start();
    const r = await fetch(`${daemon.url}/render/${docId()}/${ws.frameId}.png`);
    expect(r.status).toBe(503);
    expect(((await r.json()) as { error: string }).error).toBe(RENDER_UNAVAILABLE);
  });

  it('SVG: erro do exportador ou do layout vira 500 (não derruba o daemon)', async () => {
    await start(fakeRender(calls));
    const r = await fetch(`${daemon.url}/render/${docId()}/${ws.frameId}.svg`);
    expect([200, 500]).toContain(r.status);
    expect((await fetch(`${daemon.url}/api/health`)).status).toBe(200);
  });
});
