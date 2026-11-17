/**
 * CSS evaluation: calc()/min()/max()/clamp() and color-mix() on values that no longer contain var().
 * Pure module (no DOM, no Node).
 */

export interface Rgba {
  r: number;
  g: number;
  b: number;
  a: number;
}

type Vec3 = [number, number, number];
type Mat3 = [Vec3, Vec3, Vec3];

type Space =
  | 'srgb'
  | 'srgb-linear'
  | 'display-p3'
  | 'hsl'
  | 'hwb'
  | 'lab'
  | 'lch'
  | 'oklab'
  | 'oklch'
  | 'xyz-d50'
  | 'xyz-d65';

/** Color in a native space: components on the space's own scale (hsl/hwb in 0..100, hue in degrees). */
interface Color {
  space: Space;
  c: Vec3;
  a: number;
}

// ---------------------------------------------------------------------------
// Named colors
// ---------------------------------------------------------------------------

const NAMED_COLORS: Record<string, string> = Object.fromEntries(
  (
    'aliceblue f0f8ff,antiquewhite faebd7,aqua 00ffff,aquamarine 7fffd4,azure f0ffff,beige f5f5dc,' +
    'bisque ffe4c4,black 000000,blanchedalmond ffebcd,blue 0000ff,blueviolet 8a2be2,brown a52a2a,' +
    'burlywood deb887,cadetblue 5f9ea0,chartreuse 7fff00,chocolate d2691e,coral ff7f50,' +
    'cornflowerblue 6495ed,cornsilk fff8dc,crimson dc143c,cyan 00ffff,darkblue 00008b,' +
    'darkcyan 008b8b,darkgoldenrod b8860b,darkgray a9a9a9,darkgreen 006400,darkgrey a9a9a9,' +
    'darkkhaki bdb76b,darkmagenta 8b008b,darkolivegreen 556b2f,darkorange ff8c00,' +
    'darkorchid 9932cc,darkred 8b0000,darksalmon e9967a,darkseagreen 8fbc8f,darkslateblue 483d8b,' +
    'darkslategray 2f4f4f,darkslategrey 2f4f4f,darkturquoise 00ced1,darkviolet 9400d3,' +
    'deeppink ff1493,deepskyblue 00bfff,dimgray 696969,dimgrey 696969,dodgerblue 1e90ff,' +
    'firebrick b22222,floralwhite fffaf0,forestgreen 228b22,fuchsia ff00ff,gainsboro dcdcdc,' +
    'ghostwhite f8f8ff,gold ffd700,goldenrod daa520,gray 808080,green 008000,greenyellow adff2f,' +
    'grey 808080,honeydew f0fff0,hotpink ff69b4,indianred cd5c5c,indigo 4b0082,ivory fffff0,' +
    'khaki f0e68c,lavender e6e6fa,lavenderblush fff0f5,lawngreen 7cfc00,lemonchiffon fffacd,' +
    'lightblue add8e6,lightcoral f08080,lightcyan e0ffff,lightgoldenrodyellow fafad2,' +
    'lightgray d3d3d3,lightgreen 90ee90,lightgrey d3d3d3,lightpink ffb6c1,lightsalmon ffa07a,' +
    'lightseagreen 20b2aa,lightskyblue 87cefa,lightslategray 778899,lightslategrey 778899,' +
    'lightsteelblue b0c4de,lightyellow ffffe0,lime 00ff00,limegreen 32cd32,linen faf0e6,' +
    'magenta ff00ff,maroon 800000,mediumaquamarine 66cdaa,mediumblue 0000cd,mediumorchid ba55d3,' +
    'mediumpurple 9370db,mediumseagreen 3cb371,mediumslateblue 7b68ee,mediumspringgreen 00fa9a,' +
    'mediumturquoise 48d1cc,mediumvioletred c71585,midnightblue 191970,mintcream f5fffa,' +
    'mistyrose ffe4e1,moccasin ffe4b5,navajowhite ffdead,navy 000080,oldlace fdf5e6,olive 808000,' +
    'olivedrab 6b8e23,orange ffa500,orangered ff4500,orchid da70d6,palegoldenrod eee8aa,' +
    'palegreen 98fb98,paleturquoise afeeee,palevioletred db7093,papayawhip ffefd5,' +
    'peachpuff ffdab9,peru cd853f,pink ffc0cb,plum dda0dd,powderblue b0e0e6,purple 800080,' +
    'rebeccapurple 663399,red ff0000,rosybrown bc8f8f,royalblue 4169e1,saddlebrown 8b4513,' +
    'salmon fa8072,sandybrown f4a460,seagreen 2e8b57,seashell fff5ee,sienna a0522d,silver c0c0c0,' +
    'skyblue 87ceeb,slateblue 6a5acd,slategray 708090,slategrey 708090,snow fffafa,' +
    'springgreen 00ff7f,steelblue 4682b4,tan d2b48c,teal 008080,thistle d8bfd8,tomato ff6347,' +
    'turquoise 40e0d0,violet ee82ee,wheat f5deb3,white ffffff,whitesmoke f5f5f5,yellow ffff00,' +
    'yellowgreen 9acd32'
  )
    .split(',')
    .map((p) => p.split(' ') as [string, string]),
);

