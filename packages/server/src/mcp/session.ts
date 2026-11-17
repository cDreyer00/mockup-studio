import { randomUUID } from 'node:crypto';
import type { Request, Response } from 'express';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import type { RenderProvider } from '../render.js';
import type { DaemonServices } from '../services.js';
import type { DocumentStore } from '../store.js';
import { createMcpServer } from './server.js';

interface Session {
  server: McpServer;
  transport: StreamableHTTPServerTransport;
  lastSeen: number;
}

export interface McpHandler {
  handleMcpRequest(req: Request, res: Response): Promise<void>;
  closeAll(): Promise<void>;
  sessionCount(): number;
}

export interface McpHandlerOptions {
  /** Porta atual do daemon; usada para montar os `Host` aceitos (o SDK compara o header inteiro, com porta). */
  getPort?: () => number;
  /** Tempo de ociosidade, em ms, após o qual uma sessão é encerrada. Padrão: 30 min. */
  sessionTtlMs?: number;
  /** Motor de render (screenshot, layout, SVG medido). */
  render?: RenderProvider;
  /** Pasta de dados do daemon. */
  dataDir?: string;
  /** Serviços da fase 9; o assistente resolve o token `?turn=` das sessões abertas pelo agente. */
  services?: DaemonServices;
}

/** Token de turno do assistente: query `?turn=` ou header `x-mockup-turn`. */
function turnTokenOf(req: Request): string | undefined {
  const q = req.query?.['turn'];
  const fromQuery = Array.isArray(q) ? q[0] : q;
  if (typeof fromQuery === 'string' && fromQuery) return fromQuery;
  const h = req.headers['x-mockup-turn'];
  const fromHeader = Array.isArray(h) ? h[0] : h;
  return fromHeader || undefined;
}

export const DEFAULT_SESSION_TTL_MS = 30 * 60 * 1000;

export function createMcpHandler(store: DocumentStore, opts: McpHandlerOptions = {}): McpHandler {
  const sessions = new Map<string, Session>();
  const ttl = opts.sessionTtlMs ?? DEFAULT_SESSION_TTL_MS;

  const jsonRpcError = (res: Response, status: number, code: number, message: string): void => {
    res.status(status).json({ jsonrpc: '2.0', error: { code, message }, id: null });
  };

  const sweep = setInterval(
    () => {
      const now = Date.now();
      for (const [id, s] of [...sessions]) {
        if (now - s.lastSeen > ttl) {
          sessions.delete(id);
          s.server.close().catch(() => undefined);
        }
      }
    },
    Math.max(10, Math.min(ttl / 2, 60_000)),
  );
  sweep.unref();

  return {
    async handleMcpRequest(req, res) {
      try {
        const header = req.headers['mcp-session-id'];
        const sid = Array.isArray(header) ? header[0] : header;
        if (sid) {
          const s = sessions.get(sid);
          if (!s) {
            jsonRpcError(res, 404, -32001, 'Sessão não encontrada');
            return;
          }
          s.lastSeen = Date.now();
          await s.transport.handleRequest(req, res, req.body);
          s.lastSeen = Date.now();
          return;
        }
        if (req.method === 'POST' && isInitializeRequest(req.body)) {
          const token = turnTokenOf(req);
          if (token && !opts.services?.assistant?.resolveTurn(token)) {
            jsonRpcError(res, 403, -32002, 'Turno do assistente inexistente ou encerrado.');
            return;
          }
          const assistant = opts.services?.assistant;
          const server = createMcpServer(store, {
            render: opts.render,
            dataDir: opts.dataDir,
            getPort: opts.getPort,
            services: opts.services,
            turn: token && assistant ? () => assistant.resolveTurn(token) : undefined,
          });
          const port = opts.getPort?.();
          const transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: () => randomUUID(),
            enableDnsRebindingProtection: true,
            allowedHosts:
              port !== undefined
                ? [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`]
                : undefined,
            onsessioninitialized: (id) => {
              sessions.set(id, { server, transport, lastSeen: Date.now() });
            },
          });
          transport.onclose = () => {
            if (transport.sessionId) sessions.delete(transport.sessionId);
          };
          await server.connect(transport);
          await transport.handleRequest(req, res, req.body);
          return;
        }
        jsonRpcError(
          res,
          400,
          -32000,
          'Requisição inválida: sessão ausente. Envie initialize primeiro.',
        );
      } catch (e) {
        if (!res.headersSent) {
          jsonRpcError(res, 500, -32603, e instanceof Error ? e.message : 'Erro interno');
        }
      }
    },
    async closeAll() {
      clearInterval(sweep);
      const all = [...sessions.values()];
      sessions.clear();
      await Promise.allSettled(all.map((s) => s.server.close()));
    },
    sessionCount: () => sessions.size,
  };
}
