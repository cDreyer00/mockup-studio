import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Document, NodePath, Op } from '@mockup/core';
import type { RenderProvider } from '../render.js';
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
  .describe('Id do documento (padrão: documento ativo).');

/** Erro de uso (mensagem em português dizendo o que fazer); vira `isError` na resposta. */
export class ToolError extends Error {}

/** Resultado de ferramenta com imagens (a imagem vem antes do texto). */
export interface RichResult {
  text: string;
  images?: { data: string; mimeType: string }[];
}

export interface McpServerOptions {
  /** Motor de render (Electron). Ausente: ferramentas de screenshot informam que não há render. */
  render?: RenderProvider;
  dataDir?: string;
  /** Porta do daemon (para a mensagem de render indisponível). */
  getPort?: () => number;
}

export interface ToolContext {
  server: McpServer;
  store: DocumentStore;
  opts: McpServerOptions;
  tool<S extends z.ZodRawShape>(
    name: string,
    cfg: { title: string; description: string; inputSchema: S; annotations?: Annotations },
    handler: (args: z.infer<z.ZodObject<S>>) => Promise<string | RichResult> | string | RichResult,
  ): void;
  requireNode(doc: Document, id: string): NodePath;
  summaryOf(doc: Document, ids: string[], fallbackIds?: string[]): string;
  apply(docId: string, ops: Op[], label?: string): ReturnType<DocumentStore['applyOps']>;
  selectedOrFirstFrame(docId: string, doc: Document): string;
}