// ---------------------------------------------------------------------------
// Color space conversions (CSS Color 4 matrices)
// ---------------------------------------------------------------------------

const LIN_SRGB_TO_XYZ: Mat3 = [
  [506752 / 1228815, 87881 / 245763, 12673 / 70218],
  [87098 / 409605, 175762 / 245763, 12673 / 175545],
  [7918 / 409605, 87881 / 737289, 1001167 / 1053270],
];
const XYZ_TO_LIN_SRGB: Mat3 = [
  [12831 / 3959, -329 / 214, -1974 / 3959],
  [-851781 / 878810, 1648619 / 878810, 36519 / 878810],
  [705 / 12673, -2585 / 12673, 705 / 667],
];
const LIN_P3_TO_XYZ: Mat3 = [
  [608311 / 1250200, 189793 / 714400, 198249 / 1000160],
  [35783 / 156275, 247089 / 357200, 198249 / 2500400],
  [0, 32229 / 714400, 5220557 / 5000800],
];
const XYZ_TO_LIN_P3: Mat3 = [
  [446124 / 137915, -333277 / 137915, -72051 / 137915],
  [-14852 / 17905, 63121 / 17905, 423 / 17905],
  [11844 / 330415, -50337 / 660830, 316169 / 330415],
];
const D65_TO_D50: Mat3 = [
  [1.0479297925449969, 0.022946870601609652, -0.05019226628920524],
  [0.02962780877005599, 0.9904344267538799, -0.017073799063418826],
  [-0.009243040646204504, 0.015055191490298152, 0.7518742814281371],
];
const D50_TO_D65: Mat3 = [
  [0.955473421488075, -0.02309845494876471, 0.06325924320057072],
  [-0.0283697093338637, 1.0099953980813041, 0.021041441191917323],
  [0.012314014864481998, -0.020507649298898964, 1.330365926242124],
];
const XYZ_TO_LMS: Mat3 = [
  [0.819022437996703, 0.3619062600528904, -0.1288737815209879],
  [0.0329836539323885, 0.9292868615863434, 0.0361446663506424],
  [0.0481771893596242, 0.2642395317527308, 0.6335478284694309],
];
const LMS_TO_XYZ: Mat3 = [
  [1.2268798758459243, -0.5578149944602171, 0.2813910456659647],
  [-0.0405757452148008, 1.112286803280317, -0.0717110580655164],
  [-0.0763729366746601, -0.4214933324022432, 1.5869240198367816],
];
const LMS_TO_OKLAB: Mat3 = [
  [0.210454268309314, 0.7936177747023054, -0.0040720430116193],
  [1.9779985324311684, -2.42859224204858, 0.450593709617411],
  [0.0259040424655478, 0.7827717124575296, -0.8086757549230774],
];
const OKLAB_TO_LMS: Mat3 = [
  [1, 0.3963377773761749, 0.2158037573099136],
  [1, -0.1055613458156586, -0.0638541728258133],
  [1, -0.0894841775298119, -1.2914855480194092],
];

const D50_WHITE: Vec3 = [0.3457 / 0.3585, 1, (1 - 0.3457 - 0.3585) / 0.3585];
const LAB_EPSILON = 216 / 24389;
const LAB_KAPPA = 24389 / 27;

