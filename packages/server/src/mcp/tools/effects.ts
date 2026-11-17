import { z } from 'zod';
import {
  EFFECTS,
  EFFECT_BACKGROUND_STYLE,
  createEffectNode,
  effectKinds,
  effectParamsProblems,
  getEffect,
  presetParams,
  resolveEffectParams,
  type EffectParamDef,
  type MediaParamValue,
  type Node,
} from '@mockup/core';
import { READ, ToolError, WRITE, docIdField, type ToolContext } from '../context.js';

const LEAF_TYPES = new Set(['text', 'image', 'svg', 'effect', 'video', 'embed']);

const paramValue = z.union([z.number(), z.boolean(), z.string()]);
const paramsField = z
  .record(z.string(), paramValue)
  .optional()
  .describe('Effect params, e.g. { "speed": 0.5, "color1": "#6c5ce7" }. See list_effects.');

function paramDoc(p: EffectParamDef): string {
  let range = '';
  if (p.type === 'number') {
    const lo = p.min ?? '';
    const hi = p.max ?? '';
    range = lo !== '' || hi !== '' ? ` ${lo}..${hi}` : '';
  } else if (p.type === 'select') {
    range = ` {${(p.options ?? []).join('|')}}`;
  }
  return `${p.name}:${p.type}${range}=${JSON.stringify(p.default)}`;
}

/** Param problems as a ToolError with the list_effects hint. */
function checkParams(kind: string, params: Record<string, MediaParamValue>): void {
  const problems = effectParamsProblems(kind, params);
  if (!problems.length) return;
  const kinds = effectKinds();
  throw new ToolError(
    `Invalid params for effect "${kind}":\n- ${problems.join('\n- ')}\n` +
      `Use list_effects to see the effects${kinds.length ? ` (${kinds.join(', ')})` : ''}, their params and presets.`,
  );
}

function unknownKind(kind: string): never {
  checkParams(kind, {});
  throw new ToolError(`Unknown effect: "${kind}". Use list_effects to see the available ones.`);
}

