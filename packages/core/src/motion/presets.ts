/**
 * Animation presets: entrance/exit families (`in`/`out`) and emphasis/loops, each a parametric
 * keyframe generator. Keyframes only touch compositor-friendly properties (transform, opacity,
 * filter; the wipes also use clip-path) and take the node's own rest values (`MotionBase`) so a motion
 * composes with the design: entrances and exits animate `transform`, emphasis animates the individual
 * `translate` / `rotate` / `scale` properties, so a loop and an entrance can run at the same time.
 */
import type { AnimationKeyframe, AnimationKind } from '../types.js';

export type MotionParamValue = number | string;

export interface MotionParamDef {
  name: string;
  label: string;
  type: 'number' | 'color';
  default: MotionParamValue;
  min?: number;
  max?: number;
  step?: number;
  unit?: 'px' | '%' | 'deg' | 'x';
  description?: string;
}

/** Rest values of the animated element (from its style); absent = the CSS initial value. */
export interface MotionBase {
  opacity?: string;
  transform?: string;
  filter?: string;
  translate?: string;
  rotate?: string;
  scale?: string;
}

export type PresetGroup = 'fade' | 'move' | 'scale' | 'reveal' | '3d' | 'attention' | 'loop';

export interface AnimationPreset {
  name: string;
  label: string;
  /** Kinds it can be used as; the first is the default. */
  kinds: AnimationKind[];
  group: PresetGroup;
  description: string;
  /** Default duration of one iteration (ms) for `in`/`emphasis`; `out` uses 75% of it. */
  duration: number;
  easing: string;
  /** Default easing as an exit. */
  outEasing?: string;
  /** Default number of plays (`infinite` for loops). */
  iterations?: number | 'infinite';
  /** Only compositor-friendly properties (transform, opacity, filter). */
  gpu: boolean;
  /** Movement keeps its direction as an exit (`fade-up` leaves upwards); others play reversed. */
  directional?: boolean;
  params: MotionParamDef[];
  /** Keyframes in kebab-case CSS for the kind (custom keyframes come from the animation itself). */
  keyframes(
    p: Record<string, MotionParamValue>,
    kind: AnimationKind,
    base: MotionBase,
  ): AnimationKeyframe[];
}

/* ---------------- helpers ---------------- */

const fmt = (n: number, digits = 3): string => {
  const s = n.toFixed(digits);
  return s.includes('.') ? s.replace(/0+$/, '').replace(/\.$/, '') : s;
};
const px = (n: number): string => `${fmt(n)}px`;
const deg = (n: number): string => `${fmt(n)}deg`;

/** Splits a CSS value on top-level whitespace (parentheses kept together). */
export function splitTopLevel(value: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = '';
  for (const ch of value.trim()) {
    if (ch === '(') depth++;
    if (ch === ')') depth = Math.max(0, depth - 1);
    if (/\s/.test(ch) && depth === 0) {
      if (cur) out.push(cur);
      cur = '';
    } else cur += ch;
  }
  if (cur) out.push(cur);
  return out;
}

const isNone = (v: string | undefined): boolean => !v || v.trim() === '' || v.trim() === 'none';
const suffix = (v: string | undefined): string => (isNone(v) ? '' : ` ${v!.trim()}`);
const baseOpacity = (base: MotionBase): string =>
  base.opacity && base.opacity.trim() !== '' ? base.opacity.trim() : '1';

/** Pose of an entrance/exit relative to rest. */
interface Pose {
  x?: number | string;
  y?: number | string;
  s?: number;
  sx?: number;
  sy?: number;
  r?: number;
  rx?: number;
  ry?: number;
  perspective?: number;
  /** Rotates around the top edge (swing). */
  pivotTop?: boolean;
  /** Opacity of the hidden pose (default 0; `null` = not animated). */
  opacity?: number | null;
  blur?: number;
  clip?: string;
}

const len = (v: number | string | undefined): string =>
  v === undefined ? '0px' : typeof v === 'number' ? px(v) : v;

