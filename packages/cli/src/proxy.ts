/**
 * Proxy MCP stdio <-> Streamable HTTP.
 *
 * Um `Client` do SDK conecta no daemon; um `Server` de baixo nível atende em stdio e repassa
 * `tools/list`, `tools/call`, `resources/list`, `resources/templates/list` e `resources/read`.
 * Assim o agente (Claude Code, Codex) fala stdio e o daemon continua único e compartilhado com o editor.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import {
  StreamableHTTPClientTransport,
  StreamableHTTPError,
} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
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
import { VERSION } from './version.js';

const CLIENT_INFO = { name: 'mockup-cli', version: VERSION };

const NETWORK_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ECONNABORTED',
  'EPIPE',
  'UND_ERR_SOCKET',
]);

function networkCode(e: unknown): boolean {
  const code = (e as { code?: unknown } | null | undefined)?.code;
  return typeof code === 'string' && NETWORK_CODES.has(code);
}

/**
 * Só erros de conexão justificam reconectar e repetir (daemon caiu ou reiniciou).
 * Timeouts e erros de aplicação NÃO: repetir duplicaria efeitos como `write_html`.
 */
export function isConnectionError(err: unknown): boolean {
  if (err === null || typeof err !== 'object') return false;
  const cause = (err as { cause?: unknown }).cause;
  if (networkCode(err) || networkCode(cause)) return true;
  if (err instanceof StreamableHTTPError) return err.code === 404;
  return err instanceof Error && err.message.includes('fetch failed') && !!cause;
}

interface Upstream {
  client: Client;
  transport: StreamableHTTPClientTransport;
}

async function connectUpstream(location: DaemonLocation): Promise<Upstream> {
  const client = new Client(CLIENT_INFO);
  const transport = new StreamableHTTPClientTransport(new URL(location.mcpUrl));
  await client.connect(transport);
  return { client, transport };
}

export async function runStdioProxy(): Promise<void> {
  let location = await ensureDaemon();
  let current = await connectUpstream(location);
  let upstream = current.client;
  log(`conectado ao daemon em ${location.mcpUrl}`);

  /** Reconecta e repete uma vez, apenas se o erro for de conexão (daemon caiu ou reiniciou). */
  async function withUpstream<T>(fn: (c: Client) => Promise<T>): Promise<T> {
    try {
      return await fn(upstream);
    } catch (err) {
      if (!isConnectionError(err)) throw err;
      log('falha ao falar com o daemon; tentando reconectar.', (err as Error).message);
      try {
        await upstream.close();
      } catch {
        /* ignorado */
      }
      location = await ensureDaemon();
      current = await connectUpstream(location);
      upstream = current.client;
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
      await current.transport.terminateSession();
    } catch {
      /* ignorado */
    }
    try {
      await upstream.close();
    } catch {
      /* ignorado */
    } finally {
      process.exit(0);
    }
  };
  await server.connect(transport);
}
