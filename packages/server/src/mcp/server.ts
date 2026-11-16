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
import type { RenderProvider } from '../render.js';
import type { DocumentStore } from '../store.js';
import { GUIDES, GUIDE_TOPICS, type GuideTopic } from './guides.js';

type Annotations = { readOnlyHint?: boolean; destructiveHint?: boolean; idempotentHint?: boolean };

const READ: Annotations = { readOnlyHint: true };
const WRITE: Annotations = { readOnlyHint: false, destructiveHint: false };
const DESTRUCTIVE: Annotations = { readOnlyHint: false, destructiveHint: true };

const docIdField = z.string().optional().describe('Id do documento (padrão: documento ativo).');
const nodeIdsField = z
  .array(z.string())
  .min(1)
  .describe('Ids dos nós, ex.: ["el_ab12cd34", "tx_9f8e7d6c"].');
const stylesField = z
  .record(z.string(), z.string())
  .describe('Propriedades CSS, ex.: { "display": "flex", "gap": "16px", "background": "#fff" }.');

class ToolError extends Error {}

function pxOf(v: string | undefined): number {
  const n = v ? parseFloat(v) : NaN;
  return Number.isFinite(n) ? n : 0;
}

export interface McpServerOptions {
  /** Motor de render (Electron). Ausente: ferramentas de screenshot informam que não há render. */
  render?: RenderProvider;
  dataDir?: string;
}

