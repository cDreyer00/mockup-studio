import path from 'node:path';
import {
  startDaemon,
  resolvePort,
  normalizeDocumentPath,
  requestShutdown,
  waitForShutdown,
  DOCUMENT_EXT,
} from '@mockup/server';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { ensureDaemon, findDaemon, log } from './discover.js';
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

/** The `packages/editor/dist` folder (monorepo) once it has been built; otherwise `undefined`. */
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
 * `mockup serve [--port N] [--render] [files...]`: daemon in the foreground. With `--render` it runs the
 * headless Electron (with screenshots); without it, the Node daemon (which serves the editor at `/` if built).
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
        'Electron not found for --render: install the desktop app, set MOCKUP_DESKTOP_EXE ' +
          'or run `npm run build` (the @mockup/desktop package must be built).',
      );
    }
    log(`Headless Electron (${electron.source}) in the foreground. Press Ctrl+C to exit.`);
    process.exitCode = await runElectronForeground(electron, resolvePort(opts.port), files);
    return;
  }
  const editorDir = findEditorDir();
  const handle = await startDaemon({
    port: resolvePort(opts.port),
    headless: true,
    mode: 'serve',
    openFiles: files,
    editorDir,
    // `mockup stop` (POST /api/shutdown) closes the daemon, saving the documents, and exits the process
    onShutdown: () => process.exit(0),
  });
  log(
    `daemon at ${handle.url} (MCP: ${handle.mcpUrl}, WS: ${handle.wsUrl}). Press Ctrl+C to exit.`,
  );
  if (editorDir) log(`editor in the browser: ${handle.url}/`);
  log('no render engine (Node daemon): screenshot unavailable; use --render for Electron.');
  // No signal handlers here: `startDaemon` (writeInfo) already installs SIGINT/SIGTERM, closes the
  // daemon and calls process.exit(0). The HTTP server keeps the process alive.
}

/** `mockup open <file>`: opens it in the daemon (starting a headless one if needed). */
export async function open(file: string): Promise<void> {
  const target = path.resolve(file);
  const daemon = await ensureDaemon();
  const info = (await post(`${daemon.url}/api/open`, { path: target })) as {
    docId?: string;
    name?: string;
  };
  log(`opened: ${target}${info.docId ? ` (${info.docId})` : ''}`);
}

/** Resolves the path of the new document (always `.mockup.json`) and the default name (basename without extension). */
export function resolveNewDocument(
  file: string,
  name?: string,
): { target: string; docName: string } {
  const target = normalizeDocumentPath(file);
  const base = path.basename(target);
  return { target, docName: name ?? base.slice(0, base.length - DOCUMENT_EXT.length) };
}

/** Parses `--port`; throws if it is not an integer between 0 and 65535. */
export function parsePort(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : NaN;
  if (!Number.isInteger(n) || n < 0 || n > 65535) {
    throw new Error('--port requires an integer between 0 and 65535.');
  }
  return n;
}

/** `mockup new <file> [--name Name]`: creates an empty document and opens it. */
export async function create(file: string, name?: string): Promise<void> {
  const { target, docName } = resolveNewDocument(file, name);
  const daemon = await ensureDaemon();
  const info = (await post(`${daemon.url}/api/new`, { path: target, name: docName })) as {
    docId?: string;
  };
  log(`created: ${target}${info.docId ? ` (${info.docId})` : ''}`);
}

/**
 * `mockup stop`: asks the discovered daemon to shut down (`POST /api/shutdown`). Works for the
 * Node daemon (headless or `serve`) and for headless Electron (which exits with `app.quit()`); the
 * desktop app with a window refuses (409) and must be closed from its own window. Documents are saved.
 */
export async function stop(): Promise<void> {
  const daemon = await findDaemon();
  if (!daemon) {
    log('no Mockup Studio daemon is running.');
    return;
  }
  const r = await requestShutdown(daemon.url);
  if (!r.accepted) {
    throw new Error(
      r.status === 409
        ? `the daemon at ${daemon.url} (pid ${daemon.pid ?? '?'}) is the desktop app with a window and cannot be stopped over HTTP: close it from its window.`
        : `could not stop the daemon at ${daemon.url}: ${r.error ?? 'unknown error'}`,
    );
  }
  if (!(await waitForShutdown(daemon.url)))
    throw new Error(
      `the daemon at ${daemon.url} accepted the request but is still responding; kill pid ${daemon.pid ?? '?'}.`,
    );
  log(`daemon stopped (pid ${daemon.pid ?? '?'}, port ${daemon.port}).`);
}