/** Transform list of the pose (`rest` = the same functions at identity, so they interpolate). */
function poseTransform(p: Pose, rest: boolean): string {
  const fns: string[] = [];
  if (p.perspective !== undefined) fns.push(`perspective(${px(p.perspective)})`);
  if (p.x !== undefined || p.y !== undefined)
    fns.push(rest ? 'translate3d(0px, 0px, 0px)' : `translate3d(${len(p.x)}, ${len(p.y)}, 0px)`);
  if (p.pivotTop) fns.push('translateY(-50%)');
  if (p.rx !== undefined) fns.push(`rotateX(${deg(rest ? 0 : p.rx)})`);
  if (p.ry !== undefined) fns.push(`rotateY(${deg(rest ? 0 : p.ry)})`);
  if (p.r !== undefined) fns.push(`rotate(${deg(rest ? 0 : p.r)})`);
  if (p.pivotTop) fns.push('translateY(50%)');
  if (p.s !== undefined || p.sx !== undefined || p.sy !== undefined) {
    const sx = rest ? 1 : (p.sx ?? p.s ?? 1);
    const sy = rest ? 1 : (p.sy ?? p.s ?? 1);
    fns.push(`scale(${fmt(sx)}, ${fmt(sy)})`);
  }
  return fns.join(' ');
}

function poseFrame(p: Pose, rest: boolean, base: MotionBase): AnimationKeyframe {
  const kf: AnimationKeyframe = {};
  const t = poseTransform(p, rest);
  if (t) kf.transform = `${t}${suffix(base.transform)}`;
  if (p.opacity !== null) kf.opacity = rest ? baseOpacity(base) : fmt(p.opacity ?? 0);
  if (p.blur !== undefined) kf.filter = `blur(${px(rest ? 0 : p.blur)})${suffix(base.filter)}`;
  if (p.clip !== undefined) kf['clip-path'] = rest ? 'inset(0% 0% 0% 0%)' : p.clip;
  return kf;
}

/** Pose flipped for an exit that keeps moving the same way. */
function onward(p: Pose): Pose {
  const neg = (v: number | string | undefined): number | string | undefined =>
    typeof v === 'number' ? -v : typeof v === 'string' ? `calc(${v} * -1)` : v;
  return {
    ...p,
    ...(p.x !== undefined && { x: neg(p.x) }),
    ...(p.y !== undefined && { y: neg(p.y) }),
    ...(p.r !== undefined && { r: -p.r }),
    ...(p.rx !== undefined && { rx: -p.rx }),
    ...(p.ry !== undefined && { ry: -p.ry }),
  };
}

/**
 * Entrance (hidden pose → rest) or exit (rest → hidden pose). `fadeFor` < 1 makes the opacity reach
 * its value in the first part of an entrance (or leave in the last part of an exit) while the
 * movement takes the whole duration.
 */
function entranceExit(
  pose: Pose,
  kind: AnimationKind,
  base: MotionBase,
  opts: { directional?: boolean; fadeFor?: number; outPose?: Pose } = {},
): AnimationKeyframe[] {
  const fadeFor = opts.fadeFor ?? 1;
  if (kind === 'out') {
    const hidden = opts.outPose ?? (opts.directional ? onward(pose) : pose);
    const from = { offset: 0, ...poseFrame(hidden, true, base) };
    const to = { offset: 1, ...poseFrame(hidden, false, base) };
    if (fadeFor >= 1 || hidden.opacity === null) return [from, to];
    return [from, { offset: 1 - fadeFor, opacity: baseOpacity(base) }, to];
  }
  const from = { offset: 0, ...poseFrame(pose, false, base) };
  const to = { offset: 1, ...poseFrame(pose, true, base) };
  if (fadeFor >= 1 || pose.opacity === null) return [from, to];
  return [from, { offset: fadeFor, opacity: baseOpacity(base) }, to];
}

/** One step of an emphasis (relative to rest). */
interface Beat {
  o: number;
  tx?: number;
  /** px, or a CSS length expression. */
  ty?: number | string;
  r?: number;
  s?: number;
  sx?: number;
  sy?: number;
  /** Opacity multiplier. */
  op?: number;
  /** drop-shadow radius (px). */
  glow?: number;
  easing?: string;
}

/** A bare `0` is not a valid operand next to a length inside `calc()`. */
const zeroLength = (v: string): string => (/^[+-]?(0+(\.0*)?|\.0+)$/.test(v) ? '0px' : v);

function composeTranslate(base: string | undefined, tx: string, ty: string): string {
  if (isNone(base)) return `${tx} ${ty}`;
  const [bx = '0px', by = '0px'] = splitTopLevel(base!).map(zeroLength);
  return `calc(${bx} + ${tx}) calc(${by} + ${ty})`;
}

function composeRotate(base: string | undefined, r: number): string {
  if (isNone(base)) return deg(r);
  const parts = splitTopLevel(base!);
  // only a plain angle composes; an axis form is replaced
  return parts.length === 1
    ? `calc(${/^[+-]?(0+(\.0*)?|\.0+)$/.test(parts[0]!) ? '0deg' : parts[0]} + ${deg(r)})`
    : deg(r);
}

