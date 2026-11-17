/**
 * Integração REAL de mídia: sobe o Electron headless e confere, pelo screenshot e pela exportação,
 * vídeo com poster e `time`, ilha Three.js, Lottie e Rive vindos de `assets/` e export gif e mp4.
 * Requer os builds de core, server, editor e desktop.
 */
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Mcp, colorStats, decodePng, freePort, waitHealth } from './integration-helpers.js';
import { pngSize } from './main/render-utils.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.resolve(here, '..');
const repo = path.resolve(appDir, '../..');
const req = createRequire(import.meta.url);
const electronExe = req('electron') as string;
const ffmpeg = req('ffmpeg-static') as string;
const built = fs.existsSync(path.join(appDir, 'out/main/index.js'));
const editorReady = fs.existsSync(path.join(repo, 'packages/editor/dist/render.html'));

type Rgb = [number, number, number];

/** Média RGB de um quadrado `size` x `size` no centro da imagem. */
function centerColor(png: Buffer, size = 20): Rgb {
  const { width, height, rgba } = decodePng(png);
  const x0 = Math.floor(width / 2 - size / 2);
  const y0 = Math.floor(height / 2 - size / 2);
  const sum: Rgb = [0, 0, 0];
  for (let y = y0; y < y0 + size; y++) {
    for (let x = x0; x < x0 + size; x++) {
      const i = (y * width + x) * 4;
      sum[0] += rgba[i]!;
      sum[1] += rgba[i + 1]!;
      sum[2] += rgba[i + 2]!;
    }
  }
  const n = size * size;
  return [Math.round(sum[0] / n), Math.round(sum[1] / n), Math.round(sum[2] / n)];
}

const isRed = (c: Rgb): boolean => c[0] > 180 && c[1] < 90 && c[2] < 90;
const isGreen = (c: Rgb): boolean => c[1] > 180 && c[0] < 90 && c[2] < 90;
const isBlue = (c: Rgb): boolean => c[2] > 180 && c[0] < 90 && c[1] < 90;
const isOrange = (c: Rgb): boolean => c[0] > 200 && c[1] > 90 && c[1] < 170 && c[2] < 60;

/** Texto que `ffmpeg -i` imprime no stderr (a execução sem destino sai com erro). */
function ffmpegInfo(file: string): string {
  try {
    execFileSync(ffmpeg, ['-i', file], { encoding: 'utf8', stdio: 'pipe' });
  } catch (e) {
    return String((e as { stderr?: string }).stderr ?? '');
  }
  return '';
}

function durationSeconds(file: string): number {
  const m = /Duration: (\d+):(\d+):(\d+(?:\.\d+)?)/.exec(ffmpegInfo(file));
  if (!m) return NaN;
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
}

const transform = {
  ty: 'tr',
  p: { a: 0, k: [0, 0] },
  a: { a: 0, k: [0, 0] },
  s: { a: 0, k: [100, 100] },
  r: { a: 0, k: 0 },
  o: { a: 0, k: 100 },
};

/** Lottie mínimo: retângulo 200x200 preenchido de verde puro, 30 fps, 60 quadros. */
const LOTTIE_GREEN = {
  v: '5.7.4',
  fr: 30,
  ip: 0,
  op: 60,
  w: 200,
  h: 200,
  nm: 'retangulo',
  ddd: 0,
  assets: [],
  layers: [
    {
      ddd: 0,
      ind: 1,
      ty: 4,
      nm: 'forma',
      sr: 1,
      ks: {
        o: { a: 0, k: 100 },
        r: { a: 0, k: 0 },
        p: { a: 0, k: [100, 100, 0] },
        a: { a: 0, k: [0, 0, 0] },
        s: { a: 0, k: [100, 100, 100] },
      },
      ao: 0,
      shapes: [
        {
          ty: 'gr',
          nm: 'grupo',
          it: [
            {
              ty: 'rc',
              d: 1,
              s: { a: 0, k: [200, 200] },
              p: { a: 0, k: [0, 0] },
              r: { a: 0, k: 0 },
            },
            { ty: 'fl', c: { a: 0, k: [0, 1, 0, 1] }, o: { a: 0, k: 100 }, r: 1 },
            transform,
          ],
        },
      ],
      ip: 0,
      op: 60,
      st: 0,
      bm: 0,
    },
  ],
};

const varuint = (n: number): number[] => {
  const out: number[] = [];
  do {
    let b = n & 0x7f;
    n >>>= 7;
    if (n) b |= 0x80;
    out.push(b);
  } while (n);
  return out;
};
const f32 = (v: number): number[] => [...new Uint8Array(new Float32Array([v]).buffer)];
const u32 = (v: number): number[] => [v & 255, (v >>> 8) & 255, (v >>> 16) & 255, (v >>> 24) & 255];
const prop = (key: number, ...value: number[]): number[] => [...varuint(key), ...value];
const obj = (type: number, ...props: number[][]): number[] => [
  ...varuint(type),
  ...props.flat(),
  0,
];

