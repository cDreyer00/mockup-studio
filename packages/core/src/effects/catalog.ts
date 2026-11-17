/**
 * Effects catalog: custom GLSL shaders (WebGL 1 fragment shaders) and particles.
 * Single source for the editor, the render page, the MCP (`list_effects`) and the exporters.
 * No DOM and no Node.
 */
import type { EffectSpec, MediaParamValue } from '../types.js';
import {
  GLASS_FRAGMENT,
  GRAIN_FRAGMENT,
  HALFTONE_FRAGMENT,
  LIQUID_METAL_FRAGMENT,
  MESH_GRADIENT_FRAGMENT,
  WAVES_FRAGMENT,
} from './shaders.js';

export type EffectCategory = 'shader' | 'particles';
export type EffectParamType = 'number' | 'color' | 'boolean' | 'select';

export interface EffectParamDef {
  /** Param name (camelCase), e.g. `speed`, `color1`. In the shader it becomes the `u_<name>` uniform. */
  name: string;
  label: string;
  type: EffectParamType;
  default: MediaParamValue;
  min?: number;
  max?: number;
  step?: number;
  /** Options for `select`. */
  options?: string[];
  description: string;
}

export interface EffectPreset {
  /** Preset id (kebab-case), e.g. `aurora`. */
  name: string;
  label: string;
  params: Record<string, MediaParamValue>;
}

export interface EffectDef {
  kind: string;
  label: string;
  category: EffectCategory;
  description: string;
  params: EffectParamDef[];
  presets: EffectPreset[];
  /** GLSL ES 1.0 fragment shader (`shader` only). */
  fragment?: string;
}

// ---------- definition builders ----------

const num = (
  name: string,
  label: string,
  def: number,
  min: number,
  max: number,
  step: number,
  description: string,
): EffectParamDef => ({ name, label, type: 'number', default: def, min, max, step, description });

const color = (name: string, label: string, def: string, description: string): EffectParamDef => ({
  name,
  label,
  type: 'color',
  default: def,
  description,
});

const bool = (name: string, label: string, def: boolean, description: string): EffectParamDef => ({
  name,
  label,
  type: 'boolean',
  default: def,
  description,
});

const select = (
  name: string,
  label: string,
  def: string,
  options: string[],
  description: string,
): EffectParamDef => ({ name, label, type: 'select', default: def, options, description });

const speed = (def = 1): EffectParamDef =>
  num('speed', 'Speed', def, 0, 4, 0.05, 'Animation speed (0 = static).');

const preset = (
  name: string,
  label: string,
  params: Record<string, MediaParamValue>,
): EffectPreset => ({ name, label, params });

