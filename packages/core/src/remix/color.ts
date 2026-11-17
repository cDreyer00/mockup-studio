/**
 * Shade scale (50..900) from a base color, computed in OKLCH: lightness (L) follows
 * a fixed light-to-dark curve, the hue (h) is the base's and chroma follows the base, with less
 * saturation at the ends, reduced until it fits the sRGB gamut. Pure module (no DOM and no Node).
 */
import { formatHexColor, parseCssColor } from '../cssEval.js';

export interface ColorStop {
  /** 50, 100, 200, ..., 900. */
  stop: number;
  /** `#rrggbb`. */
  color: string;
}

export const COLOR_STOPS = [50, 100, 200, 300, 400, 500, 600, 700, 800, 900] as const;

/** OKLCH lightness of each stop (50 very light, 900 very dark). */
const STOP_L = [0.975, 0.94, 0.885, 0.81, 0.72, 0.63, 0.54, 0.45, 0.37, 0.29];
/** How much of the base chroma each stop keeps (the ends are more desaturated). */
const STOP_CHROMA = [0.12, 0.28, 0.52, 0.78, 0.95, 1, 0.96, 0.85, 0.72, 0.58];
/** Chroma ratio ceiling relative to the base (avoids blowing out the saturation of a very light/dark base). */
const MAX_CHROMA_RATIO = 1.6;
/** Below this the color is treated as gray (no hue). */
const ACHROMATIC = 0.004;

type Vec3 = [number, number, number];

const toLinear = (c: number): number =>
  c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
const toGamma = (c: number): number =>
  c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;

/** sRGB (0..1) → OKLab. */
function rgbToOklab(r: number, g: number, b: number): Vec3 {
  const lr = toLinear(r);
  const lg = toLinear(g);
  const lb = toLinear(b);
  const l = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb);
  const m = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb);
  const s = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

/** OKLab → gamma-encoded sRGB from linear, without clamping (to test the gamut). */
function oklabToRgb(L: number, a: number, b: number): Vec3 {
  const l = Math.pow(L + 0.3963377774 * a + 0.2158037573 * b, 3);
  const m = Math.pow(L - 0.1055613458 * a - 0.0638541728 * b, 3);
  const s = Math.pow(L - 0.0894841775 * a - 1.291485548 * b, 3);
  const lin: Vec3 = [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
  return lin.map((c) => toGamma(Math.max(c, 0))) as Vec3;
}

const inGamut = (rgb: Vec3): boolean => rgb.every((c) => c >= -0.0005 && c <= 1.0005);

/** OKLCH color → hex, reducing chroma until it fits sRGB (L and h preserved). */
function oklchToHex(L: number, C: number, hRad: number): string {
  const make = (c: number): Vec3 => oklabToRgb(L, c * Math.cos(hRad), c * Math.sin(hRad));
  let rgb = make(C);
  if (!inGamut(rgb)) {
    let lo = 0;
    let hi = C;
    for (let i = 0; i < 24; i++) {
      const mid = (lo + hi) / 2;
      if (inGamut(make(mid))) lo = mid;
      else hi = mid;
    }
    rgb = make(lo);
  }
  const [r, g, b] = rgb;
  return formatHexColor({ r, g, b, a: 1 });
}

/**
 * Ten shades (stops 50..900) of the `base` color (hex, `rgb()`, `hsl()`, `oklch()`, CSS names...; `var()`
 * tokens must arrive already resolved). The stop whose lightness is closest to the base's gets the
 * base itself (opacity is dropped); the others follow the lightness curve, with the same
 * hue. Deterministic. Throws `Error` if the color is not recognized.
 */
export function colorScale(base: string): ColorStop[] {
  const rgba = typeof base === 'string' ? parseCssColor(base) : null;
  if (!rgba)
    throw new Error(`Invalid color: "${String(base)}". Use hex, rgb(), hsl() or a CSS name.`);
  const baseHex = formatHexColor({ ...rgba, a: 1 });
  const [bl, ba, bb] = rgbToOklab(rgba.r, rgba.g, rgba.b);
  const chroma = Math.hypot(ba, bb);
  const hue = Math.atan2(bb, ba);

  let anchor = 0;
  for (let i = 1; i < STOP_L.length; i++) {
    if (Math.abs(STOP_L[i]! - bl) < Math.abs(STOP_L[anchor]! - bl)) anchor = i;
  }
  const anchorFactor = STOP_CHROMA[anchor]!;
  return COLOR_STOPS.map((stop, i) => {
    if (i === anchor) return { stop, color: baseHex };
    if (chroma < ACHROMATIC) return { stop, color: oklchToHex(STOP_L[i]!, 0, 0) };
    const ratio = Math.min(STOP_CHROMA[i]! / anchorFactor, MAX_CHROMA_RATIO);
    return { stop, color: oklchToHex(STOP_L[i]!, chroma * ratio, hue) };
  });
}

/** OKLab lightness (0..1) of a CSS color, or `null` if invalid. Useful for sorting shades. */
export function colorLightness(value: string): number | null {
  const c = parseCssColor(value);
  return c ? rgbToOklab(c.r, c.g, c.b)[0] : null;
}
