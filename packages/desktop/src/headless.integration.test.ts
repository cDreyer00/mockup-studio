/**
 * REAL integration: starts headless Electron (the `electron` package binary + `out/main`) and captures
 * the example frame through the `/render` routes. Requires `npm run build` (desktop and editor) first.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pngSize } from './main/render-utils.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.resolve(here, '..');
const repo = path.resolve(appDir, '../..');
const electronExe = createRequire(import.meta.url)('electron') as string;
const built = fs.existsSync(path.join(appDir, 'out/main/index.js'));
const editorReady = fs.existsSync(path.join(repo, 'packages/editor/dist/render.html'));

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address() as net.AddressInfo;
      s.close(() => resolve(port));
    });
  });
}

async function waitHealth(url: string, child: ChildProcess, ms = 60000): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (child.exitCode !== null) throw new Error(`Electron exited (code ${child.exitCode})`);
    try {
      const r = await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(1000) });
      if (r.ok && ((await r.json()) as { render?: boolean }).render === true) return;
    } catch {
      /* still starting up */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('Timed out waiting for /api/health with render: true');
}

describe.skipIf(!built || !editorReady)('Headless Electron (integration)', () => {
  let tmp: string;
  let child: ChildProcess;
  let url: string;
  let docId: string;
  let stderr = '';

  beforeAll(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mockup-desktop-'));
    const dataDir = path.join(tmp, 'data');
    fs.mkdirSync(dataDir);
    const file = path.join(tmp, 'landing.mockup.json');
    fs.copyFileSync(path.join(repo, 'examples/landing.mockup.json'), file);
    const port = await freePort();
    url = `http://127.0.0.1:${port}`;
    const env: NodeJS.ProcessEnv = { ...process.env, MOCKUP_DATA_DIR: dataDir };
    delete env.ELECTRON_RUN_AS_NODE;
    child = spawn(
      electronExe,
      [appDir, '--mockup-headless', '--port', String(port), '--data-dir', dataDir],
      { env, stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true },
    );
    child.stderr!.on('data', (d: Buffer) => (stderr += d.toString()));
    await waitHealth(url, child);
    const r = await fetch(`${url}/api/open`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: file }),
    });
    docId = ((await r.json()) as { docId: string }).docId;
  });

  afterAll(async () => {
    if (child && child.exitCode === null) {
      const exited = new Promise((r) => child.once('exit', r));
      if (process.platform === 'win32' && child.pid)
        spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
      else child.kill('SIGKILL');
      await Promise.race([exited, new Promise((r) => setTimeout(r, 10000))]);
    }
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  const get = async (p: string): Promise<{ status: number; body: Buffer; type: string | null }> => {
    const r = await fetch(`${url}${p}`, { signal: AbortSignal.timeout(60000) });
    return {
      status: r.status,
      body: Buffer.from(await r.arrayBuffer()),
      type: r.headers.get('content-type'),
    };
  };

  it('desktop frame at 1x: PNG 1440x900', async () => {
    const r = await get(`/render/${docId}/fr_d3sk1440.png?scale=1`);
    expect(r.status, stderr).toBe(200);
    expect(r.type).toBe('image/png');
    expect(pngSize(r.body)).toEqual({ width: 1440, height: 900 });
  });

  it('2x: 2880x1800', async () => {
    const r = await get(`/render/${docId}/fr_d3sk1440.png?scale=2`);
    expect(r.status, stderr).toBe(200);
    expect(pngSize(r.body)).toEqual({ width: 2880, height: 1800 });
  });

  it('inner node (Navbar) has the width of the frame', async () => {
    const r = await get(`/render/${docId}/el_dsk00007.png?scale=1`);
    expect(r.status, stderr).toBe(200);
    const s = pngSize(r.body);
    expect(s.width).toBe(1440);
    expect(s.height).toBeLessThan(900);
  });

  it('JPG starts with FFD8', async () => {
    const r = await get(`/render/${docId}/fr_d3sk1440.jpg?quality=80`);
    expect(r.status, stderr).toBe(200);
    expect(r.type).toBe('image/jpeg');
    expect(r.body[0]).toBe(0xff);
    expect(r.body[1]).toBe(0xd8);
  });

  it('WebSocket: a client message of 32 bytes or more gets an ack and the daemon keeps responding', async () => {
    // Regression: the bundle replaced the optional `bufferutil` of `ws` with `{}` and the first large
    // masked frame hung the main process.
    const ws = new WebSocket(url.replace('http', 'ws') + '/ws');
    const ack = await new Promise<{ type: string; reqId?: string }>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('no ack in 10 s')), 10000);
      ws.addEventListener('error', () => reject(new Error('WebSocket error')));
      ws.addEventListener('open', () =>
        ws.send(
          JSON.stringify({
            type: 'op:apply',
            reqId: 'r1',
            docId,
            ops: [
              {
                type: 'renameNodes',
                changes: [{ nodeId: 'el_dsk00007', name: 'Navbar '.repeat(20) }],
              },
            ],
          }),
        ),
      );
      ws.addEventListener('message', (e) => {
        const m = JSON.parse(String(e.data)) as { type: string; reqId?: string };
        if (m.reqId === 'r1') {
          clearTimeout(timer);
          resolve(m);
        }
      });
    });
    ws.close();
    expect(ack.type, stderr).toBe('ack');
    const h = await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(5000) });
    expect(h.ok).toBe(true);
  });

  it('repeated calls use the cache and give the same result', async () => {
    const a = await get(`/render/${docId}/fr_d3sk1440.png?scale=1`);
    const b = await get(`/render/${docId}/fr_d3sk1440.png?scale=1`);
    expect(a.body.equals(b.body)).toBe(true);
  });
});