function composeScale(base: string | undefined, sx: number, sy: number): string {
  const same = Math.abs(sx - sy) < 1e-9;
  if (isNone(base)) return same ? fmt(sx) : `${fmt(sx)} ${fmt(sy)}`;
  const [bx = '1', by = bx] = splitTopLevel(base!);
  return `calc(${bx} * ${fmt(sx)}) calc(${by} * ${fmt(sy)})`;
}

function composeOpacity(base: MotionBase, m: number): string {
  const b = baseOpacity(base);
  const n = Number(b);
  return Number.isFinite(n) ? fmt(n * m) : `calc(${b} * ${fmt(m)})`;
}

/** Emphasis keyframes on the individual transform properties (and opacity/filter when used). */
function beats(
  list: Beat[],
  base: MotionBase,
  glowColor = 'rgba(255, 255, 255, 0.8)',
): AnimationKeyframe[] {
  const usesT = list.some((b) => b.tx !== undefined || b.ty !== undefined);
  const usesR = list.some((b) => b.r !== undefined);
  const usesS = list.some((b) => b.s !== undefined || b.sx !== undefined || b.sy !== undefined);
  const usesO = list.some((b) => b.op !== undefined);
  const usesG = list.some((b) => b.glow !== undefined);
  return list.map((b) => {
    const kf: AnimationKeyframe = { offset: b.o };
    if (usesT) {
      const ty = typeof b.ty === 'string' ? b.ty : px(b.ty ?? 0);
      kf.translate = composeTranslate(base.translate, px(b.tx ?? 0), ty);
    }
    if (usesR) kf.rotate = composeRotate(base.rotate, b.r ?? 0);
    if (usesS) kf.scale = composeScale(base.scale, b.sx ?? b.s ?? 1, b.sy ?? b.s ?? 1);
    if (usesO) kf.opacity = composeOpacity(base, b.op ?? 1);
    if (usesG)
      kf.filter = `drop-shadow(0px 0px ${px(b.glow ?? 0)} ${glowColor})${suffix(base.filter)}`;
    if (b.easing) kf.easing = b.easing;
    return kf;
  });
}

const n = (p: Record<string, MotionParamValue>, k: string): number => Number(p[k]);

const DISTANCE = (d: number, max = 600): MotionParamDef => ({
  name: 'distance',
  label: 'Distance',
  type: 'number',
  default: d,
  min: 0,
  max,
  step: 1,
  unit: 'px',
  description: 'How far it travels.',
});

const IN_OUT: AnimationKind[] = ['in', 'out'];

/* ---------------- entrance / exit ---------------- */

function fadeMove(name: string, label: string, dx: number, dy: number): AnimationPreset {
  return {
    name,
    label,
    kinds: IN_OUT,
    group: 'move',
    description: `Fades in while moving ${name.split('-')[1]}.`,
    duration: 600,
    easing: 'smooth-out',
    outEasing: 'smooth-in',
    gpu: true,
    directional: true,
    params: [DISTANCE(24)],
    keyframes: (p, kind, base) =>
      entranceExit({ x: -dx * n(p, 'distance'), y: -dy * n(p, 'distance') }, kind, base, {
        directional: true,
      }),
  };
}

function slideMove(name: string, label: string, dx: number, dy: number): AnimationPreset {
  return {
    name,
    label,
    kinds: IN_OUT,
    group: 'move',
    description: `Flies in moving ${name.split('-')[1]}, from its own size away (100% = one width/height).`,
    duration: 700,
    easing: 'expo-out',
    outEasing: 'expo-in',
    gpu: true,
    directional: true,
    params: [
      {
        name: 'distance',
        label: 'Distance',
        type: 'number',
        default: 100,
        min: 0,
        max: 1000,
        step: 5,
        unit: '%',
        description: 'Travel in % of its own width/height.',
      },
    ],
    keyframes: (p, kind, base) => {
      const d = n(p, 'distance');
      const pose: Pose = {
        x: dx === 0 ? 0 : `${fmt(-dx * d)}%`,
        y: dy === 0 ? 0 : `${fmt(-dy * d)}%`,
      };
      return entranceExit(pose, kind, base, { directional: true, fadeFor: 0.2 });
    },
  };
}

