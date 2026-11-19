import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { AgentBackend } from './agent/backend.js';
import { AssistantService } from './agent/assistant.js';
import { EditorChannel } from './editors.js';
import { createApp } from './http.js';
import { createMcpHandler } from './mcp/session.js';
import { getDataDir, removeDaemonInfo, resolvePort, writeDaemonInfo } from './paths.js';
import type { DaemonMode } from './http.js';
import type { TrashProvider } from './files.js';
import type { RenderProvider } from './render.js';
import { RemixService } from './remix.js';
import { ScriptService } from './scripts/service.js';
import type { DaemonServices } from './services.js';
import { DocumentStore } from './store.js';
import { attachWebSocket } from './ws.js';

export interface DaemonOptions {
  port?: number;
  host?: string;
  headless?: boolean;
  openFiles?: string[];
  dataDir?: string;
  writeInfo?: boolean;
  /** Idle TTL of MCP sessions in ms (default 30 min). */
  sessionTtlMs?: number;
  /** Render engine (injected by the desktop app). Without it, screenshot/layout are unavailable. */
  render?: RenderProvider;
  /**
   * Moves a file to the OS Recycle Bin / Trash (the desktop app injects `shell.trashItem`). Without
   * it, deleting a document (`delete_file`, Home › Delete file…) deletes permanently.
   */
  trash?: TrashProvider;
  /** Folder with the editor build (`packages/editor/dist`), served at `/` by the daemon. */
  editorDir?: string;
  /** Who started the daemon (health). Default: `desktop` with render, `headless` with `headless`, otherwise `serve`. */
  mode?: DaemonMode;
  /**
   * Enables `POST /api/shutdown`: the daemon responds 202, closes (saving the documents) and then
   * calls this callback (e.g. `process.exit` or `app.quit`). Without it the route responds 409.
   */
  onShutdown?: () => void;
  /**
   * Assistant backends in place of the detected ones (`claude` and `codex` CLIs on PATH). Used in
   * tests with a fake backend.
   */
  agentBackends?: AgentBackend[];
}

export interface DaemonHandle {
  port: number;
  host: string;
  url: string;
  mcpUrl: string;
  wsUrl: string;
  store: DocumentStore;
  /** Assistant, scripts, remix and editor windows. */
  services: Required<DaemonServices>;
  /** Injected render engine (or `undefined`). */
  render?: RenderProvider;
  /** Number of active MCP sessions. */
  sessionCount(): number;
  close(): Promise<void>;
}

const log = (...args: unknown[]): void => console.error('[mockup-daemon]', ...args);

export async function startDaemon(opts: DaemonOptions = {}): Promise<DaemonHandle> {
  const host = opts.host ?? '127.0.0.1';
  const writeInfo = opts.writeInfo !== false;
  const dataDir = opts.dataDir ?? (writeInfo ? getDataDir() : undefined);
  const requestedPort = opts.port ?? resolvePort();
  const startedAt = new Date().toISOString();

  const store = new DocumentStore({ dataDir });
  let actualPort = requestedPort;
  const assistant = new AssistantService(store, {
    dataDir,
    getPort: () => actualPort,
    host,
    render: opts.render,
    backends: opts.agentBackends,
  });
  const scripts = new ScriptService(store, { render: opts.render, assistant });
  const remix = new RemixService(store, { assistant });
  const editors = new EditorChannel();
  const services: Required<DaemonServices> = { assistant, scripts, remix, editors };
  const mcp = createMcpHandler(store, {
    getPort: () => actualPort,
    sessionTtlMs: opts.sessionTtlMs,
    render: opts.render,
    trash: opts.trash,
    dataDir,
    services,
  });
  const app = createApp(store, mcp, {
    getPort: () => actualPort,
    startedAt,
    allowedHosts: [host],
    dataDir,
    render: opts.render,
    trash: opts.trash,
    editorDir: opts.editorDir,
    mode: opts.mode ?? (opts.render ? 'desktop' : opts.headless ? 'headless' : 'serve'),
    shutdown: opts.onShutdown
      ? () => {
          log('shutdown requested over HTTP');
          void handle.close().finally(() => opts.onShutdown?.());
        }
      : undefined,
  });
  const server = http.createServer(app);

  await new Promise<void>((resolve, reject) => {
    const onError = (err: Error): void => {
      reject(
        (err as NodeJS.ErrnoException).code === 'EADDRINUSE'
          ? new Error(
              `Port ${requestedPort} is already in use on ${host}. Use --port to choose another.`,
            )
          : err,
      );
    };
    server.once('error', onError);
    server.listen(requestedPort, host, () => {
      server.off('error', onError);
      resolve();
    });
  });

  // ws forwards the server errors (EADDRINUSE) as an unhandled `error`, which would crash the
  // process before the clear message above: it is only attached after the port is obtained.
  const ws = attachWebSocket(server, store, '/ws', services);
  actualPort = (server.address() as AddressInfo).port;
  const origin = `${host === '::1' ? '[::1]' : host}:${actualPort}`;
  const url = `http://${origin}`;
  const mcpUrl = `${url}/mcp`;
  const wsUrl = `ws://${origin}/ws`;

  for (const file of opts.openFiles ?? []) {
    try {
      await store.open(file);
    } catch (e) {
      log(`could not open ${file}:`, e instanceof Error ? e.message : e);
    }
  }

  const info = { port: actualPort, pid: process.pid, startedAt, url, mcpUrl, wsUrl };
  const cleanupInfo = (): void => removeDaemonInfo(dataDir, process.pid);
  const onSignal = (): void => {
    void handle.close().finally(() => process.exit(0));
  };
  if (writeInfo) {
    writeDaemonInfo(info, dataDir);
    process.once('exit', cleanupInfo);
    process.once('SIGINT', onSignal);
    process.once('SIGTERM', onSignal);
  }

  let closing: Promise<void> | null = null;
  const handle: DaemonHandle = {
    port: actualPort,
    host,
    url,
    mcpUrl,
    wsUrl,
    store,
    services,
    render: opts.render,
    sessionCount: () => mcp.sessionCount(),
    close() {
      closing ??= (async () => {
        if (writeInfo) {
          process.off('exit', cleanupInfo);
          process.off('SIGINT', onSignal);
          process.off('SIGTERM', onSignal);
        }
        await assistant.close();
        await ws.close();
        await mcp.closeAll();
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
        await store.closeAll();
        await opts.render?.close?.().catch(() => undefined);
        if (writeInfo) removeDaemonInfo(dataDir, process.pid);
        log('stopped');
      })();
      return closing;
    },
  };
  log(`listening on ${url}`);
  return handle;
}
