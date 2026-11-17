/**
 * Validação do payload de snapshot e das requisições de importação (zod), com mensagens em pt-BR.
 * O formato completo está em `@mockup/snapshot-core` (`format.ts` e `api.ts`).
 */
import { z } from 'zod';
import {
  MAX_IMPORT_TIMEOUT_MS,
  DEFAULT_IMPORT_TIMEOUT_MS,
  DEFAULT_IMPORT_VIEWPORT,
  SNAPSHOT_FORMAT,
  SNAPSHOT_VERSION,
  type ImportPlacement,
  type SnapshotPayload,
  type SnapshotViewport,
} from '@mockup/snapshot-core';

/** Erro de uso da importação: `status` é o código HTTP; a mensagem vai direto ao usuário/agente. */
export class SnapshotImportError extends Error {
  /** Lido pelo handler de erros do `http.ts` (4xx com mensagem). */
  readonly expose = true;
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'SnapshotImportError';
  }
}

export const MAX_SNAPSHOT_NODES = 5000;
export const MAX_SNAPSHOT_DEPTH = 200;
const MAX_ASSETS = 3000;
const MAX_FONTS = 500;
const MAX_STRING = 40_000_000;
const MAX_CSS_PX = 100_000;

const px = z.number().finite().positive().max(MAX_CSS_PX);

const PayloadSchema = z.object({
  format: z.literal(SNAPSHOT_FORMAT, { error: `format deve ser "${SNAPSHOT_FORMAT}"` }),
  version: z.literal(SNAPSHOT_VERSION, {
    error: `versão do snapshot não suportada (este daemon lê a versão ${SNAPSHOT_VERSION})`,
  }),
  source: z.object({
    url: z.string().max(8192),
    title: z.string().max(2000).default(''),
    capturedAt: z.string().max(64).default(''),
    viewport: z.object({ width: px, height: px }),
    devicePixelRatio: z.number().finite().positive().max(16).default(1),
    selector: z.string().max(2000).optional(),
  }),
  root: z.looseObject({ type: z.string(), children: z.array(z.unknown()).default([]) }),
  width: px,
  height: px,
  assets: z
    .array(
      z.object({
        id: z.string().regex(/^[\w-]{1,32}$/, { error: 'id de asset inválido' }),
        kind: z.enum(['image', 'font']),
        url: z.string().max(MAX_STRING),
        dataUrl: z.string().max(MAX_STRING).optional(),
        mime: z.string().max(200).optional(),
      }),
    )
    .max(MAX_ASSETS, { error: `snapshot com assets demais (máximo ${MAX_ASSETS})` }),
  fonts: z
    .array(
      z.object({
        family: z.string().min(1).max(300),
        weight: z.string().max(40).default('400'),
        style: z.string().max(40).default('normal'),
        assetIds: z.array(z.string().max(32)).max(50),
        unicodeRange: z.string().max(2000).optional(),
      }),
    )
    .max(MAX_FONTS, { error: `snapshot com fontes demais (máximo ${MAX_FONTS})` })
    .default([]),
  reference: z
    .object({
      dataUrl: z.string().max(MAX_STRING),
      width: px,
      height: px,
    })
    .optional(),
  stats: z
    .object({
      nodes: z.number().default(0),
      truncated: z.boolean().default(false),
      warnings: z.array(z.string().max(2000)).max(500).default([]),
    })
    .default({ nodes: 0, truncated: false, warnings: [] }),
});

function describeIssues(error: z.ZodError): string {
  return error.issues
    .slice(0, 5)
    .map((i) => {
      const where = i.path.map(String).join('.');
      return where ? `${where}: ${i.message}` : i.message;
    })
    .join('; ');
}

/** Conta nós e profundidade sem recursão (árvores muito fundas não estouram a pilha). */
export function measureTree(root: unknown): { nodes: number; depth: number } {
  let nodes = 0;
  let depth = 0;
  const stack: { n: unknown; d: number }[] = [{ n: root, d: 1 }];
  while (stack.length > 0) {
    const { n, d } = stack.pop()!;
    nodes++;
    if (d > depth) depth = d;
    if (nodes > MAX_SNAPSHOT_NODES * 2) break;
    const kids = (n as { children?: unknown }).children;
    if (Array.isArray(kids)) for (const k of kids) stack.push({ n: k, d: d + 1 });
  }
  return { nodes, depth };
}

/**
 * Valida o payload: formato/versão, limites de tamanho e de nós (~5000) e profundidade. A validação
 * do conteúdo de cada nó (tags, atributos, estilos) fica com o `NodeSchema` do core, na importação.
 */
