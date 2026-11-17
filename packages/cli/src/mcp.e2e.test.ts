/**
 * E2E do `mockup mcp` por stdio: sem daemon rodando, o CLI deve subir um headless sozinho,
 * fazer proxy das ferramentas e responder. Usa porta e pasta de dados próprias para não
 * interferir com um daemon real.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { locateElectron } from './electron.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const binPath = path.resolve(here, '../dist/bin.js');

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address() as net.AddressInfo;
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

function textOf(result: unknown): string {
  const content = (result as { content?: { type: string; text?: string }[] }).content ?? [];
  return content
    .filter((c) => c.type === 'text')
    .map((c) => c.text ?? '')
    .join('\n');
}

describe('mockup mcp (stdio)', () => {
  let dataDir: string;
  let client: Client;
  let transport: StdioClientTransport;

  beforeAll(async () => {
    expect(fs.existsSync(binPath), `build do cli ausente: ${binPath}`).toBe(true);
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mockup-cli-'));
    const port = await freePort();
    transport = new StdioClientTransport({
      command: process.execPath,
      args: [binPath, 'mcp'],
      env: { ...process.env, MOCKUP_DATA_DIR: dataDir, MOCKUP_PORT: String(port) },
      stderr: 'pipe',
    });
    client = new Client({ name: 'cli-e2e', version: '0.0.0' });
    await client.connect(transport);
  });

  afterAll(async () => {
    await client?.close().catch(() => undefined);
    // Encerra o daemon headless que o CLI subiu.
    const infoPath = path.join(dataDir, 'daemon.json');
    if (fs.existsSync(infoPath)) {
      const { pid } = JSON.parse(fs.readFileSync(infoPath, 'utf8')) as { pid: number };
      try {
        process.kill(pid);
      } catch {
        /* já encerrado */
      }
    }
    await new Promise((r) => setTimeout(r, 500));
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('lista ferramentas via proxy', async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    expect(names).toEqual(
      expect.arrayContaining(['get_basic_info', 'write_html', 'get_tree_summary', 'undo']),
    );
  });

  it('cria documento, escreve HTML e lê o resumo', async () => {
    const docPath = path.join(dataDir, 'teste.mockup.json');
    const created = await client.callTool({
      name: 'create_document',
      arguments: { path: docPath, name: 'Teste' },
    });
    expect(textOf(created)).toContain('Teste');

    const frame = await client.callTool({
      name: 'create_frame',
      arguments: { name: 'Desktop', width: 1200, height: 800 },
    });
    const frameText = textOf(frame);
    const frameId = /fr_[0-9a-z]{8}/.exec(frameText)?.[0];
    expect(frameId).toBeTruthy();

    const written = await client.callTool({
      name: 'write_html',
      arguments: {
        parentId: frameId,
        html: '<section class="hero"><h1>Olá mundo</h1><p>Subtítulo</p></section>',
        css: '.hero { display: flex; flex-direction: column; gap: 16px; }',
      },
    });
    expect(textOf(written)).toContain('Olá mundo');

    const summary = await client.callTool({ name: 'get_tree_summary', arguments: { depth: 3 } });
    const summaryText = textOf(summary);
    expect(summaryText).toContain('Desktop');
    expect(summaryText).toContain('Olá mundo');

    const info = await client.callTool({ name: 'get_basic_info', arguments: {} });
    expect(textOf(info)).toContain('Desktop');

    // Ciclo do agente: ver o resultado e entregar o código. Com Electron disponível (pacote desktop
    // buildado), o CLI sobe o Electron headless e o screenshot é uma imagem PNG de verdade.
    const shot = await client.callTool({
      name: 'get_screenshot',
      arguments: { nodeId: frameId, scale: 1, format: 'png' },
    });
    const content = (shot as { content: { type: string; data?: string; mimeType?: string }[] })
      .content;
    const image = content.find((c) => c.type === 'image');
    if (locateElectron()) {
      expect(shot.isError, textOf(shot)).toBeFalsy();
      expect(image?.mimeType).toBe('image/png');
      // assinatura PNG (\x89PNG) em base64
      expect(image?.data?.startsWith('iVBORw0KGgo')).toBe(true);
    } else {
      expect(shot.isError).toBe(true);
      expect(textOf(shot)).toMatch(/render/i);
    }

    const outputDir = path.join(dataDir, 'exports');
    const exported = await client.callTool({
      name: 'export',
      arguments: { nodeIds: [frameId], format: 'html', outputDir },
    });
    expect(exported.isError, textOf(exported)).toBeFalsy();
    const files = fs.readdirSync(outputDir).filter((f) => f.endsWith('.html'));
    expect(files.length).toBe(1);
    expect(fs.readFileSync(path.join(outputDir, files[0]), 'utf8')).toContain('Olá mundo');
  });

  it('erro de parâmetro chega pelo proxy com mensagem acionável', async () => {
    const r = await client.callTool({ name: 'create_frame', arguments: { name: 'X' } });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toContain('width');
    expect(textOf(r)).toContain('Exemplo: create_frame(');
  });

  it('expõe os guias como resources', async () => {
    const { resources } = await client.listResources();
    expect(resources.map((r) => r.uri)).toContain('guide://getting-started');
    const read = await client.readResource({ uri: 'guide://getting-started' });
    expect(read.contents[0]).toHaveProperty('text');
  });
});
