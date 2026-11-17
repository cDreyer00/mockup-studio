import { z } from 'zod';
import { PREVIEW_STATES, type LayoutNode } from '@mockup/core';
import { renderTargetFor, type RenderTarget } from '../../component-view.js';
import { renderUnavailableMessage } from '../../render.js';
import { READ, ToolError, docIdField, type ToolContext } from '../context.js';

const short = (s: string, max: number): string => (s.length > max ? `${s.slice(0, max - 1)}…` : s);
const kb = (n: number): string => `${Math.max(1, Math.round(n / 1024))} KB`;

/** Uma linha por nó: `id "nome" tag x,y wxh` (+ texto das linhas); filhos além de `depth` viram contagem. */
export function formatLayout(root: LayoutNode, depth: number): string {
  const lines: string[] = [];
  const walk = (n: LayoutNode, level: number): void => {
    const pad = '  '.repeat(level);
    const text = n.lines?.length
      ? ` "${short(
          n.lines
            .map((l) => l.text)
            .join(' ')
            .replace(/\s+/g, ' ')
            .trim(),
          60,
        )}"`
      : '';
    lines.push(
      `${pad}${n.id} "${n.name}" ${n.tag} ${Math.round(n.x)},${Math.round(n.y)} ${Math.round(n.width)}x${Math.round(n.height)}${text}`,
    );
    if (level >= depth) {
      if (n.children.length)
        lines.push(`${pad}  … ${n.children.length} filho(s) além da profundidade`);
      return;
    }
    for (const c of n.children) walk(c, level + 1);
  };
  walk(root, 0);
  return lines.join('\n');
}

export function registerRenderTools(ctx: ToolContext): void {
  const { tool, store, opts, readNode } = ctx;

  /**
   * Alvo de render: documento com instâncias expandidas (a página de render não conhece
   * componentes); `cp_...` e nós de um principal rendem numa instância padrão.
   */
  const targetOf = (doc: Parameters<typeof renderTargetFor>[0], id: string): RenderTarget => {
    const t = renderTargetFor(doc, id);
    if (!t) {
      readNode(doc, id); // lança o erro padrão de nó não encontrado
      throw new ToolError(`Nó não encontrado: "${id}".`);
    }
    return t;
  };

  const needRender = () => {
    if (!opts.render)
      throw new ToolError(renderUnavailableMessage({ pid: process.pid, port: opts.getPort?.() }));
    return opts.render;
  };

  tool(
    'get_screenshot',
    {
      title: 'Screenshot de um nó',
      description:
        'Renderiza um nó e devolve a IMAGEM; use após cada conjunto de mudanças para conferir. Dica: scale 1 e maxWidth 800 gastam menos contexto. Sem nodeId usa a seleção ou o primeiro frame. state mostra hover, dark etc. Exige render.',
      example: { nodeId: 'fr_ab12cd34', scale: 1, format: 'png', maxWidth: 800 },
      inputSchema: {
        nodeId: z
          .string()
          .optional()
          .describe('Id do nó, ex.: "fr_ab12cd34" (padrão: seleção atual ou primeiro frame).'),
        scale: z
          .union([z.literal(1), z.literal(2), z.literal(3)])
          .optional()
          .describe('Escala de pixels: 1 (padrão), 2 ou 3. Ex.: 2 para checar detalhes.'),
        format: z
          .enum(['png', 'jpg'])
          .optional()
          .describe('"png" (padrão) ou "jpg" (arquivo menor), ex.: "png".'),
        maxWidth: z
          .number()
          .int()
          .min(16)
          .optional()
          .describe('Largura máxima da imagem em px; reduz mantendo a proporção. Ex.: 800.'),
        transparent: z
          .boolean()
          .optional()
          .describe('true deixa o fundo transparente fora do conteúdo (só png). Padrão false.'),
        state: z
          .enum(PREVIEW_STATES)
          .optional()
          .describe(
            `Estado de prévia (veja get_guide("tailwind")): ${PREVIEW_STATES.join(', ')}. Mostra o nó com os states (hover:, dark:...) aplicados, ex.: "hover".`,
          ),
        docId: docIdField,
      },
      annotations: READ,
    },
    async ({ nodeId, scale, format, maxWidth, transparent, state, docId }) => {
      const render = needRender();
      const id = store.resolveDocId(docId);
      const doc = store.get(id);
      const target = nodeId ?? ctx.selectedOrFirstFrame(id, doc);
      const rt = targetOf(doc, target);
      const fmt = format ?? 'png';
      let r;
      try {
        r = await render.capture({
          doc: rt.doc,
          docId: id,
          nodeId: rt.nodeId,
          assetsDir: store.assetsDir(id),
          scale: scale ?? 1,
          format: fmt,
          maxWidth,
          transparent,
          ...(state ? { state } : {}),
        });
      } catch (e) {
        throw new ToolError(
          `Falha ao renderizar ${target}: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
      const ext = r.mime === 'image/jpeg' ? 'jpg' : 'png';
      return {
        images: [{ data: r.data.toString('base64'), mimeType: r.mime }],
        text: `${target} "${rt.name}": ${Math.round(r.width)}x${Math.round(r.height)} px (imagem ${r.pixelWidth}x${r.pixelHeight} ${ext}, ${kb(r.data.length)})${state ? ` com o estado "${state}"` : ''}`,
      };
    },
  );

  tool(
    'get_layout',
    {
      title: 'Medidas reais do layout',
      description:
        'Posição e tamanho reais (renderizados) de um nó e descendentes, uma linha por nó: id "nome" tag x,y wxh, mais o texto das linhas. Para checar alinhamento e overflow. Exige render.',
      example: { nodeId: 'fr_ab12cd34', depth: 3 },
      inputSchema: {
        nodeId: z.string().describe('Id do nó raiz da medição, ex.: "fr_ab12cd34".'),
        depth: z
          .number()
          .int()
          .min(0)
          .max(10)
          .optional()
          .describe(
            'Níveis de descendentes exibidos, de 0 a 10, ex.: 3 (padrão 3); o resto vira contagem.',
          ),
        docId: docIdField,
      },
      annotations: READ,
    },
    async ({ nodeId, depth, docId }) => {
      const render = needRender();
      const id = store.resolveDocId(docId);
      const doc = store.get(id);
      const rt = targetOf(doc, nodeId);
      let layout: LayoutNode;
      try {
        layout = await render.measure({
          doc: rt.doc,
          docId: id,
          nodeId: rt.nodeId,
          assetsDir: store.assetsDir(id),
        });
      } catch (e) {
        throw new ToolError(
          `Falha ao medir ${nodeId}: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
      return formatLayout(layout, depth ?? 3);
    },
  );
}
