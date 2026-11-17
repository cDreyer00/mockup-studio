/**
 * Conferência de mídia pelos bytes (vídeo, Lottie, Rive), compartilhada pelo upload HTTP e pelas
 * ferramentas MCP. Sem dependência de http.ts (evita ciclo).
 */
import path from 'node:path';
import { fetchBytes } from './assets.js';

export const ANIMATION_FETCH_MAX = 50 * 1024 * 1024;

export type VideoKind = { ext: '.mp4' | '.m4v' | '.mov' | '.webm' | '.ogv'; mime: string };

/** Detecta vídeo pelos primeiros bytes: mp4/m4v/mov (ftyp), webm/mkv (EBML) e ogg. */
export function detectVideo(head: Buffer): VideoKind | null {
  if (head.length >= 12 && head.toString('ascii', 4, 8) === 'ftyp') {
    const brand = head.toString('ascii', 8, 12);
    if (/^(avif|avis|heic|heix|hevc|mif1|msf1)/.test(brand)) return null;
    if (brand === 'qt  ') return { ext: '.mov', mime: 'video/quicktime' };
    if (brand === 'M4V ' || brand === 'M4VH' || brand === 'M4VP')
      return { ext: '.m4v', mime: 'video/x-m4v' };
    return { ext: '.mp4', mime: 'video/mp4' };
  }
  if (
    head.length >= 4 &&
    head[0] === 0x1a &&
    head[1] === 0x45 &&
    head[2] === 0xdf &&
    head[3] === 0xa3
  )
    return { ext: '.webm', mime: 'video/webm' };
  if (head.length >= 4 && head.toString('ascii', 0, 4) === 'OggS')
    return { ext: '.ogv', mime: 'video/ogg' };
  return null;
}

/** Valida um arquivo Lottie (JSON com v, fr, layers, ou .lottie zip). */
export function lottieKind(bytes: Buffer): '.json' | '.lottie' | string {
  if (bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b) return '.lottie';
  let json: unknown;
  try {
    json = JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/, ''));
  } catch {
    return 'O arquivo não é um JSON válido de Lottie.';
  }
  const o = json as Record<string, unknown> | null;
  if (!o || typeof o !== 'object' || !('v' in o) || !('fr' in o) || !Array.isArray(o['layers']))
    return 'O JSON não parece uma animação Lottie (esperado: campos "v", "fr" e "layers").';
  return '.json';
}

/** Confere os bytes de Lottie/Rive: devolve a extensão ('.json', '.lottie', '.riv') ou a mensagem de erro. */
export function validateAnimation(bytes: Buffer, provider: 'lottie' | 'rive'): string {
  if (provider === 'rive') {
    return bytes.toString('ascii', 0, 4) === 'RIVE'
      ? '.riv'
      : 'O arquivo não é um Rive válido (deve começar com "RIVE"). Use um .riv exportado do Rive.';
  }
  return lottieKind(bytes);
}

/** Baixa e valida um Lottie/Rive por URL http(s). Lança Error (mensagem em português). */
export async function fetchAnimation(
  url: string,
  provider: 'lottie' | 'rive',
  fetcher: typeof fetchBytes = fetchBytes,
): Promise<{ bytes: Buffer; hint: string; ext: string }> {
  const r = await fetcher(url, { maxBytes: ANIMATION_FETCH_MAX, timeoutMs: 20_000 });
  const ext = validateAnimation(r.bytes, provider);
  if (!ext.startsWith('.')) throw new Error(ext);
  const hint = path.basename(new URL(r.finalUrl).pathname) || provider;
  return { bytes: r.bytes, hint, ext };
}
