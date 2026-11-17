/** HTTP calls to the daemon for repeater data and placeholders (same origin as `daemon`). */
import type { DataSource } from '@mockup/core';
import { useDoc } from '../state/docStore';
import { ui } from '../state/uiStore';

export interface BindDataBody {
  data?: unknown[];
  text?: string;
  format?: 'json' | 'csv';
  path?: string;
  url?: string;
  select?: string;
  mapping?: Record<string, string>;
  limit?: number;
}

export interface BindDataResult {
  /** Repeater id (new when a container was converted). */
  nodeId: string;
  count: number;
  columns: string[];
  source: DataSource;
}

export interface PlaceholderBody {
  nodeId: string;
  kind: string;
  seed?: string;
  width?: number;
  height?: number;
  label?: string;
}

function activeDoc(docId?: string): string {
  const id = docId ?? useDoc.getState().activeDocId;
  if (!id) throw new Error('No document open');
  return id;
}

async function post<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(json.error ?? `Request failed (${res.status})`);
  return json;
}

const enc = encodeURIComponent;

export const features = {
  /** Binds data to the repeater; a container with children is converted into a repeater. */
  bindData(nodeId: string, body: BindDataBody, docId?: string): Promise<BindDataResult> {
    return post(`/api/data/${enc(activeDoc(docId))}/${enc(nodeId)}/bind`, body);
  },
  /** Re-reads the source (file/URL) of the `dataSource`. */
  refreshData(nodeId: string, docId?: string): Promise<BindDataResult> {
    return post(`/api/data/${enc(activeDoc(docId))}/${enc(nodeId)}/refresh`, {});
  },
  /** Generates a placeholder SVG and applies it as the image `src`. */
  placeholder(body: PlaceholderBody, docId?: string): Promise<{ src: string; nodeId: string }> {
    return post(`/api/placeholder/${enc(activeDoc(docId))}`, body);
  },
};

/** Converts a container with children into a repeater (the children become the template) and selects it. */
export async function convertToRepeater(nodeId: string): Promise<string | null> {
  try {
    const res = await features.bindData(nodeId, { data: [] });
    ui.select([res.nodeId]);
    return res.nodeId;
  } catch (e) {
    ui.toast(e instanceof Error ? e.message : String(e), 'error');
    return null;
  }
}
