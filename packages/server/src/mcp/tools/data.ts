import { z } from 'zod';
import { MAX_DATA_ITEMS, findNode, type Document } from '@mockup/core';
import {
  DataSourceError,
  bindOps,
  dataReport,
  loadData,
  reloadSource,
  type DataReport,
} from '../../datasource.js';
import { READ, ToolError, WRITE, docIdField, type ToolContext } from '../context.js';
import { registerImageEditTools } from './imageEdit.js';
import { docWithNodes } from '../../component-view.js';

/** Converte erros de dados em `ToolError` (mensagem já em português). */
async function asToolError<T>(fn: () => Promise<T> | T): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof DataSourceError) throw new ToolError(e.message);
    throw e;
  }
}

function describeSource(r: DataReport): string {
  const s = r.source;
  const origin =
    s.kind === 'inline'
      ? 'dados colados/editados'
      : s.kind === 'url'
        ? `URL ${s.url}`
        : `arquivo ${s.path}`;
  const extra = [
    s.select ? `select "${s.select}"` : '',
    s.limit ? `limit ${s.limit}` : '',
    s.mapping ? `mapping ${JSON.stringify(s.mapping)}` : '',
    s.fetchedAt ? `lido em ${s.fetchedAt}` : '',
  ].filter(Boolean);
  return `Origem: ${origin}${extra.length ? ` (${extra.join('; ')})` : ''}.`;
}

function reportText(r: DataReport): string {
  const lines = [
    `Repetidor ${r.nodeId}: ${r.count} item(ns).`,
    `Colunas: ${r.columns.join(', ') || '(nenhuma)'}.`,
    `Campos do template: ${r.templateFields.length ? r.templateFields.join(', ') : '(nenhum; use {{campo}} nos textos, src e atributos)'}.`,
    describeSource(r),
  ];
  for (const w of r.warnings) lines.push(`Aviso: ${w}`);
  return lines.join('\n');
}

const cell = (v: unknown): string => {
  const s =
    v === undefined || v === null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v);
  const one = s.replace(/\s+/g, ' ').replace(/\|/g, '/');
  return one.length > 40 ? `${one.slice(0, 39)}…` : one;
};

function tableOf(data: unknown[], columns: string[], limit: number): string {
  const rows = data.slice(0, limit);
  const head = ['#', ...columns];
  const body = rows.map((item, i) => [
    String(i),
    ...columns.map((c) =>
      c === '$item'
        ? cell(item)
        : cell(item && typeof item === 'object' ? (item as Record<string, unknown>)[c] : undefined),
    ),
  ]);
  return [head, ...body].map((r) => `| ${r.join(' | ')} |`).join('\n');
}

