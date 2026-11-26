/**
 * Compiles node animations into Web Animations keyframes and timing (the same data drives the
 * canvas, the render page, the presentation and the exported CSS). Times in ms.
 *
 * Fill rules: an entrance fills backwards (hidden while it waits for its build/delay; afterwards the
 * element simply returns to its own style, which is the last keyframe), an exit fills forwards
 * (stays hidden) and an emphasis does not fill.
 */
import { expandRepeaterChildren } from '../data.js';
import type { AnimationKeyframe, AnimationKind, Node, NodeAnimation } from '../types.js';
import { resolveEasing } from './easing.js';
import { SPLIT_STAGGER } from './normalize.js';
import {
  getMotionPreset,
  presetDuration,
  presetEasing,
  presetIterations,
  motionPresetParams,
} from './presets.js';
import type { MotionBase } from './presets.js';
import { countTextSegments } from './split.js';

export type MotionTarget =
  | { type: 'self' }
  /** n-th visible child (DOM order). */
  | { type: 'child'; index: number }
  /** n-th word/character span of a split text. */
  | { type: 'segment'; index: number };

export interface MotionTiming {
  duration: number;
  /** Wait inside its build (delay + stagger offset). */
  delay: number;
  /** CSS easing (springs already as `linear()`). */
  easing: string;
  /** `Infinity` for loops. */
  iterations: number;
  direction: 'normal' | 'alternate';
  fill: 'backwards' | 'forwards' | 'none';
}

export interface CompiledMotion {
  nodeId: string;
  /** Index of the animation in `node.animations`. */
  index: number;
  kind: AnimationKind;
  /** Build of the animation (0 = automatic). */
  build: number;
  target: MotionTarget;
  /** kebab-case CSS (see `toWaapiKeyframes`). */
  keyframes: AnimationKeyframe[];
  timing: MotionTiming;
}

/** Rest values of an element, read from its style. */
export function motionBaseOf(style: Record<string, string> | undefined): MotionBase {
  const s = style ?? {};
  const base: MotionBase = {};
  for (const k of ['opacity', 'transform', 'filter', 'translate', 'rotate', 'scale'] as const) {
    const v = s[k];
    if (v !== undefined && v.trim() !== '') base[k] = v.trim();
  }
  return base;
}

/** Duration, easing and iterations of an animation with the preset defaults filled in. */
export function animationDefaults(anim: NodeAnimation): {
  duration: number;
  easing: string;
  iterations: number | 'infinite';
  delay: number;
  build: number;
  stagger: number;
} {
  const preset = getMotionPreset(anim.preset);
  const duration = anim.duration ?? (preset ? presetDuration(preset, anim.kind) : 600);
  const easing = anim.easing ?? (preset ? presetEasing(preset, anim.kind) : 'smooth');
  const iterations = anim.iterations ?? (preset ? presetIterations(preset) : 1);
  const stagger = anim.split ? (anim.stagger ?? SPLIT_STAGGER[anim.split]) : 0;
  return { duration, easing, iterations, delay: anim.delay ?? 0, build: anim.build ?? 0, stagger };
}

/** Keyframes and timing of one animation on one target (delay without stagger). */
export function compileAnimation(
  anim: NodeAnimation,
  base: MotionBase = {},
): { keyframes: AnimationKeyframe[]; timing: MotionTiming } {
  const preset = getMotionPreset(anim.preset);
  const d = animationDefaults(anim);
  const keyframes =
    anim.preset === 'custom' || !preset
      ? (anim.keyframes ?? []).map((k) => ({ ...k }))
      : preset.keyframes(motionPresetParams(preset, anim.params), anim.kind, base);
  for (const k of keyframes) if (typeof k.easing === 'string') k.easing = resolveEasing(k.easing);
  return {
    keyframes,
    timing: {
      duration: d.duration,
      delay: d.delay,
      easing: resolveEasing(d.easing),
      iterations: d.iterations === 'infinite' ? Infinity : d.iterations,
      direction: anim.alternate ? 'alternate' : 'normal',
      fill: anim.kind === 'in' ? 'backwards' : anim.kind === 'out' ? 'forwards' : 'none',
    },
  };
}

/** Children a `split: 'children'` animation moves (visible ones; repeaters expanded). */
export function motionChildren(node: Node): Node[] {
  const kids = node.type === 'repeater' ? expandRepeaterChildren(node) : node.children;
  return kids.filter((c) => !c.hidden);
}

/** Number of targets of an animation on this node (1, the visible children or the text segments). */
export function motionTargetCount(node: Node, anim: NodeAnimation): number {
  if (anim.split === 'children') return motionChildren(node).length;
  if (anim.split === 'words' || anim.split === 'chars') {
    return node.type === 'text' && node.text ? countTextSegments(node.text, anim.split) : 0;
  }
  return 1;
}

