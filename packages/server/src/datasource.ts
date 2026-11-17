/**
 * Repeater data: reading from a local file, URL, pasted text or a direct list, and the ops that
 * bind the data to a node (converting a container into a repeater when needed). Shared by the MCP
 * tools (`bind_data`, `refresh_data`) and the editor's HTTP routes.
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  MAX_DATA_BYTES,
  MAX_DATA_ITEMS,
  createRepeaterFrom,
  dataColumns,
  findNode,
  guessDataFormat,
  parseCsv,
  selectDataList,
  templateFields,
  type DataSource,
  type Document,
  type Node,
  type Op,
} from '@mockup/core';
import { fetchBytes } from './assets.js';

/** Data usage error (message saying what to do). */
export class DataSourceError extends Error {}

/** Read limit for a data file or URL. */
export const MAX_DATA_FILE_BYTES = 5 * 1024 * 1024;

export interface DataInput {
  data?: unknown[];
  text?: string;
  format?: 'json' | 'csv';
  path?: string;
  url?: string;
  select?: string;
  mapping?: Record<string, string>;
  limit?: number;
}

export interface LoadedData {
  data: unknown[];
  source: DataSource;
}

/** List of items from a JSON/CSV text, without cutting at `MAX_DATA_ITEMS` (the caller does the cutting). */
function listFromText(text: string, format: 'json' | 'csv', select?: string): unknown[] {
  if (format === 'csv') return parseCsv(text);
  let json: unknown;
  try {
    json = JSON.parse(text.replace(/^\uFEFF/, ''));
  } catch (e) {
    throw new DataSourceError(
      `Invalid JSON: ${e instanceof Error ? e.message : String(e)}. Check the content or pass format "csv".`,
    );
  }
  try {
    return selectDataList(json, select);
  } catch (e) {
    throw new DataSourceError(
      `${e instanceof Error ? e.message : String(e)}. Pass select with the path to the list (e.g. "data.items").`,
    );
  }
}

/** Applies `limit` and validates the item and size limits. */
function finalizeList(list: unknown[], limit?: number): unknown[] {
  const out = limit && limit > 0 ? list.slice(0, limit) : list;
  if (out.length > MAX_DATA_ITEMS) {
    throw new DataSourceError(
      `The source has ${out.length} items and the maximum is ${MAX_DATA_ITEMS}. Use limit (up to ${MAX_DATA_ITEMS}) to read only the first ones.`,
    );
  }
  if (out.length === 0) {
    throw new DataSourceError(
      'The source has no items. Check the content (CSV needs a header and at least one row) and select.',
    );
  }
  if (JSON.stringify(out).length > MAX_DATA_BYTES) {
    throw new DataSourceError(
      `The data exceeds ${MAX_DATA_BYTES / 1024 / 1024} MB. Use limit to read fewer items.`,
    );
  }
  return out;
}

/** Extensions accepted in `path` (the content comes back through `get_data` and the document API). */
const DATA_EXTS = ['.json', '.csv', '.tsv'];

export interface LoadOptions {
  /**
   * Folders where `path` may be (compared after resolving symlinks). Absent = any non-hidden
   * folder. The editor's HTTP route restricts it to the document's folder and the home folder.
   */
  roots?: string[];
}

const hasHiddenSegment = (p: string): boolean =>
  p.split(/[\\/]+/).some((seg) => seg.startsWith('.'));

const isInside = (root: string, p: string): boolean => {
  const rel = path.relative(root, p);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
};

/**
 * Validates and resolves the path of a data file: absolute, .json/.csv/.tsv, with no hidden folder
 * or file (segment starting with ".", e.g. `~/.ssh`, `~/.claude`), including after following
 * symlinks, and inside `roots` when given. Returns the real path.
 */