function wipe(
  name: string,
  label: string,
  side: 'up' | 'down' | 'left' | 'right',
): AnimationPreset {
  // in: the hidden edge is the one the wipe moves towards; out keeps moving the same way.
  const inClip = {
    right: 'inset(0% 100% 0% 0%)',
    left: 'inset(0% 0% 0% 100%)',
    up: 'inset(100% 0% 0% 0%)',
    down: 'inset(0% 0% 100% 0%)',
  }[side];
  const outClip = {
    right: 'inset(0% 0% 0% 100%)',
    left: 'inset(0% 100% 0% 0%)',
    up: 'inset(0% 0% 100% 0%)',
    down: 'inset(100% 0% 0% 0%)',
  }[side];
  return {
    name,
    label,
    kinds: IN_OUT,
    group: 'reveal',
    description: `Reveals it with a mask moving ${side} (clip-path: repaints while it runs).`,
    duration: 700,
    easing: 'expo-in-out',
    gpu: false,
    directional: true,
    params: [],
    keyframes: (_p, kind, base) =>
      entranceExit({ clip: inClip, opacity: null }, kind, base, {
        outPose: { clip: outClip, opacity: null },
      }),
  };
}

const ENTRANCES: AnimationPreset[] = [
  {
    name: 'fade',
    label: 'Fade',
    kinds: IN_OUT,
    group: 'fade',
    description: 'Fades in (or out).',
    duration: 400,
    easing: 'smooth',
    gpu: true,
    params: [],
    keyframes: (_p, kind, base) => entranceExit({}, kind, base),
  },
  fadeMove('fade-up', 'Fade up', 0, -1),
  fadeMove('fade-down', 'Fade down', 0, 1),
  fadeMove('fade-left', 'Fade left', -1, 0),
  fadeMove('fade-right', 'Fade right', 1, 0),
  slideMove('slide-up', 'Slide up', 0, -1),
  slideMove('slide-down', 'Slide down', 0, 1),
  slideMove('slide-left', 'Slide left', -1, 0),
  slideMove('slide-right', 'Slide right', 1, 0),
  {
    name: 'zoom-in',
    label: 'Zoom in',
    kinds: IN_OUT,
    group: 'scale',
    description: 'Grows into place from slightly smaller.',
    duration: 500,
    easing: 'expo-out',
    outEasing: 'smooth-in',
    gpu: true,
    params: [
      {
        name: 'scale',
        label: 'Start scale',
        type: 'number',
        default: 0.85,
        min: 0,
        max: 1,
        step: 0.01,
        unit: 'x',
      },
    ],
    keyframes: (p, kind, base) => entranceExit({ s: n(p, 'scale') }, kind, base),
  },
  {
    name: 'zoom-out',
    label: 'Zoom out',
    kinds: IN_OUT,
    group: 'scale',
    description: 'Settles into place from slightly bigger.',
    duration: 600,
    easing: 'expo-out',
    outEasing: 'smooth-in',
    gpu: true,
    params: [
      {
        name: 'scale',
        label: 'Start scale',
        type: 'number',
        default: 1.15,
        min: 1,
        max: 4,
        step: 0.01,
        unit: 'x',
      },
    ],
    keyframes: (p, kind, base) => entranceExit({ s: n(p, 'scale') }, kind, base),
  },
  {
    name: 'pop',
    label: 'Pop',
    kinds: IN_OUT,
    group: 'scale',
    description: 'Springs in from small with a bounce.',
    duration: 550,
    easing: 'spring-bouncy',
    outEasing: 'back-in',
    gpu: true,
    params: [
      {
        name: 'scale',
        label: 'Start scale',
        type: 'number',
        default: 0.5,
        min: 0,
        max: 1,
        step: 0.01,
        unit: 'x',
      },
    ],
    keyframes: (p, kind, base) => entranceExit({ s: n(p, 'scale') }, kind, base, { fadeFor: 0.3 }),
  },
  {
    name: 'blur',
    label: 'Blur',
    kinds: IN_OUT,
    group: 'fade',
    description: 'Comes into focus while fading in.',
    duration: 700,
    easing: 'smooth-out',
    outEasing: 'smooth-in',
    gpu: true,
    params: [
      {
        name: 'blur',
        label: 'Blur',
        type: 'number',
        default: 12,
        min: 0,
        max: 80,
        step: 1,
        unit: 'px',
      },
    ],
    keyframes: (p, kind, base) => entranceExit({ blur: n(p, 'blur'), s: 1.04 }, kind, base),
  },
  {
    name: 'rise',
    label: 'Rise',
    kinds: IN_OUT,
    group: 'move',
    description: 'Rises softly out of a blur (keynote titles).',
    duration: 900,
    easing: 'expo-out',
    outEasing: 'expo-in',
    gpu: true,
    directional: true,
    params: [
      DISTANCE(40),
      {
        name: 'blur',
        label: 'Blur',
        type: 'number',
        default: 8,
        min: 0,
        max: 60,
        step: 1,
        unit: 'px',
      },
    ],
    keyframes: (p, kind, base) =>
      entranceExit({ y: n(p, 'distance'), s: 0.97, blur: n(p, 'blur') }, kind, base, {
        directional: true,
      }),
  },
  {
    name: 'drop',
    label: 'Drop',
    kinds: IN_OUT,
    group: 'move',
    description: 'Falls into place and bounces.',
    duration: 900,
    easing: 'bounce',
    outEasing: 'smooth-in',
    gpu: true,
    directional: true,
    params: [DISTANCE(80)],
    keyframes: (p, kind, base) =>
      entranceExit({ y: -n(p, 'distance') }, kind, base, { directional: true, fadeFor: 0.25 }),
  },
  {
    name: 'flip-up',
    label: 'Flip up',
    kinds: IN_OUT,
    group: '3d',
    description: 'Flips up in 3D around its horizontal axis.',
    duration: 800,
    easing: 'spring',
    outEasing: 'smooth-in',
    gpu: true,
    directional: true,
    params: [
      {
        name: 'angle',
        label: 'Angle',
        type: 'number',
        default: 75,
        min: -180,
        max: 180,
        step: 1,
        unit: 'deg',
      },
      {
        name: 'perspective',
        label: 'Perspective',
        type: 'number',
        default: 800,
        min: 100,
        max: 4000,
        step: 10,
        unit: 'px',
      },
    ],
    keyframes: (p, kind, base) =>
      entranceExit({ perspective: n(p, 'perspective'), rx: n(p, 'angle') }, kind, base, {
        directional: true,
        fadeFor: 0.4,
      }),
  },
  {
    name: 'flip-left',
    label: 'Flip left',
    kinds: IN_OUT,
    group: '3d',
    description: 'Flips in 3D around its vertical axis.',
    duration: 800,
    easing: 'spring',
    outEasing: 'smooth-in',
    gpu: true,
    directional: true,
    params: [
      {
        name: 'angle',
        label: 'Angle',
        type: 'number',
        default: 75,
        min: -180,
        max: 180,
        step: 1,
        unit: 'deg',
      },
      {
        name: 'perspective',
        label: 'Perspective',
        type: 'number',
        default: 800,
        min: 100,
        max: 4000,
        step: 10,
        unit: 'px',
      },
    ],
    keyframes: (p, kind, base) =>
      entranceExit({ perspective: n(p, 'perspective'), ry: n(p, 'angle') }, kind, base, {
        directional: true,
        fadeFor: 0.4,
      }),
  },
  {
    name: 'swing',
    label: 'Swing',
    kinds: IN_OUT,
    group: '3d',
    description: 'Swings in from its top edge like a hanging sign.',
    duration: 1000,
    easing: 'spring-wobbly',
    outEasing: 'back-in',
    gpu: true,
    params: [
      {
        name: 'angle',
        label: 'Angle',
        type: 'number',
        default: 25,
        min: -90,
        max: 90,
        step: 1,
        unit: 'deg',
      },
    ],
    keyframes: (p, kind, base) =>
      entranceExit({ pivotTop: true, r: n(p, 'angle') }, kind, base, { fadeFor: 0.2 }),
  },
  {
    name: 'spin-in',
    label: 'Spin in',
    kinds: IN_OUT,
    group: 'scale',
    description: 'Spins and grows into place.',
    duration: 800,
    easing: 'spring',
    outEasing: 'smooth-in',
    gpu: true,
    directional: true,
    params: [
      {
        name: 'angle',
        label: 'Angle',
        type: 'number',
        default: -180,
        min: -1080,
        max: 1080,
        step: 5,
        unit: 'deg',
      },
      {
        name: 'scale',
        label: 'Start scale',
        type: 'number',
        default: 0.4,
        min: 0,
        max: 1,
        step: 0.01,
        unit: 'x',
      },
    ],
    keyframes: (p, kind, base) =>
      entranceExit({ r: n(p, 'angle'), s: n(p, 'scale') }, kind, base, {
        directional: true,
        fadeFor: 0.4,
      }),
  },
  wipe('wipe-right', 'Wipe right', 'right'),
  wipe('wipe-left', 'Wipe left', 'left'),
  wipe('wipe-up', 'Wipe up', 'up'),
  wipe('wipe-down', 'Wipe down', 'down'),
];

