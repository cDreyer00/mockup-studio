/**
 * Motion easings: named curves (CSS `cubic-bezier`) and physical ones (springs, bounce, elastic)
 * generated as CSS `linear()` curves, so the same string drives the Web Animations API on the canvas,
 * the render page and the exported CSS. Pure: no DOM.
 */

export interface NamedEasing {
  name: string;
  label: string;
  description: string;
  /** `curve` = smooth bezier; `overshoot` = goes past the target (back, spring, elastic); `bounce`. */
  group: 'basic' | 'smooth' | 'overshoot' | 'physics';
}

/** CSS keywords and bezier curves. */
const BEZIER: Record<string, string> = {
  linear: 'linear',
  ease: 'ease',
  'ease-in': 'ease-in',
  'ease-out': 'ease-out',
  'ease-in-out': 'ease-in-out',
  smooth: 'cubic-bezier(0.4, 0, 0.2, 1)',
  'smooth-out': 'cubic-bezier(0.05, 0.7, 0.1, 1)',
  'smooth-in': 'cubic-bezier(0.3, 0, 0.8, 0.15)',
  'expo-out': 'cubic-bezier(0.16, 1, 0.3, 1)',
  'expo-in': 'cubic-bezier(0.7, 0, 0.84, 0)',
  'expo-in-out': 'cubic-bezier(0.87, 0, 0.13, 1)',
  'back-out': 'cubic-bezier(0.34, 1.56, 0.64, 1)',
  'back-in': 'cubic-bezier(0.36, 0, 0.66, -0.56)',
  'back-in-out': 'cubic-bezier(0.68, -0.6, 0.32, 1.6)',
};

/** Springs by `bounce` (0 = no overshoot, 0.9 = very wobbly). */
const SPRINGS: Record<string, number> = {
  'spring-soft': 0,
  spring: 0.25,
  'spring-bouncy': 0.5,
  'spring-wobbly': 0.7,
};

export const NAMED_EASINGS: NamedEasing[] = [
  {
    name: 'linear',
    label: 'Linear',
    group: 'basic',
    description: 'Constant speed (spins, loops).',
  },
  { name: 'ease', label: 'Ease', group: 'basic', description: 'CSS default.' },
  { name: 'ease-in', label: 'Ease in', group: 'basic', description: 'Starts slow.' },
  { name: 'ease-out', label: 'Ease out', group: 'basic', description: 'Ends slow.' },
  { name: 'ease-in-out', label: 'Ease in-out', group: 'basic', description: 'Slow at both ends.' },
  {
    name: 'smooth',
    label: 'Smooth',
    group: 'smooth',
    description: 'Standard UI curve (moves within the screen).',
  },
  {
    name: 'smooth-out',
    label: 'Smooth out',
    group: 'smooth',
    description: 'Fast start, long soft landing: entrances.',
  },
  {
    name: 'smooth-in',
    label: 'Smooth in',
    group: 'smooth',
    description: 'Accelerates away: exits.',
  },
  { name: 'expo-out', label: 'Expo out', group: 'smooth', description: 'Snappy entrance.' },
  { name: 'expo-in', label: 'Expo in', group: 'smooth', description: 'Snappy exit.' },
  { name: 'expo-in-out', label: 'Expo in-out', group: 'smooth', description: 'Dramatic move.' },
  {
    name: 'back-out',
    label: 'Back out',
    group: 'overshoot',
    description: 'Overshoots the target, then settles.',
  },
  { name: 'back-in', label: 'Back in', group: 'overshoot', description: 'Pulls back, then goes.' },
  {
    name: 'back-in-out',
    label: 'Back in-out',
    group: 'overshoot',
    description: 'Anticipation and overshoot.',
  },
  {
    name: 'spring-soft',
    label: 'Spring (soft)',
    group: 'physics',
    description: 'Spring without overshoot.',
  },
  { name: 'spring', label: 'Spring', group: 'physics', description: 'Spring, small overshoot.' },
  {
    name: 'spring-bouncy',
    label: 'Spring (bouncy)',
    group: 'physics',
    description: 'Spring with a visible bounce.',
  },
  {
    name: 'spring-wobbly',
    label: 'Spring (wobbly)',
    group: 'physics',
    description: 'Spring that wobbles a few times.',
  },
  { name: 'bounce', label: 'Bounce', group: 'physics', description: 'Falls and bounces (ball).' },
  {
    name: 'elastic',
    label: 'Elastic',
    group: 'physics',
    description: 'Elastic snap past the end.',
  },
];

