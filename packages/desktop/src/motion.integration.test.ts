/**
 * REAL motion integration: starts headless Electron, opens a document with node animations and
 * checks, via screenshot, that `time`, `build` and `times` (filmstrip) show the animations.
 * Requires the core, server, editor and desktop builds.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDocument, createNodeFromTag, serializeDocument } from '@mockup/core';
import { Mcp, decodePng, freePort, waitHealth } from './integration-helpers.js';
import { pngSize } from './main/render-utils.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.resolve(here, '..');
const repo = path.resolve(appDir, '../..');
const req = createRequire(import.meta.url);
const electronExe = req('electron') as string;
const built = fs.existsSync(path.join(appDir, 'out/main/index.js'));
const editorReady = fs.existsSync(path.join(repo, 'packages/editor/dist/render.html'));

const FRAME_W = 600;
const FRAME_H = 300;
const BG = { r: 32, g: 64, b: 128 };

describe.skipIf(!built || !editorReady)('node animations in screenshots (integration)', () => {
  let tmp: string;
  let child: ChildProcess;
  let url: string;
  let mcp: Mcp;
  let autoFrame = '';
  let clickFrame = '';
  let stderr = '';

  const makeFrame = (name: string, build: number) => {
    const frame = createNodeFromTag('div', {
      isRoot: true,
      name,
      styles: {
        width: `${FRAME_W}px`,
        height: `${FRAME_H}px`,
        background: `rgb(${BG.r}, ${BG.g}, ${BG.b})`,
        padding: '40px',
        'box-sizing': 'border-box',
      },
      position: { x: 0, y: 0 },
      children: [
        createNodeFromTag('h1', {
          name: 'Title',
          text: 'MOTION',
          styles: { margin: '0', color: '#ffffff', 'font-size': '120px', 'font-weight': '900' },
        }),
      ],
    });
    frame.children[0]!.animations = [{ kind: 'in', preset: 'fade', ...(build ? { build } : {}) }];
    return frame;
  };

  beforeAll(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mockup-motion-'));
    const dataDir = path.join(tmp, 'data');
    fs.mkdirSync(dataDir);

    const doc = createDocument('Motion');
    const auto = makeFrame('Auto', 0);
    const click = makeFrame('Click', 1);
    doc.pages[0]!.frames.push(auto, click);
    autoFrame = auto.id;
    clickFrame = click.id;
    const file = path.join(tmp, 'motion.mockup.json');
    fs.writeFileSync(file, serializeDocument(doc), 'utf8');

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
    const r = await fetch(`${url}/api/open`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: file }),
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

  const shot = async (nodeId: string, args: Record<string, unknown>): Promise<Buffer> => {
    const r = await mcp.call('get_screenshot', { nodeId, ...args });
    expect(r.images.length, `${r.text}\n${stderr}`).toBeGreaterThan(0);
    return r.images[0]!;
  };

  /** Pixels of the title area that differ from the frame background. */
  const inkOf = (png: Buffer, x0 = 40, y0 = 40, w = 520, h = 140): number => {
    const { width, rgba } = decodePng(png);
    let n = 0;
    for (let y = y0; y < y0 + h; y++)
      for (let x = x0; x < x0 + w; x++) {
        const i = (y * width + x) * 4;
        const d =
          Math.abs(rgba[i]! - BG.r) + Math.abs(rgba[i + 1]! - BG.g) + Math.abs(rgba[i + 2]! - BG.b);
        if (d > 30) n++;
      }
    return n;
  };

  it('time: 0 hides an entrance, time: 2 shows it, no time shows the design state', async () => {
    const t0 = await shot(autoFrame, { time: 0 });
    expect(pngSize(t0)).toEqual({ width: FRAME_W, height: FRAME_H });
    expect(inkOf(t0), stderr).toBe(0);
    const t2 = await shot(autoFrame, { time: 2 });
    expect(inkOf(t2), stderr).toBeGreaterThan(500);
    const design = await shot(autoFrame, {});
    expect(inkOf(design), stderr).toBeGreaterThan(500);
  }, 120000);

  it('build: 0 hides a click build, build: 1 shows it', async () => {
    const b0 = await shot(clickFrame, { build: 0 });
    expect(inkOf(b0), stderr).toBe(0);
    const b1 = await shot(clickFrame, { build: 1 });
    expect(inkOf(b1), stderr).toBeGreaterThan(500);
  }, 120000);

  it('filmstrip: 3 cells in one image, first empty and last visible', async () => {
    const png = await shot(autoFrame, { times: [0, 0.2, 2], columns: 3 });
    const { width, height } = pngSize(png);
    // 3 frames + 2 gaps + 2 paddings (24 px each)
    expect(Math.abs(width - (3 * FRAME_W + 4 * 24))).toBeLessThanOrEqual(2);
    expect(height).toBeGreaterThanOrEqual(FRAME_H + 2 * 24);
    // cell i starts at x = 24 + i * (FRAME_W + 24), y = 24
    const cellInk = (i: number) => inkOf(png, 24 + i * (FRAME_W + 24) + 40, 24 + 40);
    expect(cellInk(0), stderr).toBe(0);
    expect(cellInk(2), stderr).toBeGreaterThan(500);
  }, 120000);
});
