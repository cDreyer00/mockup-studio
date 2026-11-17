import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { AgentBackend } from './agent/backend.js';
import { AssistantService } from './agent/assistant.js';
import { createApp } from './http.js';
import { createMcpHandler } from './mcp/session.js';
import { getDataDir, removeDaemonInfo, resolvePort, writeDaemonInfo } from './paths.js';
import type { DaemonMode } from './http.js';
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
  /** TTL de ociosidade das sessões MCP em ms (padrão 30 min). */
  sessionTtlMs?: number;
  /** Motor de render (injetado pelo app desktop). Sem ele, screenshot/layout ficam indisponíveis. */
  render?: RenderProvider;
  /** Pasta com o build do editor (`packages/editor/dist`), servida em `/` pelo daemon. */
  editorDir?: string;
  /** Quem iniciou o daemon (health). Padrão: `desktop` com render, `headless` com `headless`, senão `serve`. */
  mode?: DaemonMode;
  /**
   * Habilita `POST /api/shutdown`: o daemon responde 202, fecha (salvando os documentos) e então
   * chama este callback (ex.: `process.exit` ou `app.quit`). Sem ele a rota responde 409.
   */
  onShutdown?: () => void;
  /**
   * Backends do assistente no lugar dos detectados (CLIs `claude` e `codex` no PATH). Usado nos
   * testes com um backend falso.
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
  /** Assistente, scripts e remix. */
  services: Required<DaemonServices>;
  /** Motor de render injetado (ou `undefined`). */
  render?: RenderProvider;
  /** Número de sessões MCP ativas. */
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
  const services: Required<DaemonServices> = { assistant, scripts, remix };
  const mcp = createMcpHandler(store, {
    getPort: () => actualPort,
    sessionTtlMs: opts.sessionTtlMs,
    render: opts.render,
    dataDir,
    services,
  });
  const app = createApp(store, mcp, {
    getPort: () => actualPort,
    startedAt,
    allowedHosts: [host],
    dataDir,
    render: opts.render,
    editorDir: opts.editorDir,
    mode: opts.mode ?? (opts.render ? 'desktop' : opts.headless ? 'headless' : 'serve'),
    shutdown: opts.onShutdown
      ? () => {
          log('encerramento pedido por HTTP');
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

  // O ws repassa os erros do servidor (EADDRINUSE) como `error` sem ouvinte, o que derrubaria o
  // processo antes da mensagem clara abaixo: só se anexa depois que a porta foi obtida.
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
      log(`não foi possível abrir ${file}:`, e instanceof Error ? e.message : e);
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
        log('encerrado');
      })();
      return closing;
    },
  };
  log(`ouvindo em ${url}`);
  return handle;
}
