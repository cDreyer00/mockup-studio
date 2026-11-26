/**
 * Timeline of a frame (slide): its animations grouped in builds. Build 0 plays when the frame
 * appears; each click of a presentation plays the next build (distinct `build` values in increasing
 * order). The **linear timeline** lays the builds back to back (each starts when the previous one
 * ends): it is what the editor's timeline scrubs, what `get_screenshot` `time` renders and what the
 * animated export records. Times in ms.
 */
import type { AnimationKind, AnimationSplit, Node } from '../types.js';
import { animationDefaults, animationEnd, motionTargetCount } from './compile.js';
import { getSlideTransition, resolveTransition } from './transitions.js';
import type { ResolvedTransition } from './transitions.js';

export interface MotionTimelineItem {
  nodeId: string;
  name: string;
  /** Index in `node.animations`. */
  index: number;
  kind: AnimationKind;
  preset: string;
  build: number;
  /** Position of its build in the play order (0 = automatic, 1 = first click...). */
  click: number;
  /** Start on the linear timeline (first target). */
  start: number;
  /** End on the linear timeline (last target); `null` = loops forever. */
  end: number | null;
  delay: number;
  /** One iteration. */
  duration: number;
  iterations: number | 'infinite';
  /** Named or CSS easing (defaults filled in). */
  easing: string;
  split?: AnimationSplit;
  targets: number;
  stagger: number;
}

export interface MotionTimelineBuild {
  build: number;
  /** 0 = automatic (when the frame appears), then 1, 2... per click. */
  click: number;
  /** Start on the linear timeline. */
  start: number;
  /** Until its last finite animation ends (loops do not count). */
  duration: number;
  items: number;
}

export interface MotionTimeline {
  frameId: string;
  /** Build 0 always comes first (even without animations), then one per click. */
  builds: MotionTimelineBuild[];
  /** Sorted by start. */
  items: MotionTimelineItem[];
  /** Linear duration: all builds back to back (loops excluded). */
  duration: number;
  /** Click builds (builds after the automatic one). */
  clicks: number;
  /** Animations that loop forever. */
  loops: number;
  /** Slide transition of the frame (defaults filled in). */
  transition: ResolvedTransition | null;
  warnings: string[];
}

/** A point of a frame's timeline: linear `time`, or after `build` (optionally `time` into it). */
export type MotionAt = { time: number; build?: undefined } | { build: number; time?: number };

interface Found {
  node: Node;
}

function collect(frame: Node): Found[] {
  const out: Found[] = [];
  const walk = (n: Node): void => {
    if (n.hidden) return;
    if (n.animations?.length) out.push({ node: n });
    for (const c of n.children) walk(c);
  };
  walk(frame);
  return out;
}

/** `true` when the frame or any visible descendant has animations. */
export function frameHasMotion(frame: Node): boolean {
  const walk = (n: Node): boolean => !n.hidden && (!!n.animations?.length || n.children.some(walk));
  return walk(frame);
}

const cache = new WeakMap<Node, MotionTimeline>();

/** Timeline of a root frame (memoized by node identity). Pass the expanded view (instances). */
export function frameMotionTimeline(frame: Node): MotionTimeline {
  const hit = cache.get(frame);
  if (hit) return hit;
  const found = collect(frame);
  const warnings: string[] = [];

  // builds in play order
  const used = new Set<number>([0]);
  for (const { node } of found) for (const a of node.animations!) used.add(a.build ?? 0);
  const order = [...used].sort((a, b) => a - b);
  const click = new Map(order.map((b, i) => [b, i]));

  // build durations
  const durations = new Map<number, number>(order.map((b) => [b, 0]));
  for (const { node } of found) {
    for (const a of node.animations!) {
      const end = animationEnd(node, a);
      if (end === null) continue;
      const b = a.build ?? 0;
      durations.set(b, Math.max(durations.get(b)!, end));
    }
  }
  const starts = new Map<number, number>();
  let t = 0;
  const builds: MotionTimelineBuild[] = order.map((b, i) => {
    starts.set(b, t);
    const build = { build: b, click: i, start: t, duration: durations.get(b)!, items: 0 };
    t += build.duration;
    return build;
  });

  const items: MotionTimelineItem[] = [];
  for (const { node } of found) {
    const kinds = { in: [] as number[], out: [] as number[] };
    node.animations!.forEach((a, index) => {
      const d = animationDefaults(a);
      const targets = motionTargetCount(node, a);
      const start = starts.get(d.build)! + d.delay;
      const end = animationEnd(node, a);
      items.push({
        nodeId: node.id,
        name: node.name,
        index,
        kind: a.kind,
        preset: a.preset,
        build: d.build,
        click: click.get(d.build)!,
        start,
        end: end === null ? null : starts.get(d.build)! + end,
        delay: d.delay,
        duration: d.duration,
        iterations: d.iterations,
        easing: d.easing,
        ...(a.split && { split: a.split }),
        targets,
        stagger: d.stagger,
      });
      builds[click.get(d.build)!]!.items++;
      if (a.kind === 'in') kinds.in.push(d.build);
      if (a.kind === 'out') kinds.out.push(d.build);
      if ((a.split === 'words' || a.split === 'chars') && (node.type !== 'text' || !node.text))
        warnings.push(
          `"${node.name}" (${node.id}): split "${a.split}" only works on a text node with text.`,
        );
      if (a.split === 'children' && targets === 0)
        warnings.push(
          `"${node.name}" (${node.id}): split "children" but it has no visible children.`,
        );
    });
    if (kinds.in.length > 1)
      warnings.push(
        `"${node.name}" (${node.id}) has ${kinds.in.length} entrances: while two run, the later one wins.`,
      );
    const firstIn = kinds.in.length ? Math.min(...kinds.in) : null;
    for (const b of kinds.out)
      if (firstIn !== null && b < firstIn)
        warnings.push(
          `"${node.name}" (${node.id}) exits in build ${b} before it enters in build ${firstIn}.`,
        );
  }
  items.sort((a, b) => a.start - b.start || a.nodeId.localeCompare(b.nodeId) || a.index - b.index);
  if (t > 30_000)
    warnings.push(
      `The timeline lasts ${(t / 1000).toFixed(1)} s; animated export records at most 30 s.`,
    );

  const timeline: MotionTimeline = {
    frameId: frame.id,
    builds,
    items,
    duration: t,
    clicks: builds.length - 1,
    loops: items.filter((i) => i.end === null).length,
    transition: frame.slideTransition ? resolveTransition(frame.slideTransition) : null,
    warnings,
  };
  cache.set(frame, timeline);
  return timeline;
}

