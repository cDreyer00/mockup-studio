/**
 * Render page API (`window.__mockupRender`), used by the desktop app's main process
 * for faithful screenshots and for `get_layout`. It does not connect to the daemon: it receives the finished document.
 */
import { createElement } from 'react';
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import type {
  Document,
  LayoutGrid,
  LayoutNode,
  LayoutRect,
  LayoutStyle,
  LayoutTextLine,
  Node,
  PreviewState,
  RenderBox,
} from '@mockup/core';
import { buildOfClick, expandDocument, frameMotionTimeline, linearTimeAt } from '@mockup/core';
import type { MotionAt } from '@mockup/core';
import { fxClock } from '../fx/clock';
import { fxRenderInfo, fxSettled } from '../fx/ready';
import { MotionScope } from '../motion/scope';
import { RenderApp, renderFrameOf } from './RenderApp';
import { FILMSTRIP_MAX_CELLS, FILMSTRIP_MAX_COLUMNS, Filmstrip } from './Filmstrip';
import type { FilmstripCell } from './Filmstrip';
import {
  LAYOUT_STYLE_PROPS,
  fitLineBox,
  groupLines,
  measureGridTracks,
  pickFrame,
} from './measure';
import type { CharBox } from './measure';

export interface RenderPayload {
  doc: Document;
  docId: string;
  nodeId: string;
  transparent?: boolean;
  /** State preview (hover, focus, active, focus-visible, disabled, dark). */
  state?: PreviewState;
  /**
   * Animation instant (s) of effects, video and node animations (along the frame's linear timeline).
   * Without `time` and `build`: effects at 0 (a video with a poster shows the poster) and node
   * animations in the design state.
   */
  time?: number;
  /**
   * State after this many CLICKS (0 = only the automatic build; counted in play order, not by build
   * number): earlier builds finished, later ones not started; with `time`, seconds into it.
   */
  build?: number;
  /**
   * Filmstrip: one cell per instant (1 to 12, s, relative to `build` when given), in a single grid.
   * Always whole frames (`nodeId` only selects the frame). The effects clock holds one time: the first.
   * `measure()` is not available after a filmstrip.
   */
  times?: number[];
  /** Filmstrip columns (1 to 12, default `min(times.length, 4)`). */
  columns?: number;
}

export interface MockupRenderApi {
  render(payload: RenderPayload): Promise<RenderBox>;
  measure(nodeId: string): LayoutNode;
  /** Changes the time of the already rendered frame and waits for the animations to draw (capturing N frames). */
  setTime(t: number): Promise<void>;
}

declare global {
  interface Window {
    __mockupRenderReady?: boolean;
    __mockupRender?: MockupRenderApi;
  }
}

const ASSET_TIMEOUT_MS = 5000;
const DEFAULT_PAGE_BG = '#0f1115';

const raf = (): Promise<void> => new Promise((r) => requestAnimationFrame(() => r()));
const FX_TIMEOUT_MS = 10000;
const timeout = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const esc = (id: string): string => `[data-node-id="${id.replace(/["\\]/g, '\\$&')}"]`;

/** Waits for the image to load and decode (with a time limit; an error does not hang). */
async function imageReady(img: HTMLImageElement): Promise<void> {
  const work = (async () => {
    if (!img.complete) {
      await new Promise<void>((resolve) => {
        img.addEventListener('load', () => resolve(), { once: true });
        img.addEventListener('error', () => resolve(), { once: true });
      });
    }
    try {
      await img.decode();
    } catch {
      /* broken image: carry on */
    }
  })();
  await Promise.race([work, timeout(ASSET_TIMEOUT_MS)]);
}

function rectIn(el: Element, origin: DOMRect) {
  const r = el.getBoundingClientRect();
  return { x: r.left - origin.left, y: r.top - origin.top, width: r.width, height: r.height };
}

let ctx2d: CanvasRenderingContext2D | null | undefined;
/** Ascent/descent of the element's font (font metric, not of the text). */
function fontMetrics(cs: CSSStyleDeclaration): { ascent: number; descent: number } {
  const size = parseFloat(cs.fontSize) || 16;
  try {
    if (ctx2d === undefined) ctx2d = document.createElement('canvas').getContext('2d');
    if (ctx2d) {
      ctx2d.font = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
      const m = ctx2d.measureText('Hg');
      if (m.fontBoundingBoxAscent !== undefined && m.fontBoundingBoxDescent !== undefined)
        return { ascent: m.fontBoundingBoxAscent, descent: m.fontBoundingBoxDescent };
    }
  } catch {
    /* no canvas: approximate */
  }
  return { ascent: size * 0.8, descent: size * 0.2 };
}

