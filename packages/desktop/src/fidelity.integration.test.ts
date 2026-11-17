/**
 * REAL fidelity: with the app open (window), the engine's screenshot (`/render/...png`) must be
 * identical to what the canvas shows (same embedded fonts and assets). Launches Electron with
 * Playwright, crops the frame on the canvas and compares pixel by pixel with the engine's PNG.
 * Requires `npm run build` (desktop and editor) first.
 */
import fs from 'node:fs';
import { createRequire } from 'node:module';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';
import { _electron, type ElectronApplication, type Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pngSize } from './main/render-utils.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.resolve(here, '..');
const repo = path.resolve(appDir, '../..');
const electronExe = createRequire(import.meta.url)('electron') as string;
const built = fs.existsSync(path.join(appDir, 'out/main/index.js'));
const editorReady = fs.existsSync(path.join(repo, 'packages/editor/dist/render.html'));

const windir = process.env.WINDIR ?? 'C:\\Windows';
const fontSource = [
  path.join(windir, 'Fonts', 'segoeui.ttf'),
  path.join(windir, 'Fonts', 'arial.ttf'),
  '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
  '/System/Library/Fonts/Supplemental/Arial.ttf',
].find((f) => fs.existsSync(f));

const FAMILY = 'FidelitySans';
const FRAME_ID = 'fr_fidelity1';
const DOC_ID = 'doc_fidelity1';

