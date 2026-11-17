import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDocument, serializeDocument } from '@mockup/core';
import { startDaemon, type DaemonHandle } from './daemon.js';
import { checkHealth } from './health.js';
import { takeOverDaemon } from './control.js';

const dirs: string[] = [];
const handles: DaemonHandle[] = [];

function tmp(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'mockup-shutdown-'));
  dirs.push(d);
  return d;
}

afterEach(async () => {
  await Promise.all(handles.splice(0).map((h) => h.close()));
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

async function start(opts: Parameters<typeof startDaemon>[0] = {}): Promise<DaemonHandle> {
  const h = await startDaemon({ port: 0, writeInfo: false, dataDir: tmp(), ...opts });
  handles.push(h);
  return h;
}

const post = (url: string, headers: Record<string, string> = {}) =>
  fetch(`${url}/api/shutdown`, { method: 'POST', headers });

describe('health.mode e POST /api/shutdown', () => {
  it('informa o modo conforme quem iniciou', async () => {
    expect((await checkHealth((await start({ headless: true })).url))?.mode).toBe('headless');
    expect((await checkHealth((await start({})).url))?.mode).toBe('serve');
    expect((await checkHealth((await start({ mode: 'desktop' })).url))?.mode).toBe('desktop');
  });

  it('sem onShutdown (app desktop) recusa com 409 e continua no ar', async () => {
    const d = await start({ mode: 'desktop' });
    expect((await checkHealth(d.url))?.canShutdown).toBe(false);
    const res = await post(d.url);
    expect(res.status).toBe(409);
    expect(await checkHealth(d.url)).not.toBeNull();
  });

  it('com onShutdown responde 202, salva os documentos e encerra', async () => {
    const onShutdown = vi.fn();
    const dir = tmp();
    const file = path.join(dir, 'a.mockup.json');
    fs.writeFileSync(file, serializeDocument(createDocument('A')), 'utf8');
    const d = await start({ headless: true, openFiles: [file], onShutdown });
    expect((await checkHealth(d.url))?.canShutdown).toBe(true);
    const res = await post(d.url);
    expect(res.status).toBe(202);
    await vi.waitFor(() => expect(onShutdown).toHaveBeenCalledTimes(1));
    expect(await checkHealth(d.url, 300)).toBeNull();
  });

  it('recusa Origin externa e Host não local', async () => {
    const onShutdown = vi.fn();
    const d = await start({ onShutdown });
    expect((await post(d.url, { origin: 'https://evil.example' })).status).toBe(403);
    const status = await new Promise<number>((resolve, reject) => {
      const req = http.request(
        `${d.url}/api/shutdown`,
        { method: 'POST', headers: { host: 'evil.example' } },
        (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        },
      );
      req.on('error', reject);
      req.end();
    });
    expect(status).toBe(403);
    expect(onShutdown).not.toHaveBeenCalled();
  });

  it('takeOverDaemon devolve os documentos abertos e espera a porta liberar', async () => {
    const dir = tmp();
    const file = path.join(dir, 'b.mockup.json');
    fs.writeFileSync(file, serializeDocument(createDocument('B')), 'utf8');
    const d = await start({ headless: true, openFiles: [file], onShutdown: () => undefined });
    const r = await takeOverDaemon(d.url, 5000);
    expect(r.ok).toBe(true);
    expect(r.paths.map((p) => path.resolve(p))).toEqual([path.resolve(file)]);
    expect(await checkHealth(d.url, 300)).toBeNull();
  });

  it('takeOverDaemon não derruba um daemon que recusa', async () => {
    const d = await start({ mode: 'desktop' });
    const r = await takeOverDaemon(d.url, 1000);
    expect(r.ok).toBe(false);
    expect(await checkHealth(d.url)).not.toBeNull();
  });

  it('porta ocupada rejeita com mensagem clara (sem erro não tratado do ws)', async () => {
    const a = await start();
    await expect(startDaemon({ port: a.port, writeInfo: false, dataDir: tmp() })).rejects.toThrow(
      /já está em uso/,
    );
  });
});
