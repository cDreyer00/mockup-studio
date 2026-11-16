import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from './http.js';
import { createMcpHandler } from './mcp/session.js';
import { getDataDir, removeDaemonInfo, resolvePort, writeDaemonInfo } from './paths.js';
import { DocumentStore } from './store.js';
import { attachWebSocket } from './ws.js';

export interface DaemonOptions {
  port?: number;
  host?: string;
  headless?: boolean;
  openFiles?: string[];
  dataDir?: string;
  writeInfo?: boolean;
}

export interface DaemonHandle {
  port: number;
  host: string;
  url: string;
  mcpUrl: string;
  wsUrl: string;
  store: DocumentStore;
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
  const mcp = createMcpHandler(store);
  let actualPort = requestedPort;
  const app = createApp(store, mcp, { getPort: () => actualPort, startedAt });
  const server = http.createServer(app);
  const ws = attachWebSocket(server, store);

  await new Promise<void>((resolve, reject) => {
    const onError = (err: Error): void => {
      reject(
        (err as NodeJS.ErrnoException).code === 'EADDRINUSE'
          ? new Error(
              `Porta ${requestedPort} já está em uso em ${host}. Use --port para escolher outra.`,
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

  actualPort = (server.address() as AddressInfo).port;
  const origin = `${host === '::1' ? '[::1]' : host}:${actualPort}`;
  const url = `http://${origin}`;
  const mcpUrl = `${url}/mcp`;
  const wsUrl = `ws://${origin}/ws`;

  for (const file of opts.openFiles ?? []) {
    try {
      await store.open(file);
    } catch (e) {
      log(`não foi possível abrir ${file}:`, e instanceof Error ? e.message : e);
    }
  }

  const info = { port: actualPort, pid: process.pid, startedAt, url, mcpUrl, wsUrl };
  const cleanupInfo = (): void => removeDaemonInfo(dataDir);
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
    close() {
      closing ??= (async () => {
        if (writeInfo) {
          process.off('exit', cleanupInfo);
          process.off('SIGINT', onSignal);
          process.off('SIGTERM', onSignal);
        }
        await ws.close();
        await mcp.closeAll();
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
        await store.closeAll();
        if (writeInfo) removeDaemonInfo(dataDir);
        log('encerrado');
      })();
      return closing;
    },
  };
  log(`ouvindo em ${url}`);
  return handle;
}
