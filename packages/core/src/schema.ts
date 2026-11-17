import { z } from 'zod';
import { collectIds } from './document.js';
import { dropUnsafeStyles, cssValueProblem } from './styles.js';
import { EffectSpecSchema, EmbedSpecSchema, VideoSpecSchema } from './media.js';
import { sanitizeSvg } from './svg.js';
import { orderVector, parseVectorLoose } from './vector/schema.js';
import { vectorToSvg } from './vector/svg.js';
import { BLOCKED_TAGS, TAG_RE, TOKEN_NAME_RE, VOID_TAGS, attrNameProblem } from './tags.js';
import type { DataSource, Document, FontRef, Node, Page } from './types.js';

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
/** Tokens sem o prefixo `--` (ex.: `primary`) ganham o prefixo; chaves já corretas ficam como estão. */
export function normalizeTokenNames(tokens: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(tokens)) {
    const name = k.trim();
    out[name.startsWith('--') || name === '' ? name : `--${name}`] = v;
  }
  return out;
}

/**
 * Mapa de tokens CSS: nomes sem `--` ganham o prefixo; as chaves precisam casar `--nome` e os
 * valores não podem escapar da declaração CSS (ver `cssValueProblem`).
 */
export const TokensSchema = z
  .record(z.string(), z.string())
  .transform(normalizeTokenNames)
  .superRefine((tokens, ctx) => {
    for (const [k, v] of Object.entries(tokens)) {
      if (!TOKEN_NAME_RE.test(k)) {
        ctx.addIssue({
          code: 'custom',
          message: `nome de token inválido: "${k}" (use o formato --nome)`,
          path: [k],
        });
      }
      const problem = cssValueProblem(v);
      if (problem) {
        ctx.addIssue({
          code: 'custom',
          message: `valor inválido para "${k}": ${problem}`,
          path: [k],
        });
      }
    }
  });

/** Na leitura de arquivos, tokens com valor perigoso são descartados em vez de recusar o documento. */
const FileTokensSchema = z
  .record(z.string(), z.string())
  .transform((tokens) =>
    Object.fromEntries(Object.entries(tokens).filter(([, v]) => cssValueProblem(v) === null)),
  )
  .pipe(TokensSchema);

/** Limites dos dados de um repetidor (itens e tamanho serializado). */
export const MAX_DATA_ITEMS = 1000;
export const MAX_DATA_BYTES = 2 * 1024 * 1024;

