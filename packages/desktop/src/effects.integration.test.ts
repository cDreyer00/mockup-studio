/**
 * Integração REAL dos efeitos: sobe o Electron headless, cria um frame com um efeito WebGL
 * (`mesh-gradient`) por MCP, verifica que o screenshot não é vazio (o WebGL desenhou), que o tempo
 * muda a imagem e que a exportação webm (ffmpeg) gera um vídeo de 2 s.
 * Requer os builds de core, server, editor e desktop.
 */
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Mcp, colorStats, freePort, waitHealth } from './integration-helpers.js';
import { pngSize } from './main/render-utils.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.resolve(here, '..');
const repo = path.resolve(appDir, '../..');
const req = createRequire(import.meta.url);
const electronExe = req('electron') as string;
const built = fs.existsSync(path.join(appDir, 'out/main/index.js'));
const editorReady = fs.existsSync(path.join(repo, 'packages/editor/dist/render.html'));

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
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
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
