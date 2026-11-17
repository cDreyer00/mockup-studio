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
  .describe('Id do documento, ex.: "doc_ab12cd34" (padrão: documento ativo; veja list_documents).');

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
  /** Serviços da fase 9 (scripts, remix, assistente). */
  services?: DaemonServices;
  /** Sessão aberta por um agente do assistente (`/mcp?turn=<token>`): liga as ops ao turno. */
  turn?: TurnResolver;
}

/** Configuração de uma ferramenta. `example` é uma chamada correta, citada nos erros de parâmetro. */
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
  /** Nó para ESCRITA (real, ou id virtual/nó de principal): instâncias não são expandidas. */
  requireNode(doc: Document, id: string): NodePath;
  /**
   * Nó para LEITURA: aceita também ids virtuais (`in_x/...`) e nós de principais, lendo do documento
   * expandido (instância = HTML expandido); `doc` é o documento em que o nó vive.
   */
  readNode(doc: Document, id: string): { path: NodePath; doc: Document };
  summaryOf(doc: Document, ids: string[], fallbackIds?: string[]): string;
  apply(docId: string, ops: Op[], label?: string): ReturnType<DocumentStore['applyOps']>;
  /**
   * Grupo de undo da sessão: o do turno do assistente que abriu a sessão, ou `undefined` (sessão
   * comum). Lança `ToolError` se o turno já terminou (o agente cancelado não escreve mais).
   */
  group(): string | undefined;
  selectedOrFirstFrame(docId: string, doc: Document): string;
}
