/**
 * Integração REAL: sobe o Electron headless (binário do pacote `electron` + `out/main`) e captura
 * o frame do exemplo pelas rotas `/render`. Requer `npm run build` (desktop e editor) antes.
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
    if (child.exitCode !== null) throw new Error(`Electron encerrou (código ${child.exitCode})`);
    try {
      const r = await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(1000) });
      if (r.ok && ((await r.json()) as { render?: boolean }).render === true) return;
    } catch {
      /* ainda subindo */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('Timeout aguardando /api/health com render: true');
}

describe.skipIf(!built || !editorReady)('Electron headless (integração)', () => {
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
    const env = { ...process.env, MOCKUP_DATA_DIR: dataDir };
    delete env.ELECTRON_RUN_AS_NODE;
    child = spawn(
      electronExe,
      [appDir, '--headless', '--port', String(port), '--data-dir', dataDir],
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

  it('frame desktop em 1x: PNG 1440x900', async () => {
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

  it('nó interno (Navbar) tem a largura do frame', async () => {
    const r = await get(`/render/${docId}/el_dsk00007.png?scale=1`);
    expect(r.status, stderr).toBe(200);
    const s = pngSize(r.body);
    expect(s.width).toBe(1440);
    expect(s.height).toBeLessThan(900);
  });

  it('JPG começa com FFD8', async () => {
    const r = await get(`/render/${docId}/fr_d3sk1440.jpg?quality=80`);
    expect(r.status, stderr).toBe(200);
    expect(r.type).toBe('image/jpeg');
    expect(r.body[0]).toBe(0xff);
    expect(r.body[1]).toBe(0xd8);
  });

  it('chamadas repetidas usam o cache e dão o mesmo resultado', async () => {
    const a = await get(`/render/${docId}/fr_d3sk1440.png?scale=1`);
    const b = await get(`/render/${docId}/fr_d3sk1440.png?scale=1`);
    expect(a.body.equals(b.body)).toBe(true);
  });
});
