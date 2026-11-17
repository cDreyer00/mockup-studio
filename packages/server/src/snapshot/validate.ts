/**
 * Validation of the snapshot payload and import requests (zod).
 * The full format is in `@mockup/snapshot-core` (`format.ts` e `api.ts`).
 */
import { z } from 'zod';
import {
  MAX_IMPORT_TIMEOUT_MS,
  DEFAULT_IMPORT_TIMEOUT_MS,
  DEFAULT_IMPORT_VIEWPORT,
  IMPORT_VIEWPORT_LIMITS,
  SNAPSHOT_FORMAT,
  SNAPSHOT_VERSION,
  type ImportPlacement,
  type SnapshotPayload,
  type SnapshotViewport,
} from '@mockup/snapshot-core';

/** Import usage error: `status` is the HTTP code; the message goes straight to the user/agent. */
export class SnapshotImportError extends Error {
  /** Read by the `http.ts` error handler (4xx with message). */
  readonly expose = true;
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'SnapshotImportError';
  }
}

export const MAX_SNAPSHOT_NODES = 5000;
export const MAX_SNAPSHOT_DEPTH = 200;
const MAX_ASSETS = 3000;
const MAX_FONTS = 500;
const MAX_STRING = 40_000_000;
const MAX_CSS_PX = 100_000;

const px = z.number().finite().positive().max(MAX_CSS_PX);

const PayloadSchema = z.object({
  format: z.literal(SNAPSHOT_FORMAT, { error: `format must be "${SNAPSHOT_FORMAT}"` }),
  version: z.literal(SNAPSHOT_VERSION, {
    error: `unsupported snapshot version (this daemon reads version ${SNAPSHOT_VERSION})`,
  }),
  source: z.object({
    url: z.string().max(8192),
    title: z.string().max(2000).default(''),
    capturedAt: z.string().max(64).default(''),
    viewport: z.object({ width: px, height: px }),
    devicePixelRatio: z.number().finite().positive().max(16).default(1),
    selector: z.string().max(2000).optional(),
  }),
  root: z.looseObject({ type: z.string(), children: z.array(z.unknown()).default([]) }),
  width: px,
  height: px,
  assets: z
    .array(
      z.object({
        id: z.string().regex(/^[\w-]{1,32}$/, { error: 'invalid asset id' }),
        kind: z.enum(['image', 'font']),
        url: z.string().max(MAX_STRING),
        dataUrl: z.string().max(MAX_STRING).optional(),
        mime: z.string().max(200).optional(),
      }),
    )
    .max(MAX_ASSETS, { error: `snapshot has too many assets (max ${MAX_ASSETS})` }),
  fonts: z
    .array(
      z.object({
        family: z.string().min(1).max(300),
        weight: z.string().max(40).default('400'),
        style: z.string().max(40).default('normal'),
        assetIds: z.array(z.string().max(32)).max(50),
        unicodeRange: z.string().max(2000).optional(),
      }),
    )
    .max(MAX_FONTS, { error: `snapshot has too many fonts (max ${MAX_FONTS})` })
    .default([]),
  reference: z
    .object({
      dataUrl: z.string().max(MAX_STRING),
      width: px,
      height: px,
    })
    .optional(),
  stats: z
    .object({
      nodes: z.number().default(0),
      truncated: z.boolean().default(false),
      warnings: z.array(z.string().max(2000)).max(500).default([]),
    })
    .default({ nodes: 0, truncated: false, warnings: [] }),
});

function describeIssues(error: z.ZodError): string {
  return error.issues
    .slice(0, 5)
    .map((i) => {
      const where = i.path.map(String).join('.');
      return where ? `${where}: ${i.message}` : i.message;
    })
    .join('; ');
}

/** Counts nodes and depth without recursion (very deep trees do not overflow the stack). */
export function measureTree(root: unknown): { nodes: number; depth: number } {
  let nodes = 0;
  let depth = 0;
  const stack: { n: unknown; d: number }[] = [{ n: root, d: 1 }];
  while (stack.length > 0) {
    const { n, d } = stack.pop()!;
    nodes++;
    if (d > depth) depth = d;
    if (nodes > MAX_SNAPSHOT_NODES * 2) break;
    const kids = (n as { children?: unknown }).children;
    if (Array.isArray(kids)) for (const k of kids) stack.push({ n: k, d: d + 1 });
  }
  return { nodes, depth };
}

/**
 * Validates the payload: format/version, size and node limits (~5000) and depth. Validation of each
 * node's content (tags, attributes, styles) is left to the core `NodeSchema`, at import time.
 */
