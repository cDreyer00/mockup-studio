/**
 * E2E of `mockup mcp` over stdio: with no daemon running, the CLI must start a headless one on its own,
 * proxy the tools and respond. Uses its own port and data folder so as not to
 * interfere with a real daemon.
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
    expect(fs.existsSync(binPath), `cli build missing: ${binPath}`).toBe(true);
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
    // Stops the headless daemon that the CLI started.
    const infoPath = path.join(dataDir, 'daemon.json');
    if (fs.existsSync(infoPath)) {
      const { pid } = JSON.parse(fs.readFileSync(infoPath, 'utf8')) as { pid: number };
      try {
        process.kill(pid);
      } catch {
        /* already stopped */
      }
    }
    await new Promise((r) => setTimeout(r, 500));
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('lists tools via proxy', async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    expect(names).toEqual(
      expect.arrayContaining(['get_basic_info', 'write_html', 'get_tree_summary', 'undo']),
    );
  });

  it('creates a document, writes HTML and reads the summary', async () => {
    const docPath = path.join(dataDir, 'test.mockup.json');
    const created = await client.callTool({
      name: 'create_document',
      arguments: { path: docPath, name: 'Test' },
    });
    expect(textOf(created)).toContain('Test');

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
        html: '<section class="hero"><h1>Hello world</h1><p>Subtitle</p></section>',
        css: '.hero { display: flex; flex-direction: column; gap: 16px; }',
      },
    });
    expect(textOf(written)).toContain('Hello world');

    const summary = await client.callTool({ name: 'get_tree_summary', arguments: { depth: 3 } });
    const summaryText = textOf(summary);
    expect(summaryText).toContain('Desktop');
    expect(summaryText).toContain('Hello world');

    const info = await client.callTool({ name: 'get_basic_info', arguments: {} });
    expect(textOf(info)).toContain('Desktop');

    // Agent cycle: see the result and deliver the code. With Electron available (desktop package
    // built), the CLI starts headless Electron and the screenshot is a real PNG image.
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
      // PNG signature (\x89PNG) in base64
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
    expect(fs.readFileSync(path.join(outputDir, files[0]), 'utf8')).toContain('Hello world');
  });

  it('parameter error comes through the proxy with an actionable message', async () => {
    const r = await client.callTool({ name: 'create_frame', arguments: { name: 'X' } });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toContain('width');
    expect(textOf(r)).toContain('Example: create_frame(');
  });

  it('exposes the guides as resources', async () => {
    const { resources } = await client.listResources();
    expect(resources.map((r) => r.uri)).toContain('guide://getting-started');
    const read = await client.readResource({ uri: 'guide://getting-started' });
    expect(read.contents[0]).toHaveProperty('text');
  });
});
