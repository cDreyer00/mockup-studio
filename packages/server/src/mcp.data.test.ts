import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { findNode, type Node } from '@mockup/core';
import { startDaemon, type DaemonHandle } from './index.js';
import { makeWorkspace } from './test-utils.js';

type Ws = ReturnType<typeof makeWorkspace>;
const textOf = (r: unknown): string =>
  (r as { content: { type: string; text?: string }[] }).content
    .filter((c) => c.type === 'text')
    .map((c) => c.text)
    .join('\n');

const TEMPLATE =
  '<div class="lista"><article class="card"><h3>{{nome}}</h3><p>{{preco | a combinar}}</p></article></div>';

const items = (n: number): { nome: string; preco: string }[] =>
  Array.from({ length: n }, (_, i) => ({ nome: `Produto ${i + 1}`, preco: `R$ ${i + 1}` }));

describe('MCP: dados em repetidores', () => {
  let ws: Ws;
  let daemon: DaemonHandle;
  let client: Client;
  let server: http.Server | undefined;

  beforeEach(async () => {
    ws = makeWorkspace();
    daemon = await startDaemon({ port: 0, dataDir: ws.dataDir, writeInfo: false });
    client = new Client({ name: 'teste', version: '0.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(daemon.mcpUrl)));
    await client.callTool({ name: 'open_document', arguments: { path: ws.file } });
  });
  afterEach(async () => {
    await client.close();
    await daemon.close();
    await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
    server = undefined;
    ws.cleanup();
  });

  const call = (name: string, args: Record<string, unknown> = {}) =>
    client.callTool({ name, arguments: args });
  const docId = () => daemon.store.resolveDocId();
  const doc = () => daemon.store.get(docId());
  const frame = () => doc().pages[0]!.frames[0]!;

  /** Escreve o template e devolve o contêiner (a `div.lista`) com os filhos. */
  async function makeTemplate(): Promise<Node> {
    const r = await call('write_html', { parentId: ws.frameId, html: TEMPLATE });
    expect(r.isError, textOf(r)).toBeFalsy();
    return frame().children[0]!;
  }

  it('bind_data inline: converte o contêiner, preserva os ids dos filhos e o undo restaura', async () => {
    const box = await makeTemplate();
    const childIds = box.children.map((c) => c.id);
    const before = JSON.stringify(frame());
    const r = await call('bind_data', { nodeId: box.id, data: items(20) });
    expect(r.isError, textOf(r)).toBeFalsy();
    const rep = frame().children[0]!;
    expect(rep.type).toBe('repeater');
    expect(rep.id).not.toBe(box.id);
    expect(rep.id.startsWith('rp_')).toBe(true);
    expect(rep.name).toBe(box.name);
    expect(rep.children.map((c) => c.id)).toEqual(childIds);
    expect(rep.data).toHaveLength(20);
    expect(rep.dataSource?.kind).toBe('inline');
    const t = textOf(r);
    expect(t).toContain(rep.id);
    expect(t).toContain('20 item');
    expect(t).toContain('nome');
    expect(t).not.toContain('Aviso');

    // um único undo restaura o contêiner original
    const u = await call('undo');
    expect(u.isError, textOf(u)).toBeFalsy();
    expect(JSON.stringify(frame())).toBe(before);
  });

  it('bind_data num repetidor só troca os dados (mesmo id)', async () => {
    const box = await makeTemplate();
    await call('bind_data', { nodeId: box.id, data: items(3) });
    const rep = frame().children[0]!;
    const r = await call('bind_data', { nodeId: rep.id, data: items(5) });
    expect(r.isError, textOf(r)).toBeFalsy();
    expect(frame().children[0]!.id).toBe(rep.id);
    expect(frame().children[0]!.data).toHaveLength(5);
  });

  it('arquivo JSON com select; avisa de campos do template sem coluna', async () => {
    const box = await makeTemplate();
    const file = path.join(ws.dir, 'api.json');
    fs.writeFileSync(
      file,
      JSON.stringify({
        meta: { total: 4 },
        resposta: { lista: items(4).map((x) => ({ titulo: x.nome })) },
      }),
    );
    const r = await call('bind_data', { nodeId: box.id, path: file, select: 'resposta.lista' });
    expect(r.isError, textOf(r)).toBeFalsy();
    const rep = frame().children[0]!;
    expect(rep.data).toHaveLength(4);
    expect(rep.dataSource).toMatchObject({ kind: 'json', path: file, select: 'resposta.lista' });
    expect(rep.dataSource?.fetchedAt).toBeTruthy();
    expect(textOf(r)).toContain('Aviso');
    expect(textOf(r)).toContain('{{nome}}');
  });

  it('CSV com ponto e vírgula e mapping (some o aviso)', async () => {
    const box = await makeTemplate();
    const file = path.join(ws.dir, 'produtos.csv');
    fs.writeFileSync(file, 'titulo;preco\nCafé;10\n"Chá; verde";12\n');
    const r = await call('bind_data', {
      nodeId: box.id,
      path: file,
      mapping: { nome: 'titulo' },
    });
    expect(r.isError, textOf(r)).toBeFalsy();
    const rep = frame().children[0]!;
    expect(rep.data).toEqual([
      { titulo: 'Café', preco: '10' },
      { titulo: 'Chá; verde', preco: '12' },
    ]);
    expect(rep.dataSource).toMatchObject({ kind: 'csv', mapping: { nome: 'titulo' } });
    expect(textOf(r)).not.toContain('Aviso');
    const html = textOf(await call('get_code', { nodeId: ws.frameId, format: 'html' }));
    expect(html).toContain('Café');
    expect(html).toContain('Chá; verde');
  });

  it('texto colado em CSV', async () => {
    const box = await makeTemplate();
    const r = await call('bind_data', {
      nodeId: box.id,
      text: 'nome,preco\nA,1\nB,2',
      format: 'csv',
    });
    expect(r.isError, textOf(r)).toBeFalsy();
    expect(frame().children[0]!.data).toHaveLength(2);
  });

  it('URL (JSON) e refresh_data depois de a origem mudar', async () => {
    const box = await makeTemplate();
    let payload = JSON.stringify(items(2));
    server = http.createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' }).end(payload);
    });
    await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/dados`;
    const r = await call('bind_data', { nodeId: box.id, url });
    expect(r.isError, textOf(r)).toBeFalsy();
    const rep = frame().children[0]!;
    expect(rep.data).toHaveLength(2);
    expect(rep.dataSource).toMatchObject({ kind: 'url', url });
    payload = JSON.stringify(items(6));
    const rr = await call('refresh_data', { nodeId: rep.id });
    expect(rr.isError, textOf(rr)).toBeFalsy();
    expect(frame().children[0]!.data).toHaveLength(6);
    expect(textOf(rr)).toContain('6 item');
  });

  it('refresh_data de arquivo relê o conteúdo; inline dá erro claro', async () => {
    const box = await makeTemplate();
    const file = path.join(ws.dir, 'lista.json');
    fs.writeFileSync(file, JSON.stringify(items(2)));
    await call('bind_data', { nodeId: box.id, path: file });
    const rep = frame().children[0]!;
    fs.writeFileSync(file, JSON.stringify(items(7)));
    const r = await call('refresh_data', { nodeId: rep.id });
    expect(r.isError, textOf(r)).toBeFalsy();
    expect(frame().children[0]!.data).toHaveLength(7);
    // desfaz só o refresh
    await call('undo');
    expect(frame().children[0]!.data).toHaveLength(2);

    await call('bind_data', { nodeId: rep.id, data: items(1) });
    const bad = await call('refresh_data', { nodeId: rep.id });
    expect(bad.isError).toBe(true);
    expect(textOf(bad)).toContain('bind_data');
  });

  it('get_data mostra origem, colunas, campos e as primeiras linhas', async () => {
    const box = await makeTemplate();
    await call('bind_data', { nodeId: box.id, data: items(30) });
    const rep = frame().children[0]!;
    const t = textOf(await call('get_data', { nodeId: rep.id }));
    expect(t).toContain('30 item');
    expect(t).toContain('Colunas: nome, preco');
    expect(t).toContain('Campos do template: nome, preco');
    expect(t).toContain('| 0 | Produto 1 | R$ 1 |');
    expect(t).toContain('| 19 | Produto 20 |');
    expect(t).not.toContain('Produto 21');
    const few = textOf(await call('get_data', { nodeId: rep.id, limit: 2 }));
    expect(few).toContain('Primeiras 2 de 30');
    const notRep = await call('get_data', { nodeId: ws.frameId });
    expect(notRep.isError).toBe(true);
  });

  it('export html contém os 20 itens', async () => {
    const box = await makeTemplate();
    await call('bind_data', { nodeId: box.id, data: items(20) });
    const out = path.join(ws.dir, 'saida');
    const r = await call('export', { nodeIds: [ws.frameId], format: 'html', outputDir: out });
    expect(r.isError, textOf(r)).toBeFalsy();
    const file = fs.readdirSync(out).find((f) => f.endsWith('.html'))!;
    const html = fs.readFileSync(path.join(out, file), 'utf8');
    expect(html.match(/<article/g)).toHaveLength(20);
    expect(html).toContain('Produto 20');
    expect(html).not.toContain('{{');
  });

  it('export copia para assets/ as imagens vindas dos dados', async () => {
    const r1 = await call('write_html', {
      parentId: ws.frameId,
      html: '<div class="g"><img src="{{foto}}" alt=""></div>',
    });
    expect(r1.isError, textOf(r1)).toBeFalsy();
    fs.mkdirSync(path.join(ws.dir, 'assets'), { recursive: true });
    fs.writeFileSync(
      path.join(ws.dir, 'assets', 'a.svg'),
      '<svg xmlns="http://www.w3.org/2000/svg"/>',
    );
    fs.writeFileSync(
      path.join(ws.dir, 'assets', 'b.svg'),
      '<svg xmlns="http://www.w3.org/2000/svg"/>',
    );
    const box = frame().children[0]!;
    await call('bind_data', { nodeId: box.id, data: [{ foto: 'a.svg' }, { foto: 'b.svg' }] });
    const out = path.join(ws.dir, 'saida2');
    const r = await call('export', { nodeIds: [ws.frameId], format: 'html', outputDir: out });
    expect(r.isError, textOf(r)).toBeFalsy();
    expect(fs.existsSync(path.join(out, 'assets', 'a.svg'))).toBe(true);
    expect(fs.existsSync(path.join(out, 'assets', 'b.svg'))).toBe(true);
  });

  it('limites e erros claros', async () => {
    const box = await makeTemplate();
    const big = await call('bind_data', { nodeId: box.id, data: items(1001) });
    expect(big.isError).toBe(true);
    expect(textOf(big)).toContain('1000');
    expect(frame().children[0]!.type).not.toBe('repeater');

    const limited = await call('bind_data', { nodeId: box.id, data: items(1001), limit: 5 });
    expect(limited.isError, textOf(limited)).toBeFalsy();
    expect(frame().children[0]!.data).toHaveLength(5);

    const cur = frame().children[0]!.id;
    const none = await call('bind_data', { nodeId: cur });
    expect(none.isError).toBe(true);
    expect(textOf(none)).toContain('exatamente uma origem');
    const two = await call('bind_data', { nodeId: cur, data: [], path: 'C:/x.json' });
    expect(two.isError).toBe(true);
    const rel = await call('bind_data', { nodeId: cur, path: 'dados.json' });
    expect(textOf(rel)).toContain('absoluto');
    const root = await call('bind_data', { nodeId: ws.frameId, data: items(2) });
    expect(root.isError).toBe(true);
    expect(textOf(root)).toContain('frame raiz');
  });

  it('path recusa pastas e arquivos ocultos, .txt, traversal e symlink para oculto', async () => {
    const box = await makeTemplate();
    const put = (rel: string, content: string): string => {
      const f = path.join(ws.dir, rel);
      fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.writeFileSync(f, content);
      return f;
    };
    const secret = JSON.stringify([{ nome: 'SEGREDO' }]);
    const ssh = put('.ssh/chaves.json', secret);
    const claude = put('.claude/.credentials.json', secret);
    const txt = put('notas.txt', 'nome\nSEGREDO\n');
    const traversal = path.join(ws.dir, 'sub', '..', '.claude', '.credentials.json');
    const attempts = [ssh, claude, traversal];
    const link = path.join(ws.dir, 'atalho.json');
    try {
      fs.symlinkSync(claude, link, 'file');
      attempts.push(link);
    } catch {
      // sem permissão para symlink (Windows sem modo desenvolvedor): o resto do teste vale
    }
    for (const p of attempts) {
      const r = await call('bind_data', { nodeId: box.id, path: p });
      expect(r.isError, p).toBe(true);
      expect(textOf(r)).toContain('oculto');
      expect(textOf(r)).not.toContain('SEGREDO');
    }
    const t = await call('bind_data', { nodeId: box.id, path: txt });
    expect(t.isError).toBe(true);
    expect(textOf(t)).toContain('.txt');
    expect(frame().children[0]!.type).not.toBe('repeater');
    expect(JSON.stringify(doc())).not.toContain('SEGREDO');

    // caminho com ".." que termina em pasta comum continua aceito
    put('dados/ok.json', JSON.stringify(items(2)));
    const ok = await call('bind_data', {
      nodeId: box.id,
      path: path.join(ws.dir, 'sub', '..', 'dados', 'ok.json'),
    });
    expect(ok.isError, textOf(ok)).toBeFalsy();
  });

  it('get_html marca o repetidor e write_html replace com a marca preserva os dados', async () => {
    const box = await makeTemplate();
    const file = path.join(ws.dir, 'lista.json');
    fs.writeFileSync(file, JSON.stringify(items(5)));
    await call('bind_data', { nodeId: box.id, path: file });
    const rep = frame().children[0]!;
    const html = textOf(await call('get_html', { nodeId: rep.id }));
    expect(html).toContain(`data-mockup-repeat="${rep.id}"`);
    expect(html).toContain('data-repeat="5"');
    expect(html).toContain('{{nome}}');

    const edited = html.replace('a combinar', 'sob consulta');
    const w = await call('write_html', { parentId: rep.id, mode: 'replace', html: edited });
    expect(w.isError, textOf(w)).toBeFalsy();
    expect(textOf(w)).not.toContain('Aviso');
    const back = frame().children[0]!;
    expect(back.type).toBe('repeater');
    expect(back.data).toEqual(items(5));
    expect(back.dataSource).toMatchObject({ kind: 'json', path: file });
    expect(back.attrs['data-mockup-repeat']).toBeUndefined();
    expect(back.attrs['data-repeat']).toBeUndefined();
    expect(JSON.stringify(back.children)).toContain('sob consulta');
    expect(textOf(await call('get_code', { nodeId: ws.frameId, format: 'html' }))).toContain(
      'Produto 5',
    );

    // sem a marca: vira contêiner comum, mas a resposta avisa e o undo restaura
    const plain = html.replace(/ data-mockup-repeat="[^"]*"/, '').replace(/ data-repeat="\d+"/, '');
    const lost = await call('write_html', { parentId: back.id, mode: 'replace', html: plain });
    expect(textOf(lost)).toContain('perderam os dados');
    expect(textOf(lost)).toContain(`${back.id} (5 itens)`);
    expect(frame().children[0]!.type).not.toBe('repeater');
    await call('undo');
    expect(frame().children[0]!.type).toBe('repeater');
    expect(frame().children[0]!.data).toHaveLength(5);
  });

  it('contêiner sem filhos pede o template primeiro', async () => {
    const r1 = await call('write_html', {
      parentId: ws.frameId,
      html: '<div class="vazio"></div>',
    });
    expect(r1.isError, textOf(r1)).toBeFalsy();
    const empty = frame().children[0]!;
    const r = await call('bind_data', { nodeId: empty.id, data: items(2) });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toContain('write_html');
    expect(textOf(r)).toContain('{{nome}}');
  });

  describe('rotas HTTP', () => {
    const post = (url: string, body: unknown) =>
      fetch(`${daemon.url}${url}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });

    it('bind converte e refresh relê (source editor, uma entrada de undo)', async () => {
      const box = await makeTemplate();
      const file = path.join(ws.dir, 'rota.json');
      fs.writeFileSync(file, JSON.stringify(items(3)));
      const res = await post(`/api/data/${docId()}/${box.id}/bind`, { path: file });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { nodeId: string; count: number; columns: string[] };
      expect(body.count).toBe(3);
      expect(body.columns).toEqual(['nome', 'preco']);
      expect(body.nodeId.startsWith('rp_')).toBe(true);
      expect(findNode(doc(), body.nodeId)?.node.type).toBe('repeater');

      fs.writeFileSync(file, JSON.stringify(items(9)));
      const rr = await post(`/api/data/${docId()}/${body.nodeId}/refresh`, {});
      expect(rr.status).toBe(200);
      expect(((await rr.json()) as { count: number }).count).toBe(9);

      const bad = await post(`/api/data/${docId()}/${body.nodeId}/bind`, {
        data: items(1),
        text: 'x',
      });
      expect(bad.status).toBe(400);
      await post(`/api/data/${docId()}/${body.nodeId}/bind`, { data: items(1) });
      const inline = await post(`/api/data/${docId()}/${body.nodeId}/refresh`, {});
      expect(inline.status).toBe(400);
      const missing = await post(`/api/data/${docId()}/nao_existe/bind`, { data: items(1) });
      expect(missing.status).toBe(400);
      const noDoc = await post(`/api/data/doc_xx/${box.id}/bind`, { data: items(1) });
      expect(noDoc.status).toBe(404);
    });

    it('bind pelo editor só lê path da pasta do documento ou do home e exige Origin local', async () => {
      const box = await makeTemplate();
      const other = makeWorkspace();
      const home = path.join(ws.dir, 'home-falso');
      fs.mkdirSync(home);
      const spy = vi.spyOn(os, 'homedir').mockReturnValue(home);
      try {
        const outside = path.join(other.dir, 'fora.json');
        fs.writeFileSync(outside, JSON.stringify(items(2)));
        const r = await post(`/api/data/${docId()}/${box.id}/bind`, { path: outside });
        expect(r.status).toBe(400);
        expect(((await r.json()) as { error: string }).error).toContain('pasta do documento');

        fs.mkdirSync(path.join(ws.dir, '.oculta'));
        const hidden = path.join(ws.dir, '.oculta', 'x.json');
        fs.writeFileSync(hidden, JSON.stringify(items(2)));
        const h = await post(`/api/data/${docId()}/${box.id}/bind`, { path: hidden });
        expect(h.status).toBe(400);

        const evil = await fetch(`${daemon.url}/api/data/${docId()}/${box.id}/bind`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', origin: 'https://exemplo.com' },
          body: JSON.stringify({ text: '[{"nome":"x"}]' }),
        });
        expect(evil.status).toBe(403);

        const inDoc = path.join(ws.dir, 'perto.json');
        fs.writeFileSync(inDoc, JSON.stringify(items(2)));
        const ok = await post(`/api/data/${docId()}/${box.id}/bind`, { path: inDoc });
        expect(ok.status).toBe(200);
      } finally {
        spy.mockRestore();
        other.cleanup();
      }
    });
  });
});
