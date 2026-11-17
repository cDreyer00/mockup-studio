/**
 * In-browser capture: serializes the subtree of a DOM element into core nodes with reduced
 * computed styles. Runs in the page (extension, headless Electron via executeJavaScript, tests).
 */
import { createNodeFromTag, type Node } from '@mockup/core';
import { AssetRegistry, inlineAssets } from './capture/assets.js';
import { Defaults } from './capture/defaults.js';
import { collectFonts } from './capture/fonts.js';
import { PLACEHOLDER_NAMES, REPLACED_TAGS } from './capture/props.js';
import { type TreeCtx, visit } from './capture/tree.js';
import { isTransparent, px } from './capture/util.js';
import {
  SNAPSHOT_FORMAT,
  SNAPSHOT_LIMITS,
  SNAPSHOT_VERSION,
  type SnapshotPayload,
} from './format.js';

export interface CaptureOptions {
  /** Default `SNAPSHOT_LIMITS.maxNodes`. */
  maxNodes?: number;
  /** Default `SNAPSHOT_LIMITS.maxDepth`. */
  maxDepth?: number;
  /** Tries to read the bytes of images/fonts (fetch in the page) to embed them as data URLs. Default true. */
  inlineAssets?: boolean;
  /** Limit per embedded asset (bytes). */
  maxInlineAssetBytes?: number;
  /** Maximum sum of the embedded data URLs (characters). Default `SNAPSHOT_LIMITS.maxInlineTotalBytes`. */
  maxInlineTotalBytes?: number;
  /** Given selector (goes into `source.selector`). */
  selector?: string;
}

/** Above this the automatic `height` test is skipped (cheap path). */
const CHEAP_NODE_THRESHOLD = 1500;

/** First non-transparent background color from the element upwards (or `#ffffff`). */
function backgroundBehind(el: Element): string {
  for (let e: Element | null = el; e; e = e.parentElement) {
    const c = getComputedStyle(e).backgroundColor;
    if (!isTransparent(c)) return c;
  }
  return '#ffffff';
}

/** Captures the element and its subtree. */
export async function captureElement(
  el: Element,
  opts: CaptureOptions = {},
): Promise<SnapshotPayload> {
  const defaults = new Defaults();
  const assets = new AssetRegistry();
  const warnings: string[] = [];
  const ctx: TreeCtx = {
    root: el,
    defaults,
    assets,
    families: new Set(),
    maxNodes: opts.maxNodes ?? SNAPSHOT_LIMITS.maxNodes,
    maxDepth: opts.maxDepth ?? SNAPSHOT_LIMITS.maxDepth,
    count: 0,
    truncated: false,
    warnings,
    cheap: el.getElementsByTagName('*').length > CHEAP_NODE_THRESHOLD,
  };

  let root: Node;
  let width: number;
  let height: number;
  try {
    defaults.init();
    const he = el as HTMLElement;
    width = he.offsetWidth ?? el.getBoundingClientRect().width;
    height = he.offsetHeight ?? el.getBoundingClientRect().height;
    if (getComputedStyle(el).display === 'none') {
      throw new Error('The element is hidden (display: none); there is nothing to capture.');
    }

    const tag = el.localName.toLowerCase();
    const needsWrap =
      REPLACED_TAGS.has(tag) || tag in PLACEHOLDER_NAMES || tag === 'br' || tag === 'picture';
    let built: Node | null;
    if (needsWrap) {
      // The root is an element without children (img, svg, input...): a relative div of the same size wraps it.
      ctx.count++;
      const child = visit(el, defaults.body, 1, el, ctx, false);
      built = createNodeFromTag('div', {
        name: 'Snapshot',
        styles: { position: 'relative', width: px(width), height: px(height) },
        children: child ? [child] : [],
      });
    } else {
      built = visit(el, null, 0, el, ctx, true, true);
    }
    if (!built) throw new Error('The element produced no nodes (blocked or hidden tag).');
    root = built;
    root.type = 'element';
    root.style['background-color'] = backgroundBehind(el);
  } finally {
    defaults.dispose();
  }

  const fonts = await collectFonts(ctx.families, assets, (m) => warnings.push(m));

  if (opts.inlineAssets !== false) {
    await inlineAssets(assets.list, {
      maxAssetBytes: opts.maxInlineAssetBytes ?? SNAPSHOT_LIMITS.maxInlineAssetBytes,
      maxTotalBytes: opts.maxInlineTotalBytes ?? SNAPSHOT_LIMITS.maxInlineTotalBytes,
      warn: (m) => warnings.push(m),
    });
  }

  return {
    format: SNAPSHOT_FORMAT,
    version: SNAPSHOT_VERSION,
    source: {
      url: location.href,
      title: document.title,
      capturedAt: new Date().toISOString(),
      viewport: { width: window.innerWidth, height: window.innerHeight },
      devicePixelRatio: window.devicePixelRatio,
      ...(opts.selector ? { selector: opts.selector } : {}),
    },
    root,
    width,
    height,
    assets: assets.list,
    fonts,
    stats: { nodes: ctx.count, truncated: ctx.truncated, warnings },
  };
}

/** Captures the first element matching the selector (clear error if none matches). */
export async function captureSelector(
  selector: string,
  opts: CaptureOptions = {},
): Promise<SnapshotPayload> {
  const el = document.querySelector(selector);
  if (!el) throw new Error(`No element matches the selector "${selector}".`);
  return captureElement(el, { ...opts, selector });
}
