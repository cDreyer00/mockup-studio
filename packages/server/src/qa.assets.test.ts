import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { resolveDataPath } from './datasource.js';
import { startDaemon, type DaemonHandle } from './index.js';
import { makeWorkspace } from './test-utils.js';

type Ws = ReturnType<typeof makeWorkspace>;
const textOf = (r: unknown): string =>
  (r as { content: { type: string; text?: string }[] }).content
    .filter((c) => c.type === 'text')
    .map((c) => c.text)
    .join('\n');

function png(w: number, h: number, fill: number): Buffer {
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
    chunk('IDAT', zlib.deflateSync(Buffer.alloc(h * (1 + w * 4), fill))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

describe('QA: link /cdn estável entre reinícios do daemon', () => {
  let ws: Ws;
  let daemon: DaemonHandle | undefined;
  let client: Client | undefined;

  const boot = async (): Promise<void> => {
    daemon = await startDaemon({ port: 0, dataDir: ws.dataDir, writeInfo: false });
    client = new Client({ name: 'teste', version: '0.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(daemon.mcpUrl)));
    await client.callTool({ name: 'open_document', arguments: { path: ws.file } });
  };
  const shutdown = async (): Promise<void> => {
    await client?.close();
    await daemon?.close();
    client = undefined;
    daemon = undefined;
  };

  beforeEach(() => {
    ws = makeWorkspace();
  });
  afterEach(async () => {
    await shutdown();
    ws.cleanup();
  });

  it('o mesmo conteúdo mantém o hash e o /cdn responde depois de reiniciar (outro nome, outro daemon)', async () => {
    const bytes = png(20, 10, 9);
    const hash = crypto.createHash('sha256').update(bytes).digest('hex').slice(0, 32);
    await boot();
    const up = await client!.callTool({
      name: 'upload_asset',
      arguments: { source: `data:image/png;base64,${bytes.toString('base64')}`, name: 'um' },
    });
    expect(textOf(up)).toContain(`/cdn/${hash}.png`);
    await shutdown();

    await boot();
    // arquivo com outro nome e o mesmo conteúdo: o mesmo link
    const file = path.join(ws.dir, 'copia-com-outro-nome.png');
    fs.writeFileSync(file, bytes);
    const again = await client!.callTool({ name: 'upload_asset', arguments: { source: file } });
    expect(textOf(again)).toContain(`/cdn/${hash}.png`);
    const url = textOf(again).match(/http:\S+\/cdn\/\S+\.png/)![0];
    const res = await fetch(url);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toContain('immutable');
    expect(
      crypto
        .createHash('sha256')
        .update(Buffer.from(await res.arrayBuffer()))
        .digest('hex'),
    ).toContain(hash);
    // variações do nome não resolvem (caixa, extensão trocada, sem extensão, traversal)
    const base = new URL(url).origin;
    for (const p of [
      `/cdn/${hash.toUpperCase()}.png`,
      `/cdn/${hash}.jpg`,
      `/cdn/${hash}`,
      `/cdn/..%2f..%2fcdn%2findex.json`,
      `/cdn/index.json`,
    ]) {
      expect((await fetch(base + p)).status, p).toBe(404);
    }
  });
});

describe('QA: caminhos de rede em bind_data', () => {
  const bs = String.fromCharCode(92);
  const unc = [bs + bs + '127.0.0.1', 'inexistente', 'x.csv'].join(bs);

  // Abrir um compartilhamento SMB pode enviar credenciais NTLM a um host escolhido no prompt:
  // a recusa precisa acontecer antes de qualquer acesso ao disco (sem "não encontrado").
  it('recusa caminho UNC e de dispositivo antes de tocar a rede', async () => {
    for (const p of [
      unc,
      '//127.0.0.1/c$/x.csv',
      bs + bs + '?' + bs + 'UNC' + bs + 'h' + bs + 's' + bs + 'x.csv',
    ]) {
      await expect(resolveDataPath(p), p).rejects.toThrow(/caminho de rede/i);
    }
  });
});