export const EFFECTS: readonly EffectDef[] = [
  {
    kind: 'mesh-gradient',
    label: 'Mesh gradient',
    category: 'shader',
    description:
      'Four-color gradient with soft drifting blobs, warped by noise, with optional swirl and grain.',
    params: [
      color('color1', 'Color 1', '#0d1b4c', 'First color (top-left corner).'),
      color('color2', 'Color 2', '#00c2a8', 'Second color (top-right corner).'),
      color('color3', 'Color 3', '#7b2ff7', 'Third color (bottom-right corner).'),
      color('color4', 'Color 4', '#12d8fa', 'Fourth color (bottom-left corner).'),
      speed(1),
      num('distortion', 'Distortion', 0.5, 0, 1, 0.01, 'Strength of the noise warp.'),
      num('swirl', 'Swirl', 0.3, 0, 1, 0.01, 'How much the center twists on itself.'),
      num('grain', 'Grain', 0.15, 0, 1, 0.01, 'Amount of grain over the gradient.'),
    ],
    presets: [
      preset('aurora', 'Aurora', {
        color1: '#0d1b4c',
        color2: '#00c2a8',
        color3: '#7b2ff7',
        color4: '#12d8fa',
      }),
      preset('sunset', 'Sunset', {
        color1: '#ff5e62',
        color2: '#ff9966',
        color3: '#f9d423',
        color4: '#8e2de2',
        swirl: 0.45,
      }),
      preset('ocean', 'Ocean', {
        color1: '#03045e',
        color2: '#0077b6',
        color3: '#00b4d8',
        color4: '#90e0ef',
        distortion: 0.65,
        grain: 0.08,
      }),
      preset('candy', 'Cotton candy', {
        color1: '#ff9ec7',
        color2: '#ffd6a5',
        color3: '#a0c4ff',
        color4: '#caffbf',
        distortion: 0.4,
        grain: 0.05,
      }),
    ],
    fragment: MESH_GRADIENT_FRAGMENT,
  },
  {
    kind: 'grain',
    label: 'Film grain',
    category: 'shader',
    description: 'Animated film noise over a two-color gradient.',
    params: [
      color('color1', 'Color 1', '#1b1b1f', 'Base color (top of the gradient).'),
      color('color2', 'Color 2', '#4a4a55', 'Base color (bottom of the gradient).'),
      num('intensity', 'Intensity', 0.55, 0, 1, 0.01, 'Grain strength.'),
      num('size', 'Size', 1.5, 0.5, 6, 0.1, 'Grain size (px at 720 height).'),
      speed(1),
    ],
    presets: [
      preset('film', 'Film', {
        color1: '#1b1b1f',
        color2: '#4a4a55',
        intensity: 0.55,
        size: 1.5,
      }),
      preset('warm', 'Warm', {
        color1: '#ff7a59',
        color2: '#ffcf70',
        intensity: 0.45,
        size: 1.2,
      }),
      preset('cool', 'Cool', {
        color1: '#1d4ed8',
        color2: '#22d3ee',
        intensity: 0.5,
        size: 1.8,
      }),
      preset('paper', 'Paper', {
        color1: '#f5f5f4',
        color2: '#d6d3d1',
        intensity: 0.35,
        size: 1,
        speed: 0.4,
      }),
    ],
    fragment: GRAIN_FRAGMENT,
  },
  {
    kind: 'halftone',
    label: 'Halftone',
    category: 'shader',
    description: 'Halftone dots, squares or lines that vary in size over a moving gradient.',
    params: [
      color('color', 'Color', '#111111', 'Dot color.'),
      color('background', 'Background', '#f4efe6', 'Background color.'),
      num('dotSize', 'Cell size', 22, 6, 60, 1, 'Grid cell side (px at 720 height).'),
      num('angle', 'Angle', 45, 0, 90, 1, 'Grid rotation, in degrees.'),
      speed(1),
      select(
        'shape',
        'Shape',
        'circle',
        ['circle', 'square', 'line'],
        'Element shape: circle, square or line.',
      ),
    ],
    presets: [
      preset('ink', 'Ink', { color: '#111111', background: '#f4efe6', dotSize: 22, angle: 45 }),
      preset('pop', 'Pop', { color: '#ff3d81', background: '#ffe14d', dotSize: 24, angle: 15 }),
      preset('blueprint', 'Blueprint', {
        color: '#9ad1ff',
        background: '#0a2540',
        dotSize: 18,
        angle: 0,
        shape: 'square',
      }),
      preset('scanlines', 'Lines', {
        color: '#e5e5e5',
        background: '#0b0b0f',
        dotSize: 16,
        angle: 0,
        shape: 'line',
      }),
    ],
    fragment: HALFTONE_FRAGMENT,
  },
  {
    kind: 'waves',
    label: 'Waves',
    category: 'shader',
    description: 'Flowing wavy lines with a two-color gradient over a solid background.',
    params: [
      color('color1', 'Color 1', '#22d3ee', 'Color of the first lines.'),
      color('color2', 'Color 2', '#e879f9', 'Color of the last lines.'),
      color('background', 'Background', '#07070f', 'Background color.'),
      num('frequency', 'Frequency', 4, 0.5, 12, 0.1, 'How many waves fit across the width.'),
      num('amplitude', 'Amplitude', 1, 0, 2, 0.05, 'Wave height.'),
      num('lines', 'Lines', 14, 1, 40, 1, 'Number of lines.'),
      speed(1),
    ],
    presets: [
      preset('neon', 'Neon', {
        color1: '#22d3ee',
        color2: '#e879f9',
        background: '#07070f',
      }),
      preset('silk', 'Silk', {
        color1: '#fda4af',
        color2: '#fcd34d',
        background: '#1c1917',
        frequency: 2.6,
        amplitude: 1.3,
        lines: 22,
        speed: 0.6,
      }),
      preset('deep', 'Deep', {
        color1: '#38bdf8',
        color2: '#818cf8',
        background: '#0b132b',
        frequency: 5.5,
        lines: 9,
      }),
      preset('mint', 'Mint', {
        color1: '#34d399',
        color2: '#a7f3d0',
        background: '#052e2b',
        frequency: 3.2,
        amplitude: 0.8,
        lines: 30,
      }),
    ],
    fragment: WAVES_FRAGMENT,
  },
  {
    kind: 'liquid-metal',
    label: 'Liquid metal',
    category: 'shader',
    description: 'Chrome liquid-metal surface with moving procedural reflections.',
    params: [
      color('tint', 'Metal tint', '#c9ced8', 'Metal color in the light areas.'),
      color('highlight', 'Highlight', '#ffffff', 'Color of the specular highlights.'),
      num('contrast', 'Contrast', 1.4, 0.5, 3, 0.05, 'Contrast between light and dark bands.'),
      speed(1),
      num('scale', 'Scale', 1, 0.3, 3, 0.05, 'Size of the ripples (larger = more detail).'),
    ],
    presets: [
      preset('chrome', 'Chrome', { tint: '#c9ced8', highlight: '#ffffff', contrast: 1.4 }),
      preset('gold', 'Gold', { tint: '#e0b050', highlight: '#fff4cf', contrast: 1.6 }),
      preset('rose', 'Rose gold', { tint: '#e8a8b8', highlight: '#fff0f4', contrast: 1.3 }),
      preset('obsidian', 'Obsidian', {
        tint: '#7a869e',
        highlight: '#bcd0ff',
        contrast: 2.2,
        scale: 1.3,
      }),
    ],
    fragment: LIQUID_METAL_FRAGMENT,
  },
  {
    kind: 'glass',
    label: 'Fluted glass',
    category: 'shader',
    description: 'Refractive fluted glass over a moving gradient, with blur and highlights.',
    params: [
      color(
        'color1',
        'Color 1',
        '#6d5dfc',
        'First color of the background seen through the glass.',
      ),
      color(
        'color2',
        'Color 2',
        '#ff8ab3',
        'Second color of the background seen through the glass.',
      ),
      num('ribs', 'Ribs', 24, 4, 80, 1, 'Number of ribs across the width.'),
      num('refraction', 'Refraction', 1, 0, 2, 0.05, 'How much each rib shifts the image.'),
      num('blur', 'Blur', 0.25, 0, 1, 0.01, 'Blur of the background behind the glass.'),
      speed(1),
    ],
    presets: [
      preset('prism', 'Prism', { color1: '#6d5dfc', color2: '#ff8ab3' }),
      preset('dusk', 'Dusk', {
        color1: '#1e1b4b',
        color2: '#f97316',
        ribs: 32,
        refraction: 1.2,
      }),
      preset('lime', 'Lime', {
        color1: '#0f766e',
        color2: '#bef264',
        ribs: 16,
        blur: 0.4,
      }),
      preset('frost', 'Frost', {
        color1: '#e0f2fe',
        color2: '#a5b4fc',
        ribs: 40,
        refraction: 0.7,
        blur: 0.15,
      }),
    ],
    fragment: GLASS_FRAGMENT,
  },
  {
    kind: 'particles',
    label: 'Particles',
    category: 'particles',
    description:
      '2D canvas particles, deterministic in time: position is a function of (seed, index, t), with no state.',
    params: [
      num('count', 'Count', 120, 10, 2000, 10, 'Number of particles.'),
      color('color', 'Color', '#ffffff', 'Particle color.'),
      color(
        'background',
        'Background',
        '#0b1020',
        'Background color; `transparent` makes the canvas transparent.',
      ),
      num('size', 'Size', 2.5, 0.5, 12, 0.1, 'Average particle radius, in px.'),
      speed(1),
      select(
        'direction',
        'Direction',
        'up',
        ['up', 'down', 'left', 'right', 'random'],
        'Movement direction.',
      ),
      num(
        'twinkle',
        'Twinkle',
        0.5,
        0,
        1,
        0.01,
        'How much the brightness of each particle flickers.',
      ),
      bool('links', 'Links', false, 'Draws lines between neighboring particles.'),
      num('seed', 'Seed', 1, 0, 9999, 1, 'Distribution seed (same seed, same pattern).'),
    ],
    presets: [
      preset('stars', 'Stars', {
        color: '#ffffff',
        background: '#05060f',
        count: 300,
        size: 1.6,
        speed: 0.3,
        direction: 'random',
        twinkle: 0.9,
      }),
      preset('snow', 'Snow', {
        color: '#ffffff',
        background: '#0f2a4a',
        count: 160,
        size: 3.5,
        speed: 0.8,
        direction: 'down',
        twinkle: 0.2,
      }),
      preset('embers', 'Embers', {
        color: '#ffb347',
        background: '#1a0a05',
        count: 140,
        size: 3,
        speed: 1.2,
        direction: 'up',
        twinkle: 0.6,
      }),
      preset('network', 'Network', {
        color: '#7dd3fc',
        background: '#0b1220',
        count: 90,
        size: 2,
        speed: 0.4,
        direction: 'random',
        twinkle: 0,
        links: true,
      }),
      preset('fireflies', 'Fireflies', {
        color: '#fde68a',
        background: 'transparent',
        count: 50,
        size: 3,
        speed: 0.5,
        direction: 'random',
        twinkle: 1,
      }),
    ],
  },
];