const NAMES = new Set(NAMED_EASINGS.map((e) => e.name));

/** `true` for a named easing (`spring`, `back-out`...). */
export function isNamedEasing(name: string): boolean {
  return NAMES.has(name);
}

/* ---------------- curves ---------------- */

/** Spring position (0 → 1) at normalized time `u` (settles at u = 1), for a `bounce` of 0 to 0.9. */
export function springAt(u: number, bounce: number): number {
  const zeta = Math.min(1, Math.max(0.1, 1 - bounce));
  const eps = 0.004;
  if (zeta >= 0.999) {
    // critically damped: (1 + w) e^-w = eps  →  w ≈ 7.8
    const w = 7.8;
    return 1 - (1 + w * u) * Math.exp(-w * u);
  }
  const root = Math.sqrt(1 - zeta * zeta);
  const w = Math.log(1 / (eps * root)) / zeta;
  const wd = w * root;
  return 1 - Math.exp(-zeta * w * u) * (Math.cos(wd * u) + ((zeta * w) / wd) * Math.sin(wd * u));
}

/** Classic bounce-out (a ball falling onto the target). */
export function bounceOutAt(x: number): number {
  const n1 = 7.5625;
  const d1 = 2.75;
  if (x < 1 / d1) return n1 * x * x;
  if (x < 2 / d1) {
    const t = x - 1.5 / d1;
    return n1 * t * t + 0.75;
  }
  if (x < 2.5 / d1) {
    const t = x - 2.25 / d1;
    return n1 * t * t + 0.9375;
  }
  const t = x - 2.625 / d1;
  return n1 * t * t + 0.984375;
}

/** Elastic-out: snaps past the end and oscillates back. */
export function elasticOutAt(x: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  return Math.pow(2, -10 * x) * Math.sin((x * 10 - 0.75) * ((2 * Math.PI) / 3)) + 1;
}

interface Pt {
  x: number;
  y: number;
}

