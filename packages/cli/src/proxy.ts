/**
 * Proxy MCP stdio <-> Streamable HTTP.
 *
 * Um `Client` do SDK conecta no daemon; um `Server` de baixo nível atende em stdio e repassa
 * `tools/list`, `tools/call`, `resources/list`, `resources/templates/list` e `resources/read`.
 * Assim o agente (Claude Code, Codex) fala stdio e o daemon continua único e compartilhado com o editor.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListResourceTemplatesRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
  type CallToolResult,
} from '@modelcontextprotocol/sdk/types.js';
import { ensureDaemon, log, type DaemonLocation } from './discover.js';

const CLIENT_INFO = { name: 'mockup-cli', version: '0.1.0' };

async function connectUpstream(location: DaemonLocation): Promise<Client> {
  const client = new Client(CLIENT_INFO);
  await client.connect(new StreamableHTTPClientTransport(new URL(location.mcpUrl)));
  return client;
}

export async function runStdioProxy(): Promise<void> {
  let location = await ensureDaemon();
  let upstream = await connectUpstream(location);
  log(`conectado ao daemon em ${location.mcpUrl}`);

  /** Reconecta uma vez se o daemon caiu (ou foi reiniciado) entre chamadas. */
  async function withUpstream<T>(fn: (c: Client) => Promise<T>): Promise<T> {
    try {
      return await fn(upstream);
    } catch (err) {
      log('falha ao falar com o daemon; tentando reconectar.', (err as Error).message);
      try {
        await upstream.close();
      } catch {
        /* ignorado */
      }
      location = await ensureDaemon();
      upstream = await connectUpstream(location);
      return fn(upstream);
    }
  }

  const info = upstream.getServerVersion();
  const server = new Server(
    { name: info?.name ?? 'mockup-studio', version: info?.version ?? '0.1.0' },
    {
      capabilities: { tools: {}, resources: {} },
      instructions: upstream.getInstructions(),
    },
  );

  server.setRequestHandler(ListToolsRequestSchema, async (req) =>
    withUpstream((c) => c.listTools(req.params)),
  );
  server.setRequestHandler(CallToolRequestSchema, async (req) =>
    withUpstream(async (c) => (await c.callTool(req.params)) as CallToolResult),
  );
  server.setRequestHandler(ListResourcesRequestSchema, async (req) =>
    withUpstream((c) => c.listResources(req.params)),
  );
  server.setRequestHandler(ListResourceTemplatesRequestSchema, async (req) =>
    withUpstream((c) => c.listResourceTemplates(req.params)),
  );
  server.setRequestHandler(ReadResourceRequestSchema, async (req) =>
    withUpstream((c) => c.readResource(req.params)),
  );

  const transport = new StdioServerTransport();
  transport.onclose = async () => {
    log('stdio fechado; encerrando proxy.');
    try {
      await upstream.close();
    } finally {
      process.exit(0);
    }
  };
  await server.connect(transport);
}
