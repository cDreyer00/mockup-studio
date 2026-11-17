/**
 * Exchange format of website snapshots (version 1). Pure: no DOM and no Node, used by the
 * in-browser capture (extension and headless Electron), by the daemon and by the editor (paste).
 *
 * Images and fonts do not go inside the nodes: nodes reference `asset:<id>` (in the `src` of images and
 * in `url("asset:<id>")` in styles) and the `assets` list carries the original URL and, when the capture
 * managed to read the bytes, the data URL. The daemon resolves the references on import.
 */
import type { Node } from '@mockup/core';

export const SNAPSHOT_FORMAT = 'mockup-snapshot' as const;
export const SNAPSHOT_VERSION = 1 as const;

/** Prefix of asset references inside nodes (`asset:a1`). */
export const ASSET_REF_PREFIX = 'asset:';

/** Default capture limits. */
export const SNAPSHOT_LIMITS = {
  /** Maximum nodes in the captured subtree (the rest is cut and `stats.truncated` becomes true). */
  maxNodes: 3000,
  /** Maximum depth from the captured element. */
  maxDepth: 40,
  /** Largest asset embedded as a data URL in the capture (bytes); above that only the URL is kept. */
  maxInlineAssetBytes: 4 * 1024 * 1024,
  /** Maximum sum of the size of embedded data URLs (text characters, ~4/3 of the bytes). */
  maxInlineTotalBytes: 40 * 1024 * 1024,
} as const;

export interface SnapshotViewport {
  width: number;
  height: number;
}

export interface SnapshotSource {
  /** URL of the captured page (`about:blank` or the base given in import_html). */
  url: string;
  title: string;
  /** ISO 8601. */
  capturedAt: string;
  viewport: SnapshotViewport;
  devicePixelRatio: number;
  /** CSS selector of the captured element (when known). */
  selector?: string;
}

export interface SnapshotAsset {
  /** Local id (`a1`, `a2`...), referenced in nodes as `asset:<id>`. */
  id: string;
  kind: 'image' | 'font';
  /** Original absolute URL (http, https or data:). */
  url: string;
  /** Bytes as a data URL, when the capture managed to read them (same origin, CORS or already data:). */
  dataUrl?: string;
  /** MIME type, if known. */
  mime?: string;
}

export interface SnapshotFont {
  /** Family as declared in `@font-face` (no quotes). */
  family: string;
  /** `font-weight` do `@font-face` (ex.: `400`, `700`, `100 900`). */
  weight: string;
  /** `normal` or `italic`. */
  style: string;
  /** Files from `src`, in order of preference (ids from `assets`, kind `font`). */
  assetIds: string[];
  unicodeRange?: string;
}

/** Reference screenshot of the element (the daemon attaches it as a hidden "Reference" image). */
export interface SnapshotReference {
  /** PNG or JPEG as a data URL. */
  dataUrl: string;
  /** Size in CSS px (the image may have more pixels because of devicePixelRatio). */
  width: number;
  height: number;
}

export interface SnapshotStats {
  nodes: number;
  /** The capture reached `maxNodes` or `maxDepth`. */
  truncated: boolean;
  warnings: string[];
}

export interface SnapshotPayload {
  format: typeof SNAPSHOT_FORMAT;
  version: typeof SNAPSHOT_VERSION;
  source: SnapshotSource;
  /**
   * Captured element as a core node (`type: 'element'`; the daemon converts it into a frame). Styles
   * already reduced (diff against the user agent default + the document's base CSS), with the
   * inherited typography explicit on the root and `width`/`height` in px on the root.
   */
  root: Node;
  /** Size of the captured element in CSS px. */
  width: number;
  height: number;
  assets: SnapshotAsset[];
  fonts: SnapshotFont[];
  reference?: SnapshotReference;
  stats: SnapshotStats;
}

/** `asset:<id>` reference → id (or null). */
export function assetRefId(value: string | undefined | null): string | null {
  if (!value || !value.startsWith(ASSET_REF_PREFIX)) return null;
  const id = value.slice(ASSET_REF_PREFIX.length);
  return /^[\w-]{1,32}$/.test(id) ? id : null;
}

/** Object that looks like a snapshot (format and version); full validation is left to the daemon. */
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
 * Clipboard text: the payload JSON (starts with `{"format":"mockup-snapshot"`). Plain text so it
 * works in any browser; the editor recognizes it by the prefix and imports it through the daemon.
 */
export function encodeClipboard(payload: SnapshotPayload): string {
  const { format, version, ...rest } = payload;
  return JSON.stringify({ format, version, ...rest });
}

const CLIPBOARD_PREFIX_RE = /^\s*\{\s*"format"\s*:\s*"mockup-snapshot"/;

/** Is the pasted text a snapshot? (cheap test, no parsing). */
export function looksLikeSnapshot(text: string | null | undefined): boolean {
  return !!text && CLIPBOARD_PREFIX_RE.test(text);
}

/** Decodes the clipboard text; `null` if it is not a valid snapshot. */
export function decodeClipboard(text: string | null | undefined): SnapshotPayload | null {
  if (!looksLikeSnapshot(text)) return null;
  try {
    const parsed: unknown = JSON.parse(text!);
    return isSnapshotPayload(parsed) ? parsed : null;
  } catch {
    return null;
  }
}
