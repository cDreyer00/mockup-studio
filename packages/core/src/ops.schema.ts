import { z } from 'zod';
import type { Op } from './ops.js';
import {
  ComponentDefSchema,
  ComponentVariantSchema,
  DataSchema,
  DataSourceSchema,
  FontRefSchema,
  NodeSchema,
  PropDefsSchema,
  PropValueSchema,
  ThemeNameSchema,
  ThemesSchema,
  TokenMetaMapSchema,
  TokensSchema,
} from './schema.js';
import { EffectSpecSchema, EmbedSpecSchema, VideoSpecSchema } from './media.js';
import { VectorSchema } from './vector/schema.js';

const strMap = z.record(z.string(), z.string());
const id = z.string().min(1);

/** Shape of an override (strict validation lives in the handler, see components/ops.ts). */
const RawOverrideSchema = z.object({
  style: strMap.optional(),
  unsetStyle: z.array(z.string()).optional(),
  text: z.string().optional(),
  attrs: strMap.optional(),
  hidden: z.boolean().optional(),
  classes: z.string().optional(),
  states: z.record(z.string(), strMap).optional(),
  src: z.string().optional(),
  svg: z.string().optional(),
  props: z.record(z.string(), PropValueSchema).optional(),
  vector: VectorSchema.optional(),
  effect: EffectSpecSchema.optional(),
  video: VideoSpecSchema.optional(),
  embed: EmbedSpecSchema.optional(),
  data: DataSchema.optional(),
  dataSource: DataSourceSchema.optional(),
});

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
    theme: ThemeNameSchema.optional(),
  }),
  z.object({
    type: z.literal('setTokenMeta'),
    set: TokenMetaMapSchema.optional(),
    unset: z.array(z.string()).optional(),
  }),
  z.object({ type: z.literal('setThemes'), themes: ThemesSchema }),
  z.object({
    type: z.literal('replaceTokens'),
    tokens: TokensSchema,
    tokenMeta: TokenMetaMapSchema.optional(),
    themes: ThemesSchema.optional(),
  }),
  z.object({
    type: z.literal('renameToken'),
    from: z.string().min(1),
    to: z.string().min(1),
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
  z.object({
    type: z.literal('setTag'),
    changes: z.array(z.object({ nodeId: id, tag: z.string() })),
  }),
  z.object({ type: z.literal('setFonts'), fonts: z.array(FontRefSchema) }),
  z.object({
    type: z.literal('setSrc'),
    changes: z.array(z.object({ nodeId: id, src: z.string().min(1) })),
  }),
  z.object({
    type: z.literal('setSvg'),
    changes: z.array(
      z.object({ nodeId: id, svg: z.string(), attrs: z.record(z.string(), z.string()).optional() }),
    ),
  }),
  z.object({
    type: z.literal('setClasses'),
    changes: z.array(z.object({ nodeId: id, classes: z.string().nullable() })),
  }),
  z.object({
    type: z.literal('setStates'),
    changes: z.array(z.object({ nodeId: id, states: z.record(z.string(), strMap).nullable() })),
  }),
  z.object({ type: z.literal('setCssBase'), base: z.enum(['default', 'tailwind']) }),
  z.object({
    type: z.literal('addComponent'),
    component: ComponentDefSchema,
    index: z.number().optional(),
  }),
  z.object({
    type: z.literal('deleteComponent'),
    componentId: id,
    force: z.boolean().optional(),
  }),
  z.object({
    type: z.literal('updateComponent'),
    componentId: id,
    name: z.string().optional(),
    description: z.string().nullable().optional(),
    kit: z.string().nullable().optional(),
    props: PropDefsSchema.optional(),
    variants: z.array(ComponentVariantSchema).optional(),
    root: NodeSchema.optional(),
  }),
  z.object({ type: z.literal('replaceNode'), nodeId: id, node: NodeSchema }),
  z.object({
    type: z.literal('setInstanceProps'),
    changes: z.array(
      z.object({
        nodeId: id,
        set: z.record(z.string(), PropValueSchema).optional(),
        unset: z.array(z.string()).optional(),
      }),
    ),
  }),
  z.object({
    type: z.literal('setInstanceOverrides'),
    changes: z.array(
      z.object({ nodeId: id, overrides: z.record(z.string(), RawOverrideSchema).nullable() }),
    ),
  }),
  z.object({
    type: z.literal('setData'),
    changes: z.array(
      z.object({
        nodeId: id,
        data: DataSchema.nullable().optional(),
        source: DataSourceSchema.nullable().optional(),
      }),
    ),
  }),
  z.object({
    type: z.literal('setVector'),
    changes: z.array(
      z.object({ nodeId: id, vector: VectorSchema.nullable(), svg: z.string().optional() }),
    ),
  }),
  z.object({
    type: z.literal('setMedia'),
    changes: z.array(
      z.object({
        nodeId: id,
        effect: EffectSpecSchema.optional(),
        video: VideoSpecSchema.optional(),
        embed: EmbedSpecSchema.optional(),
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
  'setTokenMeta',
  'setThemes',
  'replaceTokens',
  'renameToken',
  'setNodeFlags',
  'setTag',
  'setFonts',
  'setSrc',
  'setSvg',
  'setClasses',
  'setStates',
  'setCssBase',
  'addComponent',
  'deleteComponent',
  'updateComponent',
  'replaceNode',
  'setInstanceProps',
  'setInstanceOverrides',
  'setData',
  'setVector',
  'setMedia',
];

/**
 * Rejects internal fields in ops coming from outside (WS `op:apply`, MCP): currently, `force` in
 * `deleteComponent` (only the inverse of `addComponent` uses it; see `DeleteComponentOp`). Undo and
 * redo apply the inverses through the history, without passing through here.
 */
export function assertPublicOps(ops: readonly unknown[]): void {
  for (const op of ops) {
    const o = op as { type?: unknown; force?: unknown } | null;
    if (o?.type === 'deleteComponent' && o.force !== undefined) {
      throw new Error(
        'Invalid operation: "force" in deleteComponent is internal (only undo uses it). Detach or remove the instances before deleting the component.',
      );
    }
  }
}

/** Validates and normalizes an op; throws `Error('Invalid operation: ...')` with readable problems. */
export function parseOp(input: unknown): Op {
  const type = (input as { type?: unknown } | null)?.type;
  if (typeof type !== 'string' || !OP_TYPES.includes(type)) {
    throw new Error(
      `Invalid operation: unknown type ${JSON.stringify(type)} (expected one of: ${OP_TYPES.join(', ')})`,
    );
  }
  const r = OpSchema.safeParse(input);
  if (!r.success) {
    const issues = r.error.issues.map((i) => {
      const path = i.path.map(String).join('.');
      return path ? `${path}: ${i.message}` : i.message;
    });
    throw new Error(`Invalid operation: ${issues.join('; ')}`);
  }
  return r.data;
}
