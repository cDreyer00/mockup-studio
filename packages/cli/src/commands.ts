import path from 'node:path';
import { startDaemon, resolvePort, normalizeDocumentPath, DOCUMENT_EXT } from '@mockup/server';
import { ensureDaemon, log } from './discover.js';

async function post(url: string, body: unknown): Promise<unknown> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
  return data;
}

/** `mockup serve [--port N] [arquivos...]`: daemon em primeiro plano (headless; o editor roda à parte). */
export async function serve(opts: { port?: number; files: string[] }): Promise<void> {
  const handle = await startDaemon({
    port: resolvePort(opts.port),
    headless: true,
    openFiles: opts.files.map((f) => path.resolve(f)),
  });
  log(`daemon em ${handle.url} (MCP: ${handle.mcpUrl}, WS: ${handle.wsUrl}). Ctrl+C para sair.`);
  // Sem handlers de sinal aqui: `startDaemon` (writeInfo) já instala SIGINT/SIGTERM, fecha o
  // daemon e chama process.exit(0). O servidor HTTP mantém o processo vivo.
}

/** `mockup open <arquivo>`: abre no daemon (subindo um headless se preciso). */
export async function open(file: string): Promise<void> {
  const target = path.resolve(file);
  const daemon = await ensureDaemon();
  const info = (await post(`${daemon.url}/api/open`, { path: target })) as {
    docId?: string;
    name?: string;
  };
  log(`aberto: ${target}${info.docId ? ` (${info.docId})` : ''}`);
}

/** Resolve o caminho do novo documento (sempre `.mockup.json`) e o nome padrão (basename sem extensão). */
export function resolveNewDocument(
  file: string,
  name?: string,
): { target: string; docName: string } {
  const target = normalizeDocumentPath(file);
  const base = path.basename(target);
  return { target, docName: name ?? base.slice(0, base.length - DOCUMENT_EXT.length) };
}

/** Converte `--port`; lança erro em português se não for inteiro entre 0 e 65535. */
export function parsePort(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : NaN;
  if (!Number.isInteger(n) || n < 0 || n > 65535) {
    throw new Error('--port exige um número inteiro entre 0 e 65535.');
  }
  return n;
}

/** `mockup new <arquivo> [--name Nome]`: cria um documento vazio e abre. */
export async function create(file: string, name?: string): Promise<void> {
  const { target, docName } = resolveNewDocument(file, name);
  const daemon = await ensureDaemon();
  const info = (await post(`${daemon.url}/api/new`, { path: target, name: docName })) as {
    docId?: string;
  };
  log(`criado: ${target}${info.docId ? ` (${info.docId})` : ''}`);
}
