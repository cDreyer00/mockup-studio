import { z } from 'zod';
import { findNode } from '@mockup/core';
import { REMIX_MAX_COUNT } from '../../remix.js';
import { ToolError, WRITE, docIdField, type ToolContext } from '../context.js';

const KINDS = ['color-scale', 'font-pairs', 'spacing', 'layout', 'ai'] as const;

/** Quantos frames criados entram no resumo da resposta (o resto fica só na lista de ids). */
const SUMMARY_FRAMES = 3;

export function registerRemixTools(ctx: ToolContext): void {
  const { tool, store, opts } = ctx;

  tool(
    'remix',
    {
      title: 'Remix: variações lado a lado',
      description:
        'Cria variações de um nó como frames clonados lado a lado à direita (um undo desfaz tudo). kind: color-scale (10 tons), font-pairs, spacing, layout ou ai (exige prompt e o assistente). Devolve os ids; confira com get_screenshot.',
      example: { nodeId: 'el_ab12cd34', kind: 'color-scale', count: 5 },
      inputSchema: {
        nodeId: z
          .string()
          .describe('Nó a variar, ex.: "el_ab12cd34"; o frame raiz que o contém é clonado.'),
        kind: z
          .enum(KINDS)
          .describe(
            '"color-scale" (tons 50-900 da cor do nó), "font-pairs" (pares de fontes locais), "spacing" (escala 4/8), "layout" (rearranjos do flex) ou "ai" (variações geradas pelo assistente).',
          ),
        count: z
          .number()
          .int()
          .min(1)
          .max(REMIX_MAX_COUNT)
          .optional()
          .describe(
            'Quantas variações, de 1 a 10, ex.: 5. Padrão: color-scale 10, font-pairs 4, spacing 4, layout 3, ai 3.',
          ),
        prompt: z
          .string()
          .optional()
          .describe(
            'Obrigatório em kind "ai": como as variações devem diferir, ex.: "versões mais ousadas".',
          ),
        docId: docIdField,
      },
      annotations: WRITE,
    },
    async ({ nodeId, kind, count, prompt, docId }) => {
      const remix = opts.services?.remix;
      if (!remix) throw new ToolError('Remix indisponível neste daemon.');
      const id = store.resolveDocId(docId);
      if (kind === 'ai' && !prompt?.trim())
        throw new ToolError(
          'kind "ai" exige prompt. Ex.: { nodeId: "fr_ab12cd34", kind: "ai", prompt: "versões mais ousadas" }.',
        );
      ctx.requireNode(store.get(id), nodeId);
      const r = await remix.run(id, nodeId, kind, {
        ...(count !== undefined ? { count } : {}),
        ...(prompt !== undefined ? { prompt } : {}),
        group: ctx.group(),
        source: 'mcp',
      });
      const doc = store.get(id);
      if (r.frameIds.length === 0)
        return 'O assistente terminou sem criar frames novos. Veja a página com get_basic_info.';
      const lines = r.frameIds.map((fid, i) => {
        const name = findNode(doc, fid)?.node.name ?? r.labels[i] ?? '';
        return `- ${fid} "${name}"`;
      });
      const shown = r.frameIds.slice(0, SUMMARY_FRAMES);
      const more =
        r.frameIds.length > shown.length
          ? ` (resumo dos ${shown.length} primeiros de ${r.frameIds.length})`
          : '';
      return `${r.frameIds.length} variação(ões) criada(s) lado a lado${kind === 'ai' ? ' pelo assistente' : ''}; um undo desfaz todas.\n${lines.join('\n')}\nResumo${more}:\n${ctx.summaryOf(doc, shown)}`;
    },
  );
}
