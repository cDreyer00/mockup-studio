/**
 * Contract for an assistant agent backend. The CLIs (Claude Code, Codex) implement it through a
 * subprocess (`cli.ts`); a direct API can implement the same contract later.
 */
import type { AssistantBackendInfo } from '@mockup/core';

/** MCP server the agent must use during the turn (the daemon's own, with the turn token). */
export interface AgentMcpServer {
  /** Server name in the agent config (`mcp__<name>__<tool>` tools in Claude Code). */
  name: string;
  /** Streamable HTTP URL, e.g.: `http://127.0.0.1:4747/mcp?turn=<token>`. */
  url: string;
}

export interface AgentImage {
  mime: string;
  /** Base64. */
  data: string;
}

export interface AgentRunInput {
  /** User message already including the context (selection, tree summary). */
  prompt: string;
  /** System instructions (assistant role, docId, rules). */
  system?: string;
  /** Screenshot of the selection, if there is a render. */
  images?: AgentImage[];
  /** Daemon MCP; absent = text-only turn (no tools). */
  mcp?: AgentMcpServer;
  /** Previous backend session to continue the conversation (`--resume`); if it fails, starts a new one. */
  resumeSession?: string;
  model?: string;
  /** Working folder of the subprocess (default: temporary). */
  cwd?: string;
}

/** Event emitted by the backend during the turn. */
export type AgentRunEvent =
  | { kind: 'text'; text: string }
  | { kind: 'tool'; id: string; name: string; input?: unknown }
  | { kind: 'tool-result'; id: string; ok: boolean; summary?: string }
  | { kind: 'session'; sessionId: string };

export interface AgentRunResult {
  /** Final assistant text (used if the backend emitted no deltas). */
  text: string;
  sessionId?: string;
  costUsd?: number;
}

export interface AgentBackend {
  readonly id: string;
  readonly name: string;
  /** Availability (e.g. CLI on PATH). May be cached. */
  info(): Promise<AssistantBackendInfo>;
  /**
   * Runs a turn. Must reject with a readable error on failure and kill the subprocess (whole
   * tree) when `signal` aborts, rejecting with `AbortError`.
   */
  run(
    input: AgentRunInput,
    emit: (ev: AgentRunEvent) => void,
    signal: AbortSignal,
  ): Promise<AgentRunResult>;
}
