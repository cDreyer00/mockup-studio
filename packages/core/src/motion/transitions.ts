/**
 * Slide transitions (how a root frame enters in a presentation). Each preset produces keyframes for
 * the two slides (incoming and outgoing), in the same Web Animations format as the node animations,
 * relative to a full-stage slot (translate percentages = the stage size). Going back plays the same
 * transition time-reversed (`direction: 'reverse'` with the roles swapped), so `push left` going back
 * looks like `push right` and `cover` like `reveal`. `magic` is computed by the presentation from the
 * two slides' layouts (layers matched by name).
 */
import type { AnimationKeyframe, SlideTransition, TransitionDirection } from '../types.js';

export interface TransitionPreset {
  name: string;
  label: string;
  description: string;
  duration: number;
  easing: string;
  /** Accepts `direction`. */
  directional: boolean;
  /** Only compositor-friendly properties. */
  gpu: boolean;
}

export const SLIDE_TRANSITIONS: TransitionPreset[] = [
  {
    name: 'fade',
    label: 'Fade',
    description: 'Crossfades into the new slide.',
    duration: 500,
    easing: 'smooth',
    directional: false,
    gpu: true,
  },
  {
    name: 'dip',
    label: 'Dip to black',
    description: 'Fades out to black, then fades the new slide in.',
    duration: 800,
    easing: 'ease-in-out',
    directional: false,
    gpu: true,
  },
  {
    name: 'push',
    label: 'Push',
    description: 'The new slide pushes the old one out.',
    duration: 700,
    easing: 'expo-in-out',
    directional: true,
    gpu: true,
  },
  {
    name: 'cover',
    label: 'Cover',
    description: 'The new slide slides over the old one, which sinks back.',
    duration: 700,
    easing: 'expo-out',
    directional: true,
    gpu: true,
  },
  {
    name: 'reveal',
    label: 'Reveal',
    description: 'The old slide slides away, revealing the new one.',
    duration: 700,
    easing: 'expo-out',
    directional: true,
    gpu: true,
  },
  {
    name: 'wipe',
    label: 'Wipe',
    description: 'A straight edge wipes the new slide in (clip-path: repaints while it runs).',
    duration: 700,
    easing: 'expo-in-out',
    directional: true,
    gpu: false,
  },
  {
    name: 'zoom',
    label: 'Zoom',
    description: 'The old slide zooms past the camera while the new one settles in.',
    duration: 650,
    easing: 'expo-out',
    directional: false,
    gpu: true,
  },
  {
    name: 'blur',
    label: 'Blur',
    description: 'Blurs out of the old slide into the new one.',
    duration: 650,
    easing: 'smooth',
    directional: false,
    gpu: true,
  },
  {
    name: 'flip',
    label: 'Flip',
    description: 'Flips the slide over like a card, in 3D.',
    duration: 900,
    easing: 'smooth',
    directional: true,
    gpu: true,
  },
  {
    name: 'cube',
    label: 'Cube',
    description: 'Rotates to the new slide as the next face of a cube, in 3D.',
    duration: 900,
    easing: 'expo-in-out',
    directional: true,
    gpu: true,
  },
  {
    name: 'magic',
    label: 'Magic move',
    description:
      'Layers with the same name on both slides move, resize and crossfade into their new place; the rest fades.',
    duration: 800,
    easing: 'smooth',
    directional: false,
    gpu: true,
  },
];

const BY_NAME = new Map(SLIDE_TRANSITIONS.map((t) => [t.name, t]));

export function getSlideTransition(name: string): TransitionPreset | undefined {
  return BY_NAME.get(name);
}

export const TRANSITION_DIRECTIONS: TransitionDirection[] = ['left', 'right', 'up', 'down'];

/** Transition with the preset defaults filled in. */
export interface ResolvedTransition {
  preset: string;
  duration: number;
  /** Named or CSS easing (resolve with `resolveEasing`). */
  easing: string;
  direction: TransitionDirection;
}

export function resolveTransition(t: SlideTransition): ResolvedTransition | null {
  const p = getSlideTransition(t.preset);
  if (!p) return null;
  return {
    preset: p.name,
    duration: t.duration ?? p.duration,
    easing: t.easing ?? p.easing,
    direction: p.directional ? (t.direction ?? 'left') : 'left',
  };
}