/** Start of a build on the linear timeline (`undefined` when the frame has no such build). */
export function buildStart(timeline: MotionTimeline, build: number): number | undefined {
  return timeline.builds.find((b) => b.build === build)?.start;
}

/**
 * Local time (ms into its build) of each build at a point of the timeline. Builds that have not
 * started get a negative or zero value (they show their initial state), finished ones their duration
 * or more.
 */
export function buildTimesAt(timeline: MotionTimeline, at: MotionAt): Map<number, number> {
  const out = new Map<number, number>();
  if (at.build === undefined) {
    for (const b of timeline.builds) out.set(b.build, at.time - b.start);
    return out;
  }
  for (const b of timeline.builds) {
    if (b.build < at.build) out.set(b.build, b.duration);
    else if (b.build === at.build) out.set(b.build, at.time ?? b.duration);
    else out.set(b.build, 0);
  }
  return out;
}

/** Linear time of a point (for effects, video and other clocks that only know one time). */
export function linearTimeAt(timeline: MotionTimeline, at: MotionAt): number {
  if (at.build === undefined) return at.time;
  let t = 0;
  for (const b of timeline.builds) {
    if (b.build < at.build) t = b.start + b.duration;
    else if (b.build === at.build) return b.start + (at.time ?? b.duration);
  }
  return t;
}

/** Build state after `clicks` clicks of a presentation (0 = only the automatic build). */
export function buildOfClick(timeline: MotionTimeline, clicks: number): number {
  const i = Math.min(Math.max(0, Math.trunc(clicks)), timeline.builds.length - 1);
  return timeline.builds[i]!.build;
}

const sec = (ms: number): string => `${(ms / 1000).toFixed(2).replace(/\.?0+$/, '')}s`;

/** Readable timeline for agents (`get_timeline`). */
export function formatMotionTimeline(timeline: MotionTimeline, frameName?: string): string {
  const lines: string[] = [];
  const head = frameName ? `"${frameName}" (${timeline.frameId})` : timeline.frameId;
  lines.push(
    `Timeline of ${head}: ${timeline.items.length} animation(s), ${sec(timeline.duration)} linear, ${timeline.clicks} click build(s)${timeline.loops ? `, ${timeline.loops} loop(s)` : ''}.`,
  );
  const tr = timeline.transition;
  const dir = tr && getSlideTransition(tr.preset)?.directional ? ` ${tr.direction}` : '';
  lines.push(
    tr
      ? `Slide transition: ${tr.preset}${dir}, ${tr.duration}ms, ${tr.easing}.`
      : 'Slide transition: none (the slide fades in quickly).',
  );
  for (const b of timeline.builds) {
    const label =
      b.click === 0 ? 'Build 0 (when the slide appears)' : `Build ${b.build} (click ${b.click})`;
    lines.push(`${label}: starts ${sec(b.start)}, lasts ${sec(b.duration)}`);
    for (const it of timeline.items.filter((i) => i.build === b.build)) {
      const end = it.end === null ? '∞ (loop)' : sec(it.end);
      const targets =
        it.split && it.targets !== 1 ? `, ${it.targets} ${it.split} ${it.stagger}ms apart` : '';
      const iter = it.iterations === 1 ? '' : `, ×${it.iterations}`;
      lines.push(
        `  [${it.index}] ${it.nodeId} "${it.name}": ${it.kind} ${it.preset} ${sec(it.start)}→${end} (${it.duration}ms${it.delay ? `, delay ${it.delay}ms` : ''}, ${it.easing}${iter}${targets})`,
      );
    }
  }
  if (timeline.warnings.length) {
    lines.push('Warnings:');
    for (const w of timeline.warnings) lines.push(`  - ${w}`);
  }
  return lines.join('\n');
}
