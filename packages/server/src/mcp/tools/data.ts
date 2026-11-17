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

/** Converts data errors into `ToolError` (message already in English). */
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
      ? 'pasted/edited data'
      : s.kind === 'url'
        ? `URL ${s.url}`
        : `file ${s.path}`;
  const extra = [
    s.select ? `select "${s.select}"` : '',
    s.limit ? `limit ${s.limit}` : '',
    s.mapping ? `mapping ${JSON.stringify(s.mapping)}` : '',
    s.fetchedAt ? `read at ${s.fetchedAt}` : '',
  ].filter(Boolean);
  return `Source: ${origin}${extra.length ? ` (${extra.join('; ')})` : ''}.`;
}

function reportText(r: DataReport): string {
  const lines = [
    `Repeater ${r.nodeId}: ${r.count} item(s).`,
    `Columns: ${r.columns.join(', ') || '(none)'}.`,
    `Template fields: ${r.templateFields.length ? r.templateFields.join(', ') : '(none; use {{field}} in texts, src and attributes)'}.`,
    describeSource(r),
  ];
  for (const w of r.warnings) lines.push(`Warning: ${w}`);
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
        `Node ${nodeId} is not a repeater. Use bind_data(nodeId, ...) on a container with the template ({{field}}) to bind data.`,
      );
    }
  };

  tool(
    'bind_data',
    {
      title: 'Bind data to a container (repeater)',
      description:
        'Repeats a container\'s content once per data item (JSON, CSV, URL or list). Flow: write ONE item with write_html using {{field}} in texts/src/attributes and call bind_data on the container (not a root frame). It becomes a repeater (new id). See get_guide("data").',
      example: {
        nodeId: 'el_ab12cd34',
        path: 'C:/data/products.csv',
        mapping: { name: 'title' },
        limit: 12,
      },
      inputSchema: {
        nodeId: z
          .string()
          .describe(
            'Id of the container with the template (or of a repeater), e.g. "el_ab12cd34".',
          ),
        data: z
          .array(z.unknown())
          .optional()
          .describe('List of items directly, e.g. [{ "name": "Ana", "photo": "https://..." }].'),
        path: z
          .string()
          .optional()
          .describe(
            'Absolute path of a .json/.csv/.tsv file, e.g. "C:/data/products.csv". Hidden folders and files (".ssh", ".claude"...) are refused.',
          ),
        url: z
          .string()
          .optional()
          .describe(
            'http(s) URL that returns JSON or CSV, e.g. "https://api.example.com/products".',
          ),
        text: z
          .string()
          .optional()
          .describe(
            'JSON or CSV pasted as text (also pass format). Use exactly one source among data, text, path and url.',
          ),
        format: z
          .enum(['json', 'csv'])
          .optional()
          .describe(
            'Format of text/url/path: "json" or "csv" (default: from the extension, content-type or content).',
          ),
        select: z
          .string()
          .optional()
          .describe(
            'Path to the list inside the JSON, e.g. "data.items" (default: finds the list).',
          ),
        mapping: z
          .record(z.string(), z.string())
          .optional()
          .describe('Template field -> path in the item, e.g. { "name": "user.fullName" }.'),
        limit: z
          .number()
          .int()
          .min(1)
          .max(MAX_DATA_ITEMS)
          .optional()
          .describe(`Maximum items read, from 1 to ${MAX_DATA_ITEMS}, e.g. 12.`),
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
        ? `Container ${nodeId} converted into repeater ${rep.nodeId} (its children became the template).`
        : `Data of repeater ${rep.nodeId} updated.`;
      return `${head}\n${reportText(rep)}\n${summaryOf(out.doc, [rep.nodeId])}`;
    },
  );

  tool(
    'refresh_data',
    {
      title: "Refresh a repeater's data",
      description:
        "Re-reads the file (path) or URL the repeater's data came from and updates the items, keeping select, mapping and limit. Errors if the data was pasted/edited (inline): use bind_data again.",
      example: { nodeId: 'rp_ab12cd34' },
      inputSchema: {
        nodeId: z.string().describe('Repeater id, e.g. "rp_ab12cd34".'),
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
      return `Data refreshed.\n${reportText(rep)}\n${summaryOf(out.doc, [nodeId])}`;
    },
  );

  tool(
    'get_data',
    {
      title: "View a repeater's data",
      description:
        "Shows the source, the columns, the fields used by the template ({{field}}) and the first rows of a repeater's data as a compact table.",
      example: { nodeId: 'rp_ab12cd34', limit: 10 },
      inputSchema: {
        nodeId: z.string().describe('Repeater id, e.g. "rp_ab12cd34".'),
        limit: z
          .number()
          .int()
          .min(1)
          .max(MAX_DATA_ITEMS)
          .optional()
          .describe('How many rows to show, e.g. 10 (default 20).'),
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
      return `${reportText(rep)}\n\nFirst ${shown} of ${data.length} row(s):\n${tableOf(data, rep.columns, n)}`;
    },
  );

  registerImageEditTools(ctx);
}
