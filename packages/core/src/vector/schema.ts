/** Validation (zod) of the vector model: used by the `setVector` op and when reading files. */
import { z } from 'zod';
import { sanitizeSvg } from '../svg.js';
import { parsePathData } from './path.js';
import type { Vector, VectorGradient, VectorPaint, VectorPath } from '../types.js';

/** `<svg>` attributes that the generator controls: they never go into `Vector.attrs`. */
export const GENERATED_SVG_ATTRS: readonly string[] = ['viewBox', 'xmlns', 'width', 'height'];

// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u001f\u007f]/;
const PAINT_FORBIDDEN_RE = /[<>";{}\\]|url\(|expression\(|javascript:/i;

/**
 * Color/paint as text: no characters that escape the attribute or the CSS declaration (`< > " ; { }`,
 * backslash, control) nor `url(`/`expression(`/`javascript:` (a gradient is an object).
 */
export function isSafePaintString(value: string): boolean {
  return (
    value.trim().length > 0 &&
    value.length <= 200 &&
    !PAINT_FORBIDDEN_RE.test(value) &&
    !CONTROL_RE.test(value)
  );
}

const PaintString = z.string().refine(isSafePaintString, {
  error: 'invalid paint (without < > " ; { } \\, url(, expression( or javascript:)',
});

const Frac = z.number().min(0).max(1);

const GradientStopSchema = z.object({
  offset: Frac,
  color: PaintString,
  opacity: Frac.optional(),
});

const GradientSchema = z.object({
  type: z.enum(['linear', 'radial']),
  stops: z.array(GradientStopSchema).min(1).max(32),
  x1: z.number().optional(),
  y1: z.number().optional(),
  x2: z.number().optional(),
  y2: z.number().optional(),
  cx: z.number().optional(),
  cy: z.number().optional(),
  r: z.number().min(0).optional(),
});

const PaintSchema = z.union([PaintString, GradientSchema]);

/** Only path data characters (commands, digits, signs, dot, exponent, comma and space). */
const PATH_DATA_RE = /^[MmLlHhVvCcSsQqTtAaZz0-9eE.,+\-\s]*$/;
const DASH_RE = /^(?:none|[0-9eE.,+\-\s]+)$/;
const PATH_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const ATTR_KEY_RE = /^[a-zA-Z_:][-a-zA-Z0-9_:.]*$/;

const PathSchema = z.object({
  id: z.string().regex(PATH_ID_RE, { error: 'invalid path id (use letters, digits, "-" and "_")' }),
  d: z
    .string()
    .regex(PATH_DATA_RE, { error: 'path data with invalid characters' })
    .superRefine((d, ctx) => {
      try {
        parsePathData(d);
      } catch (err) {
        const why = (err instanceof Error ? err.message : String(err)).replace(
          /^Invalid path:\s*/,
          '',
        );
        ctx.addIssue({ code: 'custom', message: `Invalid path data in "d": ${why}` });
      }
    }),
  fill: PaintSchema.optional(),
  stroke: PaintSchema.optional(),
  strokeWidth: z.number().min(0).optional(),
  opacity: Frac.optional(),
  strokeLinecap: z.enum(['butt', 'round', 'square']).optional(),
  strokeLinejoin: z.enum(['miter', 'round', 'bevel']).optional(),
  strokeDasharray: z.string().regex(DASH_RE, { error: 'invalid strokeDasharray' }).optional(),
  fillRule: z.enum(['nonzero', 'evenodd']).optional(),
});

const AttrsSchema = z.record(z.string(), z.string()).superRefine((attrs, ctx) => {
  for (const k of Object.keys(attrs)) {
    if (!ATTR_KEY_RE.test(k) || /^on/i.test(k) || /(^|:)(href|style)$/i.test(k)) {
      ctx.addIssue({ code: 'custom', message: `attribute "${k}" not allowed`, path: [k] });
    }
  }
});

export const VectorSchema: z.ZodType<Vector, unknown> = z
  .object({
    viewBox: z.object({
      x: z.number(),
      y: z.number(),
      width: z.number().positive(),
      height: z.number().positive(),
    }),
    paths: z.array(PathSchema),
    raw: z
      .string()
      .transform(sanitizeSvg)
      .refine((s) => s.length > 0, { error: 'raw without <svg>' })
      .optional(),
    attrs: AttrsSchema.optional(),
  })
  .superRefine((v, ctx) => {
    const seen = new Set<string>();
    v.paths.forEach((p, i) => {
      if (seen.has(p.id)) {
        ctx.addIssue({
          code: 'custom',
          message: `duplicate path id: "${p.id}"`,
          path: ['paths', i, 'id'],
        });
      }
      seen.add(p.id);
    });
  }) as unknown as z.ZodType<Vector, unknown>;

/** Validates when reading a file: an invalid vector becomes `undefined` (the field is dropped). */
export function parseVectorLoose(input: unknown): Vector | undefined {
  if (input === undefined || input === null) return undefined;
  const r = VectorSchema.safeParse(input);
  return r.success ? r.data : undefined;
}

/* ------------------------------------------------------------------------------- stable order */

function orderPaint(p: VectorPaint): unknown {
  if (typeof p === 'string') return p;
  const g: VectorGradient = p;
  const o: Record<string, unknown> = { type: g.type };
  for (const k of ['x1', 'y1', 'x2', 'y2', 'cx', 'cy', 'r'] as const) {
    if (g[k] !== undefined) o[k] = g[k];
  }
  o.stops = g.stops.map((s) => {
    const st: Record<string, unknown> = { offset: s.offset, color: s.color };
    if (s.opacity !== undefined) st.opacity = s.opacity;
    return st;
  });
  return o;
}

function orderPath(p: VectorPath): Record<string, unknown> {
  const o: Record<string, unknown> = { id: p.id, d: p.d };
  if (p.fill !== undefined) o.fill = orderPaint(p.fill);
  if (p.stroke !== undefined) o.stroke = orderPaint(p.stroke);
  if (p.strokeWidth !== undefined) o.strokeWidth = p.strokeWidth;
  if (p.opacity !== undefined) o.opacity = p.opacity;
  if (p.strokeLinecap !== undefined) o.strokeLinecap = p.strokeLinecap;
  if (p.strokeLinejoin !== undefined) o.strokeLinejoin = p.strokeLinejoin;
  if (p.strokeDasharray !== undefined) o.strokeDasharray = p.strokeDasharray;
  if (p.fillRule !== undefined) o.fillRule = p.fillRule;
  return o;
}

/** Vector with keys in stable order (for `serializeDocument`). */
export function orderVector(v: Vector): Record<string, unknown> {
  const out: Record<string, unknown> = {
    viewBox: { x: v.viewBox.x, y: v.viewBox.y, width: v.viewBox.width, height: v.viewBox.height },
    paths: v.paths.map(orderPath),
  };
  if (v.raw !== undefined) out.raw = v.raw;
  if (v.attrs !== undefined) {
    out.attrs = Object.fromEntries(
      Object.entries(v.attrs).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
    );
  }
  return out;
}