export interface SlidePart {
  keyframes: AnimationKeyframe[];
  /** `transform-origin` of the slot while the transition runs. */
  origin?: string;
  /** Play the keyframes backwards (time-reversed transition). */
  reverse: boolean;
}

/** Size (px) of the slides on screen: the 3D presets need real depths. */
export interface StageSize {
  width: number;
  height: number;
}

const DEFAULT_STAGE: StageSize = { width: 1280, height: 720 };

export interface TransitionPlan {
  preset: string;
  duration: number;
  /** Resolved direction (`left` for presets without one). */
  direction: TransitionDirection;
  /** Named or CSS easing of both parts. */
  easing: string;
  incoming: SlidePart;
  outgoing: SlidePart;
  /** Which slot is painted on top. */
  top: 'incoming' | 'outgoing';
  /** Perspective (px) of the stage for 3D presets. */
  perspective?: number;
  /** Slots hide their back face (flip, cube). */
  backface?: boolean;
  /** `magic`: the presentation morphs layers matched by name; the parts crossfade the rest. */
  magic?: boolean;
}

/** Unit vector of the movement: `left` = the content moves to the left. */
function vec(dir: TransitionDirection): { x: number; y: number } {
  switch (dir) {
    case 'left':
      return { x: -1, y: 0 };
    case 'right':
      return { x: 1, y: 0 };
    case 'up':
      return { x: 0, y: -1 };
    case 'down':
      return { x: 0, y: 1 };
  }
}

const tr = (x: number, y: number): string => `translate3d(${x * 100}%, ${y * 100}%, 0px)`;

interface Forward {
  incoming: AnimationKeyframe[];
  outgoing: AnimationKeyframe[];
  incomingOrigin?: string;
  outgoingOrigin?: string;
  top: 'incoming' | 'outgoing';
  perspective?: number;
  backface?: boolean;
}

const STILL: AnimationKeyframe[] = [{ opacity: '1' }, { opacity: '1' }];