export async function resolveDataPath(p: string, opts: LoadOptions = {}): Promise<string> {
  // Network path (\\host\share, //host/share) or device path (\\?\, \\.\): refused before any
  // disk access, because opening an SMB share can send NTLM credentials.
  if (/^[\\/]{2}/.test(p)) {
    throw new DataSourceError(
      `Path refused: "${p}" is a network or device path. Use a local file or an http(s) url.`,
    );
  }
  if (!path.isAbsolute(p)) {
    throw new DataSourceError(`path must be an absolute path, got "${p}".`);
  }
  const resolved = path.resolve(p);
  const hidden = (): DataSourceError =>
    new DataSourceError(
      `Path refused: "${p}" goes through a hidden folder or file (name starting with "."). Copy the data to a regular folder or paste the content into text.`,
    );
  if (hasHiddenSegment(resolved)) throw hidden();
  const badExt = (q: string): boolean => !DATA_EXTS.includes(path.extname(q).toLowerCase());
  if (badExt(resolved)) {
    throw new DataSourceError(
      `Extension "${path.extname(resolved).toLowerCase()}" is not supported. Use .json, .csv or .tsv.`,
    );
  }
  let real: string;
  try {
    real = await fs.promises.realpath(resolved);
  } catch {
    throw new DataSourceError(`File not found: ${p}`);
  }
  if (hasHiddenSegment(real)) throw hidden();
  if (badExt(real)) {
    throw new DataSourceError(
      `"${p}" points to a file without a .json, .csv or .tsv extension; refused.`,
    );
  }
  if (opts.roots) {
    const roots: string[] = [];
    for (const r of opts.roots) {
      try {
        roots.push(await fs.promises.realpath(r));
      } catch {
        // a nonexistent folder authorizes nothing
      }
    }
    if (!roots.some((r) => isInside(r, real))) {
      throw new DataSourceError(
        `Path refused: from the editor, the data file must be in the document's folder or your home folder (${opts.roots.join(', ')}). Paste the content or move the file.`,
      );
    }
  }
  return real;
}

async function readFileData(
  p: string,
  opts: LoadOptions = {},
): Promise<{ text: string; format: 'json' | 'csv' }> {
  const real = await resolveDataPath(p, opts);
  let st: fs.Stats;
  try {
    st = await fs.promises.stat(real);
  } catch {
    throw new DataSourceError(`File not found: ${p}`);
  }
  if (!st.isFile()) throw new DataSourceError(`"${p}" is not a file.`);
  if (st.size > MAX_DATA_FILE_BYTES) {
    throw new DataSourceError(
      `The file exceeds the ${MAX_DATA_FILE_BYTES / 1024 / 1024} MB limit.`,
    );
  }
  return { text: await fs.promises.readFile(real, 'utf8'), format: guessDataFormat(real) };
}

async function readUrlData(url: string): Promise<{ text: string; contentType: string }> {
  if (!/^https?:\/\//i.test(url)) {
    throw new DataSourceError(`url must start with http:// or https://, got "${url}".`);
  }
  try {
    const r = await fetchBytes(url, { maxBytes: MAX_DATA_FILE_BYTES, timeoutMs: 20_000 });
    return { text: r.bytes.toString('utf8'), contentType: r.contentType };
  } catch (e) {
    throw new DataSourceError(e instanceof Error ? e.message : String(e));
  }
}

/** Reads the data from the given source (exactly one of `data`, `text`, `path`, `url`). */
export async function loadData(input: DataInput, opts: LoadOptions = {}): Promise<LoadedData> {
  const given = [input.data, input.text, input.path, input.url].filter((v) => v !== undefined);
  if (given.length !== 1) {
    throw new DataSourceError(
      'Pass exactly one source: data (list), text (pasted JSON/CSV, with format), path (.json/.csv/.tsv file) or url (http/https).',
    );
  }
  const base: DataSource = { kind: 'inline' };
  if (input.select) base.select = input.select;
  if (input.mapping && Object.keys(input.mapping).length) base.mapping = input.mapping;
  if (input.limit) base.limit = input.limit;
  const now = new Date().toISOString();

  if (input.data !== undefined) {
    if (!Array.isArray(input.data)) {
      throw new DataSourceError('data must be a list, e.g. [{ "name": "Ana" }].');
    }
    return { data: finalizeList(input.data, input.limit), source: { ...base, fetchedAt: now } };
  }
  if (input.text !== undefined) {
    const format =
      input.format ??
      (input.text.trim().startsWith('[') || input.text.trim().startsWith('{') ? 'json' : 'csv');
    const list = listFromText(input.text, format, input.select);
    return { data: finalizeList(list, input.limit), source: { ...base, fetchedAt: now } };
  }
  if (input.path !== undefined) {
    const f = await readFileData(input.path, opts);
    const format = input.format ?? f.format;
    const list = listFromText(f.text, format, input.select);
    return {
      data: finalizeList(list, input.limit),
      source: { ...base, kind: format, path: input.path, fetchedAt: now },
    };
  }
  const url = input.url!;
  const r = await readUrlData(url);
  const format = input.format ?? guessDataFormat(`${r.contentType} ${url}`);
  const list = listFromText(r.text, format, input.select);
  return {
    data: finalizeList(list, input.limit),
    source: { ...base, kind: 'url', url, fetchedAt: now },
  };
}

