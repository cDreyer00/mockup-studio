/**
 * Motion runtime: plays the document's node animations with the Web Animations API, on the
 * compositor, without re-rendering React per frame and without per-node timers.
 *
 * A `MotionScope` belongs to one rendering surface (the canvas, the presentation, the render page).
 * Animated nodes register their element (`attach`) and the root frame registers itself (`setFrame`);
 * each frame has a mode:
 *
 * - `rest`: the design state. Only infinite loops exist and, on the canvas, follow the effects clock
 *   (play/pause) and pause while the frame is off screen.
 * - `seek`: paused at a point of the frame's timeline (linear `time`, or a build state).
 * - `play`: the linear timeline running in real time from `from` (all builds back to back).
 * - `builds`: presentation: `clicks` click builds played (with `animate`, the last one starts now).
 *
 * All the animations of a build share one start time on the document timeline, so the browser
 * keeps them in sync; seeking only writes `currentTime`.
 */
import {
  buildTimesAt,
  compileNodeMotion,
  frameMotionTimeline,
  toWaapiKeyframes,
} from '@mockup/core';
import type { CompiledMotion, MotionAt, MotionTarget, MotionTimeline, Node } from '@mockup/core';
import { fxNow, useFxClock } from '../fx/clock';

export type FrameMotionMode =
  | { type: 'rest' }
  | { type: 'seek'; at: MotionAt }
  | { type: 'play'; from: number }
  | { type: 'builds'; clicks: number; animate: boolean };

export interface MotionScopeOptions {
  /** Infinite loops play in the rest (design) state (canvas). Default false (deterministic render). */
  loopsInRest?: boolean;
  /** Rest-state loops follow the effects clock (play/pause, manual time). Default = `loopsInRest`. */
  followClock?: boolean;
  /** Scroll container used to pause frames that are off screen (canvas viewport). */
  viewport?: () => Element | null;
}

interface Live {
  anim: Animation;
  build: number;
  loop: boolean;
  /** Delay inside the build (ms): rest-state loops start already past it. */
  delay: number;
}

interface NodeEntry {
  node: Node;
  /** `null` = resolved inside the frame element by `data-node-id` (media views). */
  el: HTMLElement | null;
  compiled: CompiledMotion[];
  live: Live[];
  /** Which animations exist: only loops (`rest`) or all (`active`). */
  set: 'rest' | 'active' | null;
}

interface FrameEntry {
  id: string;
  frame: Node | null;
  el: HTMLElement | null;
  timeline: MotionTimeline | null;
  mode: FrameMotionMode;
  /** `play`: document time at which the linear timeline was at 0. */
  origin: number;
  /** `builds`: document time at which each played build started. */
  buildStarts: Map<number, number>;
  nodes: Map<string, NodeEntry>;
  visible: boolean;
}

const REST: FrameMotionMode = { type: 'rest' };

const compiledCache = new WeakMap<Node, CompiledMotion[]>();

function compiledOf(node: Node): CompiledMotion[] {
  let c = compiledCache.get(node);
  if (!c) {
    c = compileNodeMotion(node);
    compiledCache.set(node, c);
  }
  return c;
}

/** Web Animations available (absent in jsdom/node tests). */
function canAnimate(el: Element | null | undefined): el is HTMLElement {
  return !!el && typeof (el as HTMLElement).animate === 'function';
}

function docNow(): number {
  const t = typeof document !== 'undefined' ? document.timeline?.currentTime : null;
  return typeof t === 'number' ? t : typeof performance !== 'undefined' ? performance.now() : 0;
}

