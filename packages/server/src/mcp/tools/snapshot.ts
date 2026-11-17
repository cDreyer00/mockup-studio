import { z } from 'zod';
import { findNode } from '@mockup/core';
import { IMPORT_VIEWPORT_LIMITS, planCleanup } from '@mockup/snapshot-core';
import type { SnapshotImportResult } from '@mockup/snapshot-core';
import {
  importFromHtml,
  importFromUrl,
  IMPORT_URL_NEEDS_RENDER,
  type SnapshotServiceCtx,
} from '../../snapshot/service.js';
import { SnapshotImportError } from '../../snapshot/validate.js';
import { ToolError, WRITE, docIdField, type ToolContext } from '../context.js';

const placementFields = {
  name: z
    .string()
    .optional()
    .describe(
      'Nome do frame criado, ex.: "Hero do site X" (padrão: título da página ou do elemento).',
    ),
  reference: z
    .boolean()
    .optional()
    .describe('Anexar a captura de tela como frame oculto "Referência" ao lado (padrão true).'),
  pageId: z.string().optional().describe('Id da página, ex.: "pg_ab12cd34" (padrão: a primeira).'),
  x: z
    .number()
    .optional()
    .describe('Posição X do frame no canvas, ex.: 1600 (padrão: à direita do último frame).'),
  y: z
    .number()
    .optional()
    .describe('Posição Y do frame no canvas, ex.: 0 (padrão: y do primeiro frame).'),
  docId: docIdField,
};

const captureFields = {
  selector: z
    .string()
    .optional()
    .describe(
      'Seletor CSS do elemento a importar, ex.: "header" ou "#hero" (padrão: body, a página inteira).',
    ),
  width: z
    .number()
    .min(IMPORT_VIEWPORT_LIMITS.minWidth)
    .max(IMPORT_VIEWPORT_LIMITS.maxWidth)
    .optional()
    .describe(
      `Largura do viewport em px, de ${IMPORT_VIEWPORT_LIMITS.minWidth} a ${IMPORT_VIEWPORT_LIMITS.maxWidth}, ex.: 1440 (padrão 1440); escolhe o breakpoint do site.`,
    ),
  height: z
    .number()
    .min(IMPORT_VIEWPORT_LIMITS.minHeight)
    .max(IMPORT_VIEWPORT_LIMITS.maxHeight)
    .optional()
    .describe(
      `Altura do viewport em px, de ${IMPORT_VIEWPORT_LIMITS.minHeight} a ${IMPORT_VIEWPORT_LIMITS.maxHeight}, ex.: 900 (padrão 900).`,
    ),
  timeout_ms: z
    .number()
    .positive()
    .optional()
    .describe('Tempo máximo da captura em ms, até 60000, ex.: 30000 (padrão 20000).'),
};

const viewportOf = (width?: number, height?: number) =>
  width !== undefined || height !== undefined ? { width, height } : undefined;