export function getEffect(kind: string): EffectDef | undefined {
  return EFFECTS.find((e) => e.kind === kind);
}

export function effectKinds(): string[] {
  return EFFECTS.map((e) => e.kind);
}

// ---------- validation ----------

const HEX_RE = /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
const NUM = '[+-]?(?:\\d+\\.?\\d*|\\.\\d+)%?';
const FUNC_RE = new RegExp(
  `^rgba?\\(\\s*${NUM}\\s*[,\\s]\\s*${NUM}\\s*[,\\s]\\s*${NUM}\\s*(?:[,/]\\s*${NUM}\\s*)?\\)$`,
  'i',
);

/** CSS color accepted by effects: `#rgb`, `#rgba`, `#rrggbb`, `#rrggbbaa`, `rgb()`/`rgba()` or `transparent`. */
function isCssColor(v: unknown): v is string {
  if (typeof v !== 'string') return false;
  const s = v.trim();
  return s.toLowerCase() === 'transparent' || HEX_RE.test(s) || FUNC_RE.test(s);
}

function isValid(def: EffectParamDef, v: unknown): boolean {
  switch (def.type) {
    case 'number':
      return typeof v === 'number' && Number.isFinite(v);
    case 'color':
      return isCssColor(v);
    case 'boolean':
      return typeof v === 'boolean';
    case 'select':
      return typeof v === 'string' && (def.options ?? []).includes(v);
  }
}

