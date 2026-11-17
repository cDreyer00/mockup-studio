/** Pure logic for the repeater data table: edits the list and builds the `setData` ops. */
import { dataColumns, templateFields } from '@mockup/core';
import type { DataSource, Node, Op } from '@mockup/core';

type Row = Record<string, unknown>;

const isRow = (v: unknown): v is Row => !!v && typeof v === 'object' && !Array.isArray(v);

/** Table columns: those of the data, then the fields used by the template that are missing from them. */
export function tableColumns(node: Node): string[] {
  const data = Array.isArray(node.data) ? node.data : [];
  const cols = dataColumns(data);
  for (const f of templateFields(node.children)) {
    if (f.startsWith('$') || f.includes('.')) continue;
    if (!cols.includes(f)) cols.push(f);
  }
  return cols;
}

/** Template fields that exist in neither the data nor the mapping (candidates for mapping). */
export function unmappedFields(node: Node): string[] {
  const data = Array.isArray(node.data) ? node.data : [];
  const cols = new Set(dataColumns(data));
  const mapping = node.dataSource?.mapping ?? {};
  return templateFields(node.children).filter(
    (f) => !f.startsWith('$') && !f.includes('.') && !cols.has(f) && mapping[f] === undefined,
  );
}

/** Text shown in a cell (objects and lists become JSON). */
export function cellText(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

/** Converts the typed text back to the type of the previous value (number, boolean, JSON). */
export function parseCell(text: string, previous: unknown): unknown {
  if (typeof previous === 'number') {
    const n = Number(text);
    return text.trim() !== '' && Number.isFinite(n) ? n : text;
  }
  if (typeof previous === 'boolean') {
    if (text === 'true') return true;
    if (text === 'false') return false;
    return text;
  }
  if (previous !== null && typeof previous === 'object') {
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }
  return text;
}

export function setCell(data: unknown[], row: number, column: string, text: string): unknown[] {
  const cur = data[row];
  const base: Row = isRow(cur) ? cur : {};
  const next = [...data];
  next[row] = { ...base, [column]: parseCell(text, base[column]) };
  return next;
}

/** New row with all columns empty. */
export function addRow(data: unknown[], columns: string[]): unknown[] {
  return [...data, Object.fromEntries(columns.filter((c) => c !== '$item').map((c) => [c, '']))];
}

export function removeRow(data: unknown[], row: number): unknown[] {
  return data.filter((_, i) => i !== row);
}

/** New column: added empty to every row (if it already exists, nothing changes). */
export function addColumn(data: unknown[], column: string): unknown[] {
  return data.map((r) =>
    isRow(r) ? (column in r ? r : { ...r, [column]: '' }) : { [column]: '' },
  );
}

export function removeColumn(data: unknown[], column: string): unknown[] {
  return data.map((r) => {
    if (!isRow(r)) return r;
    const { [column]: _drop, ...rest } = r;
    return rest;
  });
}

/** `setData` op (one undo entry) with the new list and, optionally, the source. */
export function setDataOp(
  nodeId: string,
  change: { data?: unknown[]; source?: DataSource | null },
): Op {
  return { type: 'setData', changes: [{ nodeId, ...change }] };
}

/**
 * Source after editing the data by hand: file/URL become `inline` (Refresh would re-read the source
 * and discard the edit), keeping `path`/`url` only as a reference to where they came from. `undefined`
 * when the source is already inline (nothing changes).
 */
export function editedSource(source: DataSource | undefined): DataSource | undefined {
  if (!source || source.kind === 'inline') return undefined;
  const next: DataSource = { kind: 'inline' };
  if (source.path) next.path = source.path;
  if (source.url) next.url = source.url;
  if (source.mapping) next.mapping = source.mapping;
  if (source.fetchedAt) next.fetchedAt = source.fetchedAt;
  return next;
}

/** Source with the `field → column` mapping changed (empty `column` removes). */
export function withMapping(
  source: DataSource | undefined,
  field: string,
  column: string,
): DataSource {
  const mapping = { ...source?.mapping };
  if (column) mapping[field] = column;
  else delete mapping[field];
  const next: DataSource = { kind: 'inline', ...source };
  if (Object.keys(mapping).length) next.mapping = mapping;
  else delete next.mapping;
  return next;
}

/** Short description of the source for the panel. */
export function describeSource(source: DataSource | undefined): string {
  if (!source || source.kind === 'inline') {
    const from = source?.path ?? source?.url;
    return from ? `Edited data (came from ${from})` : 'Inline data';
  }
  if (source.kind === 'url') return `URL: ${source.url ?? ''}`;
  return `${source.kind.toUpperCase()} file: ${source.path ?? ''}`;
}