/* ---------------- emphasis and loops ---------------- */

const AMOUNT = (
  d: number,
  unit: MotionParamDef['unit'],
  max: number,
  step = 1,
): MotionParamDef => ({
  name: 'amount',
  label: 'Amount',
  type: 'number',
  default: d,
  min: 0,
  max,
  step,
  unit,
});

const EMPHASIS: AnimationPreset[] = [
  {
    name: 'pulse',
    label: 'Pulse',
    kinds: ['emphasis'],
    group: 'attention',
    description: 'Grows a little and back.',
    duration: 600,
    easing: 'ease-in-out',
    gpu: true,
    params: [AMOUNT(1.06, 'x', 3, 0.01)],
    keyframes: (p, _k, base) =>
      beats(
        [
          { o: 0, s: 1 },
          { o: 0.5, s: n(p, 'amount') },
          { o: 1, s: 1 },
        ],
        base,
      ),
  },
  {
    name: 'bounce',
    label: 'Bounce',
    kinds: ['emphasis'],
    group: 'attention',
    description: 'Hops up twice.',
    duration: 900,
    easing: 'linear',
    gpu: true,
    params: [AMOUNT(18, 'px', 300)],
    keyframes: (p, _k, base) => {
      const h = n(p, 'amount');
      const up = 'cubic-bezier(0.33, 0, 0.67, 1)';
      const down = 'cubic-bezier(0.33, 0, 1, 1)';
      return beats(
        [
          { o: 0, ty: 0, easing: up },
          { o: 0.3, ty: -h, easing: down },
          { o: 0.55, ty: 0, easing: up },
          { o: 0.72, ty: -h * 0.35, easing: down },
          { o: 0.86, ty: 0, easing: up },
          { o: 0.94, ty: -h * 0.08, easing: down },
          { o: 1, ty: 0 },
        ],
        base,
      );
    },
  },
  {
    name: 'shake',
    label: 'Shake',
    kinds: ['emphasis'],
    group: 'attention',
    description: 'Shakes sideways (“no”).',
    duration: 600,
    easing: 'ease-in-out',
    gpu: true,
    params: [AMOUNT(8, 'px', 200)],
    keyframes: (p, _k, base) => {
      const d = n(p, 'amount');
      return beats(
        [0, -1, 1, -0.8, 0.6, -0.35, 0.15, 0].map((m, i, a) => ({
          o: i / (a.length - 1),
          tx: m * d,
        })),
        base,
      );
    },
  },
  {
    name: 'wiggle',
    label: 'Wiggle',
    kinds: ['emphasis'],
    group: 'attention',
    description: 'Rotates back and forth.',
    duration: 700,
    easing: 'ease-in-out',
    gpu: true,
    params: [AMOUNT(7, 'deg', 90)],
    keyframes: (p, _k, base) => {
      const a = n(p, 'amount');
      return beats(
        [0, -1, 1, -0.7, 0.4, -0.15, 0].map((m, i, arr) => ({
          o: i / (arr.length - 1),
          r: m * a,
        })),
        base,
      );
    },
  },
  {
    name: 'tada',
    label: 'Tada',
    kinds: ['emphasis'],
    group: 'attention',
    description: 'Shrinks, then grows with a celebratory wiggle.',
    duration: 1000,
    easing: 'ease-in-out',
    gpu: true,
    params: [AMOUNT(1.1, 'x', 2, 0.01)],
    keyframes: (p, _k, base) => {
      const s = n(p, 'amount');
      const small = 1 - (s - 1);
      return beats(
        [
          { o: 0, s: 1, r: 0 },
          { o: 0.1, s: small, r: -3 },
          { o: 0.2, s: small, r: -3 },
          { o: 0.3, s, r: 3 },
          { o: 0.4, s, r: -3 },
          { o: 0.5, s, r: 3 },
          { o: 0.6, s, r: -3 },
          { o: 0.7, s, r: 3 },
          { o: 0.8, s, r: -3 },
          { o: 0.9, s, r: 3 },
          { o: 1, s: 1, r: 0 },
        ],
        base,
      );
    },
  },
  {
    name: 'heartbeat',
    label: 'Heartbeat',
    kinds: ['emphasis'],
    group: 'attention',
    description: 'Two quick beats.',
    duration: 1200,
    easing: 'ease-in-out',
    gpu: true,
    params: [AMOUNT(1.15, 'x', 3, 0.01)],
    keyframes: (p, _k, base) => {
      const s = n(p, 'amount');
      return beats(
        [
          { o: 0, s: 1 },
          { o: 0.14, s },
          { o: 0.28, s: 1 },
          { o: 0.42, s },
          { o: 0.7, s: 1 },
          { o: 1, s: 1 },
        ],
        base,
      );
    },
  },
  {
    name: 'rubber',
    label: 'Rubber band',
    kinds: ['emphasis'],
    group: 'attention',
    description: 'Squashes and stretches like rubber.',
    duration: 900,
    easing: 'ease-out',
    gpu: true,
    params: [AMOUNT(0.25, 'x', 0.8, 0.01)],
    keyframes: (p, _k, base) => {
      const a = n(p, 'amount');
      return beats(
        [
          { o: 0, sx: 1, sy: 1 },
          { o: 0.3, sx: 1 + a, sy: 1 - a },
          { o: 0.4, sx: 1 - a, sy: 1 + a },
          { o: 0.5, sx: 1 + a * 0.6, sy: 1 - a * 0.6 },
          { o: 0.65, sx: 1 - a * 0.2, sy: 1 + a * 0.2 },
          { o: 0.75, sx: 1 + a * 0.1, sy: 1 - a * 0.1 },
          { o: 1, sx: 1, sy: 1 },
        ],
        base,
      );
    },
  },
  {
    name: 'flash',
    label: 'Flash',
    kinds: ['emphasis'],
    group: 'attention',
    description: 'Blinks twice.',
    duration: 900,
    easing: 'ease-in-out',
    gpu: true,
    params: [],
    keyframes: (_p, _k, base) =>
      beats(
        [
          { o: 0, op: 1 },
          { o: 0.25, op: 0 },
          { o: 0.5, op: 1 },
          { o: 0.75, op: 0 },
          { o: 1, op: 1 },
        ],
        base,
      ),
  },
  {
    name: 'jump',
    label: 'Jump',
    kinds: ['emphasis'],
    group: 'attention',
    description: 'Squashes, jumps and lands (squash & stretch).',
    duration: 800,
    easing: 'ease-in-out',
    gpu: true,
    params: [AMOUNT(28, 'px', 300)],
    keyframes: (p, _k, base) => {
      const h = n(p, 'amount');
      // squash keeps the bottom edge in place: shift by half the lost height (% of own size)
      const land = (sy: number, y = 0): string => `calc(${px(y)} + ${fmt((1 - sy) * 50)}%)`;
      return beats(
        [
          { o: 0, sx: 1, sy: 1, ty: land(1) },
          { o: 0.15, sx: 1.12, sy: 0.88, ty: land(0.88), easing: 'cubic-bezier(0.2, 0, 0.4, 1)' },
          {
            o: 0.45,
            sx: 0.94,
            sy: 1.06,
            ty: land(1.06, -h),
            easing: 'cubic-bezier(0.6, 0, 0.8, 1)',
          },
          { o: 0.68, sx: 1.1, sy: 0.9, ty: land(0.9) },
          { o: 0.84, sx: 0.98, sy: 1.02, ty: land(1.02) },
          { o: 1, sx: 1, sy: 1, ty: land(1) },
        ],
        base,
      );
    },
  },
  {
    name: 'float',
    label: 'Float',
    kinds: ['emphasis'],
    group: 'loop',
    description: 'Floats up and down, forever.',
    duration: 3000,
    easing: 'ease-in-out',
    iterations: 'infinite',
    gpu: true,
    params: [AMOUNT(10, 'px', 200)],
    keyframes: (p, _k, base) =>
      beats(
        [
          { o: 0, ty: 0 },
          { o: 0.5, ty: -n(p, 'amount') },
          { o: 1, ty: 0 },
        ],
        base,
      ),
  },
  {
    name: 'spin',
    label: 'Spin',
    kinds: ['emphasis'],
    group: 'loop',
    description: 'Turns around, forever (negative = counter-clockwise).',
    duration: 1600,
    easing: 'linear',
    iterations: 'infinite',
    gpu: true,
    params: [
      {
        name: 'angle',
        label: 'Turn',
        type: 'number',
        default: 360,
        min: -3600,
        max: 3600,
        step: 15,
        unit: 'deg',
      },
    ],
    keyframes: (p, _k, base) =>
      beats(
        [
          { o: 0, r: 0 },
          { o: 1, r: n(p, 'angle') },
        ],
        base,
      ),
  },
  {
    name: 'breathe',
    label: 'Breathe',
    kinds: ['emphasis'],
    group: 'loop',
    description: 'Slowly grows and shrinks, forever.',
    duration: 4000,
    easing: 'ease-in-out',
    iterations: 'infinite',
    gpu: true,
    params: [AMOUNT(1.04, 'x', 2, 0.01)],
    keyframes: (p, _k, base) =>
      beats(
        [
          { o: 0, s: 1 },
          { o: 0.5, s: n(p, 'amount') },
          { o: 1, s: 1 },
        ],
        base,
      ),
  },
  {
    name: 'sway',
    label: 'Sway',
    kinds: ['emphasis'],
    group: 'loop',
    description: 'Tilts gently from side to side, forever.',
    duration: 3200,
    easing: 'ease-in-out',
    iterations: 'infinite',
    gpu: true,
    params: [AMOUNT(4, 'deg', 45)],
    keyframes: (p, _k, base) => {
      const a = n(p, 'amount');
      return beats(
        [
          { o: 0, r: 0 },
          { o: 0.25, r: a },
          { o: 0.75, r: -a },
          { o: 1, r: 0 },
        ],
        base,
      );
    },
  },
  {
    name: 'glow',
    label: 'Glow',
    kinds: ['emphasis'],
    group: 'loop',
    description: 'A soft glow that comes and goes, forever.',
    duration: 2400,
    easing: 'ease-in-out',
    iterations: 'infinite',
    gpu: true,
    params: [
      AMOUNT(18, 'px', 120),
      {
        name: 'color',
        label: 'Color',
        type: 'color',
        default: 'rgba(255, 255, 255, 0.8)',
        description: 'Glow color (CSS).',
      },
    ],
    keyframes: (p, _k, base) =>
      beats(
        [
          { o: 0, glow: 0 },
          { o: 0.5, glow: n(p, 'amount') },
          { o: 1, glow: 0 },
        ],
        base,
        String(p.color),
      ),
  },
  {
    name: 'ping',
    label: 'Ping',
    kinds: ['emphasis'],
    group: 'loop',
    description: 'Expands and fades out, forever (radar / notification dot).',
    duration: 1400,
    easing: 'cubic-bezier(0, 0, 0.2, 1)',
    iterations: 'infinite',
    gpu: true,
    params: [AMOUNT(1.9, 'x', 6, 0.05)],
    keyframes: (p, _k, base) =>
      beats(
        [
          { o: 0, s: 1, op: 1 },
          { o: 0.8, s: n(p, 'amount'), op: 0 },
          { o: 1, s: n(p, 'amount'), op: 0 },
        ],
        base,
      ),
  },
];

