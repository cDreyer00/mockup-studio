/** Pure helpers that build `setMotion` ops (the op replaces a node's whole animation list). */
import { getMotionPreset, normalizeAnimation } from '@mockup/core';
import type { AnimationKind, Node, NodeAnimation, Op, Page, SlideTransition } from '@mockup/core';

export type SetMotionOp = Extract<Op, { type: 'setMotion' }>;

/** Removes the keys whose value is `undefined`. */
function compact<T extends object>(o: T): T {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) if (v !== undefined) out[k] = v;
  return out as T;
}

/** Animation with `patch` merged in (`undefined` removes a field). */
export function mergeAnimation(anim: NodeAnimation, patch: Partial<NodeAnimation>): NodeAnimation {
  return compact({ ...anim, ...patch });
}

/** Default kind of a preset (the first it supports); `preferred` wins when the preset supports it. */
export function defaultKind(preset: string, preferred?: AnimationKind): AnimationKind {
  const def = getMotionPreset(preset);
  if (!def) return preferred ?? 'in';
  return preferred && def.kinds.includes(preferred) ? preferred : (def.kinds[0] ?? 'in');
}

/**
 * Adds `anim` to every node, in one op. `cascade` ms is added to the delay of each successive node
 * (node 0 keeps the delay of `anim`, node 1 gets +cascade, node 2 +2*cascade...).
 */
export function addAnimationOp(
  nodes: readonly Node[],
  anim: NodeAnimation,
  cascade = 0,
): SetMotionOp {
  return {
    type: 'setMotion',
    changes: nodes.map((n, i) => {
      const delay = (anim.delay ?? 0) + Math.max(0, cascade) * i;
      const added = compact({ ...anim, delay: delay > 0 ? delay : undefined });
      return { nodeId: n.id, animations: [...(n.animations ?? []), added] };
    }),
  };
}

/** Merges `patch` into the animation `index` of `node`; `null` when there is no such animation. */
export function updateAnimationOp(
  node: Node,
  index: number,
  patch: Partial<NodeAnimation>,
): SetMotionOp | null {
  const list = node.animations;
  const cur = list?.[index];
  if (!list || !cur) return null;
  const next = list.map((a, i) => (i === index ? mergeAnimation(a, patch) : a));
  return { type: 'setMotion', changes: [{ nodeId: node.id, animations: next }] };
}

/** Replaces the animation `index` of `node` as a whole. */
export function replaceAnimationOp(
  node: Node,
  index: number,
  anim: NodeAnimation,
): SetMotionOp | null {
  const list = node.animations;
  if (!list?.[index]) return null;
  return {
    type: 'setMotion',
    changes: [{ nodeId: node.id, animations: list.map((a, i) => (i === index ? anim : a)) }],
  };
}

/** Removes the animation `index` of `node` (`null` removes the list when it was the last). */
export function removeAnimationOp(node: Node, index: number): SetMotionOp | null {
  const list = node.animations;
  if (!list?.[index]) return null;
  const next = list.filter((_, i) => i !== index);
  return {
    type: 'setMotion',
    changes: [{ nodeId: node.id, animations: next.length ? next : null }],
  };
}

/** Changes the preset of an animation: parameters reset, duration/easing back to the new defaults. */
export function changePresetPatch(anim: NodeAnimation, preset: string): Partial<NodeAnimation> {
  return {
    preset,
    kind: defaultKind(preset, anim.kind),
    params: undefined,
    duration: undefined,
    easing: undefined,
    keyframes: preset === 'custom' ? (anim.keyframes ?? undefined) : undefined,
  };
}

/** Sets (or removes with `null`) the slide transition of the frames, in one op. */
export function setTransitionOp(
  frames: readonly Node[],
  transition: SlideTransition | null,
): SetMotionOp {
  return {
    type: 'setMotion',
    changes: frames.map((f) => ({ nodeId: f.id, transition })),
  };
}

/** Same transition on every frame of the page (the source frame included). */
export function transitionToAllOp(
  page: Pick<Page, 'frames'>,
  transition: SlideTransition | null,
): SetMotionOp {
  return setTransitionOp(page.frames, transition);
}

/** Merges `patch` into a transition (`undefined` removes a field). */
export function mergeTransition(
  t: SlideTransition,
  patch: Partial<SlideTransition>,
): SlideTransition {
  return compact({ ...t, ...patch });
}

/** Rounds `ms` to `step` (10 ms; Shift = 100 ms in the timeline). */
export function snapMs(ms: number, step = 10): number {
  return Math.round(ms / step) * step;
}

/** Parses the custom keyframes JSON and validates the whole animation; returns an error message otherwise. */
export function parseCustomKeyframes(
  anim: NodeAnimation,
  text: string,
): { animation: NodeAnimation } | { error: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    return { error: `Invalid JSON: ${e instanceof Error ? e.message : String(e)}` };
  }
  if (!Array.isArray(parsed)) return { error: 'Keyframes must be a JSON array.' };
  try {
    const animation = normalizeAnimation({ ...anim, keyframes: parsed });
    return { animation };
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}

/** Parses a ms text (`"250"`, `"250ms"`, `"0.25s"`); `null` when it is not a time. */
export function parseMs(text: string): number | null {
  const m = /^\s*(-?\d+(?:\.\d+)?)\s*(ms|s)?\s*$/i.exec(text);
  if (!m) return null;
  const n = Number(m[1]) * (m[2]?.toLowerCase() === 's' ? 1000 : 1);
  return Number.isFinite(n) ? Math.round(n) : null;
}

/** `1.25 s` / `340 ms`. */
export function formatMs(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(2).replace(/\.?0+$/, '')} s` : `${Math.round(ms)} ms`;
}
