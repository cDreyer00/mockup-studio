/**
 * Import service shared by the HTTP routes and the MCP tools: capture (render engine) or
 * conversion (core), then `importSnapshot`.
 */
import { createNodeFromTag, htmlToNodes, type Node, type OpSource } from '@mockup/core';
import {
  SNAPSHOT_FORMAT,
  SNAPSHOT_VERSION,
  type ImportHtmlRequest,
  type ImportPlacement,
  type ImportUrlRequest,
  type SnapshotImportRequest,
  type SnapshotImportResult,
  type SnapshotPayload,
} from '@mockup/snapshot-core';
import type { RenderProvider } from '../render.js';
import type { DocumentStore } from '../store.js';
import { importSnapshot } from './import.js';
import {
  SnapshotImportError,
  parseCaptureParams,
  parseHttpUrl,
  parsePlacement,
} from './validate.js';

export interface SnapshotServiceCtx {
  store: DocumentStore;
  render?: RenderProvider;
  /** Event source in the history (`'mcp'` for MCP tools, `'editor'` for HTTP routes). */
  source: OpSource;
}

/** 503 for `import_url` without a render engine. */
export const IMPORT_URL_NEEDS_RENDER =
  'Importing from a URL needs the render engine, which is not available in this daemon. ' +
  'Open the Mockup Studio desktop app or run `mockup serve --render`.';

const MAX_HTML_CHARS = 20_000_000;
const MAX_CSS_CHARS = 5_000_000;

const FALLBACK_WARNING =
  'Imported without a render engine: simple HTML/CSS conversion (no computed styles, page fonts or JavaScript), with lower fidelity. Check the result and adjust; the desktop app (or `mockup serve --render`) captures with computed styles.';

async function capture(
  render: RenderProvider,
  req: Parameters<NonNullable<RenderProvider['snapshot']>>[0],
  what: string,
): Promise<SnapshotPayload> {
  try {
    return await render.snapshot!(req);
  } catch (e) {
    throw new SnapshotImportError(
      502,
      `Failed to capture ${what}: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
}

/** Imports a ready payload (extension, paste in the editor). */
export function importFromPayload(
  ctx: SnapshotServiceCtx,
  req: SnapshotImportRequest,
): Promise<SnapshotImportResult> {
  const { payload, ...placement } = req;
  return importSnapshot(ctx.store, payload, placement, { source: ctx.source });
}

/** Captures the URL in the render engine and imports it. 503 without render. */
export async function importFromUrl(
  ctx: SnapshotServiceCtx,
  req: ImportUrlRequest,
): Promise<SnapshotImportResult> {
  const url = parseHttpUrl(req.url);
  const params = parseCaptureParams(req);
  const placement = parsePlacement(req);
  if (!ctx.render?.snapshot) throw new SnapshotImportError(503, IMPORT_URL_NEEDS_RENDER);
  const payload = await capture(
    ctx.render,
    {
      kind: 'url',
      url,
      selector: params.selector,
      viewport: params.viewport,
      timeoutMs: params.timeoutMs,
    },
    url,
  );
  return importSnapshot(ctx.store, payload, placement, { source: ctx.source, method: 'snapshot' });
}

/** Resolves relative image `src` values against the base (the core conversion keeps the original text). */
function absolutizeImages(nodes: Node[], base: string): void {
  const walk = (n: Node): void => {
    if (n.type === 'image' && n.src && !/^(data:|https?:|asset:)/i.test(n.src)) {
      try {
        n.src = new URL(n.src, base).href;
      } catch {
        // keep the original value
      }
    }
    n.children.forEach(walk);
  };
  nodes.forEach(walk);
}

/**
 * Captures the HTML in the render engine (computed styles) when it has `snapshot`; otherwise converts
 * it with the core (`htmlToNodes`) into a frame with the viewport width. The canvas shows frames with
 * a fixed height in px (`frameSize`: 600 if absent) and does not measure the content; without layout
 * the real height is unknown, so the frame gets the viewport height with `overflow: visible` (nothing
 * is clipped) and the warning tells the user to adjust it.
 */
export async function importFromHtml(
  ctx: SnapshotServiceCtx,
  req: ImportHtmlRequest,
): Promise<SnapshotImportResult> {
  if (typeof req.html !== 'string')
    throw new SnapshotImportError(400, 'Missing required field: html.');
  if (!req.html.trim())
    throw new SnapshotImportError(400, 'Empty HTML: provide the content to import in html.');
  if (req.html.length > MAX_HTML_CHARS)
    throw new SnapshotImportError(400, 'The HTML exceeds the limit of 20 million characters.');
  if (req.css !== undefined && (typeof req.css !== 'string' || req.css.length > MAX_CSS_CHARS))
    throw new SnapshotImportError(400, 'Invalid css (text of up to 5 million characters).');
  const baseUrl =
    req.assetsBaseUrl === undefined || req.assetsBaseUrl === ''
      ? undefined
      : parseHttpUrl(req.assetsBaseUrl, 'assetsBaseUrl');
  const params = parseCaptureParams(req);
  const placement: ImportPlacement = parsePlacement(req);

  if (ctx.render?.snapshot) {
    const payload = await capture(
      ctx.render,
      {
        kind: 'html',
        html: req.html,
        css: req.css,
        baseUrl,
        selector: params.selector,
        viewport: params.viewport,
        timeoutMs: params.timeoutMs,
      },
      'the HTML',
    );
    return importSnapshot(ctx.store, payload, placement, {
      source: ctx.source,
      method: 'snapshot',
    });
  }

  const warnings = [FALLBACK_WARNING];
  if (params.selector)
    warnings.push(
      `The selector "${params.selector}" was ignored: without render the whole HTML is converted.`,
    );
  let children: Node[];
  try {
    children = htmlToNodes(req.html, { css: req.css });
  } catch (e) {
    throw new SnapshotImportError(
      400,
      `Could not convert the HTML: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  if (children.length === 0)
    throw new SnapshotImportError(400, 'The HTML has no content to import.');
  if (baseUrl) absolutizeImages(children, baseUrl);
  const { width, height } = params.viewport;
  warnings.push(
    `The frame uses the viewport height (${height}px) without clipping the content; adjust the frame height to the content.`,
  );
  const root = createNodeFromTag('div', {
    name: 'Imported HTML',
    styles: { width: `${width}px`, height: `${height}px`, overflow: 'visible' },
    children,
  });
  const payload: SnapshotPayload = {
    format: SNAPSHOT_FORMAT,
    version: SNAPSHOT_VERSION,
    source: {
      url: baseUrl ?? 'about:blank',
      title: '',
      capturedAt: new Date().toISOString(),
      viewport: params.viewport,
      devicePixelRatio: 1,
    },
    root,
    width,
    height,
    assets: [],
    fonts: [],
    stats: { nodes: 0, truncated: false, warnings: [] },
  };
  return importSnapshot(ctx.store, payload, placement, {
    source: ctx.source,
    method: 'html',
    warnings,
  });
}