const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
/** Valid RGBA PNG with a colored gradient (no dependencies). */
function makePng(w: number, h: number): Buffer {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    const o = y * (w * 4 + 1);
    raw[o] = 0;
    for (let x = 0; x < w; x++) {
      const p = o + 1 + x * 4;
      raw[p] = Math.round((x / (w - 1)) * 255);
      raw[p + 1] = Math.round((y / (h - 1)) * 255);
      raw[p + 2] = 160;
      raw[p + 3] = 255;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function node(
  id: string,
  type: string,
  tag: string,
  style: Record<string, string>,
  extra: Record<string, unknown> = {},
) {
  return {
    id,
    type,
    name: id,
    tag,
    attrs: {},
    style,
    children: [],
    locked: false,
    hidden: false,
    ...extra,
  };
}

function makeDocument() {
  const frame = node(
    FRAME_ID,
    'frame',
    'div',
    {
      width: '600px',
      height: '400px',
      display: 'flex',
      'flex-direction': 'column',
      gap: '16px',
      padding: '24px',
      'background-color': '#fdf6e3',
      color: '#1b2733',
      'font-family': `"${FAMILY}", serif`,
      border: '4px solid #6c5ce7',
      'border-radius': '24px',
      'box-shadow': '0 12px 32px rgba(0, 0, 0, 0.45)',
    },
    {
      position: { x: 120, y: 80 },
      children: [
        node(
          'el_fid_title',
          'text',
          'h1',
          { margin: '0', 'font-size': '36px', 'font-weight': '700', 'letter-spacing': '0.5px' },
          { text: 'Canvas fidelity' },
        ),
        node(
          'el_fid_body',
          'text',
          'p',
          { margin: '0', 'font-size': '16px', 'line-height': '1.5' },
          { text: 'Text with the embedded document font, to compare with the engine.' },
        ),
        node(
          'el_fid_img',
          'image',
          'img',
          { width: '160px', height: '100px', 'border-radius': '12px', 'object-fit': 'cover' },
          { src: 'images/gradiente.png', attrs: { alt: 'gradiente' } },
        ),
        node(
          'el_fid_btn',
          'element',
          'button',
          {
            padding: '12px 20px',
            'background-color': '#6c5ce7',
            color: '#ffffff',
            border: '2px solid #3b2fb0',
            'border-radius': '10px',
            'box-shadow': '0 4px 10px rgba(59, 47, 176, 0.5)',
            'font-size': '18px',
            width: '200px',
          },
          { children: [node('el_fid_btn_t', 'text', 'span', {}, { text: 'Button inheriting' })] },
        ),
      ],
    },
  );
  return {
    version: 1,
    id: DOC_ID,
    name: 'Fidelity',
    tokens: {},
    fonts: [{ family: FAMILY, source: 'file', files: ['fonts/fidelidade.ttf'], weights: [400] }],
    meta: { createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' },
    pages: [{ id: 'pg_fidelity1', name: 'Page', background: '#1e1e1e', frames: [frame] }],
  };
}

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

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

describe.skipIf(!built || !editorReady || !fontSource)(
  'canvas × screenshot fidelity (integration)',
  () => {
    let tmp: string;
    let app: ElectronApplication | undefined;
    let pid: number | undefined;
    let page: Page;
    let port: number;

    beforeAll(async () => {
      tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mockup-fidelity-'));
      const dataDir = path.join(tmp, 'data');
      fs.mkdirSync(path.join(tmp, 'assets', 'fonts'), { recursive: true });
      fs.mkdirSync(path.join(tmp, 'assets', 'images'));
      fs.mkdirSync(dataDir);
      fs.copyFileSync(fontSource!, path.join(tmp, 'assets', 'fonts', 'fidelidade.ttf'));
      fs.writeFileSync(path.join(tmp, 'assets', 'images', 'gradiente.png'), makePng(64, 40));
      const file = path.join(tmp, 'fidelidade.mockup.json');
      fs.writeFileSync(file, JSON.stringify(makeDocument(), null, 2));

      port = await freePort();
      const env: Record<string, string> = {};
      for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
      delete env.ELECTRON_RUN_AS_NODE;
      env.MOCKUP_DATA_DIR = dataDir;
      app = await _electron.launch({
        executablePath: electronExe,
        args: [
          appDir,
          '--force-device-scale-factor=1',
          '--port',
          String(port),
          '--data-dir',
          dataDir,
          file,
        ],
        env,
        timeout: 60000,
      });
      pid = app.process().pid;

      // 2 windows: the main one and the render one (off-screen, render.html)
      const end = Date.now() + 60000;
      let main: Page | undefined;
      while (!main && Date.now() < end) {
        main = app.windows().find((w) => !w.url().includes('render.html') && w.url() !== '');
        if (!main) await new Promise((r) => setTimeout(r, 250));
      }
      if (!main) throw new Error('The main app window did not show up');
      page = main;

      await app.evaluate(({ BrowserWindow }) => {
        for (const w of BrowserWindow.getAllWindows()) {
          if (!w.webContents.getURL().includes('render.html')) {
            w.setSize(1600, 1000);
            w.center();
          }
        }
      });
    });

    afterAll(async () => {
      try {
        await app?.evaluate(({ app: a }) => a.exit(0)).catch(() => undefined);
      } catch {
        /* best effort */
      }
      if (pid && process.platform === 'win32') {
        const { spawn } = await import('node:child_process');
        await new Promise((r) => {
          const k = spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' });
          k.once('exit', r);
          k.once('error', r);
        });
      } else if (pid) {
        try {
          process.kill(pid, 'SIGKILL');
        } catch {
          /* already exited */
        }
      }
      try {
        fs.rmSync(tmp, { recursive: true, force: true });
      } catch {
        /* best effort */
      }
    });

    const frameBox = (): Promise<{ frame: Box; canvas: Box }> =>
      page.evaluate((id) => {
        const f = document.querySelector(`[data-node-id="${id}"]`)!.getBoundingClientRect();
        const c = document.querySelector('[data-testid="canvas"]')!.getBoundingClientRect();
        const r = (b: DOMRect) => ({ x: b.x, y: b.y, width: b.width, height: b.height });
        return { frame: r(f), canvas: r(c) };
      }, FRAME_ID);

    it('the canvas frame is identical to /render/<doc>/<frame>.png', async () => {
      await page.waitForSelector(`[data-node-id="${FRAME_ID}"]`, { timeout: 60000 });

      // zoom 100% (Shift+0) and the frame near the top-left corner, using DOM events only
      await page.evaluate(() => {
        window.dispatchEvent(
          new KeyboardEvent('keydown', { key: ')', code: 'Digit0', shiftKey: true, bubbles: true }),
        );
      });
      await page.waitForTimeout(300);
      for (let i = 0; i < 3; i++) {
        const { frame, canvas } = await frameBox();
        const dx = frame.x - (canvas.x + 40);
        const dy = frame.y - (canvas.y + 40);
        await page.evaluate(
          ([x, y]) => {
            document
              .querySelector('[data-testid="canvas"]')!
              .dispatchEvent(
                new WheelEvent('wheel', { deltaX: x, deltaY: y, bubbles: true, cancelable: true }),
              );
          },
          [dx, dy] as const,
        );
        await page.waitForTimeout(250);
      }
      await app!.evaluate(({ BrowserWindow }) => {
        const w = BrowserWindow.getAllWindows().find(
          (x) => !x.webContents.getURL().includes('render.html'),
        );
        w?.webContents.sendInputEvent({ type: 'mouseMove', x: 5, y: 5 });
      });
      await page.waitForTimeout(300);

      const { frame, canvas } = await frameBox();
      expect(frame.width).toBeCloseTo(600 + 0, 0); // 100%: the frame measures 600x400 (border included)
      expect(frame.height).toBeCloseTo(400, 0);
      expect(frame.x).toBeGreaterThanOrEqual(canvas.x);
      expect(frame.y).toBeGreaterThanOrEqual(canvas.y);
      expect(frame.x + frame.width).toBeLessThanOrEqual(canvas.x + canvas.width);
      expect(frame.y + frame.height).toBeLessThanOrEqual(canvas.y + canvas.height);

      // the embedded font is in use on the canvas
      const fontState = await page.evaluate(
        async ([id, family]) => {
          await document.fonts.ready;
          const faces = Array.from(document.fonts as unknown as Iterable<FontFace>).filter(
            (f) => f.family.replace(/"/g, '') === family,
          );
          const el = document.querySelector(`[data-node-id="${id}"]`)!;
          return {
            statuses: faces.map((f) => f.status),
            computed: getComputedStyle(el.querySelector('h1')!).fontFamily,
            btn: getComputedStyle(el.querySelector('button')!).fontFamily,
          };
        },
        [FRAME_ID, FAMILY] as const,
      );
      expect(fontState.statuses.length).toBeGreaterThan(0);
      expect(fontState.statuses).toContain('loaded');
      expect(fontState.computed).toContain(FAMILY);
      expect(fontState.btn).toContain(FAMILY);

      const canvasPng = await page.screenshot({
        clip: {
          x: Math.round(frame.x),
          y: Math.round(frame.y),
          width: Math.round(frame.width),
          height: Math.round(frame.height),
        },
      });

      const res = await fetch(`http://127.0.0.1:${port}/render/${DOC_ID}/${FRAME_ID}.png`, {
        signal: AbortSignal.timeout(60000),
      });
      expect(res.status).toBe(200);
      const renderPng = Buffer.from(await res.arrayBuffer());
      const a = pngSize(canvasPng);
      const b = pngSize(renderPng);
      expect(b).toEqual(a);
      expect(b).toEqual({ width: 600, height: 400 });

      const diff = await page.evaluate(
        async ([x, y]) => {
          const load = async (b64: string) => {
            const bin = atob(b64);
            const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
            const bmp = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
            const cv = document.createElement('canvas');
            cv.width = bmp.width;
            cv.height = bmp.height;
            const ctx = cv.getContext('2d')!;
            ctx.drawImage(bmp, 0, 0);
            return ctx.getImageData(0, 0, bmp.width, bmp.height);
          };
          const [p, q] = await Promise.all([load(x), load(y)]);
          if (p.width !== q.width || p.height !== q.height)
            return { size: false, bad: -1, total: 0 };
          let bad = 0;
          for (let i = 0; i < p.data.length; i += 4) {
            for (let k = 0; k < 4; k++) {
              if (Math.abs(p.data[i + k]! - q.data[i + k]!) > 8) {
                bad++;
                break;
              }
            }
          }
          return { size: true, bad, total: p.width * p.height };
        },
        [canvasPng.toString('base64'), renderPng.toString('base64')] as const,
      );
      expect(diff.size).toBe(true);
      console.log(`fidelity: ${a.width}x${a.height}, ${diff.bad} of ${diff.total} pixels differ`);
      expect(diff.bad / diff.total).toBeLessThanOrEqual(0.005);
    });
  },
);