export function registerEffectTools(ctx: ToolContext): void {
  const { tool, store, requireNode, apply, summaryOf } = ctx;

  tool(
    'list_effects',
    {
      title: 'List visual effects',
      description:
        'Lists the available effects (shaders and particles) with category, description, params (type, range, default) and presets. Use before add_effect.',
      example: {},
      inputSchema: {},
      annotations: READ,
    },
    () => {
      if (!EFFECTS.length) return 'No effects available.';
      const out = [`${EFFECTS.length} effect(s). Use add_effect(nodeId, kind, params?, preset?).`];
      for (const e of EFFECTS) {
        out.push(`\n- ${e.kind} [${e.category}] ${e.label}: ${e.description}`);
        out.push(`  params: ${e.params.map(paramDoc).join('; ') || '(none)'}`);
        if (e.presets.length) out.push(`  presets: ${e.presets.map((p) => p.name).join(', ')}`);
      }
      return out.join('\n');
    },
  );

  tool(
    'add_effect',
    {
      title: 'Add visual effect',
      description:
        'Adds an effect (see list_effects) to nodeId, a container. placement "background" (default): first child covering the container behind the content (the parent gets position: relative and isolation: isolate). "child": regular child with styles (default 100% x 240px).',
      example: {
        nodeId: 'fr_ab12cd34',
        kind: 'mesh-gradient',
        preset: 'aurora',
        params: { speed: 0.5 },
      },
      inputSchema: {
        nodeId: z
          .string()
          .describe('Id of the container that receives the effect, e.g. "fr_ab12cd34".'),
        kind: z.string().describe('Effect kind, e.g. "mesh-gradient" or "particles".'),
        params: paramsField,
        preset: z.string().optional().describe('Name of an effect preset, e.g. "aurora".'),
        placement: z
          .enum(['background', 'child'])
          .optional()
          .describe('"background" (default): container background; "child": regular child.'),
        name: z.string().optional().describe('Layer name, e.g. "Animated background".'),
        styles: z
          .record(z.string(), z.string())
          .optional()
          .describe(
            'CSS styles of the effect, e.g. { "height": "320px", "border-radius": "16px" }.',
          ),
        index: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe('Position among the children ("child" only; default: end).'),
        docId: docIdField,
      },
      annotations: WRITE,
    },
    ({ nodeId, kind, params, preset, placement, name, styles, index, docId }) => {
      const id = store.resolveDocId(docId);
      const doc = store.get(id);
      const parent = requireNode(doc, nodeId);
      if (LEAF_TYPES.has(parent.node.type)) {
        throw new ToolError(
          `${nodeId} is ${parent.node.type} and does not accept children. Pass the id of the frame or container (div/section) that will receive the effect; see get_tree_summary.`,
        );
      }
      const def = getEffect(kind);
      if (!def) unknownKind(kind);
      let base: Record<string, MediaParamValue> = {};
      if (preset) {
        const pp = presetParams(kind, preset);
        if (!pp) {
          throw new ToolError(
            `Preset "${preset}" does not exist in "${kind}". Presets: ${def!.presets.map((p) => p.name).join(', ') || '(none)'}; see list_effects.`,
          );
        }
        base = pp;
      }
      const merged = { ...base, ...(params ?? {}) };
      checkParams(kind, merged);
      const final = resolveEffectParams(kind, merged);
      const mode = placement ?? 'background';
      let node: Node;
      const ops: Parameters<typeof apply>[1] = [];
      if (mode === 'background') {
        node = createEffectNode(kind, final, {
          name: name ?? `Background ${def?.label ?? kind}`,
          styles: { ...EFFECT_BACKGROUND_STYLE, ...(styles ?? {}) },
        });
        ops.push({ type: 'createNode', parentId: nodeId, node, index: 0 });
        const set: Record<string, string> = {};
        if (!parent.node.style['position']) set['position'] = 'relative';
        if (parent.node.style['isolation'] !== 'isolate') set['isolation'] = 'isolate';
        if (Object.keys(set).length) ops.push({ type: 'updateStyles', changes: [{ nodeId, set }] });
      } else {
        node = createEffectNode(kind, final, {
          name: name ?? def?.label ?? kind,
          styles: { width: '100%', height: '240px', ...(styles ?? {}) },
        });
        ops.push({ type: 'createNode', parentId: nodeId, node, index });
      }
      const r = apply(id, ops, 'add_effect');
      return `Effect "${kind}" added: ${node.id} (${mode === 'background' ? 'background of' : 'child of'} ${nodeId}).\n${summaryOf(r.doc, [nodeId])}`;
    },
  );

  tool(
    'update_effect',
    {
      title: 'Update effect',
      description:
        'Changes an existing effect: merges params into the current ones, applies a preset, switches the kind (the old params are discarded) or, with reset, returns to the defaults. See list_effects.',
      example: { nodeId: 'fx_ab12cd34', params: { speed: 1.2 } },
      inputSchema: {
        nodeId: z.string().describe('Id of the effect node, e.g. "fx_ab12cd34".'),
        params: paramsField,
        kind: z.string().optional().describe('New effect kind, e.g. "particles".'),
        preset: z.string().optional().describe('Preset to apply before the params.'),
        reset: z
          .boolean()
          .optional()
          .describe('true resets the params to the defaults before applying preset and params.'),
        docId: docIdField,
      },
      annotations: WRITE,
    },
    ({ nodeId, params, kind, preset, reset, docId }) => {
      const id = store.resolveDocId(docId);
      const doc = store.get(id);
      const { node } = requireNode(doc, nodeId);
      if (node.type !== 'effect' || !node.effect) {
        throw new ToolError(
          `${nodeId} is ${node.type}, not an effect. Use add_effect to create one or get_tree_summary to find the id.`,
        );
      }
      const newKind = kind ?? node.effect.kind;
      const def = getEffect(newKind);
      if (!def) unknownKind(newKind);
      let base: Record<string, MediaParamValue> =
        (kind && kind !== node.effect.kind) || reset ? {} : { ...node.effect.params };
      if (preset) {
        const pp = presetParams(newKind, preset);
        if (!pp) {
          throw new ToolError(
            `Preset "${preset}" does not exist in "${newKind}". Presets: ${def!.presets.map((p) => p.name).join(', ') || '(none)'}; see list_effects.`,
          );
        }
        base = pp;
      }
      const merged = { ...base, ...(params ?? {}) };
      checkParams(newKind, merged);
      const final = resolveEffectParams(newKind, merged);
      const r = apply(
        id,
        [{ type: 'setMedia', changes: [{ nodeId, effect: { kind: newKind, params: final } }] }],
        'update_effect',
      );
      return `Effect ${nodeId} updated (${newKind}).\n${summaryOf(r.doc, [nodeId])}`;
    },
  );
}
