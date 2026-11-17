import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
  createNodeFromTag,
  findNode,
  getComputedLike,
  getDocumentSummary,
  getTreeSummary,
  htmlToNodes,
  newPageId,
  nodesToHtml,
  summarizeNode,
  type Document,
  type Node,
  type Op,
} from '@mockup/core';
import type { DocumentStore } from '../store.js';
import {
  DESTRUCTIVE,
  READ,
  ToolError,
  WRITE,
  docIdField,
  type McpServerOptions,
  type RichResult,
  type ToolConfig,
  type ToolContext,
} from './context.js';
import { formatToolInputError, notFoundToolMessage } from './errors.js';
import { GUIDES, GUIDE_INFO, GUIDE_TOPICS } from './guides.js';
import { registerExportTools } from './tools/export.js';
import { registerFontTools } from './tools/fonts.js';
import { registerImageTools } from './tools/images.js';
import { registerRenderTools } from './tools/render.js';
import { registerSnapshotTools } from './tools/snapshot.js';

export type { McpServerOptions } from './context.js';

const nodeIdsField = z
  .array(z.string())
  .min(1)
  .describe('Ids dos nós (veja get_tree_summary), ex.: ["el_ab12cd34", "tx_9f8e7d6c"].');
const stylesField = z
  .record(z.string(), z.string())
  .describe(
    'Propriedades CSS em kebab-case, ex.: { "display": "flex", "gap": "16px", "background": "#0f172a" }.',
  );

/** Instruções enviadas ao cliente MCP no handshake (o proxy stdio do CLI as repassa). */
export const SERVER_INSTRUCTIONS = [
  'Mockup Studio é um editor de design em canvas: documentos com páginas, frames (artboards) e nós HTML/CSS reais.',
  "Comece com get_guide('getting-started') (fluxo em 6 passos) e get_basic_info.",
  'Defina o design system com set_tokens antes de desenhar e prefira write_html (HTML + CSS de uma vez) a muitas chamadas create_node.',
  'Sempre confira o resultado com get_screenshot e corrija (update_styles, set_text, undo) antes de seguir.',
  'docId é opcional (vale o documento ativo), exceto em close_document.',
  'Ao terminar um conjunto de edições, chame finish_working.',
  "Problemas (render indisponível, porta ocupada...): get_guide('troubleshooting').",
].join('\n');

/**
 * Troca o erro cru de validação do SDK (`MCP error -32602: Input validation error: ... [ {zod issues} ]`)
 * por uma mensagem em português por campo, com exemplo de chamada correta, devolvida como `isError`.
 *
 * `validateToolInput` e `createToolError` são métodos de instância do `McpServer` (invocados via `this`
 * pelo handler de `tools/call`), mas não fazem parte da API pública tipada, daí o cast. O original roda
 * primeiro: só se ele falhar com erro de validação é que reformatamos (e, se a nossa revalidação achar
 * que está tudo certo, repropagamos o erro original). O catch do SDK converte o `ToolError` em `isError`.
 */
function interceptInputErrors(
  server: McpServer,
  examples: Map<string, Record<string, unknown>>,
): void {
  type Internals = {
    validateToolInput: (
      tool: { inputSchema?: z.ZodType },
      args: unknown,
      name: string,
    ) => Promise<unknown>;
    createToolError: (message: string) => unknown;
    _registeredTools: Record<string, unknown>;
  };
  const internals = server as unknown as Internals;
  const original = internals.validateToolInput.bind(server);
  internals.validateToolInput = async (tool, args, name) => {
    try {
      return await original(tool, args, name);
    } catch (e) {
      if (!tool.inputSchema) throw e;
      const parsed = await z.safeParseAsync(tool.inputSchema, args ?? {});
      if (parsed.success) throw e;
      throw new ToolError(
        formatToolInputError(name, parsed.error.issues, args, examples.get(name)),
      );
    }
  };
  const originalToolError = internals.createToolError.bind(server);
  internals.createToolError = (message) => {
    const m = /^(?:MCP error -?\d+: )?Tool (\S+) not found$/.exec(message);
    return originalToolError(
      m ? notFoundToolMessage(m[1]!, Object.keys(internals._registeredTools)) : message,
    );
  };
}

function pxOf(v: string | undefined): number {
  const n = v ? parseFloat(v) : NaN;
  return Number.isFinite(n) ? n : 0;
}