export function validateSnapshotPayload(input: unknown): SnapshotPayload {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new SnapshotImportError(
      400,
      'Invalid snapshot: expected a JSON object in the "mockup-snapshot" format.',
    );
  }
  const parsed = PayloadSchema.safeParse(input);
  if (!parsed.success) {
    throw new SnapshotImportError(400, `Invalid snapshot: ${describeIssues(parsed.error)}.`);
  }
  const { nodes, depth } = measureTree(parsed.data.root);
  if (nodes > MAX_SNAPSHOT_NODES) {
    throw new SnapshotImportError(
      400,
      `Snapshot too large: more than ${MAX_SNAPSHOT_NODES} nodes. Capture a smaller element (selector) or a smaller width.`,
    );
  }
  if (depth > MAX_SNAPSHOT_DEPTH) {
    throw new SnapshotImportError(
      400,
      `Invalid snapshot: tree deeper than ${MAX_SNAPSHOT_DEPTH} levels.`,
    );
  }
  return parsed.data as unknown as SnapshotPayload;
}

const PlacementSchema = z.object({
  docId: z.string().min(1).max(200).optional(),
  pageId: z.string().min(1).max(200).optional(),
  x: z.number().finite().optional(),
  y: z.number().finite().optional(),
  reference: z.boolean().optional(),
  name: z.string().max(200).optional(),
});

/** Extracts and validates the placement fields of an object (request body). */
export function parsePlacement(input: unknown): ImportPlacement {
  const raw = (input ?? {}) as Record<string, unknown>;
  const picked = Object.fromEntries(
    Object.entries(raw).filter(
      ([k, v]) =>
        ['docId', 'pageId', 'x', 'y', 'reference', 'name'].includes(k) &&
        v !== null &&
        v !== undefined,
    ),
  );
  const r = PlacementSchema.safeParse(picked);
  if (!r.success)
    throw new SnapshotImportError(400, `Invalid parameters: ${describeIssues(r.error)}.`);
  return r.data;
}

/** Only http/https; returns the normalized URL. */
export function parseHttpUrl(value: unknown, field = 'url'): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new SnapshotImportError(400, `Missing required field: ${field}.`);
  }
  let u: URL;
  try {
    u = new URL(value.trim());
  } catch {
    throw new SnapshotImportError(400, `Invalid ${field}: "${value.slice(0, 200)}".`);
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new SnapshotImportError(
      400,
      `${field} has a disallowed protocol (${u.protocol}): only http: and https: can be imported (file:, data:, javascript: and chrome: are rejected).`,
    );
  }
  return u.href;
}

export interface CaptureParams {
  viewport: SnapshotViewport;
  timeoutMs: number;
  selector?: string;
}

/** Viewport (width and height within `IMPORT_VIEWPORT_LIMITS`), timeout (capped) and selector. */
export function parseCaptureParams(input: {
  viewport?: Partial<SnapshotViewport>;
  timeoutMs?: unknown;
  selector?: unknown;
}): CaptureParams {
  const width = input.viewport?.width ?? DEFAULT_IMPORT_VIEWPORT.width;
  const height = input.viewport?.height ?? DEFAULT_IMPORT_VIEWPORT.height;
  const lim = IMPORT_VIEWPORT_LIMITS;
  if (
    typeof width !== 'number' ||
    !Number.isFinite(width) ||
    width < lim.minWidth ||
    width > lim.maxWidth
  ) {
    throw new SnapshotImportError(
      400,
      `Invalid viewport width (${String(width)}): use ${lim.minWidth} to ${lim.maxWidth} px.`,
    );
  }
  if (
    typeof height !== 'number' ||
    !Number.isFinite(height) ||
    height < lim.minHeight ||
    height > lim.maxHeight
  ) {
    throw new SnapshotImportError(
      400,
      `Invalid viewport height (${String(height)}): use ${lim.minHeight} to ${lim.maxHeight} px.`,
    );
  }
  let timeoutMs = DEFAULT_IMPORT_TIMEOUT_MS;
  if (input.timeoutMs !== undefined && input.timeoutMs !== null) {
    if (
      typeof input.timeoutMs !== 'number' ||
      !Number.isFinite(input.timeoutMs) ||
      input.timeoutMs <= 0
    ) {
      throw new SnapshotImportError(
        400,
        'Invalid timeoutMs: use a number of milliseconds greater than 0.',
      );
    }
    timeoutMs = Math.min(input.timeoutMs, MAX_IMPORT_TIMEOUT_MS);
  }
  let selector: string | undefined;
  if (input.selector !== undefined && input.selector !== null && input.selector !== '') {
    if (typeof input.selector !== 'string' || input.selector.length > 2000) {
      throw new SnapshotImportError(
        400,
        'Invalid selector: use a CSS selector (text of up to 2000 characters).',
      );
    }
    selector = input.selector;
  }
  return {
    viewport: { width: Math.round(width), height: Math.round(height) },
    timeoutMs,
    selector,
  };
}
