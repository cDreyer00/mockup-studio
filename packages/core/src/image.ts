/**
 * Image adjustments as real CSS: filters (`filter`), framing (`object-fit`/`object-position`),
 * crop (`object-view-box: inset(...)`) and shape mask (`clip-path`). Used by the editor's
 * "Image" panel and the `set_image` MCP tool.
 */

export type ImageFilterName =
  | 'blur'
  | 'brightness'
  | 'contrast'
  | 'saturate'
  | 'hue-rotate'
  | 'sepia'
  | 'grayscale'
  | 'invert'
  | 'opacity';

export interface ImageFilterDef {
  name: ImageFilterName;
  label: string;
  unit: 'px' | '%' | 'deg';
  min: number;
  max: number;
  /** Neutral value (no effect). */
  neutral: number;
}

/** Panel filters, in the order they go into `filter`. */
export const IMAGE_FILTERS: readonly ImageFilterDef[] = [
  { name: 'blur', label: 'Blur', unit: 'px', min: 0, max: 50, neutral: 0 },
  { name: 'brightness', label: 'Brightness', unit: '%', min: 0, max: 300, neutral: 100 },
  { name: 'contrast', label: 'Contrast', unit: '%', min: 0, max: 300, neutral: 100 },
  { name: 'saturate', label: 'Saturation', unit: '%', min: 0, max: 300, neutral: 100 },
  { name: 'hue-rotate', label: 'Hue', unit: 'deg', min: -180, max: 180, neutral: 0 },
  { name: 'sepia', label: 'Sepia', unit: '%', min: 0, max: 100, neutral: 0 },
  { name: 'grayscale', label: 'Grayscale', unit: '%', min: 0, max: 100, neutral: 0 },
  { name: 'invert', label: 'Invert', unit: '%', min: 0, max: 100, neutral: 0 },
  { name: 'opacity', label: 'Opacity', unit: '%', min: 0, max: 100, neutral: 100 },
];

const FILTER_BY_NAME = new Map(IMAGE_FILTERS.map((f) => [f.name, f]));

export type ImageFilters = Partial<Record<ImageFilterName, number>>;

