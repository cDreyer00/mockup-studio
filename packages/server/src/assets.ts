/**
 * Asset file utilities: image detection from bytes, intrinsic dimensions,
 * non-overwriting writes and downloads with size limit/timeout. No native dependencies.
 */
import fs from 'node:fs';
import path from 'node:path';

export interface ImageInfo {
  ext: '.png' | '.jpg' | '.gif' | '.webp' | '.svg' | '.avif';
  mime: string;
  width?: number;
  height?: number;
}

type Size = Pick<ImageInfo, 'width' | 'height'>;

const MIME: Record<ImageInfo['ext'], string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.avif': 'image/avif',
};

function pngSize(b: Buffer): Size {
  return b.length >= 24 ? { width: b.readUInt32BE(16), height: b.readUInt32BE(20) } : {};
}

function jpegSize(b: Buffer): Size {
  let i = 2;
  while (i + 9 < b.length) {
    if (b[i] !== 0xff) {
      i++;
      continue;
    }
    const marker = b[i + 1]!;
    if (marker === 0xff) {
      i++;
      continue;
    }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      i += 2;
      continue;
    }
    const len = b.readUInt16BE(i + 2);
    // SOF0..SOF15, except DHT (C4), JPG (C8) and DAC (CC)
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      return { height: b.readUInt16BE(i + 5), width: b.readUInt16BE(i + 7) };
    }
    i += 2 + len;
  }
  return {};
}

function gifSize(b: Buffer): Size {
  return b.length >= 10 ? { width: b.readUInt16LE(6), height: b.readUInt16LE(8) } : {};
}

function webpSize(b: Buffer): Size {
  if (b.length < 30) return {};
  const kind = b.toString('ascii', 12, 16);
  if (kind === 'VP8 ') {
    return { width: b.readUInt16LE(26) & 0x3fff, height: b.readUInt16LE(28) & 0x3fff };
  }
  if (kind === 'VP8L') {
    const bits = b.readUInt32LE(21);
    return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
  }
  if (kind === 'VP8X') {
    return { width: b.readUIntLE(24, 3) + 1, height: b.readUIntLE(27, 3) + 1 };
  }
  return {};
}

function svgSize(text: string): Size {
  const tag = /<svg\b[^>]*>/i.exec(text)?.[0] ?? '';
  const attr = (n: string): number | undefined => {
    const m = new RegExp(`\\s${n}\\s*=\\s*["']\\s*([0-9.]+)\\s*(?:px)?\\s*["']`, 'i').exec(tag);
    return m ? parseFloat(m[1]!) : undefined;
  };
  const w = attr('width');
  const h = attr('height');
  if (w && h) return { width: Math.round(w), height: Math.round(h) };
  const vb =
    /viewBox\s*=\s*["']\s*[-0-9.]+[\s,]+[-0-9.]+[\s,]+([0-9.]+)[\s,]+([0-9.]+)\s*["']/i.exec(tag);
  if (vb) return { width: Math.round(parseFloat(vb[1]!)), height: Math.round(parseFloat(vb[2]!)) };
  return {};
}

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Detects the type from the bytes (PNG/JPEG/GIF/WebP/SVG/AVIF) and reads the dimensions when possible. */
export function detectImage(b: Buffer): ImageInfo | null {
  const mk = (ext: ImageInfo['ext'], size: Size = {}): ImageInfo => ({
    ext,
    mime: MIME[ext],
    ...size,
  });
  if (b.length >= 8 && b.subarray(0, 8).equals(PNG_MAGIC)) return mk('.png', pngSize(b));
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff)
    return mk('.jpg', jpegSize(b));
  if (b.length >= 6 && /^GIF8[79]a$/.test(b.toString('ascii', 0, 6))) return mk('.gif', gifSize(b));
  if (
    b.length >= 12 &&
    b.toString('ascii', 0, 4) === 'RIFF' &&
    b.toString('ascii', 8, 12) === 'WEBP'
  )
    return mk('.webp', webpSize(b));
  if (b.length >= 12 && b.toString('ascii', 4, 8) === 'ftyp') {
    const brand = b.toString('ascii', 8, 12);
    if (brand === 'avif' || brand === 'avis') return mk('.avif');
  }
  const head = b
    .subarray(0, Math.min(b.length, 4096))
    .toString('utf8')
    .replace(/^\uFEFF/, '');
  if (/^\s*(<\?xml[^>]*>\s*)?(<!--[\s\S]*?-->\s*)*(<!doctype[^>]*>\s*)?<svg[\s>]/i.test(head)) {
    return mk('.svg', svgSize(b.toString('utf8', 0, Math.min(b.length, 65536))));
  }
  return null;
}