export function validateSnapshotPayload(input: unknown): SnapshotPayload {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new SnapshotImportError(
      400,
      'Snapshot inválido: esperado um objeto JSON no formato "mockup-snapshot".',
    );
  }
  const parsed = PayloadSchema.safeParse(input);
  if (!parsed.success) {
    throw new SnapshotImportError(400, `Snapshot inválido: ${describeIssues(parsed.error)}.`);
  }
  const { nodes, depth } = measureTree(parsed.data.root);
  if (nodes > MAX_SNAPSHOT_NODES) {
    throw new SnapshotImportError(
      400,
      `Snapshot grande demais: mais de ${MAX_SNAPSHOT_NODES} nós. Capture um elemento menor (seletor) ou uma largura menor.`,
    );
  }
  if (depth > MAX_SNAPSHOT_DEPTH) {
    throw new SnapshotImportError(
      400,
      `Snapshot inválido: árvore com mais de ${MAX_SNAPSHOT_DEPTH} níveis de profundidade.`,
    );
  }
  return parsed.data as unknown as SnapshotPayload;
}

const PlacementSchema = z.object({
  docId: z.string().min(1).max(200).optional(),
  pageId: z.string().min(1).max(200).optional(),
  x: z.number().finite().optional(),
  y: z.number().finite().optional(),
  reference: z.boolean().optional(),
  name: z.string().max(200).optional(),
});

/** Extrai e valida os campos de posicionamento de um objeto (corpo da requisição). */
export function parsePlacement(input: unknown): ImportPlacement {
  const raw = (input ?? {}) as Record<string, unknown>;
  const picked = Object.fromEntries(
    Object.entries(raw).filter(
      ([k, v]) =>
        ['docId', 'pageId', 'x', 'y', 'reference', 'name'].includes(k) &&
        v !== null &&
        v !== undefined,
    ),
  );
  const r = PlacementSchema.safeParse(picked);
  if (!r.success)
    throw new SnapshotImportError(400, `Parâmetros inválidos: ${describeIssues(r.error)}.`);
  return r.data;
}

/** Só http/https; devolve a URL normalizada. */
export function parseHttpUrl(value: unknown, field = 'url'): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new SnapshotImportError(400, `Campo obrigatório ausente: ${field}.`);
  }
  let u: URL;
  try {
    u = new URL(value.trim());
  } catch {
    throw new SnapshotImportError(400, `${field} inválida: "${value.slice(0, 200)}".`);
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new SnapshotImportError(
      400,
      `${field} com protocolo não permitido (${u.protocol}): só http: e https: podem ser importados (file:, data:, javascript: e chrome: são recusados).`,
    );
  }
  return u.href;
}

export interface CaptureParams {
  viewport: SnapshotViewport;
  timeoutMs: number;
  selector?: string;
}

/** Viewport (largura 320–3840, altura 200–4000), timeout (limitado) e seletor. */
export function parseCaptureParams(input: {
  viewport?: Partial<SnapshotViewport>;
  timeoutMs?: unknown;
  selector?: unknown;
}): CaptureParams {
  const width = input.viewport?.width ?? DEFAULT_IMPORT_VIEWPORT.width;
  const height = input.viewport?.height ?? DEFAULT_IMPORT_VIEWPORT.height;
  if (typeof width !== 'number' || !Number.isFinite(width) || width < 320 || width > 3840) {
    throw new SnapshotImportError(
      400,
      `Largura do viewport inválida (${String(width)}): use de 320 a 3840 px.`,
    );
  }
  if (typeof height !== 'number' || !Number.isFinite(height) || height < 200 || height > 4000) {
    throw new SnapshotImportError(
      400,
      `Altura do viewport inválida (${String(height)}): use de 200 a 4000 px.`,
    );
  }
  let timeoutMs = DEFAULT_IMPORT_TIMEOUT_MS;
  if (input.timeoutMs !== undefined && input.timeoutMs !== null) {
    if (
      typeof input.timeoutMs !== 'number' ||
      !Number.isFinite(input.timeoutMs) ||
      input.timeoutMs <= 0
    ) {
      throw new SnapshotImportError(
        400,
        'timeoutMs inválido: use um número de milissegundos maior que 0.',
      );
    }
    timeoutMs = Math.min(input.timeoutMs, MAX_IMPORT_TIMEOUT_MS);
  }
  let selector: string | undefined;
  if (input.selector !== undefined && input.selector !== null && input.selector !== '') {
    if (typeof input.selector !== 'string' || input.selector.length > 2000) {
      throw new SnapshotImportError(
        400,
        'selector inválido: use um seletor CSS (texto de até 2000 caracteres).',
      );
    }
    selector = input.selector;
  }
  return {
    viewport: { width: Math.round(width), height: Math.round(height) },
    timeoutMs,
    selector,
  };
}
