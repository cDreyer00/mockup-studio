/**
 * Contratos dos serviços da fase 9 (assistente, scripts e remix) compartilhados pelo WebSocket, pelo
 * MCP e entre os próprios serviços. As implementações ficam em `agent/`, `scripts/` e `remix.ts`.
 */
import type {
  AssistantBackendInfo,
  AssistantConfig,
  AssistantEvent,
  AssistantMessage,
  ClientMessage,
  RemixKind,
  RemixResult,
  ScriptFileInfo,
  ScriptRunResult,
  ServerMessage,
} from '@mockup/core';

/** Ligação de uma sessão MCP a um turno do assistente (o agente da CLI conecta com `?turn=<token>`). */
export interface TurnBinding {
  turnId: string;
  docId: string;
  /** Grupo de undo do turno: todas as ops do agente no turno viram uma única entrada. */
  group: string;
}

/**
 * Resolve o token de turno de uma sessão MCP. `undefined` = sessão comum (sem turno); `null` = o
 * token é de um turno que já terminou ou foi cancelado (as escritas devem ser recusadas).
 */
export type TurnResolver = () => TurnBinding | null | undefined;

export interface RunTurnOptions {
  /** Seleção usada como contexto (padrão: a seleção do daemon). */
  selection?: string[];
  /** Backend do turno (padrão: o da configuração). */
  backend?: string;
  /**
   * Grupo de undo a usar (ex.: um remix com IA chamado de dentro de outro turno reaproveita o
   * grupo dele). Padrão: um grupo novo por turno.
   */
  group?: string;
  /** Texto extra de instruções (ex.: o pedido de variações do remix). */
  instructions?: string;
  /** Não grava o turno no histórico do documento. */
  ephemeral?: boolean;
}

export interface AssistantServiceApi {
  /** Mensagens WS `assistant:*`. */
  handle(msg: ClientMessage): Promise<unknown>;
  /** Inicia um turno e devolve logo o id; o resultado chega pelos eventos. */
  send(docId: string, prompt: string, opts?: RunTurnOptions): Promise<{ turnId: string }>;
  /** Roda um turno inteiro e devolve a mensagem final do assistente. */
  runTurn(docId: string, prompt: string, opts?: RunTurnOptions): Promise<AssistantMessage>;
  /** Cancela o turno em andamento do documento. */
  cancel(docId: string): boolean;
  /** Pergunta só de texto, sem MCP e sem ferramentas (ex.: gerar um script). */
  generateText(prompt: string, opts?: { backend?: string; system?: string }): Promise<string>;
  resolveTurn(token: string): TurnBinding | null;
  backends(): Promise<AssistantBackendInfo[]>;
  getConfig(): AssistantConfig;
  history(docId: string): Promise<AssistantMessage[]>;
  onEvent(fn: (docId: string, event: AssistantEvent) => void): () => void;
  close(): Promise<void>;
}

export interface ScriptRunOptions {
  /** Seleção vista por `doc.selection()`. */
  selection?: string[];
  /** Grupo de undo (padrão: um grupo novo por execução). */
  group?: string;
  /** Quem originou as ops (`editor` pelo painel, `mcp` pelo run_script). */
  source?: 'editor' | 'mcp';
  timeoutMs?: number;
}

export interface ScriptServiceApi {
  /** Mensagens WS `script:*`. */
  handle(msg: ClientMessage): Promise<unknown>;
  run(docId: string, code: string, opts?: ScriptRunOptions): Promise<ScriptRunResult>;
  list(docId: string): Promise<{ dir: string | null; scripts: ScriptFileInfo[] }>;
  read(docId: string, name: string): Promise<{ name: string; code: string }>;
  save(docId: string, name: string, code: string): Promise<{ name: string }>;
  remove(docId: string, name: string): Promise<void>;
  generate(docId: string, prompt: string): Promise<{ code: string }>;
}

export interface RemixOptions {
  count?: number;
  prompt?: string;
  group?: string;
  source?: 'editor' | 'mcp';
}

export interface RemixServiceApi {
  /** Mensagem WS `remix`. */
  handle(msg: ClientMessage): Promise<unknown>;
  run(docId: string, nodeId: string, kind: RemixKind, opts?: RemixOptions): Promise<RemixResult>;
}

/** Serviços opcionais do daemon, passados ao WS e ao MCP. */
export interface DaemonServices {
  assistant?: AssistantServiceApi;
  scripts?: ScriptServiceApi;
  remix?: RemixServiceApi;
}

/** Encaminha as mensagens WS da fase 9 ao serviço certo (`undefined` = não é deste grupo). */
export function routeServiceMessage(
  services: DaemonServices,
  msg: ClientMessage,
): Promise<unknown> | undefined {
  const t = msg.type;
  const missing = (name: string): never => {
    throw new Error(`${name} indisponível neste daemon.`);
  };
  if (t.startsWith('assistant:')) return (services.assistant ?? missing('Assistente')).handle(msg);
  if (t.startsWith('script:')) return (services.scripts ?? missing('Scripts')).handle(msg);
  if (t === 'remix') return (services.remix ?? missing('Remix')).handle(msg);
  return undefined;
}

/** Eventos dos serviços repassados a todos os clientes WS. */
export function attachServiceEvents(
  services: DaemonServices,
  broadcast: (msg: ServerMessage) => void,
): () => void {
  const off = services.assistant?.onEvent((docId, event) =>
    broadcast({ type: 'assistant:event', docId, event }),
  );
  return () => off?.();
}