function mul(m: Mat3, v: Vec3): Vec3 {
  return [
    m[0][0] * v[0] + m[0][1] * v[1] + m[0][2] * v[2],
    m[1][0] * v[0] + m[1][1] * v[1] + m[1][2] * v[2],
    m[2][0] * v[0] + m[2][1] * v[1] + m[2][2] * v[2],
  ];
}

function toLinear(c: number): number {
  const abs = Math.abs(c);
  const v = abs <= 0.04045 ? abs / 12.92 : Math.pow((abs + 0.055) / 1.055, 2.4);
  return c < 0 ? -v : v;
}

function toGamma(c: number): number {
  const abs = Math.abs(c);
  const v = abs <= 0.0031308 ? abs * 12.92 : 1.055 * Math.pow(abs, 1 / 2.4) - 0.055;
  return c < 0 ? -v : v;
}

function mod360(h: number): number {
  return ((h % 360) + 360) % 360;
}

const rad = (degrees: number): number => (degrees * Math.PI) / 180;
const deg = (radians: number): number => (radians * 180) / Math.PI;
const noNaN = (n: number): number => (Number.isNaN(n) ? 0 : n);

function hslToRgb(h: number, s: number, l: number): Vec3 {
  const hh = mod360(h);
  const ss = s / 100;
  const ll = l / 100;
  const a = ss * Math.min(ll, 1 - ll);
  const f = (n: number): number => {
    const k = (n + hh / 30) % 12;
    return ll - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
  };
  return [f(0), f(8), f(4)];
}

function rgbToHsl(r: number, g: number, b: number): Vec3 {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  let h = 0;
  let s = 0;
  if (d !== 0) {
    s = l === 0 || l === 1 ? 0 : (max - l) / Math.min(l, 1 - l);
    if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
  }
  return [h, s * 100, l * 100];
}

function hwbToRgb(h: number, w: number, b: number): Vec3 {
  const ww = w / 100;
  const bb = b / 100;
  if (ww + bb >= 1) {
    const gray = ww / (ww + bb);
    return [gray, gray, gray];
  }
  const rgb = hslToRgb(h, 100, 50);
  return rgb.map((c) => c * (1 - ww - bb) + ww) as Vec3;
}

function rgbToHwb(r: number, g: number, b: number): Vec3 {
  const [h] = rgbToHsl(r, g, b);
  return [h, Math.min(r, g, b) * 100, (1 - Math.max(r, g, b)) * 100];
}

function labToXyzD50([l, a, b]: Vec3): Vec3 {
  const fy = (l + 16) / 116;
  const fx = fy + a / 500;
  const fz = fy - b / 200;
  const inv = (f: number): number => (f ** 3 > LAB_EPSILON ? f ** 3 : (116 * f - 16) / LAB_KAPPA);
  const y = l > LAB_KAPPA * LAB_EPSILON ? fy ** 3 : l / LAB_KAPPA;
  return [inv(fx) * D50_WHITE[0], y, inv(fz) * D50_WHITE[2]];
}

function xyzD50ToLab(xyz: Vec3): Vec3 {
  const f = xyz.map((v, i) => {
    const t = v / D50_WHITE[i]!;
    return t > LAB_EPSILON ? Math.cbrt(t) : (LAB_KAPPA * t + 16) / 116;
  }) as Vec3;
  return [116 * f[1] - 16, 500 * (f[0] - f[1]), 200 * (f[1] - f[2])];
}

function polarToRect([l, c, h]: Vec3): Vec3 {
  const r = rad(noNaN(h));
  return [l, c * Math.cos(r), c * Math.sin(r)];
}

function rectToPolar([l, a, b]: Vec3): Vec3 {
  return [l, Math.hypot(a, b), mod360(deg(Math.atan2(b, a)))];
}

function oklabToXyz(lab: Vec3): Vec3 {
  const lms = mul(OKLAB_TO_LMS, lab).map((v) => v ** 3) as Vec3;
  return mul(LMS_TO_XYZ, lms);
}

function xyzToOklab(xyz: Vec3): Vec3 {
  const lms = mul(XYZ_TO_LMS, xyz).map((v) => Math.cbrt(v)) as Vec3;
  return mul(LMS_TO_OKLAB, lms);
}

