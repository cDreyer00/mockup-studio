/**
 * Animated video encoding (mp4, webm, gif) from PNG frames, via ffmpeg.
 * The binary comes from `MOCKUP_FFMPEG`, the `ffmpeg-static` package or the PATH.
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';

export type AnimatedFormat = 'mp4' | 'webm' | 'gif';

export const FFMPEG_MISSING =
  'ffmpeg was not found: install ffmpeg (and keep it on the PATH) or set MOCKUP_FFMPEG to the executable path.';

/** Path to ffmpeg (env `MOCKUP_FFMPEG` > `ffmpeg-static` > `ffmpeg` on the PATH) or null. */
export function locateFfmpeg(): string | null {
  const env = process.env['MOCKUP_FFMPEG']?.trim();
  if (env) return env;
  try {
    const p = createRequire(import.meta.url)('ffmpeg-static') as string | null;
    if (typeof p === 'string' && fs.existsSync(p)) return p;
  } catch {
    // package missing: try the PATH
  }
  try {
    const r = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore', windowsHide: true });
    if (!r.error && r.status === 0) return 'ffmpeg';
  } catch {
    // no ffmpeg
  }
  return null;
}

/** ffmpeg arguments to read PNGs from stdin and write `out`. */
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
  /** Produces the frames: call `write(png)` for each one, in order. */
  produce: (write: (png: Buffer) => Promise<void>) => Promise<unknown>;
}

/** Encodes the produced frames into `out`. Rejects with a clear message if ffmpeg fails. */
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
    throw new Error(missing ? FFMPEG_MISSING : `Failed to start ffmpeg: ${err.message}`);
  }
  if (code !== 0) {
    const detail = stderr.trim() || (stdinError as Error | null)?.message || `code ${code}`;
    throw new Error(`ffmpeg failed to encode ${opts.format}: ${detail}`);
  }
}
