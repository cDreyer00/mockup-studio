import { ASSET_REF_PREFIX, type SnapshotAsset } from '../format.js';

/** Registry of assets (images and fonts) by URL, with ids `a1`, `a2`... */
export class AssetRegistry {
  readonly list: SnapshotAsset[] = [];
  private byKey = new Map<string, SnapshotAsset>();

  add(url: string, kind: 'image' | 'font'): SnapshotAsset {
    const key = `${kind}|${url}`;
    let asset = this.byKey.get(key);
    if (!asset) {
      asset = { id: `a${this.list.length + 1}`, kind, url };
      if (url.startsWith('data:')) {
        asset.dataUrl = url;
        const mime = /^data:([^;,]+)/i.exec(url)?.[1];
        if (mime) asset.mime = mime.toLowerCase();
      }
      this.list.push(asset);
      this.byKey.set(key, asset);
    }
    return asset;
  }

  /** `asset:<id>` of an image URL. */
  imageRef(url: string): string {
    return ASSET_REF_PREFIX + this.add(url, 'image').id;
  }

  /** Replaces each `url(...)` in a `background-image` value with `url("asset:<id>")`. */
  rewriteUrls(value: string, baseUrl: string): string {
    return value.replace(/url\(\s*(["']?)(.*?)\1\s*\)/g, (whole, _q: string, raw: string) => {
      if (!raw || raw.startsWith('#')) return whole;
      let abs = raw;
      try {
        abs = new URL(raw, baseUrl).href;
      } catch {
        return 'none';
      }
      return `url("${this.imageRef(abs)}")`;
    });
  }
}

const FETCH_TIMEOUT_MS = 8000;
const CONCURRENCY = 6;

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error('Failed to read the file.'));
    reader.readAsDataURL(blob);
  });
}

export interface InlineOptions {
  maxAssetBytes: number;
  maxTotalBytes: number;
  warn: (message: string) => void;
}

/** Size (characters) of the base64 data URL of a blob: `data:<mime>;base64,` + 4 * ceil(bytes / 3). */
export function estimateDataUrlLength(mime: string, byteSize: number): number {
  return `data:${mime};base64,`.length + 4 * Math.ceil(byteSize / 3);
}

/**
 * Tries to embed the bytes of the assets as data URLs (fetch in the page, up to 6 in parallel).
 * The total limit (`maxTotalBytes`) counts the size of the data URLs (text characters), which is
 * what weighs on the payload; a single unit, for already embedded assets and for downloaded ones.
 */
export async function inlineAssets(assets: SnapshotAsset[], opts: InlineOptions): Promise<void> {
  let total = 0;
  for (const a of assets) if (a.dataUrl) total += a.dataUrl.length;
  const queue = assets.filter((a) => !a.dataUrl);

  const one = async (asset: SnapshotAsset): Promise<void> => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
    try {
      const res = await fetch(asset.url, { credentials: 'same-origin', signal: ctrl.signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const declared = Number(res.headers.get('content-length') ?? '');
      if (declared > opts.maxAssetBytes) throw new Error('larger than the per-file limit');
      const blob = await res.blob();
      if (blob.size > opts.maxAssetBytes) throw new Error('larger than the per-file limit');
      // Reserves the estimate before converting (the 6 in parallel do not overflow together).
      const estimate = estimateDataUrlLength(blob.type || 'application/octet-stream', blob.size);
      if (total + estimate > opts.maxTotalBytes) throw new Error('total byte limit reached');
      total += estimate;
      let dataUrl: string;
      try {
        dataUrl = await blobToDataUrl(blob);
      } catch (err) {
        total -= estimate;
        throw err;
      }
      // Checks against the real size and adjusts the difference.
      total += dataUrl.length - estimate;
      asset.dataUrl = dataUrl;
      const mime = (blob.type || res.headers.get('content-type') || '').split(';')[0]!.trim();
      if (mime) asset.mime = mime.toLowerCase();
    } catch (err) {
      const reason = ctrl.signal.aborted
        ? 'timed out'
        : err instanceof Error
          ? err.message
          : String(err);
      opts.warn(
        `Could not embed the ${asset.kind === 'font' ? 'font' : 'image'} "${asset.url.slice(0, 200)}": ${reason}`,
      );
    } finally {
      clearTimeout(timer);
    }
  };

  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < queue.length) await one(queue[next++]!);
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, queue.length) }, worker));
}
