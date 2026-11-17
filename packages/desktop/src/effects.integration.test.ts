/**
 * Integração REAL dos efeitos: sobe o Electron headless, cria um frame com um efeito WebGL
 * (`mesh-gradient`) por MCP, verifica que o screenshot não é vazio (o WebGL desenhou), que o tempo
 * muda a imagem e que a exportação webm (ffmpeg) gera um vídeo de 2 s.
 * Requer os builds de core, server, editor e desktop.
 */
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pngSize } from './main/render-utils.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.resolve(here, '..');
const repo = path.resolve(appDir, '../..');
const req = createRequire(import.meta.url);
const electronExe = req('electron') as string;
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

/** Cliente MCP mínimo (JSON-RPC por HTTP; respostas JSON ou SSE). */
class Mcp {
  private sessionId: string | null = null;
  private id = 0;
  constructor(private base: string) {}

  private async rpc(method: string, params: unknown, notify = false): Promise<unknown> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
    };
    if (this.sessionId) headers['mcp-session-id'] = this.sessionId;
    const body = notify
      ? { jsonrpc: '2.0', method, params }
      : { jsonrpc: '2.0', id: ++this.id, method, params };
    const res = await fetch(`${this.base}/mcp`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(120000),
    });
    this.sessionId = res.headers.get('mcp-session-id') ?? this.sessionId;
    const text = await res.text();
    if (notify) return null;
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
      clientInfo: { name: 'mockup-effects-test', version: '0.0.0' },
    });
    await this.rpc('notifications/initialized', {}, true);
    return this;
  }

  /** Chama a ferramenta; devolve o texto e as imagens da resposta. Lança se `isError`. */
  async call(
    name: string,
    args: Record<string, unknown>,
  ): Promise<{ text: string; images: Buffer[] }> {
    const r = (await this.rpc('tools/call', { name, arguments: args })) as {
      content?: { type: string; text?: string; data?: string }[];
      isError?: boolean;
    };
    const content = r.content ?? [];
    const text = content.map((c) => c.text ?? '').join('\n');
    if (r.isError) throw new Error(`${name}: ${text}`);
    const images = content
      .filter((c) => c.type === 'image' && c.data)
      .map((c) => Buffer.from(c.data!, 'base64'));
    return { text, images };
  }
}

/** Decodificador PNG mínimo: 8 bits, RGB ou RGBA, sem entrelaçamento. Devolve RGBA. */
function decodePng(buf: Buffer): { width: number; height: number; rgba: Uint8Array } {
  const { width, height } = pngSize(buf);
  let pos = 8;
  let colorType = -1;
  const idat: Buffer[] = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('ascii', pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') {
      expect(data[8], 'profundidade de bits').toBe(8);
      colorType = data[9]!;
      expect(data[12], 'entrelaçamento').toBe(0);
    } else if (type === 'IDAT') idat.push(data);
    pos += 12 + len;
  }
  if (colorType !== 2 && colorType !== 6) throw new Error(`colorType ${colorType} não suportado`);
  const bpp = colorType === 6 ? 4 : 3;
  const stride = width * bpp;
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const out = new Uint8Array(height * stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]!;
    const src = y * (stride + 1) + 1;
    const dst = y * stride;
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? out[dst + x - bpp]! : 0;
      const b = y > 0 ? out[dst - stride + x]! : 0;
      const c = x >= bpp && y > 0 ? out[dst - stride + x - bpp]! : 0;
      let v = raw[src + x]!;
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      out[dst + x] = v & 255;
    }
  }
  if (bpp === 4) return { width, height, rgba: out };
  const rgba = new Uint8Array(width * height * 4);
  for (let i = 0, j = 0; i < out.length; i += 3, j += 4) {
    rgba[j] = out[i]!;
    rgba[j + 1] = out[i + 1]!;
    rgba[j + 2] = out[i + 2]!;
    rgba[j + 3] = 255;
  }
  return { width, height, rgba };
}

