import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { checkHealth, isAllowedHost, startDaemon, type DaemonHandle } from './index.js';
import { makeWorkspace } from './test-utils.js';

describe('HTTP', () => {
  let ws: ReturnType<typeof makeWorkspace>;
  let daemon: DaemonHandle;

  beforeEach(async () => {
    ws = makeWorkspace();
    fs.mkdirSync(path.join(ws.dir, 'assets'));
    fs.writeFileSync(path.join(ws.dir, 'assets', 'a.txt'), 'olá asset');
    fs.writeFileSync(path.join(ws.dir, 'segredo.txt'), 'segredo');
    daemon = await startDaemon({
      port: 0,
      dataDir: ws.dataDir,
      writeInfo: false,
      openFiles: [ws.file],
    });
  });
  afterEach(async () => {
    await daemon.close();
    ws.cleanup();
  });

  it('/api/health e checkHealth', async () => {
    const h = (await (await fetch(`${daemon.url}/api/health`)).json()) as Record<string, unknown>;
    expect(h.ok).toBe(true);
    expect(h.docs).toBe(1);
    expect(h.port).toBe(daemon.port);
    expect(h.pid).toBe(process.pid);
    expect((await checkHealth(daemon.url))?.ok).toBe(true);
    expect(await checkHealth('http://127.0.0.1:1', 300)).toBeNull();
  });

  it('/api/docs e /api/docs/:id', async () => {
    const list = (await (await fetch(`${daemon.url}/api/docs`)).json()) as {
      documents: Array<{ docId: string }>;
    };
    expect(list.documents).toHaveLength(1);
    const full = await fetch(`${daemon.url}/api/docs/${list.documents[0]!.docId}`);
    expect(full.status).toBe(200);
    expect(((await full.json()) as { doc: { pages: unknown[] } }).doc.pages.length).toBeGreaterThan(
      0,
    );
    const missing = await fetch(`${daemon.url}/api/docs/nao-existe`);
    expect(missing.status).toBe(404);
  });

  it('erros viram JSON', async () => {
    const r = await fetch(`${daemon.url}/api/open`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(r.status).toBe(400);
    expect(((await r.json()) as { error: string }).error).toContain('path');
  });

  it('/api/open com arquivo inexistente dá 404 e /api/new repetido dá 409 com mensagem', async () => {
    const missing = await fetch(`${daemon.url}/api/open`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: path.join(ws.dir, 'nao-existe.mockup.json') }),
    });
    expect(missing.status).toBe(404);
    expect(((await missing.json()) as { error: string }).error).toContain('nao-existe');

    const file = path.join(ws.dir, 'novo.mockup.json');
    const body = JSON.stringify({ path: file, name: 'Novo' });
    const first = await fetch(`${daemon.url}/api/new`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
    });
    expect(first.status).toBe(200);
    const again = await fetch(`${daemon.url}/api/new`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
    });
    expect(again.status).toBe(409);
    expect(((await again.json()) as { error: string }).error).toContain('já existe');
  });

  it('/api/open com .mockup.json inválido dá 400 com a mensagem do schema', async () => {
    const bad = path.join(ws.dir, 'quebrado.mockup.json');
    fs.writeFileSync(bad, JSON.stringify({ version: 99, id: 'x' }));
    const r = await fetch(`${daemon.url}/api/open`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: bad }),
    });
    expect(r.status).toBe(400);
    expect(((await r.json()) as { error: string }).error).toMatch(/inválido|version/i);
  });

  it('CORS aceita localhost e bloqueia outras origens', async () => {
    const ok = await fetch(`${daemon.url}/api/health`, {
      headers: { Origin: 'http://localhost:5173' },
    });
    expect(ok.headers.get('access-control-allow-origin')).toBe('http://localhost:5173');
    const bad = await fetch(`${daemon.url}/api/health`, { headers: { Origin: 'http://evil.com' } });
    expect(bad.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('/assets serve arquivos e bloqueia ..', async () => {
    const id = daemon.store.list()[0]!.docId;
    const ok = await fetch(`${daemon.url}/assets/${id}/a.txt`);
    expect(ok.status).toBe(200);
    expect(await ok.text()).toBe('olá asset');

    // caminho cru, sem normalização do cliente
    const raw = (p: string) =>
      new Promise<{ status: number; body: string }>((resolve, reject) => {
        http
          .get({ host: '127.0.0.1', port: daemon.port, path: p }, (res) => {
            let body = '';
            res.on('data', (c) => (body += c));
            res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
          })
          .on('error', reject);
      });
    for (const p of [
      `/assets/${id}/../segredo.txt`,
      `/assets/${id}/%2e%2e/segredo.txt`,
      `/assets/${id}/..%2fsegredo.txt`,
    ]) {
      const r = await raw(p);
      expect(r.status).not.toBe(200);
      expect(r.body).not.toContain('segredo');
    }
  });

  const rawReq = (method: string, p: string, headers: Record<string, string>) =>
    new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = http.request(
        { host: '127.0.0.1', port: daemon.port, path: p, method, headers },
        (res) => {
          let b = '';
          res.on('data', (c) => (b += c));
          res.on('end', () => resolve({ status: res.statusCode ?? 0, body: b }));
        },
      );
      req.on('error', reject);
      req.end();
    });

  it('isAllowedHost', () => {
    expect(isAllowedHost('localhost:4747')).toBe(true);
    expect(isAllowedHost('127.0.0.1')).toBe(true);
    expect(isAllowedHost('[::1]:80')).toBe(true);
    expect(isAllowedHost('evil.com')).toBe(false);
    expect(isAllowedHost(undefined)).toBe(false);
    expect(isAllowedHost('meu-host:1', ['meu-host'])).toBe(true);
  });

  it('valida o header Host (DNS rebinding)', async () => {
    const bad = await rawReq('GET', '/api/health', { Host: 'evil.com' });
    expect(bad.status).toBe(403);
    expect(JSON.parse(bad.body)).toEqual({ error: 'Host não permitido' });
    const ok = await rawReq('GET', '/api/health', {});
    expect(ok.status).toBe(200);
    expect((await fetch(`${daemon.url}/api/health`)).status).toBe(200);
  });

  it('erro inesperado vira 500 genérico e JSON malformado vira 400', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const spy = vi.spyOn(daemon.store, 'list').mockImplementation(() => {
      throw new Error('boom');
    });
    const r = await fetch(`${daemon.url}/api/docs`);
    expect(r.status).toBe(500);
    expect(await r.json()).toEqual({ error: 'Erro interno' });
    expect(err).toHaveBeenCalled();
    spy.mockRestore();
    err.mockRestore();
    const bad = await fetch(`${daemon.url}/api/open`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{ malformado',
    });
    expect(bad.status).toBe(400);
  });
});