/** Custom keyframes: the animation brings its own `keyframes`. */
export const CUSTOM_PRESET: AnimationPreset = {
  name: 'custom',
  label: 'Custom keyframes',
  kinds: ['in', 'out', 'emphasis'],
  group: 'attention',
  description:
    'Your own Web Animations keyframes (`keyframes`): CSS declarations per offset. Prefer transform, opacity and filter.',
  duration: 600,
  easing: 'smooth',
  gpu: true,
  params: [],
  keyframes: () => [],
};

export const MOTION_PRESETS: AnimationPreset[] = [...ENTRANCES, ...EMPHASIS, CUSTOM_PRESET];

const BY_NAME = new Map(MOTION_PRESETS.map((p) => [p.name, p]));

export function getMotionPreset(name: string): AnimationPreset | undefined {
  return BY_NAME.get(name);
}

/** Default duration (ms) of a preset for a kind (exits are a bit faster). */
export function presetDuration(preset: AnimationPreset, kind: AnimationKind): number {
  return kind === 'out' ? Math.round(preset.duration * 0.75) : preset.duration;
}

/** Default easing (name or CSS) of a preset for a kind. */
export function presetEasing(preset: AnimationPreset, kind: AnimationKind): string {
  return kind === 'out' ? (preset.outEasing ?? preset.easing) : preset.easing;
}

/** Default iterations of a preset. */
export function presetIterations(preset: AnimationPreset): number | 'infinite' {
  return preset.iterations ?? 1;
}

/** Parameters with the preset defaults filled in. */
export function motionPresetParams(
  preset: AnimationPreset,
  params: Record<string, MotionParamValue> | undefined,
): Record<string, MotionParamValue> {
  const out: Record<string, MotionParamValue> = {};
  for (const d of preset.params) out[d.name] = params?.[d.name] ?? d.default;
  return out;
}
