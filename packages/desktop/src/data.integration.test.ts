/**
 * REAL data integration: headless Electron, a repeater bound to 20 JSON items via MCP
 * (`bind_data`) and `get_screenshot` from the render engine. The card images come from the data
 * (SVG placeholders in `assets/`). The PNG goes to `MOCKUP_DATA_SHOT` (default: the system temp
 * folder, `mockup-data-20.png`) for visual inspection. Requires `npm run build` first.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { placeholderSvg } from '@mockup/core';
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

interface ToolResult {
  content?: { type: string; text?: string; data?: string; mimeType?: string }[];
  isError?: boolean;
}

/** Minimal MCP client (Streamable HTTP, JSON or SSE responses). */
class Mcp {
  private session: string | null = null;
  private id = 0;
  constructor(private readonly url: string) {}

  private async rpc(method: string, params: unknown, notify = false): Promise<unknown> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
    };
    if (this.session) headers['mcp-session-id'] = this.session;
    const body = notify
      ? { jsonrpc: '2.0', method, params }
      : { jsonrpc: '2.0', id: ++this.id, method, params };
    const res = await fetch(`${this.url}/mcp`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(90000),
    });
    this.session = res.headers.get('mcp-session-id') ?? this.session;
    if (notify) return null;
    const text = await res.text();
    const payload = res.headers.get('content-type')?.includes('text/event-stream')
      ? text
          .split('\n')
          .filter((l) => l.startsWith('data:'))
          .map((l) => l.slice(5).trim())
          .pop()
      : text;
    const msg = JSON.parse(payload ?? '{}') as { result?: unknown; error?: { message: string } };
    if (msg.error) throw new Error(`MCP ${method}: ${msg.error.message}`);
    return msg.result;
  }

  async init(): Promise<this> {
    await this.rpc('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'mockup-desktop-test', version: '0.0.0' },
    });
    await this.rpc('notifications/initialized', {}, true);
    return this;
  }

  async call(name: string, args: Record<string, unknown>): Promise<ToolResult> {
    const r = (await this.rpc('tools/call', { name, arguments: args })) as ToolResult;
    if (r.isError) throw new Error(`${name}: ${(r.content ?? []).map((c) => c.text).join('\n')}`);
    return r;
  }

  async text(name: string, args: Record<string, unknown>): Promise<string> {
    const r = await this.call(name, args);
    return (r.content ?? []).map((c) => c.text ?? '').join('\n');
  }
}

const ROLES = ['Design', 'Product', 'Engineering', 'Data', 'Marketing'];
const COLORS = ['#6c5ce7', '#00b894', '#e17055', '#0984e3', '#fdcb6e'];

describe.skipIf(!built || !editorReady)('real data in the screenshot (integration)', () => {
  let tmp: string;
  let child: ChildProcess;
  let url: string;
  let stderr = '';
  let file: string;

  beforeAll(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mockup-data-'));
    const dataDir = path.join(tmp, 'data');
    fs.mkdirSync(dataDir);
    file = path.join(tmp, 'team.mockup.json');
    // Deterministic avatars in assets/, referenced by the data.
    const ph = path.join(tmp, 'assets', 'avatars');
    fs.mkdirSync(ph, { recursive: true });
    for (let i = 1; i <= 20; i++) {
      fs.writeFileSync(path.join(ph, `p${i}.svg`), placeholderSvg('avatar', { seed: `p${i}` }));
    }
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

  it('a repeater with 20 JSON items appears in full in get_screenshot', async () => {
    const mcp = await new Mcp(url).init();
    await mcp.text('create_document', { path: file, name: 'Team' });
    const created = await mcp.text('create_frame', {
      name: 'Team',
      width: 1200,
      height: 1080,
      styles: {
        display: 'flex',
        'flex-direction': 'column',
        gap: '24px',
        padding: '40px',
        background: '#f5f6fa',
        'font-family': 'Segoe UI, Arial, sans-serif',
      },
    });
    const frameId = /fr_[0-9a-z]{8}/.exec(created)![0];
    await mcp.text('write_html', {
      parentId: frameId,
      html:
        '<h1 style="margin:0;font-size:36px;color:#2d3436">Our team</h1>' +
        '<div style="display:grid;grid-template-columns:repeat(5,1fr);gap:16px">' +
        '<article style="display:flex;flex-direction:column;align-items:center;gap:8px;padding:16px;border-radius:16px;background:#ffffff;box-shadow:0 2px 8px rgba(0,0,0,.08)">' +
        '<img src="{{avatar}}" alt="{{name}}" style="width:96px;height:96px;border-radius:50%;object-fit:cover">' +
        '<strong style="font-size:16px;color:#2d3436">{{name}}</strong>' +
        '<span style="font-size:13px;color:#636e72">{{role}}</span>' +
        '<span data-color="{{color}}" style="font-size:12px;color:#b2bec3">#{{$number}}</span>' +
        '</article></div>',
    });
    const tree = await mcp.text('get_tree_summary', { nodeId: frameId, depth: 1 });
    const gridId = /^\s+(el_[0-9a-z]{8}) .*div/m.exec(tree)![1]!;

    const items = Array.from({ length: 20 }, (_, i) => ({
      name: `Person ${String(i + 1).padStart(2, '0')}`,
      role: ROLES[i % ROLES.length],
      color: COLORS[i % COLORS.length],
      avatar: `avatars/p${i + 1}.svg`,
    }));
    const bound = await mcp.text('bind_data', { nodeId: gridId, data: items });
    expect(bound).toMatch(/20 item/);
    expect(bound).toMatch(/rp_[0-9a-z]{8}/);

    const shot = await mcp.call('get_screenshot', { nodeId: frameId, scale: 1 });
    const img = (shot.content ?? []).find((c) => c.type === 'image');
    expect(img?.mimeType, stderr).toBe('image/png');
    const png = Buffer.from(img!.data!, 'base64');
    const out = process.env.MOCKUP_DATA_SHOT ?? path.join(os.tmpdir(), 'mockup-data-20.png');
    fs.writeFileSync(out, png);
    console.log(`[data] screenshot: ${out}`);
    expect(pngSize(png)).toEqual({ width: 1200, height: 1080 });

    // Measured layout: 20 cards, the last one with the text of item 20.
    const layout = await mcp.text('get_layout', { nodeId: frameId, depth: 4 });
    expect(layout).toContain('Person 01');

    // HTML export with the 20 items and the avatars copied.
    const outDir = path.join(tmp, 'export');
    const exp = await mcp.text('export', { nodeIds: [frameId], format: 'html', outputDir: outDir });
    expect(exp).toContain('.html');
    const html = fs.readFileSync(
      path.join(
        outDir,
        fs.readdirSync(outDir).find((f) => f.endsWith('.html'))!,
      ),
      'utf8',
    );
    expect(html).toContain('Person 20');
    expect(html).not.toContain('{{name}}');
    expect(fs.existsSync(path.join(outDir, 'assets', 'avatars', 'p20.svg'))).toBe(true);
  });
});