/** Splits `filter` into top-level functions (`blur(2px) drop-shadow(0 0 2px rgba(0,0,0,.5))`). */
export function splitFilterFunctions(value: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = '';
  for (const ch of value.trim()) {
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (/\s/.test(ch) && depth === 0) {
      if (cur.trim()) out.push(cur.trim());
      cur = '';
      continue;
    }
    cur += ch;
    if (ch === ')' && depth === 0) {
      out.push(cur.trim());
      cur = '';
    }
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

function parseAmount(def: ImageFilterDef, raw: string): number | null {
  const v = raw.trim();
  if (v === '') return def.unit === 'px' ? 0 : def.unit === 'deg' ? 0 : 100;
  const m = /^(-?[0-9.]+)\s*(px|%|deg|turn|rad)?$/i.exec(v);
  if (!m) return null;
  let n = parseFloat(m[1]!);
  const unit = (m[2] ?? '').toLowerCase();
  if (def.unit === '%' && unit === '') n *= 100;
  if (def.unit === 'deg' && unit === 'turn') n *= 360;
  if (def.unit === 'deg' && unit === 'rad') n = (n * 180) / Math.PI;
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : null;
}

/**
 * Reads the known filters from `filter`; anything unrecognized (e.g. `drop-shadow`, `url()`)
 * comes back in `rest` so it is preserved.
 */
export function parseImageFilters(value: string | undefined): {
  filters: ImageFilters;
  rest: string[];
} {
  const filters: ImageFilters = {};
  const rest: string[] = [];
  if (!value || value.trim() === 'none') return { filters, rest };
  for (const fn of splitFilterFunctions(value)) {
    const m = /^([a-z-]+)\((.*)\)$/i.exec(fn);
    const def = m ? FILTER_BY_NAME.get(m[1]!.toLowerCase() as ImageFilterName) : undefined;
    const amount = def ? parseAmount(def, m![2]!) : null;
    if (def && amount !== null) filters[def.name] = amount;
    else rest.push(fn);
  }
  return { filters, rest };
}

/**
 * Builds `filter` from the values (`IMAGE_FILTERS` order), omitting neutral ones, and keeps
 * the functions in `rest`. Returns `''` when nothing is left (to remove the property).
 */
export function composeImageFilters(filters: ImageFilters, rest: string[] = []): string {
  const parts: string[] = [];
  for (const def of IMAGE_FILTERS) {
    const v = filters[def.name];
    if (v === undefined || !Number.isFinite(v) || v === def.neutral) continue;
    const clamped = Math.min(def.max, Math.max(def.min, v));
    parts.push(`${def.name}(${clamped}${def.unit})`);
  }
  return [...parts, ...rest].join(' ');
}

/** Merges new filters into the existing ones (a `null` value resets to neutral). */
export function mergeImageFilters(
  current: string | undefined,
  changes: Partial<Record<ImageFilterName, number | null>>,
): string {
  const { filters, rest } = parseImageFilters(current);
  for (const [k, v] of Object.entries(changes) as [ImageFilterName, number | null][]) {
    if (v === null || v === undefined) delete filters[k];
    else filters[k] = v;
  }
  return composeImageFilters(filters, rest);
}

/* ---------------- framing ---------------- */

export const OBJECT_FIT_VALUES = ['cover', 'contain', 'fill', 'none', 'scale-down'] as const;
export type ObjectFit = (typeof OBJECT_FIT_VALUES)[number];

/** Position shortcuts (`object-position`). */
export const OBJECT_POSITION_PRESETS: Record<string, string> = {
  center: '50% 50%',
  top: '50% 0%',
  bottom: '50% 100%',
  left: '0% 50%',
  right: '100% 50%',
  'top-left': '0% 0%',
  'top-right': '100% 0%',
  'bottom-left': '0% 100%',
  'bottom-right': '100% 100%',
};

/** `top-left` → `0% 0%`; CSS values pass through. */
export function normalizeObjectPosition(value: string): string {
  const v = value.trim().toLowerCase();
  return OBJECT_POSITION_PRESETS[v] ?? value.trim();
}

/* ---------------- crop ---------------- */

/** Crop in % of each side of the original image (0 = no crop). */
export interface ImageCrop {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

/** Clamps the crop to 0..100 and guarantees at least 1% visible on each axis. */
export function clampCrop(c: ImageCrop): ImageCrop {
  const cl = (n: number): number => Math.min(99, Math.max(0, Number.isFinite(n) ? n : 0));
  const top = cl(c.top);
  const left = cl(c.left);
  let right = cl(c.right);
  let bottom = cl(c.bottom);
  if (left + right > 99) right = 99 - left;
  if (top + bottom > 99) bottom = 99 - top;
  return { top: round2(top), right: round2(right), bottom: round2(bottom), left: round2(left) };
}

/** `object-view-box` of the crop (`inset(10% 0% 5% 0%)`); `''` when there is no crop. */
export function cropToCss(c: ImageCrop): string {
  const k = clampCrop(c);
  if (k.top === 0 && k.right === 0 && k.bottom === 0 && k.left === 0) return '';
  return `inset(${k.top}% ${k.right}% ${k.bottom}% ${k.left}%)`;
}

/** Reads `object-view-box: inset(...)` in % (1 to 4 values, like `margin`); other formats: `null`. */
export function parseCrop(value: string | undefined): ImageCrop | null {
  if (!value || value.trim() === 'none') return { top: 0, right: 0, bottom: 0, left: 0 };
  const m = /^inset\(([^)]*)\)$/i.exec(value.trim());
  if (!m) return null;
  const parts = m[1]!.trim().split(/\s+/);
  if (parts.length < 1 || parts.length > 4) return null;
  const nums: number[] = [];
  for (const p of parts) {
    const mm = /^(-?[0-9.]+)%?$/.exec(p);
    if (!mm || (p !== '0' && !p.endsWith('%'))) return null;
    nums.push(parseFloat(mm[1]!));
  }
  const [t, r = t, b = t, l = r] = nums as [number, number?, number?, number?];
  return clampCrop({ top: t, right: r!, bottom: b!, left: l! });
}

/* ---------------- shape mask ---------------- */

/** Ready-made shapes for `clip-path`. */
export const CLIP_PATH_PRESETS: Record<string, { label: string; value: string }> = {
  circle: { label: 'Circle', value: 'circle(50% at 50% 50%)' },
  ellipse: { label: 'Ellipse', value: 'ellipse(50% 50% at 50% 50%)' },
  rounded: { label: 'Rounded', value: 'inset(0% round 16%)' },
  triangle: { label: 'Triangle', value: 'polygon(50% 0%, 100% 100%, 0% 100%)' },
  diamond: { label: 'Diamond', value: 'polygon(50% 0%, 100% 50%, 50% 100%, 0% 50%)' },
  pentagon: { label: 'Pentagon', value: 'polygon(50% 0%, 100% 38%, 82% 100%, 18% 100%, 0% 38%)' },
  hexagon: {
    label: 'Hexagon',
    value: 'polygon(25% 0%, 75% 0%, 100% 50%, 75% 100%, 25% 100%, 0% 50%)',
  },
  star: {
    label: 'Star',
    value:
      'polygon(50% 0%, 61% 35%, 98% 35%, 68% 57%, 79% 91%, 50% 70%, 21% 91%, 32% 57%, 2% 35%, 39% 35%)',
  },
  arrow: {
    label: 'Arrow',
    value: 'polygon(0% 20%, 60% 20%, 60% 0%, 100% 50%, 60% 100%, 60% 80%, 0% 80%)',
  },
};

/** Ready-made shape name (`circle`) → CSS value; other values pass through (`none` removes). */
export function resolveClipPath(value: string): string {
  const v = value.trim();
  const preset = CLIP_PATH_PRESETS[v.toLowerCase()];
  if (preset) return preset.value;
  return v === 'none' ? '' : v;
}

/** Name of the ready-made shape matching the value, if any. */
export function clipPathPresetOf(value: string | undefined): string | null {
  if (!value) return null;
  const v = value.replace(/\s+/g, ' ').trim();
  for (const [k, p] of Object.entries(CLIP_PATH_PRESETS)) if (p.value === v) return k;
  return null;
}
