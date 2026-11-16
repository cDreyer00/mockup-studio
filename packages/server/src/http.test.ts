import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { checkHealth, isAllowedHost, startDaemon, type DaemonHandle } from './index.js';
import { sanitizeAssetName } from './http.js';
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

  it('GET /api/recent lista recentes existentes e ignora os removidos', async () => {
    const gone = path.join(ws.dir, 'sumiu.mockup.json');
    fs.writeFileSync(path.join(ws.dataDir, 'recent.json'), JSON.stringify([gone, ws.file]));
    const r = await fetch(`${daemon.url}/api/recent`);
    expect(r.status).toBe(200);
    expect(((await r.json()) as { recent: string[] }).recent).toEqual([ws.file]);
  });

  describe('POST /api/assets/:docId', () => {
    const post = (docId: string, name: string, body: Buffer, type = 'image/png') =>
      fetch(`${daemon.url}/api/assets/${docId}?name=${encodeURIComponent(name)}`, {
        method: 'POST',
        headers: { 'content-type': type },
        body: new Uint8Array(body),
      });
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);

    it('grava, serve por GET e evita colisão com sufixo', async () => {
      const id = daemon.store.list()[0]!.docId;
      const r = await post(id, 'foto.png', png);
      expect(r.status).toBe(200);
      expect(await r.json()).toEqual({ src: 'foto.png' });
      expect(fs.readFileSync(path.join(ws.dir, 'assets', 'foto.png'))).toEqual(png);
      const got = await fetch(`${daemon.url}/assets/${id}/foto.png`);
      expect(Buffer.from(await got.arrayBuffer())).toEqual(png);
      expect(await (await post(id, 'foto.png', png)).json()).toEqual({ src: 'foto-1.png' });
      expect(await (await post(id, 'foto.png', png)).json()).toEqual({ src: 'foto-2.png' });
    });

    it('sanitiza o nome e impede path traversal', async () => {
      const id = daemon.store.list()[0]!.docId;
      const r = await post(id, '../../x.png', png);
      expect(((await r.json()) as { src: string }).src).toBe('x.png');
      expect(fs.existsSync(path.join(ws.dir, 'assets', 'x.png'))).toBe(true);
      expect(fs.existsSync(path.join(ws.dir, '..', 'x.png'))).toBe(false);
      const win = await post(id, String.raw`C:\dir\w.png`, png);
      expect(((await win.json()) as { src: string }).src).toBe('w.png');
      const odd = await post(id, '.meu arquivo!.JPG', png);
      expect(((await odd.json()) as { src: string }).src).toBe('meu-arquivo-.jpg');
    });

    it('recusa upload e demais POST de outra origem; aceita origem local e sem Origin', async () => {
      const id = daemon.store.list()[0]!.docId;
      const evil = await fetch(`${daemon.url}/api/assets/${id}?name=x.svg`, {
        method: 'POST',
        headers: { 'content-type': 'text/plain', origin: 'http://evil.com' },
        body: '<svg/>',
      });
      expect(evil.status).toBe(403);
      expect(fs.existsSync(path.join(ws.dir, 'assets', 'x.svg'))).toBe(false);
      for (const route of ['/api/save', '/api/open', '/api/new', '/api/active', '/API/save']) {
        const r = await fetch(`${daemon.url}${route}`, {
          method: 'POST',
          headers: { 'content-type': 'text/plain', origin: 'null' },
          body: '{}',
        });
        expect(r.status, route).toBe(403);
      }
      const mcp = await fetch(`${daemon.url}/mcp`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: 'https://evil.com' },
        body: '{}',
      });
      expect(mcp.status).toBe(403);
      const local = await fetch(`${daemon.url}/api/assets/${id}?name=ok.png`, {
        method: 'POST',
        headers: { 'content-type': 'image/png', origin: 'http://localhost:5173' },
        body: new Uint8Array(png),
      });
      expect(local.status).toBe(200);
      expect((await post(id, 'sem-origin.png', png)).status).toBe(200);
      const read = await fetch(`${daemon.url}/api/docs`, {
        headers: { origin: 'http://evil.com' },
      });
      expect(read.status).toBe(200);
      expect(read.headers.get('access-control-allow-origin')).toBeNull();
    });

    it('serve assets com CSP restritiva, nosniff e SVG como anexo', async () => {
      const id = daemon.store.list()[0]!.docId;
      const svg = Buffer.from(
        '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
      );
      expect((await post(id, 'x.svg', svg, 'image/svg+xml')).status).toBe(200);
      const got = await fetch(`${daemon.url}/assets/${id}/x.svg`);
      expect(got.status).toBe(200);
      expect(got.headers.get('content-type')).toContain('image/svg+xml');
      expect(got.headers.get('content-security-policy')).toBe(
        "default-src 'none'; img-src data:; style-src 'unsafe-inline'; sandbox",
      );
      expect(got.headers.get('x-content-type-options')).toBe('nosniff');
      expect(got.headers.get('content-disposition')).toBe('attachment');
      await post(id, 'foto.png', png);
      const pngRes = await fetch(`${daemon.url}/assets/${id}/foto.png`);
      expect(pngRes.headers.get('content-security-policy')).toContain("default-src 'none'");
      expect(pngRes.headers.get('x-content-type-options')).toBe('nosniff');
      expect(pngRes.headers.get('content-disposition')).toBeNull();
    });

    it('nomes reservados do Windows ganham sufixo', async () => {
      const id = daemon.store.list()[0]!.docId;
      const cases: Array<[string, string]> = [
        ['CON.png', 'CON-arquivo.png'],
        ['nul.jpg', 'nul-arquivo.jpg'],
        ['COM1.png', 'COM1-arquivo.png'],
        ['lpt9.gif', 'lpt9-arquivo.gif'],
        ['aux.tar.png', 'aux-arquivo.tar.png'],
        ['console.png', 'console.png'],
        ['com10.png', 'com10.png'],
      ];
      for (const [name, expected] of cases) {
        const r = await post(id, name, png);
        expect(((await r.json()) as { src: string }).src, name).toBe(expected);
      }
      expect(sanitizeAssetName('PRN.svg')).toEqual({ base: 'PRN-arquivo', ext: '.svg' });
      expect(sanitizeAssetName('a...png')).toEqual({ base: 'a', ext: '.png' });
    });

    it('erros: 404, 400 e 413', async () => {
      const id = daemon.store.list()[0]!.docId;
      expect((await post('doc_inexistente', 'a.png', png)).status).toBe(404);
      expect((await post(id, 'a.exe', png)).status).toBe(400);
      expect((await post(id, 'a', png)).status).toBe(400);
      expect((await post(id, 'a.png', Buffer.alloc(0))).status).toBe(400);
      const big = await post(id, 'grande.png', Buffer.alloc(21 * 1024 * 1024, 1));
      expect(big.status).toBe(413);
      expect(fs.existsSync(path.join(ws.dir, 'assets', 'grande.png'))).toBe(false);
    });
  });
});