export const DataSourceSchema: z.ZodType<DataSource, unknown> = z.object({
  kind: z.enum(['inline', 'json', 'csv', 'url']),
  path: z.string().max(2000).optional(),
  url: z
    .string()
    .max(4000)
    .refine((u) => /^https?:\/\//i.test(u), { error: 'a URL deve ser http(s)' })
    .optional(),
  select: z.string().max(500).optional(),
  mapping: z.record(z.string(), z.string()).optional(),
  limit: z.number().int().min(1).max(MAX_DATA_ITEMS).optional(),
  fetchedAt: z.string().optional(),
});

export const DataSchema = z
  .array(z.unknown())
  .max(MAX_DATA_ITEMS, { error: `no máximo ${MAX_DATA_ITEMS} itens` })
  .refine((list) => JSON.stringify(list).length <= MAX_DATA_BYTES, {
    error: `os dados passam de ${MAX_DATA_BYTES / 1024 / 1024} MB`,
  });

export const NodeSchema: z.ZodType<Node, unknown> = z.lazy(() =>
  z
    .object({
      // `~` separa o índice nos clones dos repetidores (`REPEAT_ID_SEP` em data.ts).
      id: z
        .string()
        .min(1)
        .refine((v) => !v.includes('~'), { error: 'o id não pode conter "~"' }),
      type: z.enum([
        'frame',
        'element',
        'text',
        'image',
        'svg',
        'repeater',
        'effect',
        'video',
        'embed',
      ]),
      name: z.string(),
      tag: TagSchema,
      attrs: AttrsSchema,
      style: z.record(z.string(), z.string()).default({}).transform(dropUnsafeStyles),
      text: z.string().optional(),
      src: z.string().optional(),
      svg: z.string().transform(sanitizeSvg).optional(),
      // Vetor inválido é descartado (o markup `svg` continua valendo).
      vector: z.unknown().optional().transform(parseVectorLoose),
      effect: EffectSpecSchema.optional(),
      video: VideoSpecSchema.optional(),
      embed: EmbedSpecSchema.optional(),
      children: z.array(NodeSchema).default([]),
      locked: z.boolean().default(false),
      hidden: z.boolean().default(false),
      position: PositionSchema.optional(),
      data: DataSchema.optional(),
      dataSource: DataSourceSchema.optional(),
    })
    .refine((n) => !VOID_TAGS.has(n.tag) || (n.children.length === 0 && n.text === undefined), {
      error: 'tag void (ex. img, input, br) não pode ter filhos nem texto',
    })
    .refine((n) => n.type !== 'effect' || n.effect !== undefined, {
      error: 'nó effect sem o campo effect',
    })
    .refine((n) => n.type !== 'video' || n.video !== undefined, {
      error: 'nó video sem o campo video',
    })
    .refine((n) => n.type !== 'embed' || n.embed !== undefined, {
      error: 'nó embed sem o campo embed',
    })
    .refine(
      (n) =>
        !(n.type === 'effect' || n.type === 'video' || n.type === 'embed') ||
        n.children.length === 0,
      { error: 'nós effect, video e embed não têm filhos' },
    )
    .transform((n) => {
      // Só nós svg têm modelo vetorial; com ele, o markup é sempre o gerado (`vectorToSvg`).
      if (n.vector === undefined || n.type !== 'svg') {
        delete n.vector;
        return n;
      }
      n.svg = vectorToSvg(n.vector);
      return n;
    }),
);

export const PageSchema: z.ZodType<Page, unknown> = z.object({
  id: z.string().min(1),
  name: z.string(),
  frames: z.array(NodeSchema).default([]),
  background: z.string().default('#1e1e1e'),
});

// Charset restrito: o nome da família e os arquivos vão para CSS/HTML/SVG, então nada de
// < > { } ; "  crase, quebras de linha ou caracteres de controle.
// eslint-disable-next-line no-control-regex
const SAFE_FONT_TEXT = /^[^<>{};"\\\x60\u0000-\u001f\u007f]+$/;
const FontFamilySchema = z
  .string()
  .min(1)
  .max(200)
  .regex(SAFE_FONT_TEXT, { error: 'família com caracteres inválidos' });
const FontFileSchema = z
  .string()
  .min(1)
  .max(300)
  .regex(SAFE_FONT_TEXT, { error: 'arquivo de fonte com caracteres inválidos' })
  .refine((f) => !f.startsWith('/') && !/^[a-z][a-z0-9+.-]*:/i.test(f) && !f.includes('\\'), {
    error: 'o arquivo de fonte deve ser um caminho relativo a assets/',
  })
  .refine((f) => !f.split('/').some((seg) => seg === '..' || seg === ''), {
    error: 'o arquivo de fonte não pode conter ".." nem segmentos vazios',
  });

export const FontRefSchema: z.ZodType<FontRef, unknown> = z.object({
  family: FontFamilySchema,
  source: z.enum(['local', 'file', 'google']).optional(),
  files: z.array(FontFileSchema).optional(),
  weights: z.array(z.number().int().min(1).max(1000)).optional(),
  styles: z.array(z.enum(['normal', 'italic', 'oblique'])).optional(),
});

export const DocumentSchema: z.ZodType<Document, unknown> = z.object({
  version: z.literal(1, { error: 'versão não suportada (esperado 1)' }),
  id: z.string().min(1),
  name: z.string(),
  pages: z.array(PageSchema).min(1, { error: 'o documento precisa de ao menos uma página' }),
  tokens: FileTokensSchema.default({}),
  // Na leitura de arquivo, fonte inválida/perigosa é descartada (como as declarações de estilo
  // ruins) em vez de recusar o documento inteiro; a op `setFonts` continua estrita.
  fonts: z
    .array(z.unknown())
    .default([])
    .transform((list) =>
      list.flatMap((f) => {
        const r = FontRefSchema.safeParse(f);
        return r.success ? [r.data] : [];
      }),
    ),
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
  if (n.vector !== undefined) out.vector = orderVector(n.vector);
  if (n.effect !== undefined) out.effect = n.effect;
  if (n.video !== undefined) out.video = n.video;
  if (n.embed !== undefined) out.embed = n.embed;
  out.locked = n.locked;
  out.hidden = n.hidden;
  if (n.dataSource !== undefined) out.dataSource = n.dataSource;
  if (n.data !== undefined) out.data = n.data;
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