function clampNumber(def: EffectParamDef, v: number): number {
  let n = v;
  if (def.min !== undefined) n = Math.max(def.min, n);
  if (def.max !== undefined) n = Math.min(def.max, n);
  return n;
}

/** Full params: catalog defaults + valid values from `params` (numbers clamped to min/max). */
export function resolveEffectParams(
  kind: string,
  params: Record<string, MediaParamValue> = {},
): Record<string, MediaParamValue> {
  const def = getEffect(kind);
  if (!def) return { ...params };
  const out: Record<string, MediaParamValue> = {};
  for (const p of def.params) {
    const v = Object.prototype.hasOwnProperty.call(params, p.name) ? params[p.name] : undefined;
    if (v === undefined || !isValid(p, v)) out[p.name] = p.default;
    else out[p.name] = p.type === 'number' ? clampNumber(p, v as number) : (v as MediaParamValue);
  }
  return out;
}

const TYPE_NAMES: Record<EffectParamType, string> = {
  number: 'a number',
  color: 'a CSS color (#rgb, #rrggbb, #rrggbbaa, rgb() or rgba())',
  boolean: 'a boolean',
  select: 'a string (one of the options)',
};

/** Problems in `params` for `kind` (unknown effect, unknown param, type, range). Empty = ok. */
export function effectParamsProblems(
  kind: string,
  params: Record<string, MediaParamValue> = {},
): string[] {
  const def = getEffect(kind);
  if (!def) return [`unknown effect: "${kind}" (valid effects: ${effectKinds().join(', ')})`];
  const problems: string[] = [];
  const names = def.params.map((p) => p.name);
  for (const [name, v] of Object.entries(params)) {
    const p = def.params.find((x) => x.name === name);
    if (!p) {
      problems.push(`unknown param in "${kind}": "${name}" (valid params: ${names.join(', ')})`);
      continue;
    }
    if (p.type === 'select') {
      if (typeof v !== 'string') {
        problems.push(`param "${name}" of "${kind}" must be ${TYPE_NAMES.select}, got ${typeof v}`);
      } else if (!(p.options ?? []).includes(v)) {
        problems.push(
          `invalid option in "${name}" of "${kind}": "${v}" (options: ${(p.options ?? []).join(', ')})`,
        );
      }
    } else if (!isValid(p, v)) {
      problems.push(
        `param "${name}" of "${kind}" must be ${TYPE_NAMES[p.type]}, got ${
          typeof v === 'string' ? `"${v}"` : String(v)
        }`,
      );
    } else if (p.type === 'number') {
      const n = v as number;
      if ((p.min !== undefined && n < p.min) || (p.max !== undefined && n > p.max)) {
        problems.push(
          `param "${name}" of "${kind}" out of range: ${n} (allowed: ${p.min} to ${p.max})`,
        );
      }
    }
  }
  return problems;
}

