import { z } from 'zod';
import { collectIds } from './document.js';
import { dropUnsafeStyles, cssValueProblem } from './styles.js';
import { EffectSpecSchema, EmbedSpecSchema, VideoSpecSchema } from './media.js';
import { sanitizeSvg } from './svg.js';
import { normalizeStateKey } from './states.js';
import {
  BLOCKED_TAGS,
  TAG_RE,
  THEME_NAME_RE,
  TOKEN_NAME_RE,
  VOID_TAGS,
  attrNameProblem,
} from './tags.js';
import type {
  ComponentDef,
  ComponentVariant,
  DataSource,
  Document,
  FontRef,
  Node,
  NodeOverride,
  Page,
  PropDef,
  Theme,
  TokenMeta,
} from './types.js';
import { orderVector, parseVectorLoose } from './vector/schema.js';
import { vectorToSvg } from './vector/svg.js';

const PositionSchema = z.object({ x: z.number(), y: z.number() });

/** Caracteres que nunca aparecem em classes Tailwind legítimas (mesmo filtro de `setClasses` e do import HTML). */
export const UNSAFE_CLASS_CHARS_RE = /[<{};"`]/;

/**
 * Classes Tailwind do nó: espaços colapsados; classes com caracteres proibidos são descartadas
 * (documentos antigos continuam carregando); vazio vira ausente.
 */
const ClassesSchema = z
  .string()
  .transform((s) =>
    s
      .split(/\s+/)
      .filter((c) => c !== '' && !UNSAFE_CLASS_CHARS_RE.test(c))
      .join(' '),
  )
  .transform((s) => (s === '' ? undefined : s))
  .optional();

/**
 * Estados do nó (`hover`, `dark`, `md:hover`...): chaves inválidas e declarações inseguras são
 * descartadas (como em `style`), chaves normalizadas para a ordem canônica; vazio vira ausente.
 */
export const StatesSchema = z
  .record(z.string(), z.record(z.string(), z.string()))
  .transform((states) => {
    const out: Record<string, Record<string, string>> = {};
    for (const [k, v] of Object.entries(states)) {
      const key = normalizeStateKey(k);
      if (!key) continue;
      const style = dropUnsafeStyles(v);
      if (Object.keys(style).length === 0) continue;
      out[key] = { ...(out[key] ?? {}), ...style };
    }
    return Object.keys(out).length > 0 ? out : undefined;
  })
  .optional();

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

/** Tokens sem o prefixo `--` (ex.: `primary`) ganham o prefixo; chaves já corretas ficam como estão. */
export function normalizeTokenNames<T = string>(tokens: Record<string, T>): Record<string, T> {
  const out: Record<string, T> = {};
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

// Texto livre dos metadados: sem caracteres de controle (exceto quebra de linha) e com limite.
// eslint-disable-next-line no-control-regex
const META_TEXT = /^[^\u0000-\u0009\u000b-\u001f\u007f]*$/;

export const TokenMetaSchema: z.ZodType<TokenMeta, unknown> = z.object({
  group: z
    .string()
    .trim()
    .min(1)
    .max(64)
    .regex(/^[\p{L}\p{N} _-]+$/u, { error: 'grupo com caracteres inválidos' })
    .optional(),
  description: z.string().max(500).regex(META_TEXT).optional(),
});

export const ThemeNameSchema = z.string().trim().regex(THEME_NAME_RE, {
  error: 'nome de tema inválido (letras, dígitos, "-" e "_", começando por letra ou dígito)',
});

export const ThemeSchema: z.ZodType<Theme, unknown> = z.object({
  name: ThemeNameSchema,
  overrides: TokensSchema.default({}),
});

/** Mapa nome do token → metadados (nomes normalizados com `--`). */
export const TokenMetaMapSchema = z
  .record(z.string(), TokenMetaSchema)
  .transform((m) => normalizeTokenNames(m))
  .superRefine((m, ctx) => {
    for (const k of Object.keys(m)) {
      if (!TOKEN_NAME_RE.test(k)) {
        ctx.addIssue({ code: 'custom', message: `nome de token inválido: "${k}"`, path: [k] });
      }
    }
  });

/** Lista de temas com nomes únicos. */
export const ThemesSchema = z.array(ThemeSchema).superRefine((list, ctx) => {
  const seen = new Set<string>();
  list.forEach((t, i) => {
    if (seen.has(t.name)) {
      ctx.addIssue({ code: 'custom', message: `tema duplicado: "${t.name}"`, path: [i, 'name'] });
    }
    seen.add(t.name);
  });
});

/** Leitura de arquivo: metadados e temas inválidos são descartados em vez de recusar o documento. */
const FileTokenMetaSchema = z
  .record(z.string(), z.unknown())
  .optional()
  .transform((m) => {
    if (!m) return undefined;
    const out: Record<string, TokenMeta> = {};
    for (const [k, v] of Object.entries(m)) {
      const r = TokenMetaSchema.safeParse(v);
      if (TOKEN_NAME_RE.test(k) && r.success && (r.data.group || r.data.description)) {
        out[k] = r.data;
      }
    }
    return Object.keys(out).length > 0 ? out : undefined;
  });

const FileThemesSchema = z
  .array(z.unknown())
  .optional()
  .transform((list) => {
    if (!list) return undefined;
    const seen = new Set<string>();
    const out: Theme[] = [];
    for (const raw of list) {
      const t = raw as { name?: unknown; overrides?: unknown } | null;
      const name = ThemeNameSchema.safeParse(t?.name);
      if (!name.success || seen.has(name.data)) continue;
      const ov = FileTokensSchema.safeParse(t?.overrides ?? {});
      seen.add(name.data);
      out.push({ name: name.data, overrides: ov.success ? ov.data : {} });
    }
    return out.length > 0 ? out : undefined;
  });

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

/* ---------------- Componentes (ver docs/COMPONENTES.md) ---------------- */

export const PropValueSchema = z.union([z.string(), z.number(), z.boolean()]);

/** Nome de prop: identificador usável em `{{nome}}`. */
export const PROP_NAME_RE = /^[A-Za-z_][\w-]*$/;

const PropsMapSchema = z
  .record(z.string(), PropValueSchema)
  .transform((p) => (Object.keys(p).length > 0 ? p : undefined))
  .optional();

/** Remove campos vazios de um objeto (sem lançar). */
function dropEmpty<T extends object>(o: T): T {
  const out = { ...o } as Record<string, unknown>;
  for (const [k, v] of Object.entries(out)) {
    if (
      v === undefined ||
      // `data: []` é um valor (repetidor sem itens), não ausência
      (k !== 'data' && Array.isArray(v) && v.length === 0) ||
      (v !== null && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length === 0)
    ) {
      delete out[k];
    }
  }
  return out as T;
}

/**
 * Sobrescrita de nó (numa instância ou variante). Na leitura, declarações de estilo inseguras são
 * descartadas (como em `style`), atributos com nome inválido também, o svg é sanitizado; campos
 * vazios somem.
 */
export const NodeOverrideSchema: z.ZodType<NodeOverride, unknown> = z
  .object({
    style: z.record(z.string(), z.string()).transform(dropUnsafeStyles).optional(),
    unsetStyle: z.array(z.string()).optional(),
    text: z.string().optional(),
    attrs: z
      .record(z.string(), z.string())
      .transform((a) =>
        Object.fromEntries(
          Object.entries(a).filter(
            ([k]) => k !== 'style' && k !== 'class' && attrNameProblem(k) === null,
          ),
        ),
      )
      .optional(),
    hidden: z.boolean().optional(),
    classes: ClassesSchema,
    states: StatesSchema,
    src: z.string().optional(),
    svg: z
      .string()
      .transform(sanitizeSvg)
      .transform((s) => (s === '' ? undefined : s))
      .optional(),
    props: PropsMapSchema,
    // Vetor inválido é descartado (como em `NodeSchema`).
    vector: z.unknown().optional().transform(parseVectorLoose),
    effect: EffectSpecSchema.optional(),
    video: VideoSpecSchema.optional(),
    embed: EmbedSpecSchema.optional(),
    data: DataSchema.optional(),
    dataSource: DataSourceSchema.optional(),
  })
  .transform((o) => dropEmpty(o) as NodeOverride);

/** Mapa caminho → sobrescrita; sobrescritas vazias somem e o mapa vazio vira ausente. */
export const NodeOverridesMapSchema = z
  .record(z.string(), NodeOverrideSchema)
  .transform((m) => {
    const out: Record<string, NodeOverride> = {};
    for (const [k, v] of Object.entries(m)) if (Object.keys(v).length > 0) out[k] = v;
    return Object.keys(out).length > 0 ? out : undefined;
  })
  .optional();

export const PropDefSchema: z.ZodType<PropDef, unknown> = z
  .object({
    name: z.string().trim().regex(PROP_NAME_RE, {
      error: 'nome de prop inválido (letras, dígitos, "_" e "-", começando por letra ou "_")',
    }),
    type: z.enum(['string', 'number', 'boolean', 'enum', 'color', 'slot']),
    default: PropValueSchema.optional(),
    options: z.array(z.string()).optional(),
    description: z.string().optional(),
  })
  .transform((p) => {
    if (p.default === undefined) delete p.default;
    if (p.options === undefined) delete p.options;
    if (p.description === undefined) delete p.description;
    return p;
  });

export const PropDefsSchema = z.array(PropDefSchema).superRefine((list, ctx) => {
  const seen = new Set<string>();
  list.forEach((p, i) => {
    if (seen.has(p.name)) {
      ctx.addIssue({ code: 'custom', message: `prop duplicada: "${p.name}"`, path: [i, 'name'] });
    }
    seen.add(p.name);
  });
});

/** Mensagem para variante com `when` vazio (valeria sempre: o lugar desses estilos é o principal). */
export const EMPTY_VARIANT_MESSAGE = 'variante sem condição: mova os estilos para o principal';

const VariantShapeSchema = z.object({
  when: z.record(z.string(), PropValueSchema).default({}),
  overrides: NodeOverridesMapSchema.transform((m) => m ?? {}),
});

/** `true` se a variante tem ao menos uma condição em `when`. */
export function hasVariantCondition(v: { when?: Record<string, unknown> }): boolean {
  return !!v.when && Object.keys(v.when).length > 0;
}

/** Variante (estrita: `when` vazio é recusado). Usada nas ops (`addComponent`, `updateComponent`). */
export const ComponentVariantSchema: z.ZodType<ComponentVariant, unknown> =
  VariantShapeSchema.refine(hasVariantCondition, { error: EMPTY_VARIANT_MESSAGE, path: ['when'] });

/**
 * Variantes na leitura de arquivo: as com `when` vazio são descartadas (como as declarações de
 * estilo inseguras), em vez de recusar o documento inteiro.
 */
const FileVariantsSchema = z
  .array(VariantShapeSchema)
  .default([])
  .transform((list) => list.filter(hasVariantCondition));

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
        'instance',
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
      classes: ClassesSchema,
      states: StatesSchema,
      componentId: z.string().min(1).optional(),
      props: PropsMapSchema,
      overrides: NodeOverridesMapSchema,
      data: DataSchema.optional(),
      dataSource: DataSourceSchema.optional(),
    })
    .transform((n) => {
      // Campos opcionais que a normalização esvaziou não aparecem como `undefined` no objeto.
      if (n.classes === undefined) delete n.classes;
      if (n.states === undefined) delete n.states;
      if (n.componentId === undefined) delete n.componentId;
      if (n.props === undefined) delete n.props;
      if (n.overrides === undefined) delete n.overrides;
      return n;
    })
    .refine((n) => !VOID_TAGS.has(n.tag) || (n.children.length === 0 && n.text === undefined), {
      error: 'tag void (ex. img, input, br) não pode ter filhos nem texto',
    })
    .refine((n) => n.type !== 'instance' || !!n.componentId, {
      error: 'instância sem "componentId"',
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

function componentDefSchema(
  variants: z.ZodType<ComponentVariant[], unknown>,
): z.ZodType<ComponentDef, unknown> {
  return z
    .object({
      id: z.string().min(1),
      name: z.string().trim().min(1, { error: 'componente sem nome' }),
      description: z.string().optional(),
      kit: z.string().min(1).optional(),
      props: PropDefsSchema.default([]),
      root: NodeSchema,
      variants,
    })
    .transform((c) => {
      if (c.description === undefined) delete c.description;
      if (c.kit === undefined) delete c.kit;
      // A raiz do principal não tem posição (a posição é da instância).
      delete c.root.position;
      return c;
    })
    .refine((c) => c.root.type !== 'frame' && c.root.type !== 'instance', {
      error: 'a raiz do componente não pode ser frame nem instância',
      path: ['root'],
    });
}

/** Componente nas ops (`addComponent`): estrito (variante com `when` vazio é recusada). */
export const ComponentDefSchema: z.ZodType<ComponentDef, unknown> = componentDefSchema(
  z.array(ComponentVariantSchema).default([]),
);

/** Componente na leitura de arquivo: variantes com `when` vazio são descartadas. */
const FileComponentDefSchema: z.ZodType<ComponentDef, unknown> =
  componentDefSchema(FileVariantsSchema);

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
  tokenMeta: FileTokenMetaSchema,
  themes: FileThemesSchema,
  // Valor desconhecido de `cssBase` cai para o padrão em vez de recusar o arquivo.
  cssBase: z.enum(['tailwind']).optional().catch(undefined),
  // Biblioteca de componentes: ausente quando vazia (documentos antigos continuam iguais).
  components: z
    .array(FileComponentDefSchema)
    .optional()
    .transform((list) => (list && list.length > 0 ? list : undefined)),
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
  // Componentes: ids e nomes únicos; ids dos nós únicos no documento inteiro.
  const names = new Set<string>();
  for (const c of doc.components ?? []) {
    check(c.id, 'Componente');
    const key = c.name.toLowerCase();
    if (names.has(key)) errors.push(`Componente com nome duplicado: "${c.name}"`);
    names.add(key);
    for (const id of collectIds(c.root)) check(id, 'Nó');
  }
  if (doc.components === undefined) delete doc.components;
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

const OVERRIDE_KEYS = [
  'style',
  'unsetStyle',
  'text',
  'attrs',
  'hidden',
  'classes',
  'states',
  'src',
  'svg',
  'props',
  'vector',
  'effect',
  'video',
  'embed',
  'dataSource',
  'data',
] as const;

function orderOverrides(map: Record<string, NodeOverride>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [path, ov] of Object.entries(map)) {
    const o: Record<string, unknown> = {};
    for (const k of OVERRIDE_KEYS) if (ov[k] !== undefined) o[k] = ov[k];
    out[path] = o;
  }
  return out;
}

function orderNode(n: Node): Record<string, unknown> {
  const out: Record<string, unknown> = { id: n.id, type: n.type, name: n.name, tag: n.tag };
  if (n.componentId !== undefined) out.componentId = n.componentId;
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
  if (n.classes !== undefined) out.classes = n.classes;
  if (n.states !== undefined && Object.keys(n.states).length > 0) out.states = n.states;
  if (n.props !== undefined && Object.keys(n.props).length > 0) out.props = n.props;
  if (n.overrides !== undefined && Object.keys(n.overrides).length > 0) {
    out.overrides = orderOverrides(n.overrides);
  }
  out.locked = n.locked;
  out.hidden = n.hidden;
  if (n.dataSource !== undefined) out.dataSource = n.dataSource;
  if (n.data !== undefined) out.data = n.data;
  out.children = n.children.map(orderNode);
  return out;
}

function orderComponent(c: ComponentDef): Record<string, unknown> {
  const out: Record<string, unknown> = { id: c.id, name: c.name };
  if (c.description !== undefined) out.description = c.description;
  if (c.kit !== undefined) out.kit = c.kit;
  out.props = c.props.map((p) => {
    const o: Record<string, unknown> = { name: p.name, type: p.type };
    if (p.default !== undefined) o.default = p.default;
    if (p.options !== undefined) o.options = p.options;
    if (p.description !== undefined) o.description = p.description;
    return o;
  });
  out.variants = c.variants.map((v) => ({ when: v.when, overrides: orderOverrides(v.overrides) }));
  out.root = orderNode(c.root);
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
    ...(doc.tokenMeta && Object.keys(doc.tokenMeta).length > 0 && { tokenMeta: doc.tokenMeta }),
    ...(doc.themes && doc.themes.length > 0 && { themes: doc.themes }),
    ...(doc.cssBase && { cssBase: doc.cssBase }),
    fonts: doc.fonts.map((f) => {
      const o: Record<string, unknown> = { family: f.family };
      if (f.source !== undefined) o.source = f.source;
      if (f.files !== undefined) o.files = f.files;
      if (f.weights !== undefined) o.weights = f.weights;
      if (f.styles !== undefined) o.styles = f.styles;
      return o;
    }),
    meta: { createdAt, updatedAt, ...restMeta },
    ...(doc.components &&
      doc.components.length > 0 && { components: doc.components.map(orderComponent) }),
    pages: doc.pages.map((p) => ({
      id: p.id,
      name: p.name,
      background: p.background,
      frames: p.frames.map(orderNode),
    })),
  };
  return JSON.stringify(ordered, null, 2) + '\n';
}