function cssEscape(id: string): string {
  return id.replace(/["\\]/g, '\\$&');
}

/**
 * Text segments of the node itself: segments of a descendant node (its own split) are skipped,
 * otherwise the indexes would shift onto them.
 */
function ownSegments(root: HTMLElement): Element[] {
  return Array.from(root.querySelectorAll('[data-motion-seg]')).filter((seg) => {
    for (let p = seg.parentElement; p && p !== root; p = p.parentElement)
      if (p.hasAttribute('data-node-id')) return false;
    return true;
  });
}

/** Element a compiled animation moves inside the node's element (`segs`: lazy `ownSegments`). */
function targetOf(root: HTMLElement, target: MotionTarget, segs: () => Element[]): Element | null {
  if (target.type === 'self') return root;
  if (target.type === 'child') return root.children[target.index] ?? null;
  return segs()[target.index] ?? null;
}

let warned = false;

export class MotionScope {
  private frames = new Map<string, FrameEntry>();
  private timelineListeners = new Set<(frameId: string) => void>();
  private io: IntersectionObserver | null = null;
  private unsubClock: (() => void) | null = null;
  private readonly loopsInRest: boolean;

  constructor(private readonly opts: MotionScopeOptions = {}) {
    this.loopsInRest = !!opts.loopsInRest;
    if (opts.followClock ?? this.loopsInRest) {
      this.unsubClock = useFxClock.subscribe((s, p) => {
        if (s.playing !== p.playing || s.manual !== p.manual) this.refreshRest();
      });
    }
  }

  /* ---------------- registration ---------------- */

  /** The root frame (rendered) registers itself: its node gives the build offsets. */
  setFrame(frameId: string, frame: Node, el: HTMLElement | null): () => void {
    const f = this.ensure(frameId);
    const timeline = frameMotionTimeline(frame);
    const changed = f.timeline !== timeline;
    f.frame = frame;
    f.timeline = timeline;
    if (f.el !== el) {
      if (f.el) this.io?.unobserve(f.el);
      f.el = el;
      if (el) this.observe(el);
    }
    // media nodes waiting for the frame element
    for (const n of f.nodes.values()) if (!n.el || !n.el.isConnected) this.rebuild(f, n);
    if (changed && f.mode.type !== 'rest') this.applyFrame(f);
    if (changed) for (const cb of this.timelineListeners) cb(frameId);
    return () => {
      const cur = this.frames.get(frameId);
      if (!cur || cur.el !== el) return;
      if (el) this.io?.unobserve(el);
      cur.el = null;
      if (cur.nodes.size === 0) this.frames.delete(frameId);
    };
  }

  /**
   * An animated node registers its element (`null` for media views: found by `data-node-id` inside
   * the frame). Returns the function that removes it.
   */
  attach(frameId: string, node: Node, el: HTMLElement | null): () => void {
    const f = this.ensure(frameId);
    const prev = f.nodes.get(node.id);
    if (prev && prev.node === node && prev.el === el) return () => this.detach(frameId, node, el);
    if (prev) this.cancel(prev);
    const entry: NodeEntry = { node, el, compiled: compiledOf(node), live: [], set: null };
    f.nodes.set(node.id, entry);
    this.rebuild(f, entry);
    return () => this.detach(frameId, node, el);
  }

  private detach(frameId: string, node: Node, el: HTMLElement | null): void {
    const f = this.frames.get(frameId);
    const entry = f?.nodes.get(node.id);
    if (!f || !entry || entry.node !== node || entry.el !== el) return;
    this.cancel(entry);
    f.nodes.delete(node.id);
    if (f.nodes.size === 0 && !f.el) this.frames.delete(frameId);
  }

  /** Called with the frame id whenever a registered frame's timeline changes (document edits). */
  onTimeline(cb: (frameId: string) => void): () => void {
    this.timelineListeners.add(cb);
    return () => this.timelineListeners.delete(cb);
  }

  /* ---------------- modes ---------------- */

  getMode(frameId: string): FrameMotionMode {
    return this.frames.get(frameId)?.mode ?? REST;
  }

  /** Timeline of a registered frame (null when it is not rendered by this scope). */
  timeline(frameId: string): MotionTimeline | null {
    return this.frames.get(frameId)?.timeline ?? null;
  }

  /** Current point of the linear timeline of a frame in `play` mode (ms), else of `seek` time. */
  linearTime(frameId: string): number {
    const f = this.frames.get(frameId);
    if (!f) return 0;
    if (f.mode.type === 'play') return docNow() - f.origin;
    if (f.mode.type === 'seek' && f.mode.at.build === undefined) return f.mode.at.time;
    return 0;
  }

  setMode(frameId: string, mode: FrameMotionMode): void {
    const f = this.ensure(frameId);
    const now = docNow();
    if (mode.type === 'play') {
      f.origin = now - mode.from;
    } else if (mode.type === 'builds') {
      f.buildStarts = this.nextBuildStarts(f, mode, now);
    }
    f.mode = mode;
    this.applyFrame(f);
  }

  /** Every frame back to the design state. */
  resetAll(): void {
    for (const f of this.frames.values()) {
      if (f.mode.type === 'rest') continue;
      f.mode = REST;
      this.applyFrame(f);
    }
  }

  dispose(): void {
    for (const f of this.frames.values()) for (const n of f.nodes.values()) this.cancel(n);
    this.frames.clear();
    this.timelineListeners.clear();
    this.io?.disconnect();
    this.io = null;
    this.unsubClock?.();
    this.unsubClock = null;
  }

  /** Number of live Web Animations (diagnostics and tests). */
  liveCount(): number {
    let n = 0;
    for (const f of this.frames.values()) for (const e of f.nodes.values()) n += e.live.length;
    return n;
  }

  /* ---------------- internals ---------------- */

  private ensure(frameId: string): FrameEntry {
    let f = this.frames.get(frameId);
    if (!f) {
      f = {
        id: frameId,
        frame: null,
        el: null,
        timeline: null,
        mode: REST,
        origin: 0,
        buildStarts: new Map(),
        nodes: new Map(),
        visible: true,
      };
      this.frames.set(frameId, f);
    }
    return f;
  }

  private ioRoot: Element | null = null;

  /** The viewport element changed (canvas remount): observe the frames against the new one. */
  refreshViewport(): void {
    this.io?.disconnect();
    this.io = null;
    for (const f of this.frames.values()) {
      f.visible = true;
      if (f.el) this.observe(f.el);
    }
  }

  private observe(el: Element): void {
    if (!this.opts.viewport || typeof IntersectionObserver === 'undefined') return;
    const root = this.opts.viewport();
    if (this.io && this.ioRoot !== root) {
      this.refreshViewport();
      return;
    }
    if (!this.io) {
      this.ioRoot = root;
      this.io = new IntersectionObserver(
        (entries) => {
          for (const e of entries) {
            const id = (e.target as HTMLElement).dataset.nodeId;
            const f = id ? this.frames.get(id) : undefined;
            if (!f || f.visible === e.isIntersecting) continue;
            f.visible = e.isIntersecting;
            if (f.mode.type === 'rest') this.applyFrame(f);
          }
        },
        { root, rootMargin: '25%' },
      );
    }
    this.io.observe(el);
  }

  private refreshRest(): void {
    for (const f of this.frames.values()) if (f.mode.type === 'rest') this.applyFrame(f);
  }

  /** Start times of the played builds for a `builds` mode, keeping the ones already running. */
  private nextBuildStarts(
    f: FrameEntry,
    mode: { clicks: number; animate: boolean },
    now: number,
  ): Map<number, number> {
    const builds = f.timeline?.builds ?? [{ build: 0, click: 0, start: 0, duration: 0, items: 0 }];
    const prev = f.mode.type === 'builds' ? f.buildStarts : null;
    const clicks = Math.min(Math.max(0, mode.clicks), builds.length - 1);
    const out = new Map<number, number>();
    for (let i = 0; i <= clicks; i++) {
      const b = builds[i]!;
      const kept = prev?.get(b.build);
      if (kept !== undefined) out.set(b.build, kept);
      else if (mode.animate && i === clicks) out.set(b.build, now);
      else out.set(b.build, now - b.duration);
    }
    return out;
  }

  /**
   * Element of a node. Media views (`el` null) mark their root with the node's FULL id, clone suffix
   * included (`vd_x~2`), so each repeater clone resolves to its own element, never the template's.
   */
  private element(f: FrameEntry, n: NodeEntry): HTMLElement | null {
    if (n.el) return n.el;
    const root = f.el;
    if (!root) return null;
    if (root.dataset.nodeId === n.node.id) return root;
    return root.querySelector<HTMLElement>(`[data-node-id="${cssEscape(n.node.id)}"]`);
  }

  private cancel(n: NodeEntry): void {
    for (const l of n.live) l.anim.cancel();
    n.live = [];
    n.set = null;
  }

  /** (Re)creates the node's animations for the frame mode, then positions them. */
  private rebuild(f: FrameEntry, n: NodeEntry): void {
    this.cancel(n);
    const want = f.mode.type === 'rest' ? 'rest' : 'active';
    const el = this.element(f, n);
    if (!canAnimate(el)) return;
    let segs: Element[] | null = null;
    const segments = (): Element[] => (segs ??= ownSegments(el));
    for (const c of n.compiled) {
      const loop = c.timing.iterations === Infinity;
      if (want === 'rest' && (!loop || !this.loopsInRest)) continue;
      const target = targetOf(el, c.target, segments);
      if (!canAnimate(target)) continue;
      try {
        const anim = target.animate(toWaapiKeyframes(c.keyframes) as Keyframe[], {
          duration: c.timing.duration,
          delay: c.timing.delay,
          easing: c.timing.easing,
          iterations: c.timing.iterations,
          direction: c.timing.direction,
          fill: c.timing.fill,
        });
        anim.pause();
        anim.persist?.();
        n.live.push({ anim, build: c.build, loop, delay: c.timing.delay });
      } catch (e) {
        if (!warned) {
          warned = true;
          console.warn('[motion] animation skipped:', e);
        }
      }
    }
    n.set = want;
    this.applyNode(f, n, docNow());
  }

  private applyFrame(f: FrameEntry): void {
    const want = f.mode.type === 'rest' ? 'rest' : 'active';
    const now = docNow();
    for (const n of f.nodes.values()) {
      if (n.set !== want) this.rebuild(f, n);
      else this.applyNode(f, n, now);
    }
  }

  private applyNode(f: FrameEntry, n: NodeEntry, now: number): void {
    if (!n.live.length) return;
    const mode = f.mode;
    switch (mode.type) {
      case 'rest': {
        const clock = useFxClock.getState();
        const running = clock.playing && clock.manual === null && f.visible;
        const t = fxNow() * 1000;
        for (const l of n.live) {
          if (running) {
            l.anim.play();
            l.anim.startTime = now - (l.delay + t);
          } else {
            l.anim.pause();
            l.anim.currentTime = l.delay + t;
          }
        }
        return;
      }
      case 'seek': {
        const times = f.timeline ? buildTimesAt(f.timeline, mode.at) : null;
        for (const l of n.live) {
          l.anim.pause();
          l.anim.currentTime = Math.max(0, times?.get(l.build) ?? 0);
        }
        return;
      }
      case 'play': {
        const builds = f.timeline?.builds;
        for (const l of n.live) {
          const start = builds?.find((b) => b.build === l.build)?.start ?? 0;
          l.anim.play();
          l.anim.startTime = f.origin + start;
        }
        return;
      }
      case 'builds': {
        for (const l of n.live) {
          const start = f.buildStarts.get(l.build);
          if (start === undefined) {
            l.anim.pause();
            l.anim.currentTime = 0;
          } else {
            l.anim.play();
            l.anim.startTime = start;
          }
        }
        return;
      }
    }
  }
}