/** Text split used by the node's animations (`words`/`chars`), so the renderer emits the spans. */
export function textSplitOf(node: Node): 'words' | 'chars' | null {
  if (node.type !== 'text' || !node.animations) return null;
  let split: 'words' | 'chars' | null = null;
  for (const a of node.animations) {
    if (a.split === 'chars') return 'chars';
    if (a.split === 'words') split = 'words';
  }
  return split;
}

/**
 * All the animations of a node, one entry per target, in composite order (later entries win on the
 * same property): by build, then delay, then the list order.
 */
export function compileNodeMotion(node: Node): CompiledMotion[] {
  const list = node.animations;
  if (!list?.length) return [];
  const out: CompiledMotion[] = [];
  const textSplit = textSplitOf(node);
  list.forEach((anim, index) => {
    const d = animationDefaults(anim);
    const push = (target: MotionTarget, base: MotionBase, offset: number): void => {
      const c = compileAnimation(anim, base);
      c.timing.delay += offset;
      out.push({ nodeId: node.id, index, kind: anim.kind, build: d.build, target, ...c });
    };
    if (anim.split === 'children') {
      motionChildren(node).forEach((child, i) =>
        push({ type: 'child', index: i }, motionBaseOf(child.style), i * d.stagger),
      );
    } else if (anim.split === 'words' || anim.split === 'chars') {
      if (node.type !== 'text' || !node.text || !textSplit) return;
      // a node renders one split: chars wins over words (word animations then move characters)
      const count = countTextSegments(node.text, textSplit);
      for (let i = 0; i < count; i++) push({ type: 'segment', index: i }, {}, i * d.stagger);
    } else {
      push({ type: 'self' }, motionBaseOf(node.style), 0);
    }
  });
  return out
    .map((c, order) => ({ c, order }))
    .sort(
      (a, b) => a.c.build - b.c.build || a.c.timing.delay - b.c.timing.delay || a.order - b.order,
    )
    .map((x) => x.c);
}

/** End of an animation inside its build (ms after the build starts); `null` = infinite. */
export function animationEnd(node: Node, anim: NodeAnimation): number | null {
  const d = animationDefaults(anim);
  if (d.iterations === 'infinite') return null;
  const targets = Math.max(1, motionTargetCount(node, anim));
  return d.delay + (targets - 1) * d.stagger + d.duration * d.iterations;
}

const camel = (prop: string): string =>
  prop.startsWith('--') ? prop : prop.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());

/** Web Animations keyframes (camelCase properties; `offset`/`easing` kept). */
export function toWaapiKeyframes(
  keyframes: AnimationKeyframe[],
): Record<string, string | number>[] {
  return keyframes.map((k) => {
    const out: Record<string, string | number> = {};
    for (const [p, v] of Object.entries(k)) {
      if (v === undefined) continue;
      out[p === 'offset' || p === 'easing' ? p : camel(p)] = v;
    }
    return out;
  });
}

/** `@keyframes` body in CSS (offsets as percentages; missing offsets spread evenly). */
export function keyframesCss(name: string, keyframes: AnimationKeyframe[]): string {
  const n = keyframes.length;
  const offsets = spreadOffsets(keyframes);
  const blocks = keyframes.map((k, i) => {
    const decls = Object.entries(k)
      .filter(([p, v]) => p !== 'offset' && p !== 'easing' && v !== undefined)
      .map(([p, v]) => `${p}: ${v}`);
    if (typeof k.easing === 'string') decls.push(`animation-timing-function: ${k.easing}`);
    const pct = `${Number((offsets[i]! * 100).toFixed(3))}%`;
    return `  ${n === 1 ? '100%' : pct} { ${decls.join('; ')}; }`;
  });
  return `@keyframes ${name} {\n${blocks.join('\n')}\n}`;
}

/** Offsets of the keyframes with the missing ones spread evenly (Web Animations rule). */
export function spreadOffsets(keyframes: AnimationKeyframe[]): number[] {
  const n = keyframes.length;
  const out = keyframes.map((k, i) =>
    typeof k.offset === 'number' ? k.offset : n === 1 ? 1 : i === 0 ? 0 : i === n - 1 ? 1 : NaN,
  );
  let i = 0;
  while (i < n) {
    if (!Number.isNaN(out[i]!)) {
      i++;
      continue;
    }
    const start = i - 1;
    let end = i;
    while (end < n && Number.isNaN(out[end]!)) end++;
    const a = out[start]!;
    const b = out[end]!;
    for (let j = i; j < end; j++) out[j] = a + ((b - a) * (j - start)) / (end - start);
    i = end;
  }
  return out;
}
