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

export interface TransitionPlan {
  preset: string;
  duration: number;
  /** Named or CSS easing of both parts. */
  easing: string;
  incoming: SlidePart;
  outgoing: SlidePart;
  /** Which slot is painted on top. */
  top: 'incoming' | 'outgoing';
  /** Perspective (px) of the stage for 3D presets. */
  perspective?: number;
  /** Slots hide their back face (flip). */
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

function forward(t: ResolvedTransition): Forward {
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
      const horizontal = v.x !== 0;
      const axis = horizontal ? 'rotateY' : 'rotateX';
      // the shared edge is the outgoing slide's leading edge
      const turn = horizontal ? 90 * v.x : -90 * v.y;
      const lead = horizontal ? (v.x < 0 ? '100% 50%' : '0% 50%') : v.y < 0 ? '50% 100%' : '50% 0%';
      const trail = horizontal
        ? v.x < 0
          ? '0% 50%'
          : '100% 50%'
        : v.y < 0
          ? '50% 0%'
          : '50% 100%';
      return {
        incoming: [
          { transform: `${tr(-v.x, -v.y)} ${axis}(${-turn}deg)` },
          {
            offset: 0.5,
            transform: `${tr(-v.x / 2, -v.y / 2)} ${axis}(${-turn / 2}deg) scale(0.86)`,
          },
          { transform: `${tr(0, 0)} ${axis}(0deg)` },
        ],
        outgoing: [
          { transform: `${tr(0, 0)} ${axis}(0deg)` },
          { offset: 0.5, transform: `${tr(v.x / 2, v.y / 2)} ${axis}(${turn / 2}deg) scale(0.86)` },
          { transform: `${tr(v.x, v.y)} ${axis}(${turn}deg)` },
        ],
        incomingOrigin: trail,
        outgoingOrigin: lead,
        top: 'incoming',
        perspective: 2000,
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
 */
export function transitionPlan(t: SlideTransition, reverse = false): TransitionPlan | null {
  const r = resolveTransition(t);
  if (!r) return null;
  const f = forward(r);
  const base = {
    preset: r.preset,
    duration: r.duration,
    easing: r.easing,
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