/**
 * `.riv` mínimo (formato 7.0): Backboard, Artboard 200x200 e um Shape com Rectangle 200x200 e
 * Fill/SolidColor. `color` é ARGB.
 */
function buildRiv(color: number): Buffer {
  return Buffer.from([
    ...Buffer.from('RIVE'),
    ...varuint(7),
    ...varuint(0),
    ...varuint(0),
    0, // ToC vazia: só propriedades conhecidas
    ...obj(23), // Backboard
    ...obj(
      1, // Artboard
      prop(4, ...varuint(4), ...Buffer.from('Main')),
      prop(7, ...f32(200)),
      prop(8, ...f32(200)),
    ),
    ...obj(3, prop(5, ...varuint(0)), prop(13, ...f32(100)), prop(14, ...f32(100))), // Shape
    ...obj(7, prop(5, ...varuint(1)), prop(20, ...f32(200)), prop(21, ...f32(200))), // Rectangle
    ...obj(20, prop(5, ...varuint(1))), // Fill
    ...obj(18, prop(5, ...varuint(3)), prop(37, ...u32(color))), // SolidColor
  ]);
}

describe.skipIf(!built || !editorReady)(
  'Mídia: vídeo, Three.js, Lottie, Rive e export (integração)',
  () => {
    let tmp: string;
    let child: ChildProcess;
    let url: string;
    let mcp: Mcp;
    let stderr = '';

    beforeAll(async () => {
      tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mockup-media-'));
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
        body: JSON.stringify({ name: 'Media', path: path.join(tmp, 'media.mockup.json') }),
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

    const idOf = (text: string, prefix: string): string => {
      const id = new RegExp(`\\b(${prefix}_[A-Za-z0-9]+)`).exec(text)?.[1] ?? '';
      expect(id, text).not.toBe('');
      return id;
    };

    /** Frame novo; o nó de mídia entra com 100% x 100%, então o centro do frame é o da mídia. */
    const newFrame = async (name: string, w: number, h: number): Promise<string> => {
      const r = await mcp.call('create_frame', { name, width: w, height: h });
      return idOf(r.text, 'fr');
    };

    const shot = async (frame: string, args: Record<string, unknown> = {}): Promise<Buffer> => {
      const r = await mcp.call('get_screenshot', { nodeId: frame, ...args });
      expect(r.images.length, `${r.text}\n${stderr}`).toBeGreaterThan(0);
      return r.images[0]!;
    };

    const fullSize = { width: '100%', height: '100%' };

    describe('vídeo', () => {
      let video: string;
      let poster: string;

      beforeAll(() => {
        video = path.join(tmp, 'cores.mp4');
        poster = path.join(tmp, 'capa.png');
        const lavfi = (c: string): string[] => [
          '-f',
          'lavfi',
          '-i',
          `color=c=${c}:s=320x180:d=1:r=30`,
        ];
        execFileSync(
          ffmpeg,
          [
            '-y',
            ...lavfi('red'),
            ...lavfi('blue'),
            ...['-filter_complex', '[0:v][1:v]concat=n=2:v=1:a=0,format=yuv420p'],
            ...['-c:v', 'libx264', '-g', '5', '-pix_fmt', 'yuv420p', video],
          ],
          { stdio: 'pipe' },
        );
        execFileSync(
          ffmpeg,
          [
            ...['-y', '-f', 'lavfi', '-i', 'color=c=0x00ff00:s=320x180'],
            ...['-frames:v', '1', '-pix_fmt', 'rgb24', poster],
          ],
          { stdio: 'pipe' },
        );
      }, 60000);

      it('com poster: sem time mostra o poster; time 0.5 é vermelho e 1.5 é azul', async () => {
        const frame = await newFrame('Video poster', 320, 180);
        const r = await mcp.call('insert_video', {
          parentId: frame,
          source: video,
          poster,
          styles: fullSize,
        });
        expect(r.text).toMatch(/assets\/videos\//);
        const none = centerColor(await shot(frame));
        expect(isGreen(none), `sem time: ${none}\n${stderr}`).toBe(true);
        const red = centerColor(await shot(frame, { time: 0.5 }));
        expect(isRed(red), `time 0.5: ${red}\n${stderr}`).toBe(true);
        const blue = centerColor(await shot(frame, { time: 1.5 }));
        expect(isBlue(blue), `time 1.5: ${blue}\n${stderr}`).toBe(true);
      }, 150000);

      it('sem poster: sem time usa o video.time (1.5 s azul, 0.2 s vermelho)', async () => {
        const frame = await newFrame('Video sem poster', 320, 180);
        const r = await mcp.call('insert_video', {
          parentId: frame,
          source: video,
          styles: fullSize,
        });
        const id = idOf(r.text, 'vd');
        await mcp.call('update_media', { nodeId: id, time: 1.5 });
        const blue = centerColor(await shot(frame));
        expect(isBlue(blue), `video.time 1.5: ${blue}\n${stderr}`).toBe(true);
        await mcp.call('update_media', { nodeId: id, time: 0.2 });
        const red = centerColor(await shot(frame));
        expect(isRed(red), `video.time 0.2: ${red}\n${stderr}`).toBe(true);
      }, 150000);
    });

    it('ilha Three.js: desenha um mesh colorido sobre o fundo limpo', async () => {
      const frame = await newFrame('Three', 400, 300);
      const code = `
const scene = new THREE.Scene();
const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 10);
camera.position.z = 5;
renderer.setClearColor(0x2040ff, 1);
const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({ color: 0xff8000 }));
scene.add(mesh);
return { scene, camera, update(t) {} };
`;
      await mcp.call('insert_three', { parentId: frame, code, styles: fullSize });
      const png = await shot(frame);
      const c = centerColor(png);
      expect(isOrange(c), `centro ${c}\n${stderr}`).toBe(true);
      const { width, rgba } = decodePng(png);
      const i = (5 * width + 5) * 4; // canto: cor de limpeza (azul)
      expect(rgba[i + 2], `canto ${[rgba[i], rgba[i + 1], rgba[i + 2]]}`).toBeGreaterThan(200);
      const s = colorStats(png);
      expect(s.distinct).toBeGreaterThanOrEqual(2);
      expect(s.std).toBeGreaterThan(5);
    }, 120000);

    it('Lottie de assets/: o screenshot mostra a cor do retângulo', async () => {
      const file = path.join(tmp, 'verde.json');
      fs.writeFileSync(file, JSON.stringify(LOTTIE_GREEN));
      const frame = await newFrame('Lottie', 200, 200);
      const r = await mcp.call('insert_embed', { parentId: frame, src: file, styles: fullSize });
      expect(r.text).toMatch(/assets\/lottie\//);
      const c = centerColor(await shot(frame, { time: 0.5 }));
      expect(isGreen(c), `centro ${c}\n${stderr}`).toBe(true);
    }, 120000);

    it('Rive de assets/: o screenshot mostra a cor do retângulo', async () => {
      const file = path.join(tmp, 'laranja.riv');
      fs.writeFileSync(file, buildRiv(0xffff8000));
      const frame = await newFrame('Rive', 200, 200);
      const r = await mcp.call('insert_embed', { parentId: frame, src: file, styles: fullSize });
      expect(r.text).toMatch(/assets\/rive\//);
      const c = centerColor(await shot(frame, { time: 0.5 }));
      expect(isOrange(c), `centro ${c}\n${stderr}`).toBe(true);
    }, 120000);

    it('Rive de assets/ com bytes inválidos não trava o screenshot', async () => {
      const file = path.join(tmp, 'quebrado.riv');
      fs.writeFileSync(
        file,
        Buffer.concat([Buffer.from('RIVE'), Buffer.from([255, 1, 2, 3, 4, 5])]),
      );
      const frame = await newFrame('Rive quebrado', 200, 200);
      await mcp.call('insert_embed', { parentId: frame, src: file, styles: fullSize });
      const png = await shot(frame, { time: 0.5 });
      expect(pngSize(png)).toEqual({ width: 200, height: 200 });
    }, 120000);

    describe('export animado curto', () => {
      let frame: string;
      beforeAll(async () => {
        frame = await newFrame('Export', 320, 240);
        await mcp.call('add_effect', { nodeId: frame, kind: 'mesh-gradient' });
      }, 60000);

      const exportAs = async (format: 'gif' | 'mp4'): Promise<string> => {
        const outDir = path.join(tmp, `out-${format}`);
        fs.mkdirSync(outDir);
        const r = await mcp.call('export', {
          nodeIds: [frame],
          format,
          duration: 1,
          fps: 10,
          outputDir: outDir,
        });
        const file = fs.readdirSync(outDir).find((f) => f.endsWith(`.${format}`));
        expect(file, `${r.text}\n${stderr}`).toBeTruthy();
        return path.join(outDir, file!);
      };

      it('gif de 1 s: assinatura GIF89a e duração ≈ 1 s', async () => {
        const file = await exportAs('gif');
        expect(fs.readFileSync(file).subarray(0, 6).toString('ascii')).toBe('GIF89a');
        const d = durationSeconds(file);
        expect(d, ffmpegInfo(file)).toBeGreaterThanOrEqual(0.8);
        expect(d).toBeLessThanOrEqual(1.3);
      }, 180000);

      it('mp4 de 1 s: ftyp nos bytes 4..8 e duração ≈ 1 s', async () => {
        const file = await exportAs('mp4');
        expect(fs.readFileSync(file).subarray(4, 8).toString('ascii')).toBe('ftyp');
        const d = durationSeconds(file);
        expect(d, ffmpegInfo(file)).toBeGreaterThanOrEqual(0.8);
        expect(d).toBeLessThanOrEqual(1.3);
      }, 180000);
    });
  },
);
