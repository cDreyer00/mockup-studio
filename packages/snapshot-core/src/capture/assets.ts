import { ASSET_REF_PREFIX, type SnapshotAsset } from '../format.js';

/** Registro de assets (imagens e fontes) por URL, com ids `a1`, `a2`... */
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

  /** `asset:<id>` de uma URL de imagem. */
  imageRef(url: string): string {
    return ASSET_REF_PREFIX + this.add(url, 'image').id;
  }

  /** Troca cada `url(...)` de um valor de `background-image` por `url("asset:<id>")`. */
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
    reader.onerror = () => reject(reader.error ?? new Error('Falha ao ler o arquivo.'));
    reader.readAsDataURL(blob);
  });
}

export interface InlineOptions {
  maxAssetBytes: number;
  maxTotalBytes: number;
  warn: (message: string) => void;
}

/** Tamanho (caracteres) da data URL base64 de um blob: `data:<mime>;base64,` + 4 * ceil(bytes / 3). */
export function estimateDataUrlLength(mime: string, byteSize: number): number {
  return `data:${mime};base64,`.length + 4 * Math.ceil(byteSize / 3);
}

/**
 * Tenta embutir os bytes dos assets como data URL (fetch na página, até 6 em paralelo).
 * O limite total (`maxTotalBytes`) conta o tamanho das data URLs (caracteres do texto), que é o
 * que pesa no payload; uma unidade só, para assets já embutidos e para os baixados.
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
      if (declared > opts.maxAssetBytes) throw new Error('maior que o limite por arquivo');
      const blob = await res.blob();
      if (blob.size > opts.maxAssetBytes) throw new Error('maior que o limite por arquivo');
      // Reserva a estimativa antes de converter (os 6 em paralelo não estouram juntos).
      const estimate = estimateDataUrlLength(blob.type || 'application/octet-stream', blob.size);
      if (total + estimate > opts.maxTotalBytes) throw new Error('limite total de bytes atingido');
      total += estimate;
      let dataUrl: string;
      try {
        dataUrl = await blobToDataUrl(blob);
      } catch (err) {
        total -= estimate;
        throw err;
      }
      // Confere com o tamanho real e ajusta a diferença.
      total += dataUrl.length - estimate;
      asset.dataUrl = dataUrl;
      const mime = (blob.type || res.headers.get('content-type') || '').split(';')[0]!.trim();
      if (mime) asset.mime = mime.toLowerCase();
    } catch (err) {
      const reason = ctrl.signal.aborted
        ? 'tempo esgotado'
        : err instanceof Error
          ? err.message
          : String(err);
      opts.warn(
        `Não foi possível embutir ${asset.kind === 'font' ? 'a fonte' : 'a imagem'} "${asset.url.slice(0, 200)}": ${reason}`,
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