export function registerDataTools(ctx: ToolContext): void {
  const { tool, store, requireNode, apply, summaryOf } = ctx;

  const repeaterOf = (doc: Document, nodeId: string): void => {
    const p = requireNode(doc, nodeId);
    if (p.node.type !== 'repeater') {
      throw new ToolError(
        `O nó ${nodeId} não é um repetidor. Use bind_data(nodeId, ...) num contêiner com o template ({{campo}}) para ligar dados.`,
      );
    }
  };

  tool(
    'bind_data',
    {
      title: 'Ligar dados a um contêiner (repetidor)',
      description:
        'Repete o conteúdo de um contêiner por item de dados (JSON, CSV, URL ou lista). Fluxo: escreva UM item com write_html usando {{campo}} em textos/src/atributos e chame bind_data no contêiner (não frame raiz). Ele vira repetidor (id novo). Veja get_guide("data").',
      example: {
        nodeId: 'el_ab12cd34',
        path: 'C:/dados/produtos.csv',
        mapping: { nome: 'title' },
        limit: 12,
      },
      inputSchema: {
        nodeId: z
          .string()
          .describe('Id do contêiner com o template (ou de um repetidor), ex.: "el_ab12cd34".'),
        data: z
          .array(z.unknown())
          .optional()
          .describe('Lista de itens direto, ex.: [{ "nome": "Ana", "foto": "https://..." }].'),
        path: z
          .string()
          .optional()
          .describe(
            'Caminho absoluto de arquivo .json/.csv/.tsv, ex.: "C:/dados/produtos.csv". Pastas e arquivos ocultos (".ssh", ".claude"...) são recusados.',
          ),
        url: z
          .string()
          .optional()
          .describe(
            'URL http(s) que devolve JSON ou CSV, ex.: "https://api.exemplo.com/produtos".',
          ),
        text: z
          .string()
          .optional()
          .describe(
            'JSON ou CSV colado como texto (informe também format). Use exatamente uma origem entre data, text, path e url.',
          ),
        format: z
          .enum(['json', 'csv'])
          .optional()
          .describe(
            'Formato de text/url/path: "json" ou "csv" (padrão: pela extensão, content-type ou conteúdo).',
          ),
        select: z
          .string()
          .optional()
          .describe('Caminho da lista dentro do JSON, ex.: "data.items" (padrão: acha a lista).'),
        mapping: z
          .record(z.string(), z.string())
          .optional()
          .describe('Campo do template -> caminho no item, ex.: { "nome": "user.fullName" }.'),
        limit: z
          .number()
          .int()
          .min(1)
          .max(MAX_DATA_ITEMS)
          .optional()
          .describe(`Máximo de itens lidos, de 1 a ${MAX_DATA_ITEMS}, ex.: 12.`),
        docId: docIdField,
      },
      annotations: WRITE,
    },
    async ({ nodeId, data, path, url, text, format, select, mapping, limit, docId }) => {
      const id = store.resolveDocId(docId);
      requireNode(store.get(id), nodeId);
      const bound = await asToolError(async () => {
        const loaded = await loadData({
          ...(data !== undefined ? { data } : {}),
          ...(path !== undefined ? { path } : {}),
          ...(url !== undefined ? { url } : {}),
          ...(text !== undefined ? { text } : {}),
          ...(format ? { format } : {}),
          ...(select ? { select } : {}),
          ...(mapping ? { mapping } : {}),
          ...(limit ? { limit } : {}),
        });
        return bindOps(docWithNodes(store.get(id), [nodeId]), nodeId, loaded);
      });
      const out = apply(id, bound.ops, 'bind_data');
      const rep = dataReport(docWithNodes(out.doc, [bound.nodeId]), bound.nodeId);
      const head = bound.converted
        ? `Contêiner ${nodeId} convertido em repetidor ${rep.nodeId} (os filhos viraram o template).`
        : `Dados do repetidor ${rep.nodeId} atualizados.`;
      return `${head}\n${reportText(rep)}\n${summaryOf(out.doc, [rep.nodeId])}`;
    },
  );

  tool(
    'refresh_data',
    {
      title: 'Atualizar os dados de um repetidor',
      description:
        'Relê o arquivo (path) ou a URL de onde os dados do repetidor vieram e atualiza os itens, mantendo select, mapping e limit. Erro se os dados foram colados/editados (inline): use bind_data de novo.',
      example: { nodeId: 'rp_ab12cd34' },
      inputSchema: {
        nodeId: z.string().describe('Id do repetidor, ex.: "rp_ab12cd34".'),
        docId: docIdField,
      },
      annotations: WRITE,
    },
    async ({ nodeId, docId }) => {
      const id = store.resolveDocId(docId);
      repeaterOf(store.get(id), nodeId);
      const bound = await asToolError(async () => {
        const rep = dataReport(docWithNodes(store.get(id), [nodeId]), nodeId);
        const loaded = await reloadSource(rep.source);
        return bindOps(docWithNodes(store.get(id), [nodeId]), nodeId, loaded);
      });
      const out = apply(id, bound.ops, 'refresh_data');
      const rep = dataReport(docWithNodes(out.doc, [nodeId]), nodeId);
      return `Dados atualizados.\n${reportText(rep)}\n${summaryOf(out.doc, [nodeId])}`;
    },
  );

  tool(
    'get_data',
    {
      title: 'Ver os dados de um repetidor',
      description:
        'Mostra a origem, as colunas, os campos usados pelo template ({{campo}}) e as primeiras linhas dos dados de um repetidor como tabela compacta.',
      example: { nodeId: 'rp_ab12cd34', limit: 10 },
      inputSchema: {
        nodeId: z.string().describe('Id do repetidor, ex.: "rp_ab12cd34".'),
        limit: z
          .number()
          .int()
          .min(1)
          .max(MAX_DATA_ITEMS)
          .optional()
          .describe('Quantas linhas mostrar, ex.: 10 (padrão 20).'),
        docId: docIdField,
      },
      annotations: READ,
    },
    async ({ nodeId, limit, docId }) => {
      const doc = docWithNodes(store.get(store.resolveDocId(docId)), [nodeId]);
      repeaterOf(doc, nodeId);
      const rep = await asToolError(() => dataReport(doc, nodeId));
      const data = (findNode(doc, nodeId)?.node.data ?? []) as unknown[];
      const n = limit ?? 20;
      const shown = Math.min(n, data.length);
      return `${reportText(rep)}\n\nPrimeiras ${shown} de ${data.length} linha(s):\n${tableOf(data, rep.columns, n)}`;
    },
  );

  registerImageEditTools(ctx);
}