/** Converts from the native space to XYZ D65 (the "hub" space). */
function toXyz(space: Space, c: Vec3): Vec3 {
  switch (space) {
    case 'srgb':
      return mul(LIN_SRGB_TO_XYZ, c.map(toLinear) as Vec3);
    case 'srgb-linear':
      return mul(LIN_SRGB_TO_XYZ, c);
    case 'display-p3':
      return mul(LIN_P3_TO_XYZ, c.map(toLinear) as Vec3);
    case 'hsl':
      return toXyz('srgb', hslToRgb(noNaN(c[0]), c[1], c[2]));
    case 'hwb':
      return toXyz('srgb', hwbToRgb(noNaN(c[0]), c[1], c[2]));
    case 'lab':
      return mul(D50_TO_D65, labToXyzD50(c));
    case 'lch':
      return mul(D50_TO_D65, labToXyzD50(polarToRect(c)));
    case 'oklab':
      return oklabToXyz(c);
    case 'oklch':
      return oklabToXyz(polarToRect(c));
    case 'xyz-d50':
      return mul(D50_TO_D65, c);
    case 'xyz-d65':
      return c;
  }
}

/** Converts from XYZ D65 to the given space. */
function fromXyz(space: Space, xyz: Vec3): Vec3 {
  switch (space) {
    case 'srgb':
      return mul(XYZ_TO_LIN_SRGB, xyz).map(toGamma) as Vec3;
    case 'srgb-linear':
      return mul(XYZ_TO_LIN_SRGB, xyz);
    case 'display-p3':
      return mul(XYZ_TO_LIN_P3, xyz).map(toGamma) as Vec3;
    case 'hsl': {
      const [r, g, b] = fromXyz('srgb', xyz);
      return rgbToHsl(r, g, b);
    }
    case 'hwb': {
      const [r, g, b] = fromXyz('srgb', xyz);
      return rgbToHwb(r, g, b);
    }
    case 'lab':
      return xyzD50ToLab(mul(D65_TO_D50, xyz));
    case 'lch':
      return rectToPolar(xyzD50ToLab(mul(D65_TO_D50, xyz)));
    case 'oklab':
      return xyzToOklab(xyz);
    case 'oklch':
      return rectToPolar(xyzToOklab(xyz));
    case 'xyz-d50':
      return mul(D65_TO_D50, xyz);
    case 'xyz-d65':
      return xyz;
  }
}

/** Index of the hue component in the space, or -1 if the space is rectangular. */
function hueIndex(space: Space): number {
  if (space === 'hsl' || space === 'hwb') return 0;
  if (space === 'lch' || space === 'oklch') return 2;
  return -1;
}

/** Marks the hue as NaN when it is "powerless" (chroma ~0, saturation 0, white+black >= 100%). */
function markPowerless(space: Space, c: Vec3): void {
  if (space === 'hsl' && Math.abs(c[1]) < 1e-4) c[0] = NaN;
  else if (space === 'hwb' && c[1] + c[2] >= 100 - 1e-4) c[0] = NaN;
  else if (space === 'lch' && Math.abs(c[1]) < 0.0015) c[2] = NaN;
  else if (space === 'oklch' && Math.abs(c[1]) < 4e-6) c[2] = NaN;
}

function convertTo(color: Color, space: Space): Color {
  const c: Vec3 =
    color.space === space ? [...color.c] : fromXyz(space, toXyz(color.space, color.c));
  markPowerless(space, c);
  return { space, c, a: color.a };
}

// ---------------------------------------------------------------------------
// Color parsing
// ---------------------------------------------------------------------------

const NUM = String.raw`[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?`;
const NUM_RE = new RegExp(`^(${NUM})(%|[a-z]*)$`, 'i');

/** Number or percentage (100% = scale). `none` is 0. NaN if invalid. */
function parseComponent(tok: string, scale: number): number {
  if (tok.toLowerCase() === 'none') return 0;
  const m = NUM_RE.exec(tok);
  if (!m) return NaN;
  const n = parseFloat(m[1]!);
  if (m[2] === '%') return (n / 100) * scale;
  return m[2] === '' ? n : NaN;
}

function parseHue(tok: string): number {
  if (tok.toLowerCase() === 'none') return 0;
  const m = NUM_RE.exec(tok);
  if (!m) return NaN;
  const n = parseFloat(m[1]!);
  switch (m[2]!.toLowerCase()) {
    case '':
    case 'deg':
      return n;
    case 'rad':
      return deg(n);
    case 'grad':
      return n * 0.9;
    case 'turn':
      return n * 360;
    default:
      return NaN;
  }
}

