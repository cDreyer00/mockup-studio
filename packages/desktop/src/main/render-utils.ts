/** Funções puras do RenderService (testáveis sem Electron). */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { getFrameOf, getPageOfNode, walk, type Document, type Node } from '@mockup/core';

/** Lado máximo da imagem final, em px, após a escala. */
export const MAX_SIDE_PX = 16384;

/** Lê largura/altura do cabeçalho IHDR de um PNG. */
export function pngSize(buf: Buffer): { width: number; height: number } {
  if (buf.length < 24 || buf.readUInt32BE(0) !== 0x89504e47)
    throw new Error('Resposta não é um PNG válido');
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

/** Limite do cache de render em bytes (soma dos PNG/JPG guardados). */
export const CACHE_MAX_BYTES = 256 * 1024 * 1024;

/**
 * Valida a viewport (`frame × deviceScaleFactor`) antes de redimensionar a janela de render:
 * o Chromium falha ou esgota a memória com superfícies muito grandes.
 */
export function assertViewport(width: number, height: number, scale: number): void {
  const w = Math.ceil(width * scale);
  const h = Math.ceil(height * scale);
  if (w > MAX_SIDE_PX || h > MAX_SIDE_PX) {
    throw new Error(
      `Frame grande demais para renderizar: ${Math.ceil(width)}x${Math.ceil(height)}px CSS × escala ${scale} = ${w}x${h}px (limite de ${MAX_SIDE_PX}px por lado). Reduza a escala ou o tamanho do frame.`,
    );
  }
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
  /** Impressão digital dos arquivos referenciados (ver `assetFingerprints`). */
  assets?: string[];
}

/** sha256 do que influencia a imagem: frame do nó, tokens, temas, fontes, fundo da página e parâmetros. */
export function cacheKey(i: CacheKeyInput): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        frame: getFrameOf(i.doc, i.nodeId) ?? null,
        tokens: i.doc.tokens,
        themes: i.doc.themes ?? [],
        fonts: i.doc.fonts,
        background: getPageOfNode(i.doc, i.nodeId)?.background ?? null,
        docId: i.docId,
        nodeId: i.nodeId,
        scale: i.scale,
        format: i.format,
        quality: i.quality ?? null,
        maxWidth: i.maxWidth ?? null,
        transparent: i.transparent,
        assets: i.assets ?? [],
      }),
    )
    .digest('hex');
}

const CSS_URL = /url\(\s*(['"]?)(.*?)\1\s*\)/gi;

/** Referência relativa a `assets/` (descarta data:, http(s):, âncoras e caminhos absolutos). */
function relativeRef(raw: string): string | null {
  const ref = raw.trim();
  if (!ref || ref.startsWith('#') || ref.startsWith('/') || ref.startsWith('\\')) return null;
  if (/^[a-z][a-z0-9+.-]*:/i.test(ref)) return null;
  return ref.replace(/^\.\//, '').split(/[?#]/)[0] || null;
}

/**
 * Arquivos de `assets/` que influenciam o render do frame do nó: `src` das imagens do frame,
 * `url(...)` relativos nos estilos do frame (e no fundo da página) e os arquivos das fontes do documento.
 */
export function referencedAssets(doc: Document, nodeId: string): string[] {
  const refs = new Set<string>();
  const add = (raw: string | undefined): void => {
    const r = raw ? relativeRef(raw) : null;
    if (r) refs.add(r);
  };
  const addUrls = (css: string): void => {
    for (const m of css.matchAll(CSS_URL)) add(m[2]);
  };
  const frame = getFrameOf(doc, nodeId);
  if (frame) {
    walk(frame, (n) => {
      if (n.type === 'image') add(n.src);
      for (const v of Object.values(n.style ?? {})) addUrls(String(v));
    });
  }
  addUrls(getPageOfNode(doc, nodeId)?.background ?? '');
  for (const f of doc.fonts ?? []) for (const file of f.files ?? []) add(file);
  return [...refs].sort();
}

/**
 * Tamanho e data de modificação de cada arquivo referenciado, lidos de `assetsDir`. Caminhos que
 * escapam da pasta (`..`) e arquivos ausentes são ignorados. Trocar o conteúdo de um arquivo com o
 * mesmo nome muda a impressão digital (e portanto a chave do cache).
 */
export function assetFingerprints(assetsDir: string | null | undefined, refs: string[]): string[] {
  if (!assetsDir) return [];
  const root = path.resolve(assetsDir);
  const out: string[] = [];
  for (const raw of refs) {
    let rel = raw;
    try {
      rel = decodeURIComponent(raw);
    } catch {
      /* mantém o texto original */
    }
    if (rel.includes('\0') || rel.split(/[\\/]/).includes('..')) continue;
    const target = path.resolve(root, rel);
    if (!target.startsWith(root + path.sep)) continue;
    try {
      const st = fs.statSync(target);
      if (st.isFile()) out.push(`${raw}:${st.size}:${Math.round(st.mtimeMs)}`);
    } catch {
      /* ausente: ignora */
    }
  }
  return out;
}

/** Cache LRU limitado por tamanho (`sizeOf`; padrão 1 por entrada = limite de entradas). */
export class LruCache<V> {
  private map = new Map<string, { value: V; size: number }>();
  private total = 0;
  constructor(
    private max: number,
    private sizeOf: (value: V) => number = () => 1,
  ) {}
  get(key: string): V | undefined {
    const e = this.map.get(key);
    if (e === undefined) return undefined;
    this.map.delete(key);
    this.map.set(key, e);
    return e.value;
  }
  set(key: string, value: V): void {
    this.drop(key);
    const size = this.sizeOf(value);
    this.map.set(key, { value, size });
    this.total += size;
    // descarta os menos usados; a própria entrada some se sozinha passar do limite
    while (this.total > this.max && this.map.size > 0)
      this.drop(this.map.keys().next().value as string);
  }
  private drop(key: string): void {
    const e = this.map.get(key);
    if (!e) return;
    this.total -= e.size;
    this.map.delete(key);
  }
  get size(): number {
    return this.map.size;
  }
  /** Soma dos tamanhos das entradas. */
  get bytes(): number {
    return this.total;
  }
  clear(): void {
    this.map.clear();
    this.total = 0;
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
