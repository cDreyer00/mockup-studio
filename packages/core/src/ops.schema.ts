import { z } from 'zod';
import type { Op } from './ops.js';
import { NodeSchema, TokensSchema } from './schema.js';

const strMap = z.record(z.string(), z.string());
const id = z.string().min(1);

export const OpSchema: z.ZodType<Op, unknown> = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('createNode'),
    parentId: z.string().nullable().optional(),
    pageId: z.string().optional(),
    node: NodeSchema,
    index: z.number().optional(),
  }),
  z.object({ type: z.literal('deleteNodes'), nodeIds: z.array(id) }),
  z.object({
    type: z.literal('moveNodes'),
    nodeIds: z.array(id),
    parentId: z.string().nullable().optional(),
    pageId: z.string().optional(),
    index: z.number().optional(),
  }),
  z.object({
    type: z.literal('updateStyles'),
    changes: z
      .array(
        z.object({ nodeId: id, set: strMap.optional(), unset: z.array(z.string()).optional() }),
      )
      .optional(),
    nodeIds: z.array(id).optional(),
    styles: strMap.optional(),
    unset: z.array(z.string()).optional(),
  }),
  z.object({
    type: z.literal('setText'),
    changes: z.array(z.object({ nodeId: id, text: z.string().nullable() })),
  }),
  z.object({
    type: z.literal('setAttrs'),
    changes: z.array(
      z.object({ nodeId: id, set: strMap.optional(), unset: z.array(z.string()).optional() }),
    ),
  }),
  z.object({
    type: z.literal('renameNodes'),
    changes: z.array(z.object({ nodeId: id, name: z.string() })),
  }),
  z.object({
    type: z.literal('duplicateNodes'),
    nodeIds: z.array(id),
    idMap: strMap.optional(),
  }),
  z.object({
    type: z.literal('setPosition'),
    changes: z.array(
      z.object({
        nodeId: id,
        position: z.object({ x: z.number(), y: z.number() }).nullable(),
      }),
    ),
  }),
  z.object({
    type: z.literal('createPage'),
    pageId: id,
    name: z.string(),
    index: z.number().optional(),
    background: z.string().optional(),
    frames: z.array(NodeSchema).optional(),
  }),
  z.object({ type: z.literal('deletePage'), pageId: id }),
  z.object({ type: z.literal('renamePage'), pageId: id, name: z.string() }),
  z.object({
    type: z.literal('setTokens'),
    set: TokensSchema.optional(),
    unset: z.array(z.string()).optional(),
  }),
  z.object({
    type: z.literal('setNodeFlags'),
    changes: z.array(
      z.object({
        nodeId: id,
        locked: z.boolean().optional(),
        hidden: z.boolean().optional(),
      }),
    ),
  }),
]) as unknown as z.ZodType<Op, unknown>;

export const OpsSchema = z.array(OpSchema);

const OP_TYPES = [
  'createNode',
  'deleteNodes',
  'moveNodes',
  'updateStyles',
  'setText',
  'setAttrs',
  'renameNodes',
  'duplicateNodes',
  'setPosition',
  'createPage',
  'deletePage',
  'renamePage',
  'setTokens',
  'setNodeFlags',
];

/** Valida e normaliza uma op; lança `Error('Operação inválida: ...')` com os problemas legíveis. */
export function parseOp(input: unknown): Op {
  const type = (input as { type?: unknown } | null)?.type;
  if (typeof type !== 'string' || !OP_TYPES.includes(type)) {
    throw new Error(
      `Operação inválida: tipo desconhecido ${JSON.stringify(type)} (esperado um de: ${OP_TYPES.join(', ')})`,
    );
  }
  const r = OpSchema.safeParse(input);
  if (!r.success) {
    const issues = r.error.issues.map((i) => {
      const path = i.path.map(String).join('.');
      return path ? `${path}: ${i.message}` : i.message;
    });
    throw new Error(`Operação inválida: ${issues.join('; ')}`);
  }
  return r.data;
}