function parseAlpha(tok: string | undefined): number {
  if (tok === undefined) return 1;
  const a = parseComponent(tok, 1);
  return Number.isNaN(a) ? NaN : Math.min(1, Math.max(0, a));
}

function hexColor(hex: string): Color | null {
  if (!/^[0-9a-f]+$/i.test(hex) || ![3, 4, 6, 8].includes(hex.length)) return null;
  const full = hex.length <= 4 ? [...hex].map((ch) => ch + ch).join('') : hex;
  const byte = (i: number): number => parseInt(full.slice(i * 2, i * 2 + 2), 16) / 255;
  return { space: 'srgb', c: [byte(0), byte(1), byte(2)], a: full.length === 8 ? byte(3) : 1 };
}

const COLOR_SPACES: Record<string, Space> = {
  srgb: 'srgb',
  'srgb-linear': 'srgb-linear',
  'display-p3': 'display-p3',
  xyz: 'xyz-d65',
  'xyz-d65': 'xyz-d65',
  'xyz-d50': 'xyz-d50',
};

function functionColor(name: string, body: string): Color | null {
  const toks = body
    .trim()
    .split(/[\s,/]+/)
    .filter(Boolean);
  let space: Space;
  let c: number[];
  let alphaTok: string | undefined;

  if (name === 'color') {
    const sp = COLOR_SPACES[(toks.shift() ?? '').toLowerCase()];
    if (!sp || toks.length < 3 || toks.length > 4) return null;
    space = sp;
    c = toks.slice(0, 3).map((t) => parseComponent(t, 1));
    alphaTok = toks[3];
  } else {
    if (toks.length < 3 || toks.length > 4) return null;
    alphaTok = toks[3];
    const [t0, t1, t2] = toks as [string, string, string];
    switch (name) {
      case 'rgb':
      case 'rgba':
        space = 'srgb';
        c = [t0, t1, t2].map((t) => parseComponent(t, 255) / 255);
        break;
      case 'hsl':
      case 'hsla':
        space = 'hsl';
        c = [parseHue(t0), parseComponent(t1, 100), parseComponent(t2, 100)];
        break;
      case 'hwb':
        space = 'hwb';
        c = [parseHue(t0), parseComponent(t1, 100), parseComponent(t2, 100)];
        break;
      case 'lab':
        space = 'lab';
        c = [parseComponent(t0, 100), parseComponent(t1, 125), parseComponent(t2, 125)];
        break;
      case 'lch':
        space = 'lch';
        c = [parseComponent(t0, 100), parseComponent(t1, 150), parseHue(t2)];
        break;
      case 'oklab':
        space = 'oklab';
        c = [parseComponent(t0, 1), parseComponent(t1, 0.4), parseComponent(t2, 0.4)];
        break;
      case 'oklch':
        space = 'oklch';
        c = [parseComponent(t0, 1), parseComponent(t1, 0.4), parseHue(t2)];
        break;
      default:
        return null;
    }
  }
  const a = parseAlpha(alphaTok);
  if (Number.isNaN(a) || c.some((n) => Number.isNaN(n))) return null;
  return { space, c: c as Vec3, a };
}

function parseColor(value: string): Color | null {
  const v = value.trim().toLowerCase();
  if (v === '') return null;
  if (v === 'transparent') return { space: 'srgb', c: [0, 0, 0], a: 0 };
  if (v.startsWith('#')) return hexColor(v.slice(1));
  const named = NAMED_COLORS[v];
  if (named) return hexColor(named);
  const m = /^([a-z]+)\((.*)\)$/s.exec(v);
  return m ? functionColor(m[1]!, m[2]!) : null;
}

const clamp01 = (n: number): number => Math.min(1, Math.max(0, n));

/** CSS color → sRGB RGBA (0..1 per channel, alpha 0..1), or null if not a recognized color. */
export function parseCssColor(value: string): Rgba | null {
  const color = parseColor(value);
  if (!color) return null;
  const [r, g, b] = color.space === 'srgb' ? color.c : convertTo(color, 'srgb').c;
  return { r: clamp01(r), g: clamp01(g), b: clamp01(b), a: clamp01(color.a) };
}