export interface WriteAssetOptions {
  /** Overwrites the existing file instead of creating `name-1`, `name-2`... */
  overwrite?: boolean;
}

/**
 * Writes `bytes` to `dir/name` (creates the folder). If the name already exists, appends -1, -2...
 * before the extension, without overwriting. Returns the final name (without the folder).
 */
export async function writeAsset(
  dir: string,
  name: string,
  bytes: Uint8Array,
  opts: WriteAssetOptions = {},
): Promise<string> {
  await fs.promises.mkdir(dir, { recursive: true });
  const ext = path.extname(name);
  const base = name.slice(0, name.length - ext.length);
  if (opts.overwrite) {
    await fs.promises.writeFile(path.join(dir, name), bytes);
    return name;
  }
  for (let i = 0; i < 1000; i++) {
    const finalName = i === 0 ? name : `${base}-${i}${ext}`;
    try {
      await fs.promises.writeFile(path.join(dir, finalName), bytes, { flag: 'wx' });
      return finalName;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    }
  }
  throw new Error(`Could not write "${name}" in ${dir}: names exhausted.`);
}

export interface FetchedBytes {
  bytes: Buffer;
  contentType: string;
  finalUrl: string;
}

/** Downloads an http(s) URL with timeout and size limit. */
export async function fetchBytes(
  url: string,
  opts: { maxBytes: number; timeoutMs?: number; headers?: Record<string, string> },
): Promise<FetchedBytes> {
  let res: Response;
  try {
    res = await fetch(url, {
      headers: opts.headers,
      redirect: 'follow',
      signal: AbortSignal.timeout(opts.timeoutMs ?? 20_000),
    });
  } catch (e) {
    const timeout = e instanceof Error && (e.name === 'TimeoutError' || e.name === 'AbortError');
    const reason =
      e instanceof Error ? (e.cause instanceof Error ? e.cause.message : e.message) : String(e);
    throw new Error(
      timeout
        ? `Timed out downloading ${url}. Check the connection or download the file and pass the local path.`
        : `Failed to download ${url}: ${reason}.`,
    );
  }
  if (!res.ok) throw new Error(`Failed to download ${url}: HTTP ${res.status}.`);
  const tooBig = `The file at ${url} exceeds the limit of ${Math.round(opts.maxBytes / 1024 / 1024)} MB.`;
  const declared = Number(res.headers.get('content-length') ?? 0);
  if (declared > opts.maxBytes) throw new Error(tooBig);
  const chunks: Buffer[] = [];
  let total = 0;
  if (res.body) {
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      total += chunk.length;
      if (total > opts.maxBytes) throw new Error(tooBig);
      chunks.push(Buffer.from(chunk));
    }
  }
  return {
    bytes: Buffer.concat(chunks),
    contentType: (res.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase(),
    finalUrl: res.url || url,
  };
}

/** Decodes a data URL (base64 or url-encoded). */
export function parseDataUrl(src: string): { mime: string; bytes: Buffer } | null {
  const m = /^data:([^;,]*)((?:;[^;,]*)*),(.*)$/is.exec(src);
  if (!m) return null;
  const isBase64 = /;base64/i.test(m[2]!);
  const bytes = isBase64
    ? Buffer.from(m[3]!, 'base64')
    : Buffer.from(decodeURIComponent(m[3]!), 'utf8');
  return { mime: (m[1] || 'text/plain').toLowerCase(), bytes };
}

/** Resolves `rel` inside `root` without allowing escape from it (`..`, absolute paths). */
export function safeJoin(root: string, rel: string): string | null {
  if (!rel || rel.includes('\0') || rel.split(/[\\/]/).includes('..')) return null;
  const base = path.resolve(root);
  const target = path.resolve(base, rel);
  return target.startsWith(base + path.sep) ? target : null;
}

/** MIME types of files that can be embedded as a data URL (images and fonts). */
export const EMBEDDABLE_MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.avif': 'image/avif',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
};

/**
 * Reads a file from `assets/` (image or font) and returns the data URL; data URLs pass through.
 * `undefined` for an unsafe path (`..`, absolute outside the folder), unknown extension or error.
 * Used by the exported SVG (`resolveImage` resolves images and the embedded fonts' files).
 */
export function assetDataUrl(
  assetsDir: string | null | undefined,
  src: string,
): string | undefined {
  if (src.startsWith('data:')) return src;
  if (!assetsDir) return undefined;
  const target = safeJoin(assetsDir, src);
  const mime = target ? EMBEDDABLE_MIME[path.extname(target).toLowerCase()] : undefined;
  if (!target || !mime) return undefined;
  try {
    return `data:${mime};base64,${fs.readFileSync(target).toString('base64')}`;
  } catch {
    return undefined;
  }
}
