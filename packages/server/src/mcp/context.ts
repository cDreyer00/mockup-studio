import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Document, NodePath, Op } from '@mockup/core';
import type { RenderProvider } from '../render.js';
import type { DaemonServices, TurnResolver } from '../services.js';
import type { DocumentStore } from '../store.js';

export type Annotations = {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
};

export const READ: Annotations = { readOnlyHint: true };
export const WRITE: Annotations = { readOnlyHint: false, destructiveHint: false };
export const DESTRUCTIVE: Annotations = { readOnlyHint: false, destructiveHint: true };

export const docIdField = z
  .string()
  .optional()
  .describe('Document id, e.g. "doc_ab12cd34" (default: active document; see list_documents).');

/** Usage error (message saying what to do); becomes `isError` in the response. */
export class ToolError extends Error {}

/** Tool result with images (the image comes before the text). */
export interface RichResult {
  text: string;
  images?: { data: string; mimeType: string }[];
}

export interface McpServerOptions {
  /** Render engine (Electron). Absent: screenshot tools report that there is no render. */
  render?: RenderProvider;
  dataDir?: string;
  /** Daemon port (for the render-unavailable message). */
  getPort?: () => number;
  /** Phase 9 services (scripts, remix, assistant). */
  services?: DaemonServices;
  /** Session opened by an assistant agent (`/mcp?turn=<token>`): ties the ops to the turn. */
  turn?: TurnResolver;
}

/** Tool configuration. `example` is a correct call, quoted in parameter errors. */
export interface ToolConfig<S extends z.ZodRawShape> {
  title: string;
  description: string;
  inputSchema: S;
  annotations?: Annotations;
  example: Record<string, unknown>;
}

export interface ToolContext {
  server: McpServer;
  store: DocumentStore;
  opts: McpServerOptions;
  tool<S extends z.ZodRawShape>(
    name: string,
    cfg: ToolConfig<S>,
    handler: (args: z.infer<z.ZodObject<S>>) => Promise<string | RichResult> | string | RichResult,
  ): void;
  /** Node for WRITING (real, or virtual id/main component node): instances are not expanded. */
  requireNode(doc: Document, id: string): NodePath;
  /**
   * Node for READING: also accepts virtual ids (`in_x/...`) and main component nodes, reading from
   * the expanded document (instance = expanded HTML); `doc` is the document the node lives in.
   */
  readNode(doc: Document, id: string): { path: NodePath; doc: Document };
  summaryOf(doc: Document, ids: string[], fallbackIds?: string[]): string;
  apply(docId: string, ops: Op[], label?: string): ReturnType<DocumentStore['applyOps']>;
  /**
   * Undo group of the session: that of the assistant turn that opened the session, or `undefined`
   * (regular session). Throws `ToolError` if the turn has already ended (a canceled agent no longer writes).
   */
  group(): string | undefined;
  selectedOrFirstFrame(docId: string, doc: Document): string;
}