/** Re-reads a repeater's stored source. */
export async function reloadSource(
  source: DataSource | undefined,
  opts: LoadOptions = {},
): Promise<LoadedData> {
  if (!source || source.kind === 'inline') {
    throw new DataSourceError(
      'This repeater has pasted/edited data, with no source file or URL to refresh from. Use bind_data with path or url.',
    );
  }
  const input: DataInput = {
    ...(source.select ? { select: source.select } : {}),
    ...(source.mapping ? { mapping: source.mapping } : {}),
    ...(source.limit ? { limit: source.limit } : {}),
  };
  if (source.kind === 'url') {
    if (!source.url)
      throw new DataSourceError('The URL source lost its address; use bind_data again.');
    input.url = source.url;
  } else {
    if (!source.path)
      throw new DataSourceError('The file source lost its path; use bind_data again.');
    input.path = source.path;
    input.format = source.kind;
  }
  return loadData(input, opts);
}

export interface BindResult {
  ops: Op[];
  /** Repeater id after the ops (changes when the container is converted). */
  nodeId: string;
  converted: boolean;
}

/** Ops that bind `loaded` to the node: `setData` on a repeater or converting the container into a repeater. */
export function bindOps(doc: Document, nodeId: string, loaded: LoadedData): BindResult {
  const p = findNode(doc, nodeId);
  if (!p) {
    throw new DataSourceError(
      `Node not found: "${nodeId}". Use get_tree_summary to list valid ids.`,
    );
  }
  const node = p.node;
  if (node.type === 'repeater') {
    return {
      ops: [{ type: 'setData', changes: [{ nodeId, data: loaded.data, source: loaded.source }] }],
      nodeId,
      converted: false,
    };
  }
  if (node.type === 'text' || node.type === 'image' || node.type === 'svg') {
    throw new DataSourceError(
      `Node ${nodeId} is ${node.type}; data binds to a container with the template inside. Pass the parent container's id.`,
    );
  }
  if (!p.parent) {
    throw new DataSourceError(
      `Node ${nodeId} is a root frame; it cannot become a repeater. Put the template inside a container (e.g. write_html with a div holding the cards) and pass its id.`,
    );
  }
  if (node.children.length === 0) {
    throw new DataSourceError(
      `Container ${nodeId} has no children. Create the template first, e.g. write_html with a card using {{name}}, and call bind_data again.`,
    );
  }
  const rep = createRepeaterFrom(node, loaded.data, loaded.source);
  return {
    ops: [
      { type: 'deleteNodes', nodeIds: [nodeId] },
      { type: 'createNode', parentId: p.parent.id, node: rep, index: p.index },
    ],
    nodeId: rep.id,
    converted: true,
  };
}

export interface DataReport {
  nodeId: string;
  count: number;
  columns: string[];
  source: DataSource;
  templateFields: string[];
  warnings: string[];
}

function rootOf(field: string): string {
  return field.split('.')[0]!;
}

/** Template fields with no matching column (takes `mapping` into account). */
export function missingFields(node: Node, data: unknown[], source?: DataSource): string[] {
  const columns = dataColumns(data, 200);
  if (columns.includes('$item')) return [];
  const out: string[] = [];
  for (const f of templateFields(node.children)) {
    if (f.startsWith('$')) continue;
    const target = source?.mapping?.[f] ?? f;
    if (!columns.includes(rootOf(target))) out.push(f);
  }
  return out;
}

/** Report for repeater `nodeId` in the current document. */
export function dataReport(doc: Document, nodeId: string): DataReport {
  const p = findNode(doc, nodeId);
  if (!p || p.node.type !== 'repeater') {
    throw new DataSourceError(
      `Node ${nodeId} is not a repeater. Use bind_data to bind data to a container.`,
    );
  }
  const data = Array.isArray(p.node.data) ? p.node.data : [];
  const fields = templateFields(p.node.children);
  const warnings = missingFields(p.node, data, p.node.dataSource).map(
    (f) =>
      `The template field {{${f}}} has no matching column${p.node.dataSource?.mapping?.[f] ? ` (mapped to "${p.node.dataSource.mapping[f]}")` : ''}; adjust the template or use mapping.`,
  );
  return {
    nodeId,
    count: data.length,
    columns: dataColumns(data),
    source: p.node.dataSource ?? { kind: 'inline' },
    templateFields: fields,
    warnings,
  };
}