/** RGBA → `#rrggbb` (alpha 1) or `#rrggbbaa`; channels clamped to 0..1 and rounded. */
export function formatHexColor(c: Rgba): string {
  const byte = (n: number): string =>
    Math.round(clamp01(Number.isNaN(n) ? 0 : n) * 255)
      .toString(16)
      .padStart(2, '0');
  const alpha = byte(c.a);
  return `#${byte(c.r)}${byte(c.g)}${byte(c.b)}${alpha === 'ff' ? '' : alpha}`;
}

// ---------------------------------------------------------------------------
// Text utilities (parentheses and strings)
// ---------------------------------------------------------------------------

/** Index right after the end of the string that starts at `start` (quotes). */
function skipString(s: string, start: number): number {
  const quote = s[start];
  for (let i = start + 1; i < s.length; i++) {
    if (s[i] === '\\') i++;
    else if (s[i] === quote) return i + 1;
  }
  return s.length;
}

/** Index of the `)` that closes the `(` at `open`, or -1. */
function findClose(s: string, open: number): number {
  let depth = 0;
  for (let i = open; i < s.length; i++) {
    const ch = s[i];
    if (ch === '"' || ch === "'") i = skipString(s, i) - 1;
    else if (ch === '(') depth++;
    else if (ch === ')' && --depth === 0) return i;
  }
  return -1;
}

/** Splits at the root level by commas or whitespace. */
function splitTop(s: string, mode: 'comma' | 'space'): string[] {
  const parts: string[] = [];
  let depth = 0;
  let cur = '';
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;
    if (ch === '"' || ch === "'") {
      const end = skipString(s, i);
      cur += s.slice(i, end);
      i = end - 1;
      continue;
    }
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    const isSep = depth === 0 && (mode === 'comma' ? ch === ',' : /\s/.test(ch));
    if (isSep) {
      parts.push(cur);
      cur = '';
    } else cur += ch;
  }
  parts.push(cur);
  return mode === 'space' ? parts.filter((p) => p !== '') : parts.map((p) => p.trim());
}

// ---------------------------------------------------------------------------
// calc() / min() / max() / clamp()
// ---------------------------------------------------------------------------

interface Quantity {
  n: number;
  u: string;
}

class CalcError extends Error {}

function fail(): never {
  throw new CalcError();
}

const CALC_NUM_RE = new RegExp(`^(${NUM})(%|[a-z]*)`, 'i');