/** Cores distintas (amostra em grade) e desvio padrão da luminância. */
function colorStats(png: Buffer): { distinct: number; std: number } {
  const { width, height, rgba } = decodePng(png);
  const colors = new Set<number>();
  const lum: number[] = [];
  for (let y = 0; y < height; y += 7) {
    for (let x = 0; x < width; x += 7) {
      const i = (y * width + x) * 4;
      colors.add((rgba[i]! << 16) | (rgba[i + 1]! << 8) | rgba[i + 2]!);
      lum.push(0.299 * rgba[i]! + 0.587 * rgba[i + 1]! + 0.114 * rgba[i + 2]!);
    }
  }
  const mean = lum.reduce((a, b) => a + b, 0) / lum.length;
  const std = Math.sqrt(lum.reduce((a, b) => a + (b - mean) ** 2, 0) / lum.length);
  return { distinct: colors.size, std };
}

describe.skipIf(!built || !editorReady)('Efeitos WebGL e exportação de vídeo (integração)', () => {
  let tmp: string;
  let child: ChildProcess;
  let url: string;
  let mcp: Mcp;
  let frame: string;
  let stderr = '';

  beforeAll(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mockup-effects-'));
    const dataDir = path.join(tmp, 'data');
    fs.mkdirSync(dataDir);
    const port = await freePort();
    url = `http://127.0.0.1:${port}`;
    const env: NodeJS.ProcessEnv = { ...process.env, MOCKUP_DATA_DIR: dataDir };
    delete env.ELECTRON_RUN_AS_NODE;
    child = spawn(
      electronExe,
      [appDir, '--headless', '--port', String(port), '--data-dir', dataDir],
      { env, stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true },
    );
    child.stderr!.on('data', (d: Buffer) => (stderr += d.toString()));
    await waitHealth(url, child);
    const r = await fetch(`${url}/api/new`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Fx', path: path.join(tmp, 'fx.mockup.json') }),
    });
    expect(r.ok, await r.clone().text()).toBe(true);
    mcp = await new Mcp(url).init();
  }, 90000);

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

  const shot = async (args: Record<string, unknown>): Promise<Buffer> => {
    const r = await mcp.call('get_screenshot', { nodeId: frame, ...args });
    expect(r.images.length, `${r.text}\n${stderr}`).toBeGreaterThan(0);
    return r.images[0]!;
  };

  it('mesh-gradient: o screenshot não é vazio (WebGL desenhou)', async () => {
    const created = await mcp.call('create_frame', { name: 'Fx', width: 800, height: 600 });
    frame = /\b(fr_[A-Za-z0-9]+)/.exec(created.text)?.[1] ?? '';
    expect(frame, created.text).not.toBe('');
    await mcp.call('add_effect', { nodeId: frame, kind: 'mesh-gradient' });
    const png = await shot({});
    expect(pngSize(png)).toEqual({ width: 800, height: 600 });
    const s = colorStats(png);
    expect(s.distinct, stderr).toBeGreaterThanOrEqual(50);
    expect(s.std, stderr).toBeGreaterThan(5);
  }, 90000);

  it('time: 2 difere de time: 0', async () => {
    const a = await shot({ time: 0 });
    const b = await shot({ time: 2 });
    expect(a.equals(b)).toBe(false);
  }, 90000);

  it('export webm de 2 s com ffmpeg', async () => {
    const outDir = path.join(tmp, 'out');
    fs.mkdirSync(outDir);
    const r = await mcp.call('export', {
      nodeIds: [frame],
      format: 'webm',
      duration: 2,
      fps: 15,
      outputDir: outDir,
    });
    const file = fs.readdirSync(outDir).find((f) => f.endsWith('.webm'));
    expect(file, `${r.text}\n${stderr}`).toBeTruthy();
    const full = path.join(outDir, file!);
    expect(fs.readFileSync(full).subarray(0, 4).toString('hex')).toBe('1a45dfa3');
    const ffmpeg = req('ffmpeg-static') as string;
    let info = '';
    try {
      execFileSync(ffmpeg, ['-i', full], { encoding: 'utf8', stdio: 'pipe' });
    } catch (e) {
      // `ffmpeg -i` sem saída sai com erro; a informação vem no stderr
      info = String((e as { stderr?: string }).stderr ?? '');
    }
    expect(info).toMatch(/Duration: 00:00:02/);
  }, 180000);
});