function textLines(el: HTMLElement, origin: DOMRect): LayoutTextLine[] {
  const cs = getComputedStyle(el);
  const chars: CharBox[] = [];
  const range = document.createRange();
  // All descendant text (split text renders spans), except the text of other nodes (child nodes).
  const walker = document.createTreeWalker(el, 4 /* NodeFilter.SHOW_TEXT */);
  for (let child = walker.nextNode(); child; child = walker.nextNode()) {
    if (child.parentElement?.closest('[data-node-id]') !== el) continue;
    const text = child.textContent ?? '';
    for (let i = 0; i < text.length; i++) {
      range.setStart(child, i);
      range.setEnd(child, i + 1);
      const rect = range.getClientRects()[0];
      if (!rect) continue;
      chars.push({
        ch: text[i]!,
        x: rect.left - origin.left,
        y: rect.top - origin.top,
        width: rect.width,
        height: rect.height,
      });
    }
  }
  const metrics = fontMetrics(cs);
  const lhRaw = parseFloat(cs.lineHeight);
  const lineHeight = Number.isFinite(lhRaw) ? lhRaw : null;
  return groupLines(chars).map((l) => {
    const fit = fitLineBox(l, metrics, lineHeight);
    return {
      text: l.text,
      x: l.x,
      y: fit.y,
      width: l.width,
      height: fit.height,
      baseline: fit.baseline,
    };
  });
}

function readStyle(el: Element): LayoutStyle {
  const cs = getComputedStyle(el);
  const out: LayoutStyle = {};
  for (const p of LAYOUT_STYLE_PROPS) out[p] = cs.getPropertyValue(p);
  return out;
}

/** Tracks of the node when it is a grid container (values resolved by the browser, in px). */
function gridOf(el: Element, rect: LayoutRect): LayoutGrid | undefined {
  const cs = getComputedStyle(el);
  return measureGridTracks(
    {
      display: cs.display,
      gridTemplateColumns: cs.gridTemplateColumns,
      gridTemplateRows: cs.gridTemplateRows,
      columnGap: cs.columnGap,
      rowGap: cs.rowGap,
      borderLeftWidth: cs.borderLeftWidth,
      borderTopWidth: cs.borderTopWidth,
      paddingLeft: cs.paddingLeft,
      paddingTop: cs.paddingTop,
    },
    rect,
  );
}

function findNode(n: Node, id: string): Node | null {
  if (n.id === id) return n;
  for (const c of n.children ?? []) {
    const r = findNode(c, id);
    if (r) return r;
  }
  return null;
}

/** First hidden node on the path from the frame (exclusive) to `id` (inclusive), or null. */
function hiddenOnPath(root: Node, id: string): Node | null {
  const walk = (n: Node, hiddenAbove: Node | null): Node | null | undefined => {
    const h = hiddenAbove ?? (n !== root && n.hidden ? n : null);
    if (n.id === id) return h;
    for (const c of n.children ?? []) {
      const r = walk(c, h);
      if (r !== undefined) return r;
    }
    return undefined;
  };
  return walk(root, null) ?? null;
}

function assertVisible(frame: Node, id: string): void {
  const h = hiddenOnPath(frame, id);
  if (!h) return;
  const who =
    h.id === id ? `Node "${id}" is hidden` : `Node "${id}" is inside "${h.id}", which is hidden`;
  throw new Error(`${who}; show it with set_node_flags or capture another node.`);
}

/** Validates the motion fields of the payload. */
function checkMotionFields({ time, build, times, columns }: RenderPayload): void {
  if (time !== undefined && !(Number.isFinite(time) && time >= 0))
    throw new Error(`time must be a number >= 0 (seconds), got ${String(time)}.`);
  if (build !== undefined && !(Number.isInteger(build) && build >= 0))
    throw new Error(`build must be an integer >= 0, got ${String(build)}.`);
  if (
    times !== undefined &&
    (!Array.isArray(times) ||
      times.length < 1 ||
      times.length > FILMSTRIP_MAX_CELLS ||
      !times.every((t) => typeof t === 'number' && Number.isFinite(t) && t >= 0))
  )
    throw new Error(
      `times must be 1 to ${FILMSTRIP_MAX_CELLS} numbers >= 0 (seconds), got ${JSON.stringify(times)}.`,
    );
  if (
    columns !== undefined &&
    !(Number.isInteger(columns) && columns >= 1 && columns <= FILMSTRIP_MAX_COLUMNS)
  )
    throw new Error(
      `columns must be an integer from 1 to ${FILMSTRIP_MAX_COLUMNS}, got ${String(columns)}.`,
    );
}

