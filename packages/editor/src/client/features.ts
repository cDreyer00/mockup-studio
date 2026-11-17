/** Chamadas HTTP ao daemon para dados de repetidores e placeholders (mesma origem do `daemon`). */
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
  /** Id do repetidor (novo quando um contêiner foi convertido). */
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
  if (!id) throw new Error('Nenhum documento aberto');
  return id;
}

async function post<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(json.error ?? `Falha na requisição (${res.status})`);
  return json;
}

const enc = encodeURIComponent;

export const features = {
  /** Vincula dados ao repetidor; um contêiner com filhos é convertido em repetidor. */
  bindData(nodeId: string, body: BindDataBody, docId?: string): Promise<BindDataResult> {
    return post(`/api/data/${enc(activeDoc(docId))}/${enc(nodeId)}/bind`, body);
  },
  /** Relê a origem (arquivo/URL) da `dataSource`. */
  refreshData(nodeId: string, docId?: string): Promise<BindDataResult> {
    return post(`/api/data/${enc(activeDoc(docId))}/${enc(nodeId)}/refresh`, {});
  },
  /** Gera um SVG placeholder e o aplica como `src` da imagem. */
  placeholder(body: PlaceholderBody, docId?: string): Promise<{ src: string; nodeId: string }> {
    return post(`/api/placeholder/${enc(activeDoc(docId))}`, body);
  },
};

/** Converte um contêiner com filhos em repetidor (os filhos viram o template) e o seleciona. */
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