/** Ramer–Douglas–Peucker: keeps the points needed to stay within `tol` of the curve. */
function simplify(pts: Pt[], tol: number): Pt[] {
  if (pts.length <= 2) return pts;
  const keep = new Array<boolean>(pts.length).fill(false);
  keep[0] = true;
  keep[pts.length - 1] = true;
  const stack: [number, number][] = [[0, pts.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop()!;
    const pa = pts[a]!;
    const pb = pts[b]!;
    let worst = -1;
    let dist = 0;
    for (let i = a + 1; i < b; i++) {
      const p = pts[i]!;
      // vertical distance to the chord (the curve is a function of x)
      const t = (p.x - pa.x) / (pb.x - pa.x);
      const d = Math.abs(p.y - (pa.y + t * (pb.y - pa.y)));
      if (d > dist) {
        dist = d;
        worst = i;
      }
    }
    if (worst >= 0 && dist > tol) {
      keep[worst] = true;
      stack.push([a, worst], [worst, b]);
    }
  }
  return pts.filter((_, i) => keep[i]);
}

const num = (n: number, digits: number): string => {
  const s = n.toFixed(digits);
  return s.includes('.') ? s.replace(/0+$/, '').replace(/\.$/, '') : s;
};

/** CSS `linear()` approximating `f` on [0, 1] (f(0) = 0, f(1) = 1). */
export function linearEasing(f: (x: number) => number, samples = 240, tol = 0.0015): string {
  const pts: Pt[] = [];
  for (let i = 0; i <= samples; i++) {
    const x = i / samples;
    pts.push({ x, y: i === 0 ? 0 : i === samples ? 1 : f(x) });
  }
  const kept = simplify(pts, tol);
  const parts = kept.map((p, i) =>
    i === 0 || i === kept.length - 1 ? num(p.y, 4) : `${num(p.y, 4)} ${num(p.x * 100, 2)}%`,
  );
  return `linear(${parts.join(', ')})`;
}

const cache = new Map<string, string>();

function cached(key: string, make: () => string): string {
  let v = cache.get(key);
  if (v === undefined) {
    v = make();
    cache.set(key, v);
  }
  return v;
}

const SPRING_FN_RE = /^spring\(\s*(-?\d*\.?\d+)\s*\)$/i;
const BEZIER_RE =
  /^cubic-bezier\(\s*(-?\d*\.?\d+)\s*,\s*(-?\d*\.?\d+)\s*,\s*(-?\d*\.?\d+)\s*,\s*(-?\d*\.?\d+)\s*\)$/i;
const STEPS_RE =
  /^steps\(\s*(\d+)\s*(?:,\s*(jump-start|jump-end|jump-none|jump-both|start|end)\s*)?\)$/i;
const LINEAR_FN_RE =
  /^linear\(\s*(-?\d*\.?\d+(\s+-?\d*\.?\d+%){0,2})(\s*,\s*-?\d*\.?\d+(\s+-?\d*\.?\d+%){0,2})*\s*\)$/i;

/**
 * Problem with an easing string, or `null` when valid: a named easing, `spring(<bounce 0..0.9>)`,
 * `cubic-bezier(x1, y1, x2, y2)` (x in 0..1), `steps(n[, position])` or `linear(...)`.
 */
export function easingProblem(easing: string): string | null {
  const e = easing.trim();
  if (NAMES.has(e)) return null;
  const spring = SPRING_FN_RE.exec(e);
  if (spring) {
    const b = Number(spring[1]);
    return b >= 0 && b <= 0.9 ? null : 'spring(bounce): bounce must be between 0 and 0.9';
  }
  const bz = BEZIER_RE.exec(e);
  if (bz) {
    const x1 = Number(bz[1]);
    const x2 = Number(bz[3]);
    return x1 >= 0 && x1 <= 1 && x2 >= 0 && x2 <= 1
      ? null
      : 'cubic-bezier: x1 and x2 must be between 0 and 1';
  }
  const st = STEPS_RE.exec(e);
  if (st) {
    const n = Number(st[1]);
    if (n < 1) return 'steps(n): n must be at least 1';
    if (n < 2 && /jump-none/i.test(e)) return 'steps(n, jump-none): n must be at least 2';
    return null;
  }
  if (LINEAR_FN_RE.test(e)) return null;
  const known = NAMED_EASINGS.map((n) => n.name).join(', ');
  return `unknown easing "${easing}". Use one of: ${known}; or spring(0.4), cubic-bezier(...), steps(...), linear(...)`;
}

/** CSS easing for a named or CSS easing (springs, bounce and elastic become `linear()`). */
export function resolveEasing(easing: string): string {
  const e = easing.trim();
  const bezier = BEZIER[e];
  if (bezier) return bezier;
  const spring = SPRINGS[e];
  if (spring !== undefined) return cached(e, () => linearEasing((u) => springAt(u, spring)));
  if (e === 'bounce') return cached(e, () => linearEasing(bounceOutAt, 400, 0.0012));
  if (e === 'elastic') return cached(e, () => linearEasing(elasticOutAt, 400, 0.0012));
  const fn = SPRING_FN_RE.exec(e);
  if (fn) {
    const b = Math.min(0.9, Math.max(0, Number(fn[1])));
    return cached(`spring(${b})`, () => linearEasing((u) => springAt(u, b)));
  }
  return e;
}

/** Easing of the reverse direction: `ease-out` ↔ `ease-in`, `smooth-out` ↔ `smooth-in`... */
export function reverseEasingName(easing: string): string {
  const pairs: Record<string, string> = {
    'ease-in': 'ease-out',
    'ease-out': 'ease-in',
    'smooth-in': 'smooth-out',
    'smooth-out': 'smooth-in',
    'expo-in': 'expo-out',
    'expo-out': 'expo-in',
    'back-in': 'back-out',
    'back-out': 'back-in',
  };
  return pairs[easing] ?? easing;
}
