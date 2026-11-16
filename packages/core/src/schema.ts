import { z } from 'zod';
import { collectIds } from './document.js';
import { sanitizeSvg } from './svg.js';
import { BLOCKED_TAGS, TAG_RE, TOKEN_NAME_RE, VOID_TAGS, attrNameProblem } from './tags.js';
import type { Document, FontRef, Node, Page } from './types.js';

const PositionSchema = z.object({ x: z.number(), y: z.number() });

const TagSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(TAG_RE, {
    error: 'tag inválida (use letras minúsculas, dígitos e hífen, começando por letra)',
  })
  .refine((t) => !BLOCKED_TAGS.has(t), { error: 'tag bloqueada por segurança' });

const AttrsSchema = z
  .record(z.string(), z.string())
  .superRefine((attrs, ctx) => {
    for (const k of Object.keys(attrs)) {
      const problem = attrNameProblem(k);
      if (problem) ctx.addIssue({ code: 'custom', message: problem, path: [k] });
    }
  })
  .default({});

/** Mapa de tokens CSS: as chaves precisam casar `--nome`. */
export const TokensSchema = z.record(z.string(), z.string()).superRefine((tokens, ctx) => {
  for (const k of Object.keys(tokens)) {
    if (!TOKEN_NAME_RE.test(k)) {
      ctx.addIssue({
        code: 'custom',
        message: `nome de token inválido: "${k}" (use o formato --nome)`,
        path: [k],
      });
    }
  }
});

export const NodeSchema: z.ZodType<Node, unknown> = z.lazy(() =>
  z
    .object({
      id: z.string().min(1),
      type: z.enum(['frame', 'element', 'text', 'image', 'svg']),
      name: z.string(),
      tag: TagSchema,
      attrs: AttrsSchema,
      style: z.record(z.string(), z.string()).default({}),
      text: z.string().optional(),
      src: z.string().optional(),
      svg: z.string().transform(sanitizeSvg).optional(),
      children: z.array(NodeSchema).default([]),
      locked: z.boolean().default(false),
      hidden: z.boolean().default(false),
      position: PositionSchema.optional(),
    })
    .refine((n) => !VOID_TAGS.has(n.tag) || (n.children.length === 0 && n.text === undefined), {
      error: 'tag void (ex. img, input, br) não pode ter filhos nem texto',
    }),
);

export const PageSchema: z.ZodType<Page, unknown> = z.object({
  id: z.string().min(1),
  name: z.string(),
  frames: z.array(NodeSchema).default([]),
  background: z.string().default('#1e1e1e'),
});

export const FontRefSchema: z.ZodType<FontRef, unknown> = z.object({
  family: z.string(),
  source: z.enum(['local', 'file', 'google']).optional(),
  files: z.array(z.string()).optional(),
  weights: z.array(z.number()).optional(),
  styles: z.array(z.string()).optional(),
});

export const DocumentSchema: z.ZodType<Document, unknown> = z.object({
  version: z.literal(1, { error: 'versão não suportada (esperado 1)' }),
  id: z.string().min(1),
  name: z.string(),
  pages: z.array(PageSchema).min(1, { error: 'o documento precisa de ao menos uma página' }),
  tokens: TokensSchema.default({}),
  fonts: z.array(FontRefSchema).default([]),
  meta: z
    .object({ createdAt: z.string(), updatedAt: z.string() })
    .catchall(z.unknown())
    .default(() => {
      const now = new Date().toISOString();
      return { createdAt: now, updatedAt: now };
    }),
});

type Parsed = { ok: true; doc: Document } | { ok: false; errors: string[] };

function parseInternal(input: unknown): Parsed {
  let data = input;
  if (typeof input === 'string') {
    try {
      data = JSON.parse(input);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, errors: [`JSON malformado: ${msg}`] };
    }
  }
  const parsed = DocumentSchema.safeParse(data);
  if (!parsed.success) {
    return {
      ok: false,
      errors: parsed.error.issues.map((i) => {
        const path = i.path.map(String).join('.');
        return path ? `${path}: ${i.message}` : i.message;
      }),
    };
  }
  const doc = parsed.data;
  const seen = new Set<string>();
  const errors: string[] = [];
  const check = (id: string, kind: string): void => {
    if (seen.has(id)) errors.push(`${kind} com id duplicado: "${id}"`);
    seen.add(id);
  };
  for (const page of doc.pages) {
    check(page.id, 'Página');
    for (const id of collectIds(page)) check(id, 'Nó');
  }
  return errors.length > 0 ? { ok: false, errors } : { ok: true, doc };
}

export function validateDocument(
  input: unknown,
): { ok: true; doc: Document } | { ok: false; errors: string[] } {
  return parseInternal(input);
}

/** Valida e normaliza (aplica defaults). Aceita string JSON ou objeto. */
export function parseDocument(input: string | unknown): Document {
  const r = parseInternal(input);
  if (!r.ok) throw new Error(`Documento inválido: ${r.errors.join('; ')}`);
  return r.doc;
}

function orderNode(n: Node): Record<string, unknown> {
  const out: Record<string, unknown> = { id: n.id, type: n.type, name: n.name, tag: n.tag };
  if (n.position !== undefined) out.position = { x: n.position.x, y: n.position.y };
  out.attrs = n.attrs;
  out.style = n.style;
  if (n.text !== undefined) out.text = n.text;
  if (n.src !== undefined) out.src = n.src;
  if (n.svg !== undefined) out.svg = n.svg;
  out.locked = n.locked;
  out.hidden = n.hidden;
  out.children = n.children.map(orderNode);
  return out;
}

/** JSON com 2 espaços, `\n` final e ordem de chaves estável. */
export function serializeDocument(doc: Document): string {
  const { createdAt, updatedAt, ...restMeta } = doc.meta;
  const ordered = {
    version: doc.version,
    id: doc.id,
    name: doc.name,
    tokens: doc.tokens,
    fonts: doc.fonts.map((f) => {
      const o: Record<string, unknown> = { family: f.family };
      if (f.source !== undefined) o.source = f.source;
      if (f.files !== undefined) o.files = f.files;
      if (f.weights !== undefined) o.weights = f.weights;
      if (f.styles !== undefined) o.styles = f.styles;
      return o;
    }),
    meta: { createdAt, updatedAt, ...restMeta },
    pages: doc.pages.map((p) => ({
      id: p.id,
      name: p.name,
      background: p.background,
      frames: p.frames.map(orderNode),
    })),
  };
  return JSON.stringify(ordered, null, 2) + '\n';
}
