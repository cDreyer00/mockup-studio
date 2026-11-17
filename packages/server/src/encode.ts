/**
 * Codificação de vídeo animado (mp4, webm, gif) a partir de quadros PNG, via ffmpeg.
 * O binário vem de `MOCKUP_FFMPEG`, do pacote `ffmpeg-static` ou do PATH.
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';

export type AnimatedFormat = 'mp4' | 'webm' | 'gif';

export const FFMPEG_MISSING =
  'O ffmpeg não foi encontrado: instale o ffmpeg (e deixe-o no PATH) ou defina MOCKUP_FFMPEG com o caminho do executável.';

/** Caminho do ffmpeg (env `MOCKUP_FFMPEG` > `ffmpeg-static` > `ffmpeg` no PATH) ou null. */
export function locateFfmpeg(): string | null {
  const env = process.env['MOCKUP_FFMPEG']?.trim();
  if (env) return env;
  try {
    const p = createRequire(import.meta.url)('ffmpeg-static') as string | null;
    if (typeof p === 'string' && fs.existsSync(p)) return p;
  } catch {
    // pacote ausente: tenta o PATH
  }
  try {
    const r = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore', windowsHide: true });
    if (!r.error && r.status === 0) return 'ffmpeg';
  } catch {
    // sem ffmpeg
  }
  return null;
}

/** Argumentos do ffmpeg para ler PNGs do stdin e gravar `out`. */
export function ffmpegArgs(format: AnimatedFormat, fps: number, out: string): string[] {
  const input = [
    '-y',
    '-hide_banner',
    '-loglevel',
    'error',
    '-f',
    'image2pipe',
    '-framerate',
    String(fps),
    '-c:v',
    'png',
    '-i',
    '-',
  ];
  if (format === 'mp4') {
    return [
      ...input,
      '-vf',
      'scale=trunc(iw/2)*2:trunc(ih/2)*2',
      '-c:v',
      'libx264',
      '-pix_fmt',
      'yuv420p',
      '-movflags',
      '+faststart',
      out,
    ];
  }
  if (format === 'webm') {
    return [
      ...input,
      '-c:v',
      'libvpx-vp9',
      '-b:v',
      '0',
      '-crf',
      '34',
      '-deadline',
      'realtime',
      '-cpu-used',
      '8',
      '-row-mt',
      '1',
      '-pix_fmt',
      'yuv420p',
      out,
    ];
  }
  return [
    ...input,
    '-vf',
    `fps=${Math.min(fps, 30)},split[a][b];[a]palettegen[p];[b][p]paletteuse`,
    '-loop',
    '0',
    out,
  ];
}

export interface EncodeOptions {
  ffmpeg: string | null;
  format: AnimatedFormat;
  fps: number;
  out: string;
  /** Produz os quadros: chame `write(png)` para cada um, em ordem. */
  produce: (write: (png: Buffer) => Promise<void>) => Promise<unknown>;
}

/** Codifica os quadros produzidos em `out`. Rejeita com mensagem clara se o ffmpeg falhar. */
export async function encodeFrames(opts: EncodeOptions): Promise<void> {
  if (!opts.ffmpeg) throw new Error(FFMPEG_MISSING);
  const fps = opts.format === 'gif' ? Math.min(opts.fps, 30) : opts.fps;
  const child = spawn(opts.ffmpeg, ffmpegArgs(opts.format, fps, opts.out), {
    stdio: ['pipe', 'ignore', 'pipe'],
    windowsHide: true,
  });
  let stderr = '';
  child.stderr.on('data', (d: Buffer) => {
    stderr = (stderr + d.toString('utf8')).slice(-4000);
  });
  let spawnError: Error | null = null;
  let stdinError: Error | null = null;
  const exited = new Promise<number | null>((resolve) => {
    child.on('error', (e) => {
      spawnError = e;
      resolve(null);
    });
    child.on('close', (code) => resolve(code));
  });
  child.stdin.on('error', (e) => {
    stdinError = e;
  });

  const write = async (png: Buffer): Promise<void> => {
    if (spawnError || stdinError || child.stdin.destroyed) return;
    if (!child.stdin.write(png)) {
      await new Promise<void>((resolve) => {
        const done = () => {
          child.stdin.off('drain', done);
          child.stdin.off('close', done);
          resolve();
        };
        child.stdin.once('drain', done);
        child.stdin.once('close', done);
      });
    }
  };

  let produceError: unknown = null;
  try {
    await opts.produce(write);
  } catch (e) {
    produceError = e;
  }
  if (!child.stdin.destroyed) child.stdin.end();
  if (produceError) child.kill();
  const code = await exited;
  if (produceError) throw produceError;
  const err = spawnError as Error | null;
  if (err) {
    const missing = (err as NodeJS.ErrnoException).code === 'ENOENT';
    throw new Error(missing ? FFMPEG_MISSING : `Falha ao iniciar o ffmpeg: ${err.message}`);
  }
  if (code !== 0) {
    const detail = stderr.trim() || (stdinError as Error | null)?.message || `código ${code}`;
    throw new Error(`O ffmpeg falhou ao codificar ${opts.format}: ${detail}`);
  }
}
