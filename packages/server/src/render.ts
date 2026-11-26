/**
 * Render engine contract. The daemon does not depend on Electron: the desktop app (`@mockup/desktop`)
 * injects an implementation in `startDaemon({ render })`. Without it, screenshot, `get_layout` and
 * measured SVG are unavailable (the tools explain how to enable them).
 */
import type { Document, LayoutNode, PreviewState } from '@mockup/core';
import type { PageSnapshotRequest, PageSnapshotResult } from '@mockup/snapshot-core';

export type RenderScale = 1 | 2 | 3;
export type RenderFormat = 'png' | 'jpg';

export interface RenderTarget {
  /** Whole document (the render uses tokens, fonts and the frame that contains the node). */
  doc: Document;
  docId: string;
  /** Node to capture; the root frame that contains it is rendered whole and cropped to the node. */
  nodeId: string;
  /**
   * The document's `assets/` folder (or null if unsaved). The engine uses the size and date of the
   * referenced files (images and fonts) in the cache key, so it never returns a stale render.
   */
  assetsDir?: string | null;
}

export interface CaptureRequest extends RenderTarget {
  scale?: RenderScale;
  format?: RenderFormat;
  /** JPG quality (0–100, default 90). */
  quality?: number;
  /** Maximum width of the final image in px (scales down keeping the aspect ratio). */
  maxWidth?: number;
  /** Transparent background outside the content (PNG). Default `false`. */
  transparent?: boolean;
  /** Preview state (hover, focus, dark...): applies the node's `states` like the editor preview. */
  state?: PreviewState;
  /**
   * Time (s) of the animations in the captured frame: effects, particles, video, Lottie, Rive and
   * Three.js. Default 0 (video with `poster` shows the poster when `time` is not given). Node
   * animations (`node.animations`) follow the frame's linear motion timeline at this time; without
   * `time` and `build` they show the design state (as on the canvas).
   */
  time?: number;
  /**
   * Node animations after this build (0 = the automatic one, 1 = first click...): earlier builds
   * finished, later ones not started; with `time`, that many seconds into the build.
   */
  build?: number;
  /**
   * Filmstrip: one cell per instant (s, like `time`; relative to `build` when given), laid out in a
   * single image, left to right, top to bottom (at most 12).
   */
  times?: number[];
  /** Filmstrip columns (default: up to 4). */
  columns?: number;
}

/** Capture of N PNG frames of an animated node (to export mp4, webm or gif). */
export interface FramesRequest extends RenderTarget {
  scale?: RenderScale;
  /** Maximum width of each frame in px (scales down keeping the aspect ratio). */
  maxWidth?: number;
  /** Frames per second (1 to 60). */
  fps: number;
  /** Duration in seconds (> 0). */
  duration: number;
  /** Start time (s), default 0. */
  start?: number;
}

export interface FramesInfo {
  /** Number of frames delivered. */
  frames: number;
  /** Size of each frame in px. */
  pixelWidth: number;
  pixelHeight: number;
}

export interface CaptureResult {
  data: Buffer;
  mime: 'image/png' | 'image/jpeg';
  /** Node size in CSS px. */
  width: number;
  height: number;
  /** Size of the generated image in px. */
  pixelWidth: number;
  pixelHeight: number;
}

export interface RenderProvider {
  capture(req: CaptureRequest): Promise<CaptureResult>;
  /** Geometry of the node's subtree, relative to the root frame (see `LayoutNode`). */
  measure(target: RenderTarget): Promise<LayoutNode>;
  /**
   * Opens the URL (or the HTML) in an isolated window, runs the `@mockup/snapshot-core` capture on
   * the element and returns the snapshot (import_url/import_html). Optional: without it, URL import
   * is unavailable and HTML import falls back to the core conversion.
   */
  snapshot?(req: PageSnapshotRequest): Promise<PageSnapshotResult>;
  /**
   * Renders the node into `round(duration × fps)` frames, with the animation clock at
   * `start + i / fps`, and hands each PNG in order to `onFrame` (which may be async: the
   * next frame waits). Optional: engines without animation do not implement it.
   */
  captureFrames?(
    req: FramesRequest,
    onFrame: (png: Buffer, index: number) => Promise<void> | void,
  ): Promise<FramesInfo>;
  close?(): Promise<void>;
}

/** Render-unavailable message with the pid and port of the render-less daemon and how to fix it. */
export function renderUnavailableMessage(info: { pid?: number; port?: number } = {}): string {
  const who =
    info.pid !== undefined
      ? ` This is a Node daemon without render (pid ${info.pid}${info.port !== undefined ? `, port ${info.port}` : ''}).`
      : '';
  return (
    RENDER_UNAVAILABLE +
    who +
    ' To replace it with one that has screenshot support: stop it with `mockup stop` (or kill the process by pid) ' +
    'and call the tool again, or open the desktop app, which takes over the port on its own.'
  );
}

export const RENDER_UNAVAILABLE =
  'The render engine is not available in this daemon (plain Node daemon, no Electron). ' +
  'Open the Mockup Studio desktop app or run `mockup serve --render` (`mockup mcp` starts ' +
  'headless Electron automatically when it is installed).';