function forward(t: ResolvedTransition, stage: StageSize): Forward {
  const v = vec(t.direction);
  switch (t.preset) {
    case 'dip':
      return {
        incoming: [
          { offset: 0, opacity: '0' },
          { offset: 0.5, opacity: '0' },
          { offset: 1, opacity: '1' },
        ],
        outgoing: [
          { offset: 0, opacity: '1' },
          { offset: 0.5, opacity: '0' },
          { offset: 1, opacity: '0' },
        ],
        top: 'incoming',
      };
    case 'push':
      return {
        incoming: [{ transform: tr(-v.x, -v.y) }, { transform: tr(0, 0) }],
        outgoing: [{ transform: tr(0, 0) }, { transform: tr(v.x, v.y) }],
        top: 'incoming',
      };
    case 'cover':
      return {
        incoming: [{ transform: tr(-v.x, -v.y) }, { transform: tr(0, 0) }],
        outgoing: [
          { transform: 'scale(1)', opacity: '1' },
          { transform: 'scale(0.92)', opacity: '0.5' },
        ],
        top: 'incoming',
      };
    case 'reveal':
      return {
        incoming: [
          { transform: 'scale(0.92)', opacity: '0.5' },
          { transform: 'scale(1)', opacity: '1' },
        ],
        outgoing: [{ transform: tr(0, 0) }, { transform: tr(v.x, v.y) }],
        top: 'outgoing',
      };
    case 'wipe': {
      // the edge travels in the movement direction, uncovering the new slide behind it
      const from =
        t.direction === 'left'
          ? 'inset(0% 0% 0% 100%)'
          : t.direction === 'right'
            ? 'inset(0% 100% 0% 0%)'
            : t.direction === 'up'
              ? 'inset(100% 0% 0% 0%)'
              : 'inset(0% 0% 100% 0%)';
      return {
        incoming: [{ 'clip-path': from }, { 'clip-path': 'inset(0% 0% 0% 0%)' }],
        outgoing: STILL,
        top: 'incoming',
      };
    }
    case 'zoom':
      return {
        incoming: [
          { transform: 'scale(0.8)', opacity: '0' },
          { transform: 'scale(1)', opacity: '1' },
        ],
        outgoing: [
          { transform: 'scale(1)', opacity: '1' },
          { transform: 'scale(1.25)', opacity: '0' },
        ],
        top: 'incoming',
      };
    case 'blur':
      return {
        incoming: [
          { offset: 0, filter: 'blur(24px)', opacity: '0' },
          { offset: 1, filter: 'blur(0px)', opacity: '1' },
        ],
        outgoing: [
          { offset: 0, filter: 'blur(0px)', opacity: '1' },
          { offset: 1, filter: 'blur(24px)', opacity: '0' },
        ],
        top: 'incoming',
      };
    case 'flip': {
      const horizontal = v.x !== 0;
      const axis = horizontal ? 'rotateY' : 'rotateX';
      // content moving left/up turns the card around its vertical/horizontal axis
      const sign = horizontal ? v.x : -v.y;
      return {
        incoming: [
          { transform: `${axis}(${-180 * sign}deg) scale(0.9)` },
          { offset: 0.5, transform: `${axis}(${-90 * sign}deg) scale(0.8)` },
          { transform: `${axis}(0deg) scale(1)` },
        ],
        outgoing: [
          { transform: `${axis}(0deg) scale(1)` },
          { offset: 0.5, transform: `${axis}(${90 * sign}deg) scale(0.8)` },
          { transform: `${axis}(${180 * sign}deg) scale(0.9)` },
        ],
        top: 'incoming',
        perspective: 1600,
        backface: true,
      };
    }
    case 'cube': {
      // A real cube: both slides are faces turning around the cube's center axis, half a slide
      // behind the screen; the faces turned away from the camera are hidden.
      const horizontal = v.x !== 0;
      const axis = horizontal ? 'rotateY' : 'rotateX';
      const d = Math.round((horizontal ? stage.width : stage.height) / 2);
      const face = (deg: number): string =>
        `translateZ(-${d}px) ${axis}(${deg}deg) translateZ(${d}px)`;
      // content moving left/up: the incoming face comes from the right/bottom of the cube
      const from = horizontal ? -90 * v.x : 90 * v.y;
      return {
        incoming: [{ transform: face(from) }, { transform: face(0) }],
        outgoing: [{ transform: face(0) }, { transform: face(-from) }],
        top: 'incoming',
        perspective: Math.round(d * 3.4),
        backface: true,
      };
    }
    case 'magic':
    case 'fade':
    default:
      return {
        incoming: [{ opacity: '0' }, { opacity: '1' }],
        outgoing: t.preset === 'magic' ? [{ opacity: '1' }, { opacity: '0' }] : STILL,
        top: 'incoming',
      };
  }
}

/**
 * Keyframes of both slides for a transition. `reverse` (navigating back) plays the forward transition
 * time-reversed: the slide that is leaving takes the keyframes the incoming slide had, backwards.
 * `stage` is the size of the slides on screen (`cube` turns around an axis half a slide deep).
 */
export function transitionPlan(
  t: SlideTransition,
  reverse = false,
  stage: StageSize = DEFAULT_STAGE,
): TransitionPlan | null {
  const r = resolveTransition(t);
  if (!r) return null;
  const f = forward(r, stage);
  const base = {
    preset: r.preset,
    duration: r.duration,
    easing: r.easing,
    direction: r.direction,
    ...(f.perspective !== undefined && { perspective: f.perspective }),
    ...(f.backface && { backface: true }),
    ...(r.preset === 'magic' && { magic: true }),
  };
  if (!reverse) {
    return {
      ...base,
      incoming: {
        keyframes: f.incoming,
        reverse: false,
        ...(f.incomingOrigin && { origin: f.incomingOrigin }),
      },
      outgoing: {
        keyframes: f.outgoing,
        reverse: false,
        ...(f.outgoingOrigin && { origin: f.outgoingOrigin }),
      },
      top: f.top,
    };
  }
  return {
    ...base,
    // going back: the slide we return to plays the old outgoing part backwards, and vice versa
    incoming: {
      keyframes: f.outgoing,
      reverse: true,
      ...(f.outgoingOrigin && { origin: f.outgoingOrigin }),
    },
    outgoing: {
      keyframes: f.incoming,
      reverse: true,
      ...(f.incomingOrigin && { origin: f.incomingOrigin }),
    },
    top: f.top === 'incoming' ? 'outgoing' : 'incoming',
  };
}
