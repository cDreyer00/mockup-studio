/** Funções puras do RenderService (testáveis sem Electron). */
import { createHash } from 'node:crypto';
import { getFrameOf, getPageOfNode, type Document, type Node } from '@mockup/core';

/** Lado máximo da imagem final, em px, após a escala. */
export const MAX_SIDE_PX = 16384;

/** Lê largura/altura do cabeçalho IHDR de um PNG. */
export function pngSize(buf: Buffer): { width: number; height: number } {
  if (buf.length < 24 || buf.readUInt32BE(0) !== 0x89504e47)
    throw new Error('Resposta não é um PNG válido');
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

/** Valida o tamanho final; lança erro claro quando excede o limite. */
export function assertSize(width: number, height: number, scale: number): void {
  const w = Math.round(width * scale);
  const h = Math.round(height * scale);
  if (w < 1 || h < 1) throw new Error(`O nó tem tamanho vazio (${width}x${height}).`);
  if (w > MAX_SIDE_PX || h > MAX_SIDE_PX) {
    throw new Error(
      `Imagem grande demais: ${w}x${h}px (limite de ${MAX_SIDE_PX}px por lado). Reduza a escala ou capture um nó menor.`,
    );
  }
}

/** Largura/altura em px declaradas no estilo do frame, quando forem valores `Npx`. */
export function declaredSize(frame: Node | undefined): { width?: number; height?: number } {
  const styles = (frame?.style ?? {}) as Record<string, unknown>;
  const px = (v: unknown): number | undefined => {
    const m = typeof v === 'string' ? /^\s*(\d+(?:\.\d+)?)px\s*$/.exec(v) : null;
    return m ? Number(m[1]) : undefined;
  };
  return { width: px(styles.width), height: px(styles.height) };
}

export interface CacheKeyInput {
  doc: Document;
  docId: string;
  nodeId: string;
  scale: number;
  format: string;
  quality?: number;
  maxWidth?: number;
  transparent: boolean;
}

/** sha256 do que influencia a imagem: frame do nó, tokens, fontes, fundo da página e parâmetros. */
export function cacheKey(i: CacheKeyInput): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        frame: getFrameOf(i.doc, i.nodeId) ?? null,
        tokens: i.doc.tokens,
        fonts: i.doc.fonts,
        background: getPageOfNode(i.doc, i.nodeId)?.background ?? null,
        docId: i.docId,
        nodeId: i.nodeId,
        scale: i.scale,
        format: i.format,
        quality: i.quality ?? null,
        maxWidth: i.maxWidth ?? null,
        transparent: i.transparent,
      }),
    )
    .digest('hex');
}

/** Cache LRU simples (Map preserva a ordem de inserção). */
export class LruCache<V> {
  private map = new Map<string, V>();
  constructor(private max: number) {}
  get(key: string): V | undefined {
    const v = this.map.get(key);
    if (v === undefined) return undefined;
    this.map.delete(key);
    this.map.set(key, v);
    return v;
  }
  set(key: string, value: V): void {
    this.map.delete(key);
    this.map.set(key, value);
    while (this.map.size > this.max) this.map.delete(this.map.keys().next().value as string);
  }
  get size(): number {
    return this.map.size;
  }
  clear(): void {
    this.map.clear();
  }
}

/** Rejeita se `p` não resolver em `ms`; `onTimeout` roda antes (ex.: destruir a janela travada). */
export async function withTimeout<T>(
  p: Promise<T>,
  ms: number,
  what: string,
  onTimeout?: () => void,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      onTimeout?.();
      reject(new Error(`Tempo esgotado (${Math.round(ms / 1000)} s) em: ${what}`));
    }, ms);
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    clearTimeout(timer);
  }
}
