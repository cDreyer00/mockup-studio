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
  .describe('Parâmetros do efeito, ex.: { "speed": 0.5, "color1": "#6c5ce7" }. Veja list_effects.');

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

/** Problemas dos params como ToolError com a sugestão de list_effects. */
function checkParams(kind: string, params: Record<string, MediaParamValue>): void {
  const problems = effectParamsProblems(kind, params);
  if (!problems.length) return;
  const kinds = effectKinds();
  throw new ToolError(
    `Parâmetros inválidos para o efeito "${kind}":\n- ${problems.join('\n- ')}\n` +
      `Use list_effects para ver os efeitos${kinds.length ? ` (${kinds.join(', ')})` : ''}, seus parâmetros e presets.`,
  );
}

function unknownKind(kind: string): never {
  checkParams(kind, {});
  throw new ToolError(`Efeito inexistente: "${kind}". Use list_effects para ver os disponíveis.`);
}

export function registerEffectTools(ctx: ToolContext): void {
  const { tool, store, requireNode, apply, summaryOf } = ctx;

  tool(
    'list_effects',
    {
      title: 'Listar efeitos visuais',
      description:
        'Lista os efeitos disponíveis (shaders e partículas) com categoria, descrição, parâmetros (tipo, faixa, padrão) e presets. Use antes de add_effect.',
      example: {},
      inputSchema: {},
      annotations: READ,
    },
    () => {
      if (!EFFECTS.length) return 'Nenhum efeito disponível.';
      const out = [`${EFFECTS.length} efeito(s). Use add_effect(nodeId, kind, params?, preset?).`];
      for (const e of EFFECTS) {
        out.push(`\n- ${e.kind} [${e.category}] ${e.label}: ${e.description}`);
        out.push(`  params: ${e.params.map(paramDoc).join('; ') || '(nenhum)'}`);
        if (e.presets.length) out.push(`  presets: ${e.presets.map((p) => p.name).join(', ')}`);
      }
      return out.join('\n');
    },
  );

  tool(
    'add_effect',
    {
      title: 'Adicionar efeito visual',
      description:
        'Adiciona um efeito (shader WebGL ou partículas; veja list_effects). placement "background" (padrão): vira o primeiro filho de nodeId, cobrindo-o atrás do conteúdo; o pai ganha position: relative e isolation: isolate. "child": filho comum com styles (padrão 100% x 240px). nodeId deve ser um contêiner, não texto/imagem/svg/mídia.',
      example: {
        nodeId: 'fr_ab12cd34',
        kind: 'mesh-gradient',
        preset: 'aurora',
        params: { speed: 0.5 },
      },
      inputSchema: {
        nodeId: z.string().describe('Id do contêiner que recebe o efeito, ex.: "fr_ab12cd34".'),
        kind: z.string().describe('Tipo do efeito, ex.: "mesh-gradient" ou "particles".'),
        params: paramsField,
        preset: z.string().optional().describe('Nome de um preset do efeito, ex.: "aurora".'),
        placement: z
          .enum(['background', 'child'])
          .optional()
          .describe('"background" (padrão): fundo do contêiner; "child": filho comum.'),
        name: z.string().optional().describe('Nome da camada, ex.: "Fundo animado".'),
        styles: z
          .record(z.string(), z.string())
          .optional()
          .describe('Estilos CSS do efeito, ex.: { "height": "320px", "border-radius": "16px" }.'),
        index: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe('Posição entre os filhos (só em "child"; padrão: final).'),
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
          `${nodeId} é ${parent.node.type} e não aceita filhos. Passe o id do frame ou do contêiner (div/section) que receberá o efeito; veja get_tree_summary.`,
        );
      }
      const def = getEffect(kind);
      if (!def) unknownKind(kind);
      let base: Record<string, MediaParamValue> = {};
      if (preset) {
        const pp = presetParams(kind, preset);
        if (!pp) {
          throw new ToolError(
            `Preset "${preset}" não existe em "${kind}". Presets: ${def!.presets.map((p) => p.name).join(', ') || '(nenhum)'}; veja list_effects.`,
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
          name: name ?? `Fundo ${def?.label ?? kind}`,
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
      return `Efeito "${kind}" adicionado: ${node.id} (${mode === 'background' ? 'fundo de' : 'filho de'} ${nodeId}).\n${summaryOf(r.doc, [nodeId])}`;
    },
  );

  tool(
    'update_effect',
    {
      title: 'Atualizar efeito',
      description:
        'Altera um efeito existente: mescla params nos atuais, aplica um preset, troca o kind (os params antigos são descartados) ou, com reset, volta aos padrões. Veja list_effects.',
      example: { nodeId: 'ef_ab12cd34', params: { speed: 1.2 } },
      inputSchema: {
        nodeId: z.string().describe('Id do nó de efeito, ex.: "ef_ab12cd34".'),
        params: paramsField,
        kind: z.string().optional().describe('Novo tipo de efeito, ex.: "particles".'),
        preset: z.string().optional().describe('Preset a aplicar antes dos params.'),
        reset: z
          .boolean()
          .optional()
          .describe('true volta os parâmetros aos padrões antes de aplicar preset e params.'),
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
          `${nodeId} é ${node.type}, não um efeito. Use add_effect para criar um ou get_tree_summary para achar o id.`,
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
            `Preset "${preset}" não existe em "${newKind}". Presets: ${def!.presets.map((p) => p.name).join(', ') || '(nenhum)'}; veja list_effects.`,
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
      return `Efeito ${nodeId} atualizado (${newKind}).\n${summaryOf(r.doc, [nodeId])}`;
    },
  );
}
