/**
 * Formato de troca dos snapshots de sites (versão 1). Puro: sem DOM e sem Node, usado pela
 * captura no navegador (extensão e Electron headless), pelo daemon e pelo editor (colar).
 *
 * Imagens e fontes não vão dentro dos nós: os nós referenciam `asset:<id>` (no `src` de imagens e
 * em `url("asset:<id>")` nos estilos) e a lista `assets` traz a URL original e, quando a captura
 * conseguiu ler os bytes, a data URL. O daemon resolve as referências ao importar.
 */
import type { Node } from '@mockup/core';

export const SNAPSHOT_FORMAT = 'mockup-snapshot' as const;
export const SNAPSHOT_VERSION = 1 as const;

/** Prefixo das referências a assets dentro dos nós (`asset:a1`). */
export const ASSET_REF_PREFIX = 'asset:';

/** Limites padrão da captura. */
export const SNAPSHOT_LIMITS = {
  /** Máximo de nós na subárvore capturada (o resto é cortado e `stats.truncated` fica true). */
  maxNodes: 3000,
  /** Profundidade máxima a partir do elemento capturado. */
  maxDepth: 40,
  /** Maior asset embutido como data URL na captura (bytes); acima disso só a URL vai. */
  maxInlineAssetBytes: 4 * 1024 * 1024,
  /** Soma máxima das data URLs embutidas (bytes). */
  maxInlineTotalBytes: 40 * 1024 * 1024,
} as const;

export interface SnapshotViewport {
  width: number;
  height: number;
}

export interface SnapshotSource {
  /** URL da página capturada (`about:blank` ou a base informada no import_html). */
  url: string;
  title: string;
  /** ISO 8601. */
  capturedAt: string;
  viewport: SnapshotViewport;
  devicePixelRatio: number;
  /** Seletor CSS do elemento capturado (quando conhecido). */
  selector?: string;
}

export interface SnapshotAsset {
  /** Id local (`a1`, `a2`...), referenciado nos nós como `asset:<id>`. */
  id: string;
  kind: 'image' | 'font';
  /** URL absoluta original (http, https ou data:). */
  url: string;
  /** Bytes em data URL, quando a captura conseguiu ler (mesma origem, CORS ou já era data:). */
  dataUrl?: string;
  /** Tipo MIME, se conhecido. */
  mime?: string;
}

export interface SnapshotFont {
  /** Família como declarada no `@font-face` (sem aspas). */
  family: string;
  /** `font-weight` do `@font-face` (ex.: `400`, `700`, `100 900`). */
  weight: string;
  /** `normal` ou `italic`. */
  style: string;
  /** Arquivos do `src`, em ordem de preferência (ids de `assets`, kind `font`). */
  assetIds: string[];
  unicodeRange?: string;
}

/** Captura de tela de referência do elemento (o daemon a anexa como imagem oculta "Referência"). */
export interface SnapshotReference {
  /** PNG ou JPEG em data URL. */
  dataUrl: string;
  /** Tamanho em px CSS (a imagem pode ter mais pixels por causa do devicePixelRatio). */
  width: number;
  height: number;
}

export interface SnapshotStats {
  nodes: number;
  /** A captura atingiu `maxNodes` ou `maxDepth`. */
  truncated: boolean;
  warnings: string[];
}

export interface SnapshotPayload {
  format: typeof SNAPSHOT_FORMAT;
  version: typeof SNAPSHOT_VERSION;
  source: SnapshotSource;
  /**
   * Elemento capturado como nó do core (`type: 'element'`; o daemon o converte em frame). Estilos
   * já reduzidos (diff contra o padrão do user agent + CSS base do documento), com a tipografia
   * herdada explícita na raiz e `width`/`height` em px na raiz.
   */
  root: Node;
  /** Tamanho do elemento capturado em px CSS. */
  width: number;
  height: number;
  assets: SnapshotAsset[];
  fonts: SnapshotFont[];
  reference?: SnapshotReference;
  stats: SnapshotStats;
}

/** Referência `asset:<id>` → id (ou null). */
export function assetRefId(value: string | undefined | null): string | null {
  if (!value || !value.startsWith(ASSET_REF_PREFIX)) return null;
  const id = value.slice(ASSET_REF_PREFIX.length);
  return /^[\w-]{1,32}$/.test(id) ? id : null;
}

/** Objeto com cara de snapshot (formato e versão); a validação completa fica no daemon. */
export function isSnapshotPayload(value: unknown): value is SnapshotPayload {
  if (!value || typeof value !== 'object') return false;
  const v = value as Partial<SnapshotPayload>;
  return (
    v.format === SNAPSHOT_FORMAT &&
    v.version === SNAPSHOT_VERSION &&
    !!v.root &&
    typeof v.root === 'object' &&
    Array.isArray(v.assets)
  );
}

/**
 * Texto do clipboard: o JSON do payload (começa com `{"format":"mockup-snapshot"`). Texto puro
 * para funcionar em qualquer navegador; o editor reconhece pelo prefixo e importa pelo daemon.
 */
export function encodeClipboard(payload: SnapshotPayload): string {
  const { format, version, ...rest } = payload;
  return JSON.stringify({ format, version, ...rest });
}

const CLIPBOARD_PREFIX_RE = /^\s*\{\s*"format"\s*:\s*"mockup-snapshot"/;

/** O texto colado é um snapshot? (teste barato, sem parse). */
export function looksLikeSnapshot(text: string | null | undefined): boolean {
  return !!text && CLIPBOARD_PREFIX_RE.test(text);
}

/** Decodifica o texto do clipboard; `null` se não for um snapshot válido. */
export function decodeClipboard(text: string | null | undefined): SnapshotPayload | null {
  if (!looksLikeSnapshot(text)) return null;
  try {
    const parsed: unknown = JSON.parse(text!);
    return isSnapshotPayload(parsed) ? parsed : null;
  } catch {
    return null;
  }
}
