/**
 * Contrato de um backend de agente do assistente. As CLIs (Claude Code, Codex) implementam por
 * subprocesso (`cli.ts`); uma API direta pode implementar o mesmo contrato depois.
 */
import type { AssistantBackendInfo } from '@mockup/core';

/** Servidor MCP que o agente deve usar no turno (o do próprio daemon, com o token do turno). */
export interface AgentMcpServer {
  /** Nome do servidor na config do agente (ferramentas `mcp__<name>__<tool>` no Claude Code). */
  name: string;
  /** URL Streamable HTTP, ex.: `http://127.0.0.1:4747/mcp?turn=<token>`. */
  url: string;
}

export interface AgentImage {
  mime: string;
  /** Base64. */
  data: string;
}

export interface AgentRunInput {
  /** Mensagem do usuário já com o contexto (seleção, resumo da árvore). */
  prompt: string;
  /** Instruções de sistema (papel do assistente, docId, regras). */
  system?: string;
  /** Screenshot da seleção, se houver render. */
  images?: AgentImage[];
  /** MCP do daemon; ausente = turno só de texto (sem ferramentas). */
  mcp?: AgentMcpServer;
  /** Sessão anterior do backend para continuar a conversa (`--resume`); se falhar, começa nova. */
  resumeSession?: string;
  model?: string;
  /** Pasta de trabalho do subprocesso (padrão: temporária). */
  cwd?: string;
}

/** Evento emitido pelo backend durante o turno. */
export type AgentRunEvent =
  | { kind: 'text'; text: string }
  | { kind: 'tool'; id: string; name: string; input?: unknown }
  | { kind: 'tool-result'; id: string; ok: boolean; summary?: string }
  | { kind: 'session'; sessionId: string };

export interface AgentRunResult {
  /** Texto final do assistente (se o backend não emitiu deltas, vale este). */
  text: string;
  sessionId?: string;
  costUsd?: number;
}

export interface AgentBackend {
  readonly id: string;
  readonly name: string;
  /** Disponibilidade (ex.: CLI no PATH). Pode ser cacheada. */
  info(): Promise<AssistantBackendInfo>;
  /**
   * Roda um turno. Deve rejeitar com erro legível em falha e encerrar o subprocesso (árvore
   * inteira) quando `signal` abortar, rejeitando com `AbortError`.
   */
  run(
    input: AgentRunInput,
    emit: (ev: AgentRunEvent) => void,
    signal: AbortSignal,
  ): Promise<AgentRunResult>;
}
