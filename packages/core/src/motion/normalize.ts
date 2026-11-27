/**
 * Validation and canonical form of animations and slide transitions: unknown presets, kinds,
 * params or easings throw a readable `Error`; values equal to the preset defaults are omitted so the
 * file stays small (`{ "kind": "in", "preset": "fade-up" }` is a complete animation).
 */
import { isValidCssPropertyName, toKebabCase } from '../styles.js';
import type {
  AnimationKeyframe,
  AnimationKind,
  AnimationSplit,
  NodeAnimation,
  SlideTransition,
  TransitionDirection,
} from '../types.js';
import { easingProblem } from './easing.js';
import {
  MOTION_PRESETS,
  getMotionPreset,
  presetDuration,
  presetEasing,
  presetIterations,
} from './presets.js';
import type { AnimationPreset } from './presets.js';
import { TRANSITION_DIRECTIONS, getSlideTransition, SLIDE_TRANSITIONS } from './transitions.js';

export const ANIMATION_KINDS: AnimationKind[] = ['in', 'out', 'emphasis'];
export const ANIMATION_SPLITS: AnimationSplit[] = ['children', 'words', 'chars'];

/** Default gap between split targets (ms). */
export const SPLIT_STAGGER: Record<AnimationSplit, number> = { children: 80, words: 60, chars: 30 };

export const MAX_ANIMATIONS_PER_NODE = 20;
export const MAX_MOTION_MS = 60_000;
export const MAX_BUILD = 99;
const MAX_KEYFRAMES = 24;
const MAX_ITERATIONS = 1000;

function fail(msg: string): never {
  throw new Error(msg);
}

/** `"words"` and `"chars"` cut the text of a text node; on any other node they have no targets. */
export function isTextSplit(split: AnimationSplit | undefined): boolean {
  return split === 'words' || split === 'chars';
}

/**
 * Error for a list with a text split on a node that is not text (`null` when it fits). Strict paths
 * (`setMotion`, `createNode`, instance overrides) throw it; lenient readers use `dropTextSplit`.
 */
export function textSplitProblem(
  list: readonly NodeAnimation[] | undefined,
  nodeType: string,
  where: string,
): string | null {
  if (nodeType === 'text' || !list?.some((a) => isTextSplit(a.split))) return null;
  return `${where}: split "words" and "chars" only apply to text nodes (this one is ${nodeType})`;
}

/** Lenient fix for a node that is not text: drops a text split (and its stagger), keeps the animation. */
export function dropTextSplit(a: NodeAnimation): NodeAnimation {
  if (!isTextSplit(a.split)) return a;
  const out = { ...a };
  delete out.split;
  delete out.stagger;
  return out;
}

const UNSAFE_VALUE = /[;{}<>]|\/\*|\\/;

function ms(v: unknown, field: string, where: string, min: number): number {
  if (typeof v !== 'number' || !Number.isFinite(v))
    fail(`${where}: "${field}" must be a number of milliseconds`);
  if (v < min || v > MAX_MOTION_MS)
    fail(`${where}: "${field}" must be between ${min} and ${MAX_MOTION_MS} ms (got ${v})`);
  return Math.round(v);
}

function presetNames(kind?: AnimationKind): string {
  return MOTION_PRESETS.filter((p) => !kind || p.kinds.includes(kind))
    .map((p) => p.name)
    .join(', ');
}

function normalizeKeyframes(list: unknown, where: string): AnimationKeyframe[] {
  if (!Array.isArray(list) || list.length === 0)
    fail(`${where}: "keyframes" must be a non-empty list (custom preset)`);
  if (list.length > MAX_KEYFRAMES) fail(`${where}: at most ${MAX_KEYFRAMES} keyframes`);
  let lastOffset = -1;
  return list.map((raw, i) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw))
      fail(`${where}: keyframe #${i + 1} must be an object of CSS declarations`);
    const out: AnimationKeyframe = {};
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      if (v === undefined || v === null) continue;
      if (k === 'offset') {
        if (typeof v !== 'number' || v < 0 || v > 1)
          fail(`${where}: keyframe #${i + 1} offset must be a number from 0 to 1`);
        if (v < lastOffset) fail(`${where}: keyframe offsets must not decrease`);
        lastOffset = v;
        out.offset = v;
        continue;
      }
      if (k === 'easing') {
        const problem = typeof v === 'string' ? easingProblem(v) : 'easing must be a string';
        if (problem) fail(`${where}: keyframe #${i + 1}: ${problem}`);
        out.easing = (v as string).trim();
        continue;
      }
      const prop = toKebabCase(k.trim());
      if (!isValidCssPropertyName(prop))
        fail(`${where}: keyframe #${i + 1}: invalid CSS property "${k}"`);
      if (prop === 'composite') fail(`${where}: keyframe #${i + 1}: "composite" is not supported`);
      const value = typeof v === 'number' ? String(v) : typeof v === 'string' ? v.trim() : null;
      if (value === null || value === '')
        fail(`${where}: keyframe #${i + 1}: "${k}" must be a CSS value`);
      if (UNSAFE_VALUE.test(value))
        fail(`${where}: keyframe #${i + 1}: "${k}" has a value that escapes the declaration`);
      out[prop] = value;
    }
    if (Object.keys(out).filter((k) => k !== 'offset' && k !== 'easing').length === 0)
      fail(`${where}: keyframe #${i + 1} has no CSS declarations`);
    return out;
  });
}

