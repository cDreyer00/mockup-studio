/** Validação (zod) do modelo vetorial: usada pela op `setVector` e pela leitura de arquivos. */
import { z } from 'zod';
import { sanitizeSvg } from '../svg.js';
import { parsePathData } from './path.js';
import type { Vector, VectorGradient, VectorPaint, VectorPath } from '../types.js';

/** Atributos do `<svg>` que o gerador controla: nunca vão para `Vector.attrs`. */
export const GENERATED_SVG_ATTRS: readonly string[] = ['viewBox', 'xmlns', 'width', 'height'];

// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u001f\u007f]/;
const PAINT_FORBIDDEN_RE = /[<>";{}\\]|url\(|expression\(|javascript:/i;

/**
 * Cor/tinta em texto: sem caracteres que escapem do atributo ou da declaração CSS (`< > " ; { }`,
 * barra invertida, controle) nem `url(`/`expression(`/`javascript:` (gradiente é objeto).
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
  error: 'tinta inválida (sem < > " ; { } \\, url(, expression( ou javascript:)',
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

/** Só caracteres de path data (comandos, dígitos, sinais, ponto, expoente, vírgula e espaço). */
const PATH_DATA_RE = /^[MmLlHhVvCcSsQqTtAaZz0-9eE.,+\-\s]*$/;
const DASH_RE = /^(?:none|[0-9eE.,+\-\s]+)$/;
const PATH_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const ATTR_KEY_RE = /^[a-zA-Z_:][-a-zA-Z0-9_:.]*$/;

const PathSchema = z.object({
  id: z
    .string()
    .regex(PATH_ID_RE, { error: 'id de path inválido (use letras, dígitos, "-" e "_")' }),
  d: z
    .string()
    .regex(PATH_DATA_RE, { error: 'path data com caracteres inválidos' })
    .superRefine((d, ctx) => {
      try {
        parsePathData(d);
      } catch (err) {
        const why = (err instanceof Error ? err.message : String(err)).replace(
          /^Path inválido:\s*/,
          '',
        );
        ctx.addIssue({ code: 'custom', message: `Path data inválido em "d": ${why}` });
      }
    }),
  fill: PaintSchema.optional(),
  stroke: PaintSchema.optional(),
  strokeWidth: z.number().min(0).optional(),
  opacity: Frac.optional(),
  strokeLinecap: z.enum(['butt', 'round', 'square']).optional(),
  strokeLinejoin: z.enum(['miter', 'round', 'bevel']).optional(),
  strokeDasharray: z.string().regex(DASH_RE, { error: 'strokeDasharray inválido' }).optional(),
  fillRule: z.enum(['nonzero', 'evenodd']).optional(),
});

const AttrsSchema = z.record(z.string(), z.string()).superRefine((attrs, ctx) => {
  for (const k of Object.keys(attrs)) {
    if (!ATTR_KEY_RE.test(k) || /^on/i.test(k) || /(^|:)(href|style)$/i.test(k)) {
      ctx.addIssue({ code: 'custom', message: `atributo "${k}" não permitido`, path: [k] });
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
      .refine((s) => s.length > 0, { error: 'raw sem <svg>' })
      .optional(),
    attrs: AttrsSchema.optional(),
  })
  .superRefine((v, ctx) => {
    const seen = new Set<string>();
    v.paths.forEach((p, i) => {
      if (seen.has(p.id)) {
        ctx.addIssue({
          code: 'custom',
          message: `id de path duplicado: "${p.id}"`,
          path: ['paths', i, 'id'],
        });
      }
      seen.add(p.id);
    });
  }) as unknown as z.ZodType<Vector, unknown>;

/** Valida na leitura de arquivo: vetor inválido vira `undefined` (o campo é descartado). */
export function parseVectorLoose(input: unknown): Vector | undefined {
  if (input === undefined || input === null) return undefined;
  const r = VectorSchema.safeParse(input);
  return r.success ? r.data : undefined;
}

/* ------------------------------------------------------------------------------- ordem estável */

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

/** Vetor com chaves em ordem estável (para `serializeDocument`). */
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