export function registerSnapshotTools(ctx: ToolContext): void {
  const { tool, store, summaryOf } = ctx;
  const service: SnapshotServiceCtx = { store, render: ctx.opts.render, source: 'mcp' };

  const describe = (r: SnapshotImportResult, origin: string): string => {
    const doc = store.get(r.docId);
    const frame = findNode(doc, r.frameId)?.node;
    const fonts = r.fonts.length ? `fontes: ${r.fonts.join(', ')}` : 'sem fontes novas';
    const head =
      `Importado de ${origin}: ${r.frameId} "${frame?.name ?? ''}" ` +
      `(${r.nodes} nós, ${r.images} imagens, ${fonts}).` +
      (r.referenceId ? ` Referência oculta: ${r.referenceId}.` : '');
    const lines = [head];
    if (r.warnings.length) lines.push('Avisos:', ...r.warnings.map((w) => `- ${w}`));
    lines.push(summaryOf(doc, [r.frameId]));
    lines.push(
      `Próximos passos: confira com get_screenshot(${r.frameId}) e simplifique com cleanup_imported(${r.frameId}).` +
        (r.referenceId
          ? ` Para comparar com o original: set_node_flags em ${r.referenceId} com hidden:false (ou get_screenshot dele).`
          : ''),
    );
    return lines.join('\n');
  };

  tool(
    'import_url',
    {
      title: 'Importar de uma URL',
      description:
        'Importa uma página ou seção de um site (URL http/https) como frame editável, com estilos computados, imagens e fontes. Precisa do motor de render. Depois: get_screenshot e cleanup_imported.',
      example: { url: 'https://example.com', selector: 'header', width: 1440 },
      inputSchema: {
        url: z.string().describe('Endereço http(s) da página, ex.: "https://example.com/pricing".'),
        ...captureFields,
        ...placementFields,
      },
      annotations: WRITE,
    },
    async ({ url, selector, width, height, timeout_ms, reference, name, pageId, x, y, docId }) => {
      try {
        const r = await importFromUrl(service, {
          url,
          selector,
          viewport: viewportOf(width, height),
          timeoutMs: timeout_ms,
          reference,
          name,
          pageId,
          x,
          y,
          docId,
        });
        return describe(r, url);
      } catch (e) {
        if (e instanceof SnapshotImportError && e.message === IMPORT_URL_NEEDS_RENDER)
          throw new ToolError(
            `${IMPORT_URL_NEEDS_RENDER} Alternativas: import_html (cole o HTML da página; sem render a conversão é mais simples) ou a extensão do navegador.`,
          );
        throw e;
      }
    },
  );

  tool(
    'import_html',
    {
      title: 'Importar HTML',
      description:
        'Importa HTML (e CSS opcional) como frame editável. Com render captura estilos computados; sem render usa uma conversão simples (menos fiel). assets_base_url resolve URLs relativas.',
      example: {
        html: '<section><h1>Olá</h1><p>Texto</p></section>',
        css: 'h1{color:#6c5ce7}',
        width: 1280,
      },
      inputSchema: {
        html: z
          .string()
          .min(1)
          .describe('HTML completo ou fragmento, ex.: "<section><h1>Olá</h1></section>".'),
        css: z
          .string()
          .optional()
          .describe('CSS extra aplicado ao HTML, ex.: "h1{color:#6c5ce7}".'),
        assets_base_url: z
          .string()
          .optional()
          .describe(
            'URL http(s) base para links e imagens relativos, ex.: "https://example.com/".',
          ),
        ...captureFields,
        ...placementFields,
      },
      annotations: WRITE,
    },
    async ({
      html,
      css,
      assets_base_url,
      selector,
      width,
      height,
      timeout_ms,
      reference,
      name,
      pageId,
      x,
      y,
      docId,
    }) => {
      const r = await importFromHtml(service, {
        html,
        css,
        assetsBaseUrl: assets_base_url,
        selector,
        viewport: viewportOf(width, height),
        timeoutMs: timeout_ms,
        reference,
        name,
        pageId,
        x,
        y,
        docId,
      });
      const how =
        r.method === 'snapshot'
          ? 'captura com estilos computados (motor de render)'
          : 'conversão sem render (fidelidade menor)';
      return describe(r, `HTML (${how})`);
    },
  );

  tool(
    'cleanup_imported',
    {
      title: 'Simplificar frame importado',
      description:
        'Limpa a árvore de um frame importado: remove wrappers vazios, desembrulha divs sem estilo e troca larguras/alturas fixas redundantes por automáticas. Uma entrada de histórico (undo desfaz).',
      example: { nodeId: 'fr_ab12cd34', fluid: true },
      inputSchema: {
        nodeId: z.string().describe('Id do frame ou nó importado a limpar, ex.: "fr_ab12cd34".'),
        remove_empty: z
          .boolean()
          .optional()
          .describe('Remover divs/spans vazios sem estilo visual (padrão true).'),
        unwrap: z
          .boolean()
          .optional()
          .describe('Desembrulhar wrappers sem estilo com um único filho (padrão true).'),
        fluid: z
          .boolean()
          .optional()
          .describe(
            'Tamanhos fluidos: width em px igual ao do pai vira auto e height em px de nós com conteúdo vira min-height (padrão true).',
          ),
        docId: docIdField,
      },
      annotations: WRITE,
    },
    ({ nodeId, remove_empty, unwrap, fluid, docId }) => {
      const id = store.resolveDocId(docId);
      ctx.requireNode(store.get(id), nodeId);
      const plan = planCleanup(store.get(id), nodeId, {
        removeEmpty: remove_empty,
        unwrap,
        fluid,
      });
      if (plan.ops.length === 0) return `Nada a limpar em ${nodeId}.`;
      const r = ctx.apply(id, plan.ops, 'cleanup_imported');
      return [
        `Limpeza de ${nodeId}: ${plan.removed} nó(s) vazio(s) removido(s), ${plan.unwrapped} wrapper(s) desembrulhado(s), ${plan.fluid} tamanho(s) fixo(s) tornado(s) automático(s).`,
        summaryOf(r.doc, [nodeId]),
        `Confira com get_screenshot(${nodeId}); desfaça com undo se algo mudou demais.`,
      ].join('\n');
    },
  );
}
