import path from 'node:path';
import { startDaemon, resolvePort } from '@mockup/server';
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
  await new Promise<void>((resolve) => {
    const stop = () => {
      void handle.close().finally(resolve);
    };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  });
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

/** `mockup new <arquivo> [--name Nome]`: cria um documento vazio e abre. */
export async function create(file: string, name?: string): Promise<void> {
  const target = path.resolve(file.endsWith('.mockup.json') ? file : `${file}.mockup.json`);
  const daemon = await ensureDaemon();
  const docName = name ?? path.basename(target).replace(/\.mockup\.json$/, '');
  const info = (await post(`${daemon.url}/api/new`, { path: target, name: docName })) as {
    docId?: string;
  };
  log(`criado: ${target}${info.docId ? ` (${info.docId})` : ''}`);
}
