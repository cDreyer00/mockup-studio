import { z } from 'zod';
import type { LayoutNode } from '@mockup/core';
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
  const { tool, store, opts, requireNode } = ctx;

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
        'Renderiza um nó (frame, seção, componente) e devolve a IMAGEM. Chame depois de cada conjunto de mudanças para conferir visualmente ' +
        '(alinhamento, cortes, overflow, contraste, textos quebrando) antes de seguir; corrija o que estiver errado e repita. ' +
        'Para economizar contexto prefira scale 1 e use maxWidth (ex.: 800) em frames grandes; use scale 2 só para checar detalhes. ' +
        'Sem nodeId usa o primeiro nó selecionado ou o primeiro frame da página. Exige o motor de render (app desktop ou Electron headless).',
      inputSchema: {
        nodeId: z
          .string()
          .optional()
          .describe('Id do nó (padrão: seleção atual ou primeiro frame).'),
        scale: z
          .union([z.literal(1), z.literal(2), z.literal(3)])
          .optional()
          .describe('Escala de pixels: 1 (padrão), 2 ou 3.'),
        format: z.enum(['png', 'jpg']).optional().describe('Formato (padrão png; jpg é menor).'),
        maxWidth: z
          .number()
          .int()
          .min(16)
          .optional()
          .describe('Largura máxima da imagem em px; reduz mantendo a proporção. Ex.: 800.'),
        transparent: z
          .boolean()
          .optional()
          .describe('Fundo transparente fora do conteúdo (só png). Padrão false.'),
        docId: docIdField,
      },
      annotations: READ,
    },
    async ({ nodeId, scale, format, maxWidth, transparent, docId }) => {
      const render = needRender();
      const id = store.resolveDocId(docId);
      const doc = store.get(id);
      const target = nodeId ?? ctx.selectedOrFirstFrame(id, doc);
      const { node } = requireNode(doc, target);
      const fmt = format ?? 'png';
      let r;
      try {
        r = await render.capture({
          doc,
          docId: id,
          nodeId: target,
          assetsDir: store.assetsDir(id),
          scale: scale ?? 1,
          format: fmt,
          maxWidth,
          transparent,
        });
      } catch (e) {
        throw new ToolError(
          `Falha ao renderizar ${target}: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
      const ext = r.mime === 'image/jpeg' ? 'jpg' : 'png';
      return {
        images: [{ data: r.data.toString('base64'), mimeType: r.mime }],
        text: `${node.id} "${node.name}": ${Math.round(r.width)}x${Math.round(r.height)} px (imagem ${r.pixelWidth}x${r.pixelHeight} ${ext}, ${kb(r.data.length)})`,
      };
    },
  );

  tool(
    'get_layout',
    {
      title: 'Medidas reais do layout',
      description:
        'Posição e tamanho reais (renderizados) de um nó e seus descendentes, relativos ao frame, uma linha por nó: `id "nome" tag x,y wxh`. ' +
        'Nós de texto trazem o texto das linhas. Use para checar alinhamentos, espaçamentos e overflow com números, depois do get_screenshot. ' +
        'Exige o motor de render (app desktop ou Electron headless).',
      inputSchema: {
        nodeId: z.string().describe('Id do nó raiz da medição, ex.: "fr_ab12cd34".'),
        depth: z
          .number()
          .int()
          .min(0)
          .max(10)
          .optional()
          .describe('Níveis de descendentes exibidos (padrão 3); o resto vira contagem.'),
        docId: docIdField,
      },
      annotations: READ,
    },
    async ({ nodeId, depth, docId }) => {
      const render = needRender();
      const id = store.resolveDocId(docId);
      const doc = store.get(id);
      requireNode(doc, nodeId);
      let layout: LayoutNode;
      try {
        layout = await render.measure({ doc, docId: id, nodeId, assetsDir: store.assetsDir(id) });
      } catch (e) {
        throw new ToolError(
          `Falha ao medir ${nodeId}: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
      return formatLayout(layout, depth ?? 3);
    },
  );
}
