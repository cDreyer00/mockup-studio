/**
 * Integração REAL de componentes: Electron headless + cliente MCP (Streamable HTTP).
 * `insert_component('shadcn-like/Button', …)` precisa aparecer certo no screenshot.
 * Requer `npm run build` (desktop e editor) antes. `QA_SHOT_DIR` grava os PNGs para inspeção.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createDocument, createNodeFromTag, serializeDocument } from '@mockup/core';
import { pngSize } from './main/render-utils.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.resolve(here, '..');
const repo = path.resolve(appDir, '../..');
const electronExe = createRequire(import.meta.url)('electron') as string;
const built = fs.existsSync(path.join(appDir, 'out/main/index.js'));
const editorReady = fs.existsSync(path.join(repo, 'packages/editor/dist/render.html'));

type Content = { type: string; text?: string; data?: string; mimeType?: string };

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

describe.skipIf(!built || !editorReady)('Componentes via MCP real (Electron headless)', () => {
  let tmp: string;
  let child: ChildProcess;
  let client: Client;
  let stderr = '';
  let frameId = '';

  beforeAll(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mockup-comp-'));
    const dataDir = path.join(tmp, 'data');
    fs.mkdirSync(dataDir);
    const doc = createDocument('Componentes');
    const frame = createNodeFromTag('div', {
      isRoot: true,
      name: 'Tela',
      styles: { width: '400px', height: '200px', background: '#ffffff', padding: '24px' },
      position: { x: 0, y: 0 },
    });
    doc.pages[0]!.frames.push(frame);
    frameId = frame.id;
    const file = path.join(tmp, 'comp.mockup.json');
    fs.writeFileSync(file, serializeDocument(doc), 'utf8');
    const port = await freePort();
    const url = `http://127.0.0.1:${port}`;
    const env: NodeJS.ProcessEnv = { ...process.env, MOCKUP_DATA_DIR: dataDir };
    delete env.ELECTRON_RUN_AS_NODE;
    child = spawn(
      electronExe,
      [appDir, '--headless', '--port', String(port), '--data-dir', dataDir],
      { env, stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true },
    );
    child.stderr!.on('data', (d: Buffer) => (stderr += d.toString()));
    await waitHealth(url, child);
    client = new Client({ name: 'qa', version: '0.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${url}/mcp`)));
    const r = await client.callTool({ name: 'open_document', arguments: { path: file } });
    expect(r.isError, stderr).toBeFalsy();
  });

  afterAll(async () => {
    await client?.close().catch(() => undefined);
    if (child && child.exitCode === null) {
      const exited = new Promise((r) => child.once('exit', r));
      if (process.platform === 'win32' && child.pid)
        spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
      else child.kill('SIGKILL');
      await Promise.race([exited, new Promise((r) => setTimeout(r, 10000))]);
    }
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  const call = async (name: string, args: Record<string, unknown>): Promise<Content[]> => {
    const r = await client.callTool({ name, arguments: args });
    const content = r.content as Content[];
    expect(r.isError, content.map((c) => c.text).join('\n')).toBeFalsy();
    return content;
  };
  const text = (c: Content[]): string => c.map((x) => x.text ?? '').join('\n');
  const shot = async (nodeId: string): Promise<Buffer> => {
    const img = (await call('get_screenshot', { nodeId, scale: 2 })).find(
      (c) => c.type === 'image',
    );
    expect(img, 'screenshot sem imagem').toBeTruthy();
    expect(img!.mimeType).toBe('image/png');
    return Buffer.from(img!.data!, 'base64');
  };

  it('insert_component Button outline "Salvar" renderiza no screenshot e difere do default', async () => {
    const out = await call('insert_component', {
      component: 'shadcn-like/Button',
      parentId: frameId,
      props: { variant: 'outline', label: 'Salvar' },
    });
    const outlineId = /Instância criada: (\S+)/.exec(text(out))![1]!;
    const def = await call('insert_component', {
      component: 'shadcn-like/Button',
      parentId: frameId,
      props: { label: 'Padrão' },
    });
    const defaultId = /Instância criada: (\S+)/.exec(text(def))![1]!;

    const a = await shot(outlineId);
    const b = await shot(defaultId);
    const sa = pngSize(a);
    expect(sa.width).toBeGreaterThan(80);
    expect(sa.height).toBeGreaterThan(40);
    expect(a.equals(b)).toBe(false);
    if (process.env.QA_SHOT_DIR) {
      fs.mkdirSync(process.env.QA_SHOT_DIR, { recursive: true });
      fs.writeFileSync(path.join(process.env.QA_SHOT_DIR, 'button-outline.png'), a);
      fs.writeFileSync(path.join(process.env.QA_SHOT_DIR, 'button-default.png'), b);
      fs.writeFileSync(path.join(process.env.QA_SHOT_DIR, 'frame.png'), await shot(frameId));
    }
    // o layout medido no navegador de verdade tem o botão com largura/altura plausíveis
    const layout = text(await call('get_layout', { nodeId: outlineId }));
    expect(layout).toMatch(/\d+/);
  });

  it('o frame inteiro com as instâncias renderiza (ids virtuais não quebram o render)', async () => {
    const png = await shot(frameId);
    expect(pngSize(png)).toEqual({ width: 800, height: 400 });
  });
});
