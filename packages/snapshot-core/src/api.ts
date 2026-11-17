/**
 * HTTP import contract of the daemon (used by the extension and the editor) and of the in-page
 * capture engine (`RenderProvider.snapshot`, implemented by the desktop app). Types and constants only.
 */
import type { SnapshotPayload, SnapshotViewport } from './format.js';

/** Daemon routes. */
export const SNAPSHOT_ROUTES = {
  /** Body `SnapshotImportRequest`; accepts a local Origin and `chrome-extension://`. */
  snapshot: '/api/snapshot',
  /** Body `ImportUrlRequest` (needs the render engine: 503 without it). */
  importUrl: '/api/import/url',
  /** Body `ImportHtmlRequest` (without render, falls back to the HTML → core nodes conversion). */
  importHtml: '/api/import/html',
} as const;

export const DEFAULT_IMPORT_VIEWPORT: SnapshotViewport = { width: 1440, height: 900 };
/** Viewport limits for import_url/import_html (CSS px), the same in the daemon, the MCP and the editor. */
export const IMPORT_VIEWPORT_LIMITS = {
  minWidth: 320,
  maxWidth: 3840,
  minHeight: 200,
  maxHeight: 4000,
} as const;

/**
 * Fixed id of the "Capture section" extension (`packages/extension`), derived from the `key` in
 * manifest.json: the unpacked copy always has this id, and the daemon only accepts the Origin
 * `chrome-extension://<this id>` (plus the extra ids from `MOCKUP_EXTENSION_IDS`).
 */
export const MOCKUP_EXTENSION_ID = 'agjagmcpikghnfnnapjbicplkmommmkn';
/** Default timeout of an import_url/import_html in the render engine (ms). */
export const DEFAULT_IMPORT_TIMEOUT_MS = 20_000;
export const MAX_IMPORT_TIMEOUT_MS = 60_000;

/** Where to place the imported frame (all optional). */
export interface ImportPlacement {
  /** Document (default: active). */
  docId?: string;
  /** Page (default: the first one, or the editor's page when it comes from the editor). */
  pageId?: string;
  /** Frame position on the canvas (default: to the right of the last frame on the page). */
  x?: number;
  y?: number;
  /** Attach the reference capture as a hidden image next to the frame (default true). */
  reference?: boolean;
  /** Frame name (default: page title or the element tag/class). */
  name?: string;
}

export interface SnapshotImportRequest extends ImportPlacement {
  payload: SnapshotPayload;
}

export interface ImportUrlRequest extends ImportPlacement {
  url: string;
  /** CSS selector of the element; default `body`. */
  selector?: string;
  viewport?: Partial<SnapshotViewport>;
  timeoutMs?: number;
}

export interface ImportHtmlRequest extends ImportPlacement {
  /** Full HTML or a fragment. */
  html: string;
  /** Extra CSS applied to the page. */
  css?: string;
  /** Base to resolve relative URLs (`<link>`, `<img>`, `url()`); http(s). */
  assetsBaseUrl?: string;
  selector?: string;
  viewport?: Partial<SnapshotViewport>;
  timeoutMs?: number;
}

/** Response of the three routes (and basis of the MCP tools' text). */
export interface SnapshotImportResult {
  docId: string;
  pageId: string;
  frameId: string;
  /** Hidden frame with the reference image, when there was one. */
  referenceId?: string;
  /** Nodes created in the frame (includes the frame). */
  nodes: number;
  /** Images written to `assets/` or embedded. */
  images: number;
  /** Font families registered in the document. */
  fonts: string[];
  warnings: string[];
  /** `snapshot` (styles computed in the browser) or `html` (conversion without render). */
  method: 'snapshot' | 'html';
}

/** Request to the in-page capture engine (desktop app). */
export type PageSnapshotRequest =
  | {
      kind: 'url';
      url: string;
      selector?: string;
      viewport: SnapshotViewport;
      timeoutMs: number;
    }
  | {
      kind: 'html';
      html: string;
      css?: string;
      baseUrl?: string;
      selector?: string;
      viewport: SnapshotViewport;
      timeoutMs: number;
    };

export type PageSnapshotResult = SnapshotPayload;