function normalizeParams(
  preset: AnimationPreset,
  params: unknown,
  where: string,
): Record<string, number | string> | undefined {
  if (params === undefined || params === null) return undefined;
  if (typeof params !== 'object' || Array.isArray(params))
    fail(`${where}: "params" must be an object`);
  const out: Record<string, number | string> = {};
  for (const [k, v] of Object.entries(params as Record<string, unknown>)) {
    if (v === undefined || v === null) continue;
    const def = preset.params.find((d) => d.name === k);
    if (!def) {
      const valid = preset.params.map((d) => d.name).join(', ');
      fail(
        `${where}: preset "${preset.name}" has no param "${k}"${valid ? ` (params: ${valid})` : ' (it has no params)'}`,
      );
    }
    if (def.type === 'number') {
      const num = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
      if (typeof num !== 'number' || !Number.isFinite(num))
        fail(`${where}: param "${k}" must be a number`);
      if ((def.min !== undefined && num < def.min) || (def.max !== undefined && num > def.max))
        fail(`${where}: param "${k}" must be between ${def.min} and ${def.max} (got ${num})`);
      if (num !== def.default) out[k] = num;
    } else {
      if (typeof v !== 'string' || v.trim() === '' || UNSAFE_VALUE.test(v))
        fail(`${where}: param "${k}" must be a CSS color`);
      if (v.trim() !== def.default) out[k] = v.trim();
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Validates an animation and returns its canonical form (kind first, defaults omitted). `where`
 * prefixes the error messages.
 */
export function normalizeAnimation(input: unknown, where = 'animation'): NodeAnimation {
  if (!input || typeof input !== 'object' || Array.isArray(input))
    fail(`${where}: must be an object like { "kind": "in", "preset": "fade-up" }`);
  const a = input as Record<string, unknown>;
  const known = new Set([
    'kind',
    'preset',
    'duration',
    'delay',
    'easing',
    'build',
    'iterations',
    'alternate',
    'split',
    'stagger',
    'params',
    'keyframes',
  ]);
  for (const k of Object.keys(a))
    if (!known.has(k) && a[k] !== undefined)
      fail(`${where}: unknown field "${k}" (fields: ${[...known].join(', ')})`);

  if (typeof a.preset !== 'string' || !a.preset.trim())
    fail(`${where}: "preset" is required (one of: ${presetNames()})`);
  const preset = getMotionPreset(a.preset.trim());
  if (!preset)
    fail(
      `${where}: unknown preset "${a.preset}". Presets: ${presetNames()} (see list_motion_presets)`,
    );

  const kind = (a.kind ?? preset.kinds[0]) as AnimationKind;
  if (!ANIMATION_KINDS.includes(kind))
    fail(`${where}: "kind" must be "in", "out" or "emphasis" (got ${JSON.stringify(a.kind)})`);
  if (!preset.kinds.includes(kind))
    fail(
      `${where}: preset "${preset.name}" works as ${preset.kinds.join('/')}, not "${kind}". Presets for ${kind}: ${presetNames(kind)}`,
    );

  const out: NodeAnimation = { kind, preset: preset.name };
  if (a.duration !== undefined && a.duration !== null) {
    const d = ms(a.duration, 'duration', where, 1);
    if (d !== presetDuration(preset, kind)) out.duration = d;
  }
  if (a.delay !== undefined && a.delay !== null) {
    const d = ms(a.delay, 'delay', where, 0);
    if (d !== 0) out.delay = d;
  }
  if (a.easing !== undefined && a.easing !== null) {
    if (typeof a.easing !== 'string') fail(`${where}: "easing" must be a string`);
    const e = a.easing.trim();
    const problem = easingProblem(e);
    if (problem) fail(`${where}: ${problem}`);
    if (e !== presetEasing(preset, kind)) out.easing = e;
  }
  if (a.build !== undefined && a.build !== null) {
    if (
      typeof a.build !== 'number' ||
      !Number.isInteger(a.build) ||
      a.build < 0 ||
      a.build > MAX_BUILD
    )
      fail(
        `${where}: "build" must be an integer from 0 to ${MAX_BUILD} (0 = when the slide appears)`,
      );
    if (a.build !== 0) out.build = a.build;
  }
  if (a.iterations !== undefined && a.iterations !== null) {
    const it = a.iterations;
    const valid =
      it === 'infinite' ||
      (typeof it === 'number' && Number.isInteger(it) && it >= 1 && it <= MAX_ITERATIONS);
    if (!valid)
      fail(`${where}: "iterations" must be an integer from 1 to ${MAX_ITERATIONS} or "infinite"`);
    if (it !== presetIterations(preset)) out.iterations = it as number | 'infinite';
  }
  if (a.alternate !== undefined && a.alternate !== null) {
    if (typeof a.alternate !== 'boolean') fail(`${where}: "alternate" must be true or false`);
    if (a.alternate) out.alternate = true;
  }
  if (a.split !== undefined && a.split !== null) {
    if (!ANIMATION_SPLITS.includes(a.split as AnimationSplit))
      fail(`${where}: "split" must be "children", "words" or "chars"`);
    out.split = a.split as AnimationSplit;
  }
  if (a.stagger !== undefined && a.stagger !== null) {
    if (!out.split)
      fail(
        `${where}: "stagger" needs "split" ("children", "words" or "chars"); to stagger several nodes give each one a delay`,
      );
    const s = ms(a.stagger, 'stagger', where, 0);
    if (s !== SPLIT_STAGGER[out.split]) out.stagger = s;
  }
  const params = normalizeParams(preset, a.params, where);
  if (params) out.params = params;
  if (preset.name === 'custom') {
    out.keyframes = normalizeKeyframes(a.keyframes, where);
  } else if (a.keyframes !== undefined && a.keyframes !== null) {
    fail(`${where}: "keyframes" only applies to preset "custom"`);
  }
  return out;
}

/** Validates a list (at most 20 per node); empty → `undefined`. */
export function normalizeAnimations(
  input: unknown,
  where = 'animations',
): NodeAnimation[] | undefined {
  if (input === undefined || input === null) return undefined;
  if (!Array.isArray(input)) fail(`${where}: must be a list of animations`);
  if (input.length > MAX_ANIMATIONS_PER_NODE)
    fail(`${where}: at most ${MAX_ANIMATIONS_PER_NODE} animations per node`);
  const out = input.map((a, i) => normalizeAnimation(a, `${where} #${i + 1}`));
  return out.length > 0 ? out : undefined;
}

/** Validates a slide transition and returns its canonical form (defaults omitted). */
export function normalizeTransition(input: unknown, where = 'transition'): SlideTransition {
  if (!input || typeof input !== 'object' || Array.isArray(input))
    fail(`${where}: must be an object like { "preset": "push", "direction": "left" }`);
  const t = input as Record<string, unknown>;
  for (const k of Object.keys(t))
    if (!['preset', 'duration', 'easing', 'direction'].includes(k) && t[k] !== undefined)
      fail(`${where}: unknown field "${k}" (fields: preset, duration, easing, direction)`);
  const names = SLIDE_TRANSITIONS.map((p) => p.name).join(', ');
  if (typeof t.preset !== 'string') fail(`${where}: "preset" is required (one of: ${names})`);
  const preset = getSlideTransition(t.preset.trim());
  if (!preset) fail(`${where}: unknown transition "${t.preset}". Transitions: ${names}`);
  const out: SlideTransition = { preset: preset.name };
  if (t.duration !== undefined && t.duration !== null) {
    const d = ms(t.duration, 'duration', where, 1);
    if (d !== preset.duration) out.duration = d;
  }
  if (t.easing !== undefined && t.easing !== null) {
    if (typeof t.easing !== 'string') fail(`${where}: "easing" must be a string`);
    const e = t.easing.trim();
    const problem = easingProblem(e);
    if (problem) fail(`${where}: ${problem}`);
    if (e !== preset.easing) out.easing = e;
  }
  if (t.direction !== undefined && t.direction !== null) {
    if (!TRANSITION_DIRECTIONS.includes(t.direction as TransitionDirection))
      fail(`${where}: "direction" must be left, right, up or down`);
    if (!preset.directional) fail(`${where}: transition "${preset.name}" has no direction`);
    if (t.direction !== 'left') out.direction = t.direction as TransitionDirection;
  }
  return out;
}