export function createMcpServer(store: DocumentStore, _opts: McpServerOptions = {}): McpServer {
  const server = new McpServer({ name: 'mockup-studio', version: '0.1.0' });

  /* ---------- helpers ---------- */

  function tool<S extends z.ZodRawShape>(
    name: string,
    cfg: { title: string; description: string; inputSchema: S; annotations?: Annotations },
    handler: (args: z.infer<z.ZodObject<S>>) => Promise<string> | string,
  ): void {
    const cb = async (args: unknown) => {
      try {
        const text = await handler(args as z.infer<z.ZodObject<S>>);
        return { content: [{ type: 'text' as const, text }] };
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return { isError: true, content: [{ type: 'text' as const, text: `Erro: ${msg}` }] };
      }
    };
    server.registerTool(name, cfg, cb as never);
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
        'Visão geral do documento ativo: arquivo, páginas, frames (id, nome, tamanho, posição), documentos abertos e seleção.',
      inputSchema: { docId: docIdField },
      annotations: READ,
    },
    ({ docId }) => {
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
      description: 'Lista os documentos abertos no daemon.',
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
        'Abre um arquivo .mockup.json e o torna ativo. Ex.: "C:/projetos/site.mockup.json".',
      inputSchema: { path: z.string().describe('Caminho do arquivo .mockup.json.') },
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
        'Cria um novo documento e o abre. Ex.: path "C:/projetos/site", name "Site". Acrescenta .mockup.json se faltar extensão.',
      inputSchema: {
        path: z.string().describe('Caminho do novo arquivo.'),
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
      description: 'Força a gravação em disco (o salvamento automático já ocorre após alterações).',
      inputSchema: { docId: docIdField },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    async ({ docId }) => `Salvo em ${await store.save(docId)}.`,
  );

  tool(
    'close_document',
    {
      title: 'Fechar documento',
      description: 'Fecha um documento aberto (salvando alterações pendentes).',
      inputSchema: { docId: z.string().describe('Id do documento a fechar.') },
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
      description: 'Devolve os nós atualmente selecionados no editor.',
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
      description: 'Seleciona nós no editor. Lista vazia limpa a seleção.',
      inputSchema: {
        nodeIds: z.array(z.string()).describe('Ids dos nós, ex.: ["el_ab12cd34"].'),
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
        'Tipo, nome, tag, página, pai, atributos, estilos próprios, texto e ancestrais de um nó.',
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
      description: 'Uma linha por filho direto do nó.',
      inputSchema: { nodeId: z.string().describe('Id do nó pai.'), docId: docIdField },
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
        'Estrutura compacta. Sem nodeId, resume o documento ativo; com nodeId, a subárvore. Ex.: depth 2.',
      inputSchema: {
        nodeId: z.string().optional().describe('Id do nó raiz do resumo (opcional).'),
        depth: z.number().int().min(0).max(10).optional().describe('Profundidade (padrão 2).'),
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
        'Estilos efetivos (com tokens resolvidos) de um ou mais nós, no formato "prop: valor".',
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
        'HTML de um nó. mode "inline" (padrão) usa style inline; "classes" devolve html + <style>.',
      inputSchema: {
        nodeId: z.string().describe('Id do nó.'),
        mode: z.enum(['inline', 'classes']).optional().describe('Modo de estilo (padrão inline).'),
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
      description: 'Lista as variáveis CSS (tokens) do documento.',
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
      description: 'Guia curto em markdown. Tópicos: getting-started, layout, responsive, tokens.',
      inputSchema: {
        topic: z.enum(GUIDE_TOPICS).describe('Tópico do guia, ex.: "getting-started".'),
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
        'Cria um frame raiz (artboard/breakpoint). Ex.: name "Desktop", width 1440, height 900. Sem x/y, fica à direita do último frame.',
      inputSchema: {
        name: z.string().describe('Nome do frame, ex.: "Desktop".'),
        width: z.number().positive().describe('Largura em px, ex.: 1440.'),
        height: z.number().positive().describe('Altura em px, ex.: 900.'),
        pageId: z.string().optional().describe('Id da página (padrão: primeira).'),
        x: z.number().optional().describe('Posição X no canvas.'),
        y: z.number().optional().describe('Posição Y no canvas.'),
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
        'Cria nós a partir de HTML + CSS. Ex.: html "<section class=\\"hero\\"><h1>Olá</h1></section>", css ".hero{display:flex;gap:16px}". ' +
        'mode: append (padrão, ao final dos filhos), replace-children (troca os filhos do pai), replace (troca o próprio nó; em frame raiz exige um único elemento de topo, que vira o frame). ' +
        'Sem parentId usa o nó selecionado ou o primeiro frame.',
      inputSchema: {
        html: z.string().describe('Marcação HTML a inserir.'),
        mode: z
          .enum(['append', 'replace', 'replace-children'])
          .optional()
          .describe('Padrão: append.'),
        parentId: z
          .string()
          .optional()
          .describe('Nó alvo (pai, ou o nó substituído em mode replace).'),
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
        'Cria um nó filho. Ex.: parentId "fr_ab12cd34", tag "button", text "Enviar", styles { "padding": "12px" }.',
      inputSchema: {
        parentId: z.string().describe('Id do pai.'),
        tag: z.string().describe('Tag HTML, ex.: "div", "h1", "p", "button", "img".'),
        styles: stylesField.optional(),
        text: z.string().optional().describe('Texto do nó, ex.: "Enviar".'),
        index: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe('Posição entre os filhos (padrão: final).'),
        name: z.string().optional().describe('Nome da camada.'),
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
        'Altera estilos CSS de vários nós. Ex.: nodeIds ["el_x"], styles { "gap": "24px" }, unset ["margin"].',
      inputSchema: {
        nodeIds: nodeIdsField,
        styles: stylesField
          .optional()
          .describe('Propriedades CSS a definir; valor "" remove a propriedade.'),
        unset: z.array(z.string()).optional().describe('Propriedades a remover, ex.: ["margin"].'),
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
        'Altera o texto de nós. Use content (mesmo texto para todos) OU contents (lista pareada com nodeIds). Ex.: nodeIds ["tx_a","tx_b"], contents ["Olá","Mundo"].',
      inputSchema: {
        nodeIds: nodeIdsField,
        content: z.string().optional().describe('Texto único aplicado a todos os nós.'),
        contents: z
          .array(z.string())
          .optional()
          .describe('Um texto por nó, na mesma ordem de nodeIds.'),
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
        'Altera atributos HTML. Ex.: nodeIds ["el_x"], attrs { "href": "/contato" }, unset ["title"].',
      inputSchema: {
        nodeIds: nodeIdsField,
        attrs: z.record(z.string(), z.string()).optional().describe('Atributos a definir.'),
        unset: z.array(z.string()).optional().describe('Atributos a remover.'),
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
        'Troca a tag HTML dos nós (ex.: div para section, h1 para p). Tags bloqueadas (script, style, iframe...) são recusadas. Ex.: nodeIds ["el_x"], tag "section".',
      inputSchema: {
        nodeIds: nodeIdsField,
        tag: z.string().describe('Nova tag HTML, ex. "section", "h2", "button".'),
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
        'Renomeia camadas. names pareado com nodeIds. Ex.: nodeIds ["el_a"], names ["Cabeçalho"].',
      inputSchema: {
        nodeIds: nodeIdsField,
        names: z.array(z.string()).describe('Novos nomes, mesma ordem de nodeIds.'),
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
        'Move nós para outro pai e/ou índice. Sem parentId, apenas reordena no pai atual. parentId null move para a raiz da página (vira frame). Ex.: nodeIds ["el_a"], parentId "el_b", index 0.',
      inputSchema: {
        nodeIds: nodeIdsField,
        parentId: z
          .string()
          .nullable()
          .optional()
          .describe('Novo pai (padrão: mantém o atual). null = raiz da página (vira frame).'),
        pageId: z
          .string()
          .optional()
          .describe('Página de destino quando parentId é null (padrão: página do primeiro nó).'),
        index: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe('Índice no pai de destino (padrão: final).'),
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
        'Duplica nós (com descendentes). Devolve o mapa id antigo -> novo. Ex.: nodeIds ["fr_a"].',
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
      description: 'Remove nós e seus descendentes (reversível com undo). Ex.: nodeIds ["el_a"].',
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
        'Posição no canvas (frames raiz) ou x/y de filho absoluto. Ex.: nodeId "fr_a", x 1600, y 0.',
      inputSchema: {
        nodeId: z.string().describe('Id do nó.'),
        x: z.number().describe('Posição X.'),
        y: z.number().describe('Posição Y.'),
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
      description: 'Cria uma nova página. Ex.: name "Mobile".',
      inputSchema: { name: z.string().describe('Nome da página.'), docId: docIdField },
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
      description: 'Renomeia uma página. Ex.: pageId "pg_ab12cd34", name "Mobile".',
      inputSchema: {
        pageId: z.string().describe('Id da página (veja get_basic_info).'),
        name: z.string().describe('Novo nome da página.'),
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
        'Remove uma página e seus frames (reversível com undo). Não é possível excluir a última página.',
      inputSchema: {
        pageId: z.string().describe('Id da página (veja get_basic_info).'),
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
        'Define hidden (oculto) e/ou locked (bloqueado) em nós. Informe ao menos um. Ex.: nodeIds ["el_a"], hidden true.',
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
        'Define/remove variáveis CSS. Ex.: tokens { "--color-primary": "#6c5ce7" }, unset ["--old"].',
      inputSchema: {
        tokens: z.record(z.string(), z.string()).describe('Tokens a definir, com prefixo "--".'),
        unset: z.array(z.string()).optional().describe('Tokens a remover.'),
        docId: docIdField,
      },
      annotations: WRITE,
    },
    ({ tokens, unset, docId }) => {
      const id = store.resolveDocId(docId);
      const bad = Object.keys(tokens).filter((k) => !k.startsWith('--'));
      if (bad.length)
        throw new ToolError(
          `Nomes de token devem começar com "--": ${bad.join(', ')}. Ex.: "--color-primary".`,
        );
      const r = apply(id, [{ type: 'setTokens', set: tokens, unset }], 'set_tokens');
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
          kind === 'undo' ? 'Desfaz a última alteração.' : 'Refaz a última alteração desfeita.',
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

  /* ---------- resources ---------- */

  for (const topic of GUIDE_TOPICS) {
    server.registerResource(
      `guide-${topic}`,
      `guide://${topic}`,
      {
        title: `Guia: ${topic}`,
        description: `Guia do Mockup Studio (${topic}).`,
        mimeType: 'text/markdown',
      },
      async (uri) => ({
        contents: [{ uri: uri.href, mimeType: 'text/markdown', text: GUIDES[topic as GuideTopic] }],
      }),
    );
  }

  return server;
}
