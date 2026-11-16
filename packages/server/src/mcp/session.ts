import { randomUUID } from 'node:crypto';
import type { Request, Response } from 'express';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import type { DocumentStore } from '../store.js';
import { createMcpServer } from './server.js';

interface Session {
  server: McpServer;
  transport: StreamableHTTPServerTransport;
}

export interface McpHandler {
  handleMcpRequest(req: Request, res: Response): Promise<void>;
  closeAll(): Promise<void>;
  sessionCount(): number;
}

export function createMcpHandler(store: DocumentStore): McpHandler {
  const sessions = new Map<string, Session>();

  const badRequest = (res: Response, message: string): void => {
    res.status(400).json({ jsonrpc: '2.0', error: { code: -32000, message }, id: null });
  };

  return {
    async handleMcpRequest(req, res) {
      try {
        const header = req.headers['mcp-session-id'];
        const sid = Array.isArray(header) ? header[0] : header;
        if (sid && sessions.has(sid)) {
          await sessions.get(sid)!.transport.handleRequest(req, res, req.body);
          return;
        }
        if (!sid && req.method === 'POST' && isInitializeRequest(req.body)) {
          const server = createMcpServer(store);
          const transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: () => randomUUID(),
            onsessioninitialized: (id) => {
              sessions.set(id, { server, transport });
            },
          });
          transport.onclose = () => {
            if (transport.sessionId) sessions.delete(transport.sessionId);
          };
          await server.connect(transport);
          await transport.handleRequest(req, res, req.body);
          return;
        }
        badRequest(res, 'Bad Request: sessão inválida ou ausente');
      } catch (e) {
        if (!res.headersSent) {
          res.status(500).json({
            jsonrpc: '2.0',
            error: { code: -32603, message: e instanceof Error ? e.message : 'Erro interno' },
            id: null,
          });
        }
      }
    },
    async closeAll() {
      const all = [...sessions.values()];
      sessions.clear();
      await Promise.allSettled(all.map((s) => s.server.close()));
    },
    sessionCount: () => sessions.size,
  };
}
