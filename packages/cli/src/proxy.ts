/**
 * Proxy MCP stdio <-> Streamable HTTP.
 *
 * An SDK `Client` connects to the daemon; a low-level `Server` serves over stdio and forwards
 * `tools/list`, `tools/call`, `resources/list`, `resources/templates/list` and `resources/read`.
 * This way the agent (Claude Code, Codex) speaks stdio and the daemon stays single and shared with the editor.
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
 * Only connection errors justify reconnecting and retrying (daemon went down or restarted).
 * Timeouts and application errors do NOT: retrying would duplicate effects such as `write_html`.
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
  log(`connected to the daemon at ${location.mcpUrl}`);

  /** Reconnects and retries once, only if the error is a connection error (daemon went down or restarted). */
  async function withUpstream<T>(fn: (c: Client) => Promise<T>): Promise<T> {
    try {
      return await fn(upstream);
    } catch (err) {
      if (!isConnectionError(err)) throw err;
      log('failed to talk to the daemon; trying to reconnect.', (err as Error).message);
      try {
        await upstream.close();
      } catch {
        /* ignored */
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
    log('stdio closed; shutting down the proxy.');
    try {
      await current.transport.terminateSession();
    } catch {
      /* ignored */
    }
    try {
      await upstream.close();
    } catch {
      /* ignored */
    } finally {
      process.exit(0);
    }
  };
  await server.connect(transport);
}