/** Params of a preset (already resolved with defaults) or undefined. */
export function presetParams(
  kind: string,
  preset: string,
): Record<string, MediaParamValue> | undefined {
  const p = getEffect(kind)?.presets.find((x) => x.name === preset);
  return p ? resolveEffectParams(kind, p.params) : undefined;
}

// ---------- CSS fallback ----------

/** Static CSS approximating the effect (fallback background for JS-free export, SVG and poster). */
export function effectFallbackCss(spec: EffectSpec): Record<string, string> {
  const def = getEffect(spec.kind);
  if (!def) return { background: '#1e1b4b' };
  // Colors already validated by resolveEffectParams: they only contain CSS color characters.
  const p = resolveEffectParams(spec.kind, spec.params);
  const s = (name: string): string => String(p[name]).trim();
  const n = (name: string): number => Number(p[name]);

  switch (spec.kind) {
    case 'mesh-gradient':
      return {
        background: [
          `radial-gradient(circle at 15% 20%, ${s('color1')}, transparent 60%)`,
          `radial-gradient(circle at 85% 15%, ${s('color2')}, transparent 60%)`,
          `radial-gradient(circle at 80% 85%, ${s('color3')}, transparent 60%)`,
          s('color4'),
        ].join(', '),
      };
    case 'grain':
      return { background: `linear-gradient(160deg, ${s('color1')}, ${s('color2')})` };
    case 'halftone': {
      const cell = Math.round(n('dotSize'));
      const dot =
        p.shape === 'line'
          ? `repeating-linear-gradient(0deg, ${s('color')} 0 ${Math.max(1, Math.round(cell / 4))}px, transparent ${Math.max(1, Math.round(cell / 4))}px ${cell}px)`
          : `radial-gradient(circle at center, ${s('color')} 0 ${p.shape === 'square' ? 38 : 30}%, transparent ${p.shape === 'square' ? 40 : 32}%) 0 0 / ${cell}px ${cell}px`;
      return { background: `${dot}, ${s('background')}` };
    }
    case 'waves': {
      const step = Math.max(6, Math.round(240 / Math.max(1, n('lines'))));
      return {
        background: [
          `repeating-linear-gradient(172deg, transparent 0 ${step}px, ${s('color1')} ${step}px ${step + 2}px)`,
          `linear-gradient(160deg, ${s('color1')}, transparent 45%)`,
          `linear-gradient(20deg, ${s('color2')}, transparent 50%)`,
          s('background'),
        ].join(', '),
      };
    }
    case 'liquid-metal':
      return {
        background: `linear-gradient(115deg, #0b0b10 0%, ${s('tint')} 25%, ${s('highlight')} 40%, #15151c 55%, ${s('tint')} 75%, ${s('highlight')} 90%)`,
      };
    case 'glass':
      return {
        background: `repeating-linear-gradient(90deg, rgba(255, 255, 255, 0.18) 0, rgba(255, 255, 255, 0) 14px, rgba(0, 0, 0, 0.1) 18px), linear-gradient(135deg, ${s('color1')}, ${s('color2')})`,
      };
    case 'particles': {
      const c = s('color');
      const dots = [
        `radial-gradient(circle at 20% 30%, ${c} 0 1.5px, transparent 2.5px)`,
        `radial-gradient(circle at 70% 20%, ${c} 0 2px, transparent 3px)`,
        `radial-gradient(circle at 45% 70%, ${c} 0 1.5px, transparent 2.5px)`,
        `radial-gradient(circle at 85% 80%, ${c} 0 2px, transparent 3px)`,
      ];
      const bg = s('background');
      return {
        background: [...dots, bg.toLowerCase() === 'transparent' ? 'transparent' : bg].join(', '),
      };
    }
    default:
      return { background: '#1e1b4b' };
  }
}