export function createMcpServer(store: DocumentStore, opts: McpServerOptions = {}): McpServer {
  const server = new McpServer(
    { name: 'mockup-studio', version: '0.1.0' },
    { instructions: SERVER_INSTRUCTIONS },
  );
  const examples = new Map<string, Record<string, unknown>>();
  interceptInputErrors(server, examples);

  /* ---------- helpers ---------- */

  function tool<S extends z.ZodRawShape>(
    name: string,
    cfg: ToolConfig<S>,
    handler: (args: z.infer<z.ZodObject<S>>) => Promise<string | RichResult> | string | RichResult,
  ): void {
    const cb = async (args: unknown) => {
      try {
        const r = await handler(args as z.infer<z.ZodObject<S>>);
        if (typeof r === 'string') return { content: [{ type: 'text' as const, text: r }] };
        return {
          content: [
            ...(r.images ?? []).map((i) => ({
              type: 'image' as const,
              data: i.data,
              mimeType: i.mimeType,
            })),
            { type: 'text' as const, text: r.text },
          ],
        };
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return { isError: true, content: [{ type: 'text' as const, text: `Erro: ${msg}` }] };
      }
    };
    const { example, ...sdkCfg } = cfg;
    examples.set(name, example);
    server.registerTool(name, sdkCfg, cb as never);
  }

  const requireNode = (doc: Document, id: string) => {
    const p = findNode(doc, id);
    if (!p) {
      throw new ToolError(
        `Nó não encontrado: "${id}". Use get_tree_summary para listar ids válidos (ex.: "fr_ab12cd34").`,
      );
    }
    return p;
  };
  const requirePage = (doc: Document, pageId: string) => {
    const p = doc.pages.find((x) => x.id === pageId);
    if (!p) {
      throw new ToolError(
        `Página não encontrada: "${pageId}". Use get_basic_info para ver as páginas.`,
      );
    }
    return p;
  };
  const requireNodes = (doc: Document, ids: string[]) => ids.map((id) => requireNode(doc, id));

  /** Resumo (profundidade 2) dos nós afetados; ids ausentes caem para os fallbacks (pai/frame). */
  function summaryOf(doc: Document, ids: string[], fallbackIds: string[] = []): string {
    const parts: string[] = [];
    const seen = new Set<string>();
    const add = (id: string): boolean => {
      if (seen.has(id)) return true;
      const p = findNode(doc, id);
      if (!p) return false;
      seen.add(id);
      parts.push(getTreeSummary(p.node, 2));
      return true;
    };
    for (const id of ids) add(id);
    if (parts.length === 0) {
      for (const id of fallbackIds) if (add(id)) break;
    }
    return parts.length ? parts.join('\n') : getDocumentSummary(doc, 1);
  }

  function fallbackFor(doc: Document, ids: string[]): string[] {
    const out: string[] = [];
    for (const id of ids) {
      const p = findNode(doc, id);
      if (p) out.push(p.parent?.id ?? p.node.id);
    }
    return out;
  }

  const apply = (docId: string, ops: Op[], label?: string) =>
    store.applyOps(docId, ops, { source: 'mcp', label });

  const selectedOrFirstFrame = (docId: string, doc: Document): string => {
    const sel = store.getSelection(docId).find((id) => findNode(doc, id));
    if (sel) return sel;
    const frame = doc.pages[0]?.frames[0];
    if (!frame)
      throw new ToolError(
        'O documento não tem frames. Use create_frame(name, width, height) primeiro.',
      );
    return frame.id;
  };

  const sizeOf = (n: Node): string =>
    `${n.style['width'] ?? 'auto'}x${n.style['height'] ?? 'auto'}`.replace(/px/g, '');

  /* ---------- leitura ---------- */

  tool(
    'get_basic_info',
    {
      title: 'Informações básicas',
      description:
        'Visão geral do documento: arquivo, páginas, frames (id, nome, tamanho, posição), documentos abertos e seleção. Chame primeiro para descobrir os ids dos frames.',
      example: {},
      inputSchema: { docId: docIdField },
      annotations: READ,
    },
    ({ docId }) => {
      // Sem documento é o estado normal no começo da sessão (as instruções mandam chamar esta
      // ferramenta primeiro): responde com o próximo passo em vez de um erro.
      if (!docId && store.list().length === 0)
        return [
          'Nenhum documento aberto ainda.',
          'Próximo passo: create_document(path, name) para começar um novo (ex.: "C:/projetos/app/design/telas") ou open_document(path) para abrir um arquivo .mockup.json existente.',
        ].join('\n');
      const id = store.resolveDocId(docId);
      const doc = store.get(id);
      const info = store.getInfo(id);
      const lines = [
        `Arquivo: ${info.name} (${info.path ?? 'sem caminho'}) | id: ${info.docId} | alterado: ${info.dirty ? 'sim' : 'não'} | revisão: ${info.revision}`,
        'Páginas:',
      ];
      for (const page of doc.pages) {
        lines.push(`- ${page.name} (${page.id}) — ${page.frames.length} frame(s)`);
        for (const f of page.frames) {
          const pos = f.position ? ` @ ${f.position.x},${f.position.y}` : '';
          lines.push(`    * ${f.name} (${f.id}) ${sizeOf(f)}${pos}`);
        }
      }
      lines.push(
        `Documentos abertos: ${store
          .list()
          .map((d) => `${d.name} (${d.docId})${d.docId === store.activeDocId ? ' [ativo]' : ''}`)
          .join(', ')}`,
      );
      const sel = store.getSelection(id);
      lines.push(`Seleção: ${sel.length ? sel.join(', ') : '(vazia)'}`);
      lines.push('Use get_tree_summary para ver a estrutura e write_html para criar conteúdo.');
      return lines.join('\n');
    },
  );

  tool(
    'list_documents',
    {
      title: 'Listar documentos abertos',
      description:
        'Lista os documentos abertos no daemon (id, nome, caminho, revisão); o ativo vem marcado com *.',
      example: {},
      inputSchema: {},
      annotations: READ,
    },
    () => {
      const list = store.list();
      if (!list.length)
        return 'Nenhum documento aberto. Use open_document(path) ou create_document(path, name).';
      return list
        .map(
          (d) =>
            `${d.docId === store.activeDocId ? '* ' : '- '}${d.name} | id: ${d.docId} | ${d.path ?? 'sem caminho'} | rev ${d.revision}${d.dirty ? ' | alterado' : ''}`,
        )
        .join('\n');
    },
  );

  tool(
    'open_document',
    {
      title: 'Abrir documento',
      description:
        'Abre um arquivo .mockup.json existente e o torna o documento ativo. Devolve o id e um resumo.',
      example: { path: 'C:/projetos/site.mockup.json' },
      inputSchema: {
        path: z
          .string()
          .describe('Caminho absoluto do arquivo, ex.: "C:/projetos/site.mockup.json".'),
      },
      annotations: WRITE,
    },
    async ({ path }) => {
      const r = await store.open(path);
      return `Documento aberto: ${r.name} (id ${r.docId}).\n${getDocumentSummary(r.doc, 1)}`;
    },
  );

  tool(
    'create_document',
    {
      title: 'Criar documento',
      description:
        'Cria um documento novo e vazio (sem frames: crie-os com create_frame) em path, acrescentando .mockup.json se faltar, e o torna ativo. Devolve o id do documento.',
      example: { path: 'C:/projetos/site', name: 'Landing page' },
      inputSchema: {
        path: z
          .string()
          .describe(
            'Caminho absoluto do novo arquivo, ex.: "C:/projetos/site" (a extensão .mockup.json é acrescentada).',
          ),
        name: z.string().describe('Nome do documento, ex.: "Landing page".'),
      },
      annotations: WRITE,
    },
    async ({ path, name }) => {
      const r = await store.create(path, name);
      return `Documento criado: ${r.name} (id ${r.docId}) em ${r.path}.\nPróximo passo: create_frame(name, width, height).`;
    },
  );

  tool(
    'save_document',
    {
      title: 'Salvar documento',
      description:
        'Força a gravação em disco; o salvamento automático já ocorre após as alterações. Devolve o caminho salvo.',
      example: {},
      inputSchema: { docId: docIdField },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    async ({ docId }) => `Salvo em ${await store.save(docId)}.`,
  );

  tool(
    'close_document',
    {
      title: 'Fechar documento',
      description: 'Fecha um documento aberto, salvando antes as alterações pendentes.',
      example: { docId: 'doc_ab12cd34' },
      inputSchema: {
        docId: z
          .string()
          .describe('Id do documento a fechar (veja list_documents), ex.: "doc_ab12cd34".'),
      },
      annotations: WRITE,
    },
    async ({ docId }) => {
      await store.close(docId);
      return `Documento ${docId} fechado.`;
    },
  );

  tool(
    'get_selection',
    {
      title: 'Seleção atual',
      description:
        'Devolve o resumo dos nós atualmente selecionados no editor (útil quando o usuário diz "este botão").',
      example: {},
      inputSchema: { docId: docIdField },
      annotations: READ,
    },
    ({ docId }) => {
      const id = store.resolveDocId(docId);
      const doc = store.get(id);
      const sel = store.getSelection(id);
      if (!sel.length) return 'Nenhum nó selecionado.';
      return sel
        .map((n) => {
          const p = findNode(doc, n);
          return p ? summarizeNode(p.node) : `${n} (não existe mais)`;
        })
        .join('\n');
    },
  );

  tool(
    'set_selection',
    {
      title: 'Definir seleção',
      description: 'Seleciona nós no editor (o usuário vê a seleção). Lista vazia limpa a seleção.',
      example: { nodeIds: ['el_ab12cd34'] },
      inputSchema: {
        nodeIds: z
          .array(z.string())
          .describe('Ids dos nós a selecionar, ex.: ["el_ab12cd34"]; [] limpa a seleção.'),
        docId: docIdField,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    ({ nodeIds, docId }) => {
      const id = store.resolveDocId(docId);
      requireNodes(store.get(id), nodeIds);
      store.setSelection(id, nodeIds, 'mcp');
      return `Seleção definida: ${nodeIds.length ? nodeIds.join(', ') : '(vazia)'}.`;
    },
  );

  tool(
    'get_node_info',
    {
      title: 'Detalhes de um nó',
      description:
        'Detalhes de um nó: tipo, nome, tag, página, pai, ancestrais, atributos, estilos próprios, texto, posição e flags.',
      example: { nodeId: 'el_ab12cd34' },
      inputSchema: {
        nodeId: z.string().describe('Id do nó, ex.: "el_ab12cd34".'),
        docId: docIdField,
      },
      annotations: READ,
    },
    ({ nodeId, docId }) => {
      const doc = store.get(store.resolveDocId(docId));
      const p = requireNode(doc, nodeId);
      const n = p.node;
      const kv = (o: Record<string, string>) =>
        Object.keys(o).length
          ? Object.entries(o)
              .map(([k, v]) => `${k}: ${v}`)
              .join('; ')
          : '(nenhum)';
      const lines = [
        `${n.id} | tipo: ${n.type} | nome: ${n.name} | tag: ${n.tag}`,
        `página: ${p.page.name} (${p.page.id})`,
        `pai: ${p.parent ? `${p.parent.name} (${p.parent.id})` : '(raiz da página)'} | índice: ${p.index}`,
        `ancestrais: ${p.ancestors.length ? p.ancestors.map((a) => `${a.name} (${a.id})`).join(' > ') : '(nenhum)'}`,
        `attrs: ${kv(n.attrs)}`,
        `style: ${kv(n.style)}`,
      ];
      if (n.position) lines.push(`posição: ${n.position.x}, ${n.position.y}`);
      if (n.text !== undefined) lines.push(`texto: ${JSON.stringify(n.text)}`);
      if (n.src) lines.push(`src: ${n.src.length > 120 ? `${n.src.slice(0, 120)}…` : n.src}`);
      lines.push(
        `filhos: ${n.children.length}${n.locked ? ' | bloqueado' : ''}${n.hidden ? ' | oculto' : ''}`,
      );
      return lines.join('\n');
    },
  );

  tool(
    'get_children',
    {
      title: 'Filhos de um nó',
      description: 'Uma linha de resumo por filho direto do nó, em ordem.',
      example: { nodeId: 'fr_ab12cd34' },
      inputSchema: {
        nodeId: z.string().describe('Id do nó pai, ex.: "fr_ab12cd34".'),
        docId: docIdField,
      },
      annotations: READ,
    },
    ({ nodeId, docId }) => {
      const doc = store.get(store.resolveDocId(docId));
      const { node } = requireNode(doc, nodeId);
      if (!node.children.length) return `${node.id} não tem filhos.`;
      return node.children.map((c) => summarizeNode(c)).join('\n');
    },
  );

  tool(
    'get_tree_summary',
    {
      title: 'Resumo da árvore',
      description:
        'Estrutura compacta da árvore, uma linha por nó. Sem nodeId resume o documento inteiro; com nodeId, a subárvore. Use para descobrir ids e conferir o resultado.',
      example: { nodeId: 'fr_ab12cd34', depth: 2 },
      inputSchema: {
        nodeId: z
          .string()
          .optional()
          .describe('Id do nó raiz do resumo, ex.: "fr_ab12cd34" (padrão: documento inteiro).'),
        depth: z
          .number()
          .int()
          .min(0)
          .max(10)
          .optional()
          .describe('Níveis exibidos de 0 a 10, ex.: 3 (padrão 2); o resto vira contagem.'),
        docId: docIdField,
      },
      annotations: READ,
    },
    ({ nodeId, depth, docId }) => {
      const doc = store.get(store.resolveDocId(docId));
      const d = depth ?? 2;
      if (!nodeId) return getDocumentSummary(doc, d);
      return getTreeSummary(requireNode(doc, nodeId).node, d);
    },
  );

  tool(
    'get_styles',
    {
      title: 'Estilos efetivos',
      description:
        'Estilos efetivos (herdados, com var() resolvido) de um ou mais nós, no formato "prop: valor".',
      example: { nodeIds: ['el_ab12cd34'] },
      inputSchema: { nodeIds: nodeIdsField, docId: docIdField },
      annotations: READ,
    },
    ({ nodeIds, docId }) => {
      const doc = store.get(store.resolveDocId(docId));
      requireNodes(doc, nodeIds);
      return nodeIds
        .map((id) => {
          const styles = getComputedLike(doc, id);
          const body = Object.entries(styles)
            .map(([k, v]) => `  ${k}: ${v}`)
            .join('\n');
          return `${id}:\n${body || '  (sem estilos)'}`;
        })
        .join('\n');
    },
  );

  tool(
    'get_html',
    {
      title: 'Exportar nó como HTML',
      description:
        'HTML de um nó. mode "inline" (padrão) usa style inline; "classes" devolve o html mais um bloco <style>. Para código de entrega prefira get_code.',
      example: { nodeId: 'fr_ab12cd34', mode: 'classes' },
      inputSchema: {
        nodeId: z.string().describe('Id do nó, ex.: "fr_ab12cd34".'),
        mode: z
          .enum(['inline', 'classes'])
          .optional()
          .describe('"inline" (style em cada nó, padrão) ou "classes" (classes + bloco <style>).'),
        docId: docIdField,
      },
      annotations: READ,
    },
    ({ nodeId, mode, docId }) => {
      const doc = store.get(store.resolveDocId(docId));
      const { node } = requireNode(doc, nodeId);
      const out = nodesToHtml([node], { mode: mode ?? 'inline' });
      return out.css && (mode ?? 'inline') === 'classes'
        ? `${out.html}\n<style>\n${out.css}\n</style>`
        : out.html;
    },
  );

  tool(
    'get_tokens',
    {
      title: 'Tokens do documento',
      description: 'Lista os tokens (variáveis CSS) do documento, um "--nome: valor" por linha.',
      example: {},
      inputSchema: { docId: docIdField },
      annotations: READ,
    },
    ({ docId }) => {
      const doc = store.get(store.resolveDocId(docId));
      const entries = Object.entries(doc.tokens);
      return entries.length
        ? entries.map(([k, v]) => `${k}: ${v}`).join('\n')
        : 'Nenhum token definido.';
    },
  );

  tool(
    'get_guide',
    {
      title: 'Guia de uso',
      description: `Guia curto em markdown, para ler antes de agir. Tópicos: ${GUIDE_TOPICS.join(', ')}. Comece por getting-started.`,
      example: { topic: 'getting-started' },
      inputSchema: {
        topic: z
          .enum(GUIDE_TOPICS)
          .describe(`Tópico do guia: ${GUIDE_TOPICS.join(', ')}. Ex.: "getting-started".`),
      },
      annotations: READ,
    },
    ({ topic }) => GUIDES[topic],
  );

  /* ---------- escrita ---------- */

  tool(
    'create_frame',
    {
      title: 'Criar frame',
      description:
        'Cria um frame raiz (artboard/breakpoint) com fundo branco. Sem x/y fica 100px à direita do último frame. Devolve o id e o resumo do frame.',
      example: { name: 'Desktop', width: 1440, height: 900 },
      inputSchema: {
        name: z.string().describe('Nome do frame, ex.: "Desktop", "Tablet", "Mobile".'),
        width: z.number().positive().describe('Largura em px, ex.: 1440.'),
        height: z.number().positive().describe('Altura em px, ex.: 900.'),
        pageId: z
          .string()
          .optional()
          .describe('Id da página, ex.: "pg_ab12cd34" (padrão: primeira).'),
        x: z
          .number()
          .optional()
          .describe('Posição X no canvas em px, ex.: 1540 (padrão: à direita do último frame).'),
        y: z
          .number()
          .optional()
          .describe('Posição Y no canvas em px, ex.: 0 (padrão: alinhado ao último frame).'),
        styles: stylesField.optional(),
        docId: docIdField,
      },
      annotations: WRITE,
    },
    ({ name, width, height, pageId, x, y, styles, docId }) => {
      const id = store.resolveDocId(docId);
      const doc = store.get(id);
      const page = pageId ? requirePage(doc, pageId) : doc.pages[0]!;
      const targetPageId = page.id;
      const last = page.frames[page.frames.length - 1];
      const px = x ?? (last ? (last.position?.x ?? 0) + pxOf(last.style['width']) + 100 : 0);
      const py = y ?? (last ? (last.position?.y ?? 0) : 0);
      const frame = createNodeFromTag('div', {
        isRoot: true,
        name,
        styles: {
          width: `${width}px`,
          height: `${height}px`,
          background: '#ffffff',
          ...(styles ?? {}),
        },
        position: { x: px, y: py },
      });
      const r = apply(
        id,
        [{ type: 'createNode', parentId: null, pageId: targetPageId, node: frame }],
        'create_frame',
      );
      return `Frame criado: ${frame.id} "${name}" ${width}x${height} em ${px},${py}.\n${summaryOf(r.doc, [frame.id])}`;
    },
  );

  tool(
    'write_html',
    {
      title: 'Escrever HTML',
      description:
        'Cria nós a partir de HTML + CSS (a forma preferida de montar telas). mode: append (padrão), replace-children ou replace. Sem parentId usa o nó selecionado ou o primeiro frame. Devolve os ids criados.',
      example: {
        parentId: 'fr_ab12cd34',
        html: '<section class="hero"><h1>Olá</h1><p>Texto</p></section>',
        css: '.hero{display:flex;flex-direction:column;gap:16px;padding:48px}',
      },
      inputSchema: {
        html: z
          .string()
          .describe(
            'Marcação HTML a inserir, ex.: "<section class=\\"hero\\"><h1>Olá</h1></section>".',
          ),
        mode: z
          .enum(['append', 'replace', 'replace-children'])
          .optional()
          .describe('"append" (padrão, ao final dos filhos), "replace-children" ou "replace".'),
        parentId: z
          .string()
          .optional()
          .describe(
            'Id do nó alvo, ex.: "fr_ab12cd34" (pai; ou o nó substituído em mode replace). Padrão: seleção ou primeiro frame.',
          ),
        css: z
          .string()
          .optional()
          .describe('CSS com os seletores usados no HTML, ex.: ".hero{display:flex}".'),
        docId: docIdField,
      },
      annotations: DESTRUCTIVE,
    },
    ({ html, mode, parentId, css, docId }) => {
      const id = store.resolveDocId(docId);
      const doc = store.get(id);
      const m = mode ?? 'append';
      const targetId = parentId ?? selectedOrFirstFrame(id, doc);
      const target = requireNode(doc, targetId);
      const nodes = htmlToNodes(html, { css });
      if (!nodes.length)
        throw new ToolError('O HTML não gerou nenhum nó. Ex.: "<div><h1>Título</h1></div>".');
      const ops: Op[] = [];
      let summaryParent = targetId;
      if (m === 'replace') {
        const parent = target.parent;
        if (!parent) {
          if (nodes.length !== 1) {
            throw new ToolError(
              'mode "replace" em frame raiz exige um único elemento de topo; envolva o conteúdo em um <div> ou use mode "replace-children".',
            );
          }
          const nn = nodes[0]!;
          const old = target.node;
          nn.type = 'frame';
          if (old.position) nn.position = { ...old.position };
          for (const k of ['width', 'height'] as const) {
            if (!nn.style[k] && old.style[k]) nn.style[k] = old.style[k]!;
          }
          const generic = nn.tag.charAt(0).toUpperCase() + nn.tag.slice(1);
          if (nn.name === generic) nn.name = old.name;
        }
        ops.push({ type: 'deleteNodes', nodeIds: [targetId] });
        nodes.forEach((node, i) => {
          ops.push(
            parent
              ? { type: 'createNode', parentId: parent.id, node, index: target.index + i }
              : {
                  type: 'createNode',
                  parentId: null,
                  pageId: target.page.id,
                  node,
                  index: target.index + i,
                },
          );
        });
        summaryParent = parent?.id ?? '';
      } else {
        if (m === 'replace-children' && target.node.children.length) {
          ops.push({ type: 'deleteNodes', nodeIds: target.node.children.map((c) => c.id) });
        }
        for (const node of nodes) ops.push({ type: 'createNode', parentId: targetId, node });
      }
      const r = apply(id, ops, 'write_html');
      const created = nodes.map((n) => n.id);
      return `HTML aplicado (${m}). Nós criados: ${created.join(', ')}.\n${summaryParent ? summaryOf(r.doc, [summaryParent]) : summaryOf(r.doc, created)}`;
    },
  );

  tool(
    'create_node',
    {
      title: 'Criar nó',
      description:
        'Cria um único nó filho (para vários elementos prefira write_html). Devolve o id do nó e o resumo do pai.',
      example: {
        parentId: 'fr_ab12cd34',
        tag: 'button',
        text: 'Enviar',
        styles: { padding: '12px 24px' },
      },
      inputSchema: {
        parentId: z.string().describe('Id do pai, ex.: "fr_ab12cd34".'),
        tag: z.string().describe('Tag HTML, ex.: "div", "h1", "p", "button", "img".'),
        styles: stylesField.optional(),
        text: z.string().optional().describe('Texto do nó, ex.: "Enviar".'),
        index: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe('Posição entre os filhos, ex.: 0 (padrão: final).'),
        name: z.string().optional().describe('Nome da camada, ex.: "Botão CTA".'),
        docId: docIdField,
      },
      annotations: WRITE,
    },
    ({ parentId, tag, styles, text, index, name, docId }) => {
      const id = store.resolveDocId(docId);
      requireNode(store.get(id), parentId);
      const node = createNodeFromTag(tag, { name, styles, text });
      const r = apply(id, [{ type: 'createNode', parentId, node, index }], 'create_node');
      return `Nó criado: ${node.id} <${tag}> em ${parentId}.\n${summaryOf(r.doc, [parentId])}`;
    },
  );

  tool(
    'update_styles',
    {
      title: 'Atualizar estilos',
      description:
        'Define e/ou remove propriedades CSS em vários nós. Informe styles e/ou unset; valor "" em styles também remove. Devolve o resumo dos nós.',
      example: { nodeIds: ['el_ab12cd34'], styles: { gap: '24px' }, unset: ['margin'] },
      inputSchema: {
        nodeIds: nodeIdsField,
        styles: stylesField
          .optional()
          .describe(
            'Propriedades CSS a definir, ex.: { "gap": "24px", "color": "#0f172a" }; valor "" remove a propriedade.',
          ),
        unset: z
          .array(z.string())
          .optional()
          .describe('Propriedades CSS a remover, ex.: ["margin", "box-shadow"].'),
        docId: docIdField,
      },
      annotations: WRITE,
    },
    ({ nodeIds, styles, unset, docId }) => {
      const id = store.resolveDocId(docId);
      requireNodes(store.get(id), nodeIds);
      if (!styles && !unset?.length) {
        throw new ToolError('Informe styles e/ou unset. Ex.: styles { "color": "#333" }.');
      }
      const r = apply(
        id,
        [
          {
            type: 'updateStyles',
            nodeIds,
            styles,
            unset,
          },
        ],
        'update_styles',
      );
      return `Estilos atualizados em ${nodeIds.length} nó(s).\n${summaryOf(r.doc, nodeIds)}`;
    },
  );

  tool(
    'set_text',
    {
      title: 'Definir texto',
      description:
        'Altera o texto de nós. Use content (o mesmo texto em todos) OU contents (um por nó, na ordem de nodeIds).',
      example: { nodeIds: ['tx_a1b2c3d4'], content: 'Olá, mundo' },
      inputSchema: {
        nodeIds: nodeIdsField,
        content: z
          .string()
          .optional()
          .describe('Texto único aplicado a todos os nós, ex.: "Comprar agora".'),
        contents: z
          .array(z.string())
          .optional()
          .describe('Um texto por nó, na ordem de nodeIds, ex.: ["Olá", "Mundo"].'),
        docId: docIdField,
      },
      annotations: WRITE,
    },
    ({ nodeIds, content, contents, docId }) => {
      const id = store.resolveDocId(docId);
      requireNodes(store.get(id), nodeIds);
      let texts: string[];
      if (contents) {
        if (contents.length !== nodeIds.length) {
          throw new ToolError(
            `contents tem ${contents.length} item(ns) e nodeIds ${nodeIds.length}; devem ter o mesmo tamanho.`,
          );
        }
        texts = contents;
      } else if (content !== undefined) {
        texts = nodeIds.map(() => content);
      } else {
        throw new ToolError('Informe content ou contents. Ex.: content "Olá".');
      }
      const r = apply(
        id,
        [{ type: 'setText', changes: nodeIds.map((nodeId, i) => ({ nodeId, text: texts[i]! })) }],
        'set_text',
      );
      return `Texto atualizado em ${nodeIds.length} nó(s).\n${summaryOf(r.doc, nodeIds)}`;
    },
  );

  tool(
    'set_attrs',
    {
      title: 'Definir atributos',
      description:
        'Define e/ou remove atributos HTML (href, alt, title...) de vários nós. Informe attrs e/ou unset. Em nó svg os atributos vão para o <svg> raiz (ex.: height, width, viewBox, fill).',
      example: { nodeIds: ['el_ab12cd34'], attrs: { href: '/contato' } },
      inputSchema: {
        nodeIds: nodeIdsField,
        attrs: z
          .record(z.string(), z.string())
          .optional()
          .describe('Atributos HTML a definir, ex.: { "href": "/contato", "alt": "Logo" }.'),
        unset: z.array(z.string()).optional().describe('Atributos a remover, ex.: ["title"].'),
        docId: docIdField,
      },
      annotations: WRITE,
    },
    ({ nodeIds, attrs, unset, docId }) => {
      const id = store.resolveDocId(docId);
      requireNodes(store.get(id), nodeIds);
      if (!attrs && !unset?.length)
        throw new ToolError('Informe attrs e/ou unset. Ex.: attrs { "alt": "Logo" }.');
      const r = apply(
        id,
        [{ type: 'setAttrs', changes: nodeIds.map((nodeId) => ({ nodeId, set: attrs, unset })) }],
        'set_attrs',
      );
      return `Atributos atualizados em ${nodeIds.length} nó(s).\n${summaryOf(r.doc, nodeIds)}`;
    },
  );

  tool(
    'set_tag',
    {
      title: 'Trocar tag HTML',
      description:
        'Troca a tag HTML dos nós (ex.: div para section). Tags bloqueadas (script, style, iframe...) e trocas inválidas são recusadas.',
      example: { nodeIds: ['el_ab12cd34'], tag: 'section' },
      inputSchema: {
        nodeIds: nodeIdsField,
        tag: z.string().describe('Nova tag HTML, ex.: "section", "h2", "button".'),
        docId: docIdField,
      },
      annotations: WRITE,
    },
    ({ nodeIds, tag, docId }) => {
      const id = store.resolveDocId(docId);
      requireNodes(store.get(id), nodeIds);
      const r = apply(
        id,
        [{ type: 'setTag', changes: nodeIds.map((nodeId) => ({ nodeId, tag })) }],
        'set_tag',
      );
      return `Tag alterada em ${nodeIds.length} nó(s).
${summaryOf(r.doc, nodeIds)}`;
    },
  );

  tool(
    'rename_nodes',
    {
      title: 'Renomear nós',
      description:
        'Renomeia camadas; names é pareado com nodeIds (mesmo tamanho). Os nomes aparecem no editor e nos arquivos exportados.',
      example: { nodeIds: ['fr_ab12cd34'], names: ['Tablet'] },
      inputSchema: {
        nodeIds: nodeIdsField,
        names: z
          .array(z.string())
          .describe('Novos nomes, na ordem de nodeIds, ex.: ["Cabeçalho"].'),
        docId: docIdField,
      },
      annotations: WRITE,
    },
    ({ nodeIds, names, docId }) => {
      const id = store.resolveDocId(docId);
      requireNodes(store.get(id), nodeIds);
      if (names.length !== nodeIds.length) {
        throw new ToolError(
          `names tem ${names.length} item(ns) e nodeIds ${nodeIds.length}; devem ter o mesmo tamanho.`,
        );
      }
      const r = apply(
        id,
        [
          {
            type: 'renameNodes',
            changes: nodeIds.map((nodeId, i) => ({ nodeId, name: names[i]! })),
          },
        ],
        'rename_nodes',
      );
      return `${nodeIds.length} nó(s) renomeado(s).\n${summaryOf(r.doc, nodeIds)}`;
    },
  );

  tool(
    'move_nodes',
    {
      title: 'Mover nós',
      description:
        'Move nós para outro pai e/ou índice. Sem parentId só reordena; parentId null leva à raiz da página (vira frame).',
      example: { nodeIds: ['el_ab12cd34'], parentId: 'fr_ab12cd34', index: 0 },
      inputSchema: {
        nodeIds: nodeIdsField,
        parentId: z
          .string()
          .nullable()
          .optional()
          .describe(
            'Id do novo pai, ex.: "el_ab12cd34" (padrão: mantém o atual). null = raiz da página (vira frame).',
          ),
        pageId: z
          .string()
          .optional()
          .describe(
            'Id da página de destino quando parentId é null, ex.: "pg_ab12cd34" (padrão: página do primeiro nó).',
          ),
        index: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe('Índice no pai de destino, ex.: 0 (padrão: final).'),
        docId: docIdField,
      },
      annotations: WRITE,
    },
    ({ nodeIds, parentId, pageId, index, docId }) => {
      const id = store.resolveDocId(docId);
      const doc = store.get(id);
      const paths = requireNodes(doc, nodeIds);
      if (parentId === null) {
        const page = requirePage(doc, pageId ?? paths[0]!.page.id);
        const ops: Op[] = [{ type: 'moveNodes', nodeIds, parentId: null, pageId: page.id, index }];
        const moving = new Set(nodeIds);
        const others = page.frames.filter((f) => !moving.has(f.id));
        const last = others[others.length - 1];
        let nextX = last ? (last.position?.x ?? 0) + pxOf(last.style['width']) + 100 : 0;
        const y = last?.position?.y ?? 0;
        const changes: { nodeId: string; position: { x: number; y: number } }[] = [];
        for (const p of paths) {
          if (p.node.position) continue;
          changes.push({ nodeId: p.node.id, position: { x: nextX, y } });
          nextX += pxOf(p.node.style['width']) + 100;
        }
        if (changes.length) ops.push({ type: 'setPosition', changes });
        const r = apply(id, ops, 'move_nodes');
        return `${nodeIds.length} nó(s) movido(s) para a raiz da página ${page.id}.\n${summaryOf(r.doc, nodeIds)}`;
      }
      if (parentId) requireNode(doc, parentId);
      const r = apply(id, [{ type: 'moveNodes', nodeIds, parentId, index }], 'move_nodes');
      const target = parentId ? [parentId] : fallbackFor(doc, nodeIds);
      return `${nodeIds.length} nó(s) movido(s).\n${summaryOf(r.doc, target, nodeIds)}`;
    },
  );

  tool(
    'duplicate_nodes',
    {
      title: 'Duplicar nós',
      description:
        'Duplica nós com seus descendentes. Devolve o mapa de ids antigos para novos. Para criar breakpoints, duplique o frame.',
      example: { nodeIds: ['fr_ab12cd34'] },
      inputSchema: { nodeIds: nodeIdsField, docId: docIdField },
      annotations: WRITE,
    },
    ({ nodeIds, docId }) => {
      const id = store.resolveDocId(docId);
      requireNodes(store.get(id), nodeIds);
      const r = apply(id, [{ type: 'duplicateNodes', nodeIds }], 'duplicate_nodes');
      const op = r.appliedOps.find((o) => o.type === 'duplicateNodes');
      const fromOp = op && op.type === 'duplicateNodes' ? op.idMap : undefined;
      const fromResult = r.results[0]?.['idMap'] as Record<string, string> | undefined;
      const idMap = fromOp ?? fromResult ?? {};
      const pairs = nodeIds.filter((o) => idMap[o]).map((o) => `${o} -> ${idMap[o]}`);
      const newIds = nodeIds.map((o) => idMap[o]).filter((x): x is string => !!x);
      return `Duplicado: ${pairs.join(', ') || '(mapa indisponível)'}.\n${summaryOf(r.doc, newIds)}`;
    },
  );

  tool(
    'delete_nodes',
    {
      title: 'Excluir nós',
      description: 'Remove nós e seus descendentes (reversível com undo).',
      example: { nodeIds: ['el_ab12cd34'] },
      inputSchema: { nodeIds: nodeIdsField, docId: docIdField },
      annotations: DESTRUCTIVE,
    },
    ({ nodeIds, docId }) => {
      const id = store.resolveDocId(docId);
      const doc = store.get(id);
      requireNodes(doc, nodeIds);
      const parents = fallbackFor(doc, nodeIds).filter((p) => !nodeIds.includes(p));
      const r = apply(id, [{ type: 'deleteNodes', nodeIds }], 'delete_nodes');
      store.setSelection(
        id,
        store.getSelection(id).filter((s) => !nodeIds.includes(s)),
        'mcp',
      );
      return `${nodeIds.length} nó(s) removido(s).\n${summaryOf(r.doc, parents)}`;
    },
  );

  tool(
    'set_position',
    {
      title: 'Definir posição',
      description:
        'Define x/y no canvas de um frame raiz ou de um filho com position absolute. Use para dispor frames lado a lado.',
      example: { nodeId: 'fr_ab12cd34', x: 1540, y: 0 },
      inputSchema: {
        nodeId: z.string().describe('Id do frame ou filho absoluto, ex.: "fr_ab12cd34".'),
        x: z.number().describe('Posição X em px, ex.: 1540.'),
        y: z.number().describe('Posição Y em px, ex.: 0.'),
        docId: docIdField,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    ({ nodeId, x, y, docId }) => {
      const id = store.resolveDocId(docId);
      requireNode(store.get(id), nodeId);
      const r = apply(
        id,
        [{ type: 'setPosition', changes: [{ nodeId, position: { x, y } }] }],
        'set_position',
      );
      return `Posição de ${nodeId} = ${x},${y}.\n${summaryOf(r.doc, [nodeId])}`;
    },
  );

  tool(
    'create_page',
    {
      title: 'Criar página',
      description:
        'Cria uma nova página (conjunto de frames) no documento. Devolve o id da página.',
      example: { name: 'Mobile' },
      inputSchema: {
        name: z.string().describe('Nome da página, ex.: "Mobile".'),
        docId: docIdField,
      },
      annotations: WRITE,
    },
    ({ name, docId }) => {
      const id = store.resolveDocId(docId);
      const pageId = newPageId();
      const r = apply(id, [{ type: 'createPage', pageId, name }], 'create_page');
      return `Página criada: ${pageId} "${name}".\n${getDocumentSummary(r.doc, 1)}`;
    },
  );

  tool(
    'rename_page',
    {
      title: 'Renomear página',
      description: 'Renomeia uma página existente (ids em get_basic_info).',
      example: { pageId: 'pg_ab12cd34', name: 'Mobile' },
      inputSchema: {
        pageId: z.string().describe('Id da página (veja get_basic_info), ex.: "pg_ab12cd34".'),
        name: z.string().describe('Novo nome da página, ex.: "Mobile".'),
        docId: docIdField,
      },
      annotations: WRITE,
    },
    ({ pageId, name, docId }) => {
      const id = store.resolveDocId(docId);
      requirePage(store.get(id), pageId);
      const r = apply(id, [{ type: 'renamePage', pageId, name }], 'rename_page');
      return `Página ${pageId} renomeada para "${name}".\n${getDocumentSummary(r.doc, 1)}`;
    },
  );

  tool(
    'delete_page',
    {
      title: 'Excluir página',
      description:
        'Remove uma página e seus frames (reversível com undo). A última página não pode ser excluída.',
      example: { pageId: 'pg_ab12cd34' },
      inputSchema: {
        pageId: z.string().describe('Id da página (veja get_basic_info), ex.: "pg_ab12cd34".'),
        docId: docIdField,
      },
      annotations: DESTRUCTIVE,
    },
    ({ pageId, docId }) => {
      const id = store.resolveDocId(docId);
      requirePage(store.get(id), pageId);
      const r = apply(id, [{ type: 'deletePage', pageId }], 'delete_page');
      return `Página ${pageId} removida.\n${getDocumentSummary(r.doc, 1)}`;
    },
  );

  tool(
    'set_node_flags',
    {
      title: 'Ocultar/bloquear nós',
      description:
        'Oculta/exibe (hidden) e/ou bloqueia/desbloqueia (locked) nós no editor. Informe ao menos um dos dois.',
      example: { nodeIds: ['el_ab12cd34'], hidden: true },
      inputSchema: {
        nodeIds: nodeIdsField,
        hidden: z.boolean().optional().describe('true oculta o nó; false o exibe.'),
        locked: z.boolean().optional().describe('true bloqueia o nó no editor; false desbloqueia.'),
        docId: docIdField,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    ({ nodeIds, hidden, locked, docId }) => {
      const id = store.resolveDocId(docId);
      requireNodes(store.get(id), nodeIds);
      if (hidden === undefined && locked === undefined) {
        throw new ToolError('Informe hidden e/ou locked. Ex.: hidden true.');
      }
      const r = apply(
        id,
        [{ type: 'setNodeFlags', changes: nodeIds.map((nodeId) => ({ nodeId, hidden, locked })) }],
        'set_node_flags',
      );
      return `Flags atualizadas em ${nodeIds.length} nó(s).\n${summaryOf(r.doc, nodeIds)}`;
    },
  );

  tool(
    'set_tokens',
    {
      title: 'Definir tokens',
      description:
        'Define/atualiza e/ou remove tokens (variáveis CSS do documento); nomes sem "--" ganham o prefixo. Devolve todos os tokens. Use depois como var(--nome).',
      example: { tokens: { '--color-primary': '#2563eb', '--space-4': '16px' } },
      inputSchema: {
        tokens: z
          .record(z.string(), z.string())
          .describe(
            'Tokens a definir; o prefixo "--" é acrescentado se faltar ("primary" vira "--primary").',
          ),
        unset: z.array(z.string()).optional().describe('Tokens a remover, ex.: ["--old-color"].'),
        docId: docIdField,
      },
      annotations: WRITE,
    },
    ({ tokens, unset, docId }) => {
      const id = store.resolveDocId(docId);
      const prefix = (k: string): string => (k.startsWith('--') ? k : `--${k}`);
      const norm = Object.fromEntries(Object.entries(tokens).map(([k, v]) => [prefix(k), v]));
      const normUnset = unset?.map(prefix);
      const r = apply(id, [{ type: 'setTokens', set: norm, unset: normUnset }], 'set_tokens');
      const entries = Object.entries(r.doc.tokens);
      return `Tokens atualizados (${entries.length} no total).\n${entries.map(([k, v]) => `${k}: ${v}`).join('\n')}`;
    },
  );

  for (const kind of ['undo', 'redo'] as const) {
    tool(
      kind,
      {
        title: kind === 'undo' ? 'Desfazer' : 'Refazer',
        description:
          kind === 'undo'
            ? 'Desfaz a última alteração do documento (inclusive as feitas pelo usuário). Devolve o resumo.'
            : 'Refaz a última alteração desfeita. Devolve o resumo.',
        example: {},
        inputSchema: { docId: docIdField },
        annotations: WRITE,
      },
      ({ docId }) => {
        const id = store.resolveDocId(docId);
        const r = kind === 'undo' ? store.undo(id, 'mcp') : store.redo(id, 'mcp');
        if (!r) return kind === 'undo' ? 'Nada para desfazer.' : 'Nada para refazer.';
        return `${kind === 'undo' ? 'Desfeito' : 'Refeito'}. Revisão ${r.revision}.\n${getDocumentSummary(r.doc, 1)}`;
      },
    );
  }

  tool(
    'finish_working',
    {
      title: 'Terminei de editar',
      description:
        'Chame ao terminar as edições (depois de conferir com get_screenshot): limpa o indicador "IA" nos nós no editor. Sem nodeIds vale para o documento.',
      example: {},
      inputSchema: {
        nodeIds: z
          .array(z.string())
          .optional()
          .describe('Ids dos nós concluídos, ex.: ["fr_ab12cd34"] (padrão: todos).'),
        docId: docIdField,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    ({ nodeIds, docId }) => {
      const id = store.resolveDocId(docId);
      store.finishWorking(id, nodeIds ?? []);
      return nodeIds?.length
        ? `Edição concluída em ${nodeIds.length} nó(s).`
        : 'Edição concluída no documento.';
    },
  );

  /* ---------- render, exportação, imagens, ícones e fontes ---------- */

  const ctx: ToolContext = {
    server,
    store,
    opts,
    tool,
    requireNode,
    summaryOf,
    apply,
    selectedOrFirstFrame,
  };
  registerRenderTools(ctx);
  registerExportTools(ctx);
  registerImageTools(ctx);
  registerFontTools(ctx);
  registerSnapshotTools(ctx);

  /* ---------- resources ---------- */

  for (const topic of GUIDE_TOPICS) {
    server.registerResource(
      `guide-${topic}`,
      `guide://${topic}`,
      {
        title: GUIDE_INFO[topic].title,
        description: GUIDE_INFO[topic].description,
        mimeType: 'text/markdown',
      },
      async (uri) => ({
        contents: [{ uri: uri.href, mimeType: 'text/markdown', text: GUIDES[topic] }],
      }),
    );
  }

  return server;
}