/**
 * Motion instant (ms) of a capture; `undefined` = design state. `clicks` is the payload's `build`:
 * a CLICK count (like `presentation_goto`), turned into the build number it reaches, so sparse build
 * numbers (e.g. 0, 2, 5) still mean 1 = after the first click.
 */
function motionAt(
  frame: Node,
  time: number | undefined,
  clicks: number | undefined,
): MotionAt | undefined {
  if (clicks !== undefined) {
    const build = buildOfClick(frameMotionTimeline(frame), clicks);
    return time !== undefined ? { build, time: time * 1000 } : { build };
  }
  return time !== undefined ? { time: time * 1000 } : undefined;
}

const fmtSeconds = (t: number): string => `${t.toFixed(2)} s`;

interface Last {
  world: HTMLElement;
  frameEl: HTMLElement;
  frame: Node;
}

/** Installs `window.__mockupRender` by mounting React in `container`. */
export function installRenderApi(container: HTMLElement): MockupRenderApi {
  let root: Root | null = null;
  let last: Last | null = null;

  // one scope for the page (single capture); filmstrip cells get their own, disposed on the next render
  const scope = new MotionScope();
  let cellScopes: MotionScope[] = [];
  let filmstrip = false;
  const disposeCells = (): void => {
    for (const s of cellScopes) s.dispose();
    cellScopes = [];
  };

  /** Fonts, images, effects and two frames: the page is ready to be captured. */
  const settle = async (world: HTMLElement): Promise<void> => {
    await document.fonts?.ready;
    await Promise.all(Array.from(world.querySelectorAll('img')).map(imageReady));
    await document.fonts?.ready;
    await fxSettled(FX_TIMEOUT_MS);
    await raf();
    await raf();
  };

  async function renderFilmstrip(p: {
    doc: Document;
    docId: string;
    frame: Node;
    state?: PreviewState;
    build?: number;
    times: number[];
    columns?: number;
  }): Promise<RenderBox> {
    const { doc, docId, frame, state, build, times } = p;
    const columns = Math.min(p.columns ?? 4, times.length);
    scope.resetAll();
    disposeCells();
    last = null;
    filmstrip = true;

    const cells: FilmstripCell[] = times.map((t) => {
      const s = new MotionScope();
      cellScopes.push(s);
      s.setMode(frame.id, { type: 'seek', at: motionAt(frame, t, build)! });
      return {
        scope: s,
        label: build !== undefined ? `click ${build} + ${fmtSeconds(t)}` : fmtSeconds(t),
      };
    });

    // The effects clock holds one time: the first cell's.
    fxRenderInfo.explicitTime = true;
    fxClock.setManual(
      linearTimeAt(frameMotionTimeline(frame), motionAt(frame, times[0]!, build)!) / 1000,
    );

    root ??= createRoot(container);
    flushSync(() =>
      root!.render(createElement(Filmstrip, { doc, docId, frame, state, cells, columns })),
    );

    const grid = container.firstElementChild as HTMLElement | null;
    const cellEls = Array.from(container.querySelectorAll<HTMLElement>('[data-filmstrip-cell]'));
    const frameEls = cellEls.map((c) => c.querySelector<HTMLElement>(esc(frame.id)));
    if (!grid || frameEls.some((f) => !f)) throw new Error(`Failed to render frame ${frame.id}`);
    void grid.getBoundingClientRect(); // forces layout, which triggers font loading
    await settle(grid);

    // Cells take the frame size (the render world is absolute and gives them none).
    const fr = frameEls[0]!.getBoundingClientRect();
    for (const c of cellEls) {
      c.style.width = `${fr.width}px`;
      c.style.height = `${fr.height}px`;
    }
    await raf();
    const g = grid.getBoundingClientRect();
    return {
      frameId: frame.id,
      frameWidth: Math.ceil(g.width),
      frameHeight: Math.ceil(g.height),
      x: g.left,
      y: g.top,
      width: g.width,
      height: g.height,
    };
  }

  const api: MockupRenderApi = {
    async render(payload) {
      checkMotionFields(payload);
      const { doc: received, docId, nodeId, transparent, state, time, build, times } = payload;
      // The daemon sends the document already expanded; a document with raw instances also works.
      const doc = expandDocument(received);
      const picked = pickFrame(doc, nodeId);
      if (!picked) throw new Error(`Node not found in the document: ${nodeId}`);
      const frame = renderFrameOf(picked.frame);
      assertVisible(frame, nodeId);

      const bg = transparent ? 'transparent' : picked.background || DEFAULT_PAGE_BG;
      for (const el of [document.documentElement, document.body]) {
        el.style.background = bg;
        el.style.margin = '0';
        el.style.overflow = 'hidden';
      }
      // No background: prevents the theme's `color-scheme: dark` from painting the screen beneath the frame.
      document.documentElement.style.colorScheme = transparent ? 'normal' : '';

      if (times)
        return renderFilmstrip({
          doc,
          docId,
          frame,
          state,
          build,
          times,
          columns: payload.columns,
        });

      // Node animations: design state without time/build, else seeked at the instant.
      const at = motionAt(frame, time, build);
      filmstrip = false;
      disposeCells();
      scope.resetAll();
      if (at) scope.setMode(frame.id, { type: 'seek', at });

      // Effects in manual time (deterministic), at the same instant as the node animations;
      // an explicit instant is remembered (poster rule).
      fxRenderInfo.explicitTime = at !== undefined;
      fxClock.setManual(at ? linearTimeAt(frameMotionTimeline(frame), at) / 1000 : 0);

      root ??= createRoot(container);
      flushSync(() =>
        root!.render(createElement(RenderApp, { doc, docId, frame, state, motion: scope })),
      );

      const world = container.firstElementChild as HTMLElement | null;
      const frameEl = world?.querySelector<HTMLElement>(esc(frame.id));
      if (!world || !frameEl) throw new Error(`Failed to render frame ${frame.id}`);
      last = { world, frameEl, frame };

      void frameEl.getBoundingClientRect(); // forces layout, which triggers font loading
      await settle(world);

      const fr = frameEl.getBoundingClientRect();
      const target = world.querySelector(esc(nodeId));
      const box = target ? rectIn(target, fr) : { x: 0, y: 0, width: fr.width, height: fr.height };
      return {
        frameId: frame.id,
        frameWidth: Math.ceil(fr.width),
        frameHeight: Math.ceil(fr.height),
        ...box,
      };
    },

    async setTime(t) {
      if (!last) throw new Error('Nothing has been rendered yet: call render() before setTime().');
      fxRenderInfo.explicitTime = true;
      scope.setMode(last.frame.id, { type: 'seek', at: { time: t * 1000 } });
      fxClock.setManual(t);
      await raf(); // lets the views react to the new time and register pending items
      await fxSettled(FX_TIMEOUT_MS);
      await raf();
      await raf();
    },

    measure(nodeId) {
      if (filmstrip)
        throw new Error(
          'measure() is not available after a filmstrip capture: render a single instant first.',
        );
      if (!last) throw new Error('Nothing has been rendered yet: call render() before measure().');
      const { world, frameEl, frame } = last;
      const node = findNode(frame, nodeId);
      if (!node) throw new Error(`Node ${nodeId} is not in the last render (frame ${frame.id}).`);
      assertVisible(frame, nodeId);
      const origin = frameEl.getBoundingClientRect();

      const build = (n: Node): LayoutNode | null => {
        const el = world.querySelector<HTMLElement>(esc(n.id));
        if (!el) return null;
        const out: LayoutNode = {
          id: n.id,
          name: n.name,
          type: n.type,
          tag: n.tag,
          ...rectIn(el, origin),
          style: readStyle(el),
          children: [],
        };
        if (n.type === 'text') out.lines = textLines(el, origin);
        const grid = gridOf(el, out);
        if (grid) out.grid = grid;
        if (n.type === 'image' && n.src) out.src = n.src;
        // effect/video/embed are boxes: no text lines.
        for (const c of n.children ?? []) {
          if (c.hidden) continue;
          const m = build(c);
          if (m) out.children.push(m);
        }
        return out;
      };
      const result = build(node);
      if (!result) throw new Error(`Node ${nodeId} was not rendered (hidden?).`);
      return result;
    },
  };
  window.__mockupRender = api;
  window.__mockupRenderReady = true;
  return api;
}
