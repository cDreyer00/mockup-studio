import path from 'node:path';
import { startDaemon, resolvePort, normalizeDocumentPath, DOCUMENT_EXT } from '@mockup/server';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { ensureDaemon, log } from './discover.js';
import { locateElectron, runElectronForeground } from './electron.js';

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

/** Pasta `packages/editor/dist` (monorepo) quando já foi buildada; senão `undefined`. */
export function findEditorDir(): string | undefined {
  try {
    const pkg = createRequire(import.meta.url).resolve('@mockup/editor/package.json');
    const dir = path.join(path.dirname(pkg), 'dist');
    return fs.existsSync(path.join(dir, 'index.html')) ? dir : undefined;
  } catch {
    return undefined;
  }
}

/**
 * `mockup serve [--port N] [--render] [arquivos...]`: daemon em primeiro plano. Com `--render` roda o
 * Electron headless (com screenshot); sem, o daemon Node (que serve o editor em `/` se estiver buildado).
 */
export async function serve(opts: {
  port?: number;
  files: string[];
  render?: boolean;
}): Promise<void> {
  const files = opts.files.map((f) => path.resolve(f));
  if (opts.render) {
    const electron = locateElectron();
    if (!electron) {
      throw new Error(
        'Electron não encontrado para --render: instale o app desktop, defina MOCKUP_DESKTOP_EXE ' +
          'ou rode `npm run build` (o pacote @mockup/desktop precisa estar buildado).',
      );
    }
    log(`Electron headless (${electron.source}) em primeiro plano. Ctrl+C para sair.`);
    process.exitCode = await runElectronForeground(electron, resolvePort(opts.port), files);
    return;
  }
  const editorDir = findEditorDir();
  const handle = await startDaemon({
    port: resolvePort(opts.port),
    headless: true,
    openFiles: files,
    editorDir,
  });
  log(`daemon em ${handle.url} (MCP: ${handle.mcpUrl}, WS: ${handle.wsUrl}). Ctrl+C para sair.`);
  if (editorDir) log(`editor no navegador: ${handle.url}/`);
  log('sem motor de render (daemon Node): screenshot indisponível; use --render para o Electron.');
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