function parseCalcBody(text: string): Quantity {
  let pos = 0;
  const skipWs = (): void => {
    while (pos < text.length && /\s/.test(text[pos]!)) pos++;
  };

  const sameUnit = (a: Quantity, b: Quantity): void => {
    if (a.u.toLowerCase() !== b.u.toLowerCase()) fail();
  };

  const parseArgs = (): Quantity[] => {
    const args: Quantity[] = [parseExpr()];
    skipWs();
    while (text[pos] === ',') {
      pos++;
      args.push(parseExpr());
      skipWs();
    }
    if (text[pos] !== ')') fail();
    pos++;
    return args;
  };

  const parseFactor = (): Quantity => {
    skipWs();
    const ch = text[pos];
    if (ch === undefined) return fail();
    if (ch === '(') {
      pos++;
      const q = parseExpr();
      skipWs();
      if (text[pos] !== ')') fail();
      pos++;
      return q;
    }
    const num = CALC_NUM_RE.exec(text.slice(pos));
    if (num) {
      pos += num[0].length;
      return { n: parseFloat(num[1]!), u: num[2]! };
    }
    if (ch === '+' || ch === '-') {
      // Unary sign before a parenthesis or function.
      pos++;
      const q = parseFactor();
      return ch === '-' ? { n: -q.n, u: q.u } : q;
    }
    const fn = /^([a-z-]+)\(/i.exec(text.slice(pos));
    if (!fn) return fail();
    pos += fn[0].length;
    const name = fn[1]!.toLowerCase();
    const args = parseArgs();
    if (name === 'calc') {
      if (args.length !== 1) fail();
      return args[0]!;
    }
    if (name === 'min' || name === 'max') {
      args.forEach((a) => sameUnit(args[0]!, a));
      const ns = args.map((a) => a.n);
      return { n: name === 'min' ? Math.min(...ns) : Math.max(...ns), u: args[0]!.u };
    }
    if (name === 'clamp') {
      if (args.length !== 3) fail();
      args.forEach((a) => sameUnit(args[0]!, a));
      const [lo, val, hi] = args as [Quantity, Quantity, Quantity];
      return { n: Math.max(lo.n, Math.min(val.n, hi.n)), u: lo.u };
    }
    return fail();
  };

  const parseTerm = (): Quantity => {
    let left = parseFactor();
    for (;;) {
      skipWs();
      const op = text[pos];
      if (op !== '*' && op !== '/') return left;
      pos++;
      const right = parseFactor();
      if (op === '*') {
        if (left.u !== '' && right.u !== '') fail();
        left = { n: left.n * right.n, u: left.u || right.u };
      } else {
        if (right.u !== '' || right.n === 0) fail();
        left = { n: left.n / right.n, u: left.u };
      }
    }
  };

  function parseExpr(): Quantity {
    let left = parseTerm();
    for (;;) {
      skipWs();
      const op = text[pos];
      if (op !== '+' && op !== '-') return left;
      pos++;
      const right = parseTerm();
      sameUnit(left, right);
      left = { n: op === '+' ? left.n + right.n : left.n - right.n, u: left.u };
    }
  }

  const result = parseFactor();
  skipWs();
  if (pos !== text.length) fail();
  return result;
}

function formatNumber(n: number): string {
  const s = String(parseFloat(n.toFixed(4)));
  return s === '-0' ? '0' : s;
}

/** Evaluates a single `calc(...)` expression (or min/max/clamp) or returns null if it cannot. */
export function evaluateCalc(expr: string): string | null {
  const text = expr.trim();
  if (!/^(calc|min|max|clamp)\(/i.test(text)) return null;
  try {
    const q = parseCalcBody(text);
    if (!Number.isFinite(q.n)) return null;
    return formatNumber(q.n) + q.u;
  } catch (e) {
    if (e instanceof CalcError) return null;
    throw e;
  }
}

// ---------------------------------------------------------------------------
// color-mix()
// ---------------------------------------------------------------------------

const MIX_SPACES: Record<string, Space> = {
  srgb: 'srgb',
  'srgb-linear': 'srgb-linear',
  'display-p3': 'display-p3',
  lab: 'lab',
  lch: 'lch',
  oklab: 'oklab',
  oklch: 'oklch',
  hsl: 'hsl',
  hwb: 'hwb',
  xyz: 'xyz-d65',
  'xyz-d50': 'xyz-d50',
  'xyz-d65': 'xyz-d65',
};

type HueMethod = 'shorter' | 'longer' | 'increasing' | 'decreasing';

interface MixItem {
  color: Color;
  pct: number | null;
}

const PCT_RE = new RegExp(`^(?:\\d+\\.?\\d*|\\.\\d+)(?:e[+-]?\\d+)?%$`, 'i');

function parseMixItem(text: string): MixItem | null {
  const toks = splitTop(text, 'space');
  let pct: number | null = null;
  if (toks.length > 1 && PCT_RE.test(toks[0]!)) pct = parseFloat(toks.shift()!);
  else if (toks.length > 1 && PCT_RE.test(toks[toks.length - 1]!)) pct = parseFloat(toks.pop()!);
  if (pct !== null && pct > 100) return null;
  const color = parseColor(toks.join(' '));
  return color ? { color, pct } : null;
}

function fixHues(h1: number, h2: number, method: HueMethod): [number, number] {
  const diff = h2 - h1;
  switch (method) {
    case 'shorter':
      if (diff > 180) h1 += 360;
      else if (diff < -180) h2 += 360;
      break;
    case 'longer':
      if (diff > 0 && diff < 180) h1 += 360;
      else if (diff > -180 && diff <= 0) h2 += 360;
      break;
    case 'increasing':
      if (h2 < h1) h2 += 360;
      break;
    case 'decreasing':
      if (h1 < h2) h1 += 360;
      break;
  }
  return [h1, h2];
}

/** Evaluates a single `color-mix(...)` and returns the color in hex (sRGB gamut with clamp), or null. */
export function evaluateColorMix(expr: string): string | null {
  const m = /^color-mix\((.*)\)$/is.exec(expr.trim());
  if (!m) return null;
  const parts = splitTop(m[1]!, 'comma');
  if (parts.length !== 3) return null;

  // Header: in <space> [<method> hue]?
  const head = parts[0]!.toLowerCase().split(/\s+/);
  if (head[0] !== 'in' || head.length < 2) return null;
  const space = MIX_SPACES[head[1]!];
  if (!space) return null;
  let method: HueMethod = 'shorter';
  if (head.length > 2) {
    if (head.length !== 4 || head[3] !== 'hue' || hueIndex(space) < 0) return null;
    if (!['shorter', 'longer', 'increasing', 'decreasing'].includes(head[2]!)) return null;
    method = head[2] as HueMethod;
  }

  const i1 = parseMixItem(parts[1]!);
  const i2 = parseMixItem(parts[2]!);
  if (!i1 || !i2) return null;

  // Percentage normalization.
  let p1 = i1.pct;
  let p2 = i2.pct;
  if (p1 === null && p2 === null) p1 = p2 = 50;
  else if (p1 === null) p1 = 100 - p2!;
  else if (p2 === null) p2 = 100 - p1;
  const sum = p1 + p2!;
  if (sum <= 0) return null;
  const w1 = p1 / sum;
  const w2 = p2! / sum;
  const alphaMul = sum < 100 ? sum / 100 : 1;

  const c1 = convertTo(i1.color, space);
  const c2 = convertTo(i2.color, space);
  const alpha = c1.a * w1 + c2.a * w2;
  const hi = hueIndex(space);
  const out: Vec3 = [0, 0, 0];

  for (let k = 0; k < 3; k++) {
    if (k === hi) {
      const h1 = c1.c[k]!;
      const h2 = c2.c[k]!;
      if (Number.isNaN(h1) && Number.isNaN(h2)) out[k] = 0;
      else if (Number.isNaN(h1)) out[k] = mod360(h2);
      else if (Number.isNaN(h2)) out[k] = mod360(h1);
      else {
        const [f1, f2] = fixHues(mod360(h1), mod360(h2), method);
        out[k] = mod360(f1 * w1 + f2 * w2);
      }
    } else {
      const premul = c1.c[k]! * c1.a * w1 + c2.c[k]! * c2.a * w2;
      out[k] = alpha === 0 ? premul : premul / alpha;
    }
  }

  const [r, g, b] = convertTo({ space, c: out, a: 1 }, 'srgb').c;
  return formatHexColor({ r, g, b, a: alpha * alphaMul });
}

// ---------------------------------------------------------------------------
// Evaluation of a full CSS value
// ---------------------------------------------------------------------------

const IDENT_CHAR = /[A-Za-z0-9_-]/;
const EVALUABLE = new Set(['calc', 'min', 'max', 'clamp', 'color-mix']);

function evaluateCall(name: string, inner: string): string {
  const lname = name.toLowerCase();
  const full = `${name}(${inner})`;
  if (lname === 'url' || lname === 'src') return full;
  if (EVALUABLE.has(lname)) {
    if (/var\(/i.test(inner)) return full;
    if (lname === 'color-mix') {
      const processed = `${name}(${evaluateCss(inner)})`;
      return evaluateColorMix(processed) ?? processed;
    }
    return evaluateCalc(full) ?? full;
  }
  return `${name}(${evaluateCss(inner)})`;
}

/**
 * Evaluates, where possible, the calc()/min()/max()/clamp() and color-mix() functions of a CSS value
 * that no longer contains var(). The rest of the value is left intact.
 */
export function evaluateCss(value: string): string {
  let out = '';
  let i = 0;
  while (i < value.length) {
    const ch = value[i]!;
    if (ch === '"' || ch === "'") {
      const end = skipString(value, i);
      out += value.slice(i, end);
      i = end;
    } else if (IDENT_CHAR.test(ch)) {
      let j = i;
      while (j < value.length && IDENT_CHAR.test(value[j]!)) j++;
      if (value[j] === '(') {
        const close = findClose(value, j);
        if (close === -1) {
          out += value.slice(i);
          break;
        }
        out += evaluateCall(value.slice(i, j), value.slice(j + 1, close));
        i = close + 1;
      } else {
        out += value.slice(i, j);
        i = j;
      }
    } else {
      out += ch;
      i++;
    }
  }
  return out;
}
