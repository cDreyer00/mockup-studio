/**
 * Protocolo WebSocket entre o daemon (`@mockup/server`) e os clientes (editor).
 * Mensagens JSON, uma por frame. Compartilhado por servidor e editor via `@mockup/core`.
 */
import type { Document } from './types.js';
import type { Op } from './ops.js';

export type OpSource = 'editor' | 'mcp' | 'system';

export interface OpenDocumentInfo {
  docId: string;
  name: string;
  /** Caminho absoluto em disco (ou `null` se ainda não salvo). */
  path: string | null;
  dirty: boolean;
  revision: number;
}

/** Estado das pilhas de undo/redo de um documento (para habilitar os botões do editor). */
export interface HistoryState {
  canUndo: boolean;
  canRedo: boolean;
}

/* ---------- servidor → cliente ---------- */

export interface HelloEvent {
  type: 'hello';
  documents: OpenDocumentInfo[];
  activeDocId: string | null;
  /** Documento ativo completo (ou null). */
  doc: Document | null;
  selection: string[];
  revision: number;
  /** Histórico do documento ativo (`{ canUndo: false, canRedo: false }` sem documento). */
  history: HistoryState;
}
export interface DocOpenedEvent {
  type: 'doc:opened';
  info: OpenDocumentInfo;
  doc: Document;
  history: HistoryState;
}
export interface DocChangedEvent {
  type: 'doc:changed';
  docId: string;
  ops: Op[];
  source: OpSource;
  revision: number;
  /** Documento completo após as ops (incluído no MVP para simplificar os clientes). */
  doc: Document;
  history: HistoryState;
}
export interface DocSavedEvent {
  type: 'doc:saved';
  docId: string;
  path: string;
}
export interface DocClosedEvent {
  type: 'doc:closed';
  docId: string;
}
export interface SelectionChangedEvent {
  type: 'selection:changed';
  docId: string;
  nodeIds: string[];
  source: OpSource;
}
export interface ActiveChangedEvent {
  type: 'active:changed';
  docId: string | null;
}
/** O agente terminou de mexer nos nós (`finish_working`): o editor apaga o indicador "IA" dos frames. */
export interface AgentFinishedEvent {
  type: 'agent:finished';
  docId: string;
  /** Nós informados pelo agente; vazio = todos os frames do documento. */
  nodeIds: string[];
}
export interface AckMessage {
  type: 'ack';
  reqId: string;
  result?: unknown;
}
export interface ErrorMessage {
  type: 'error';
  reqId?: string;
  message: string;
}

/* ---------- assistente de IA, scripts e remix (fase 9) ---------- */

/** Backend de agente conhecido pelo daemon (CLI instalada ou API). */
export interface AssistantBackendInfo {
  /** `claude`, `codex` (CLIs) ou outro backend registrado (ex.: `fake` nos testes). */
  id: string;
  name: string;
  available: boolean;
  /** Executável encontrado no PATH (CLIs). */
  path?: string;
  /** Motivo de indisponibilidade ou versão. */
  detail?: string;
}

/** Configuração do assistente (persistida na pasta de dados do daemon). */
export interface AssistantConfig {
  /** `auto` = o primeiro disponível (claude, depois codex). */
  backend: string;
  /**
   * Modelo do backend configurado (`backend`), repassado à CLI; vazio = padrão da CLI. Na leitura é um
   * atalho para `models[backend]`; na escrita vale para o backend do mesmo patch (ou o atual).
   */
  model?: string;
  /** Modelo por id de backend (um modelo do Claude não serve ao Codex); ausente = padrão da CLI. */
  models?: Record<string, string>;
}

export interface AssistantToolCall {
  id: string;
  name: string;
  input?: unknown;
  ok?: boolean;
  /** Resumo curto do resultado (primeira linha, até ~200 caracteres). */
  summary?: string;
}

export type AssistantTurnStatus = 'running' | 'done' | 'cancelled' | 'error';

/** Mensagem do histórico do assistente de um documento. */
export interface AssistantMessage {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  at: string;
  turnId: string;
  /** Só nas mensagens do assistente. */
  tools?: AssistantToolCall[];
  status?: AssistantTurnStatus;
  error?: string;
  backend?: string;
  /** Ops aplicadas pelo agente no turno (todas num único grupo de undo). */
  opsCount?: number;
  /** Seleção enviada como contexto (mensagem do usuário). */
  selection?: string[];
}

/** Evento de streaming de um turno do assistente. */
export type AssistantEvent =
  | { kind: 'turn-start'; turnId: string; user: AssistantMessage; backend: string }
  | { kind: 'text'; turnId: string; text: string }
  | { kind: 'tool'; turnId: string; tool: AssistantToolCall }
  | { kind: 'tool-result'; turnId: string; toolId: string; ok: boolean; summary?: string }
  | { kind: 'turn-end'; turnId: string; message: AssistantMessage }
  | { kind: 'cleared' };

export interface AssistantEventMessage {
  type: 'assistant:event';
  docId: string;
  event: AssistantEvent;
}

/** Imagem produzida por `doc.screenshot()` num script. */
export interface ScriptImage {
  nodeId: string;
  mime: string;
  /** Base64. */
  data: string;
  width: number;
  height: number;
}

export interface ScriptRunResult {
  ok: boolean;
  /** Saída de `console.log/info/warn/error`, uma linha por chamada. */
  logs: string[];
  /** Valor devolvido pelo script (serializado em JSON; `undefined` vira ausente). */
  result?: unknown;
  error?: string;
  images: ScriptImage[];
  /** Ops aplicadas (todas num único grupo de undo). */
  opsCount: number;
  durationMs: number;
}

export interface ScriptFileInfo {
  /** Nome do arquivo em `scripts/`, com `.js`. */
  name: string;
  size: number;
  updatedAt: string;
}

/** Tipos de remix: locais e determinísticos, ou com IA. */
export type RemixKind = 'color-scale' | 'font-pairs' | 'spacing' | 'layout' | 'ai';

export interface RemixResult {
  /** Frames criados lado a lado (vazio no `ai` até o turno terminar). */
  frameIds: string[];
  /** Nome de cada variação, paralelo a `frameIds`. */
  labels: string[];
  /** Turno do assistente (`ai`). */
  turnId?: string;
}

export type ServerMessage =
  | HelloEvent
  | DocOpenedEvent
  | DocChangedEvent
  | DocSavedEvent
  | DocClosedEvent
  | SelectionChangedEvent
  | ActiveChangedEvent
  | AgentFinishedEvent
  | AssistantEventMessage
  | AckMessage
  | ErrorMessage;

/* ---------- cliente → servidor ---------- */

export interface OpApplyRequest {
  type: 'op:apply';
  reqId: string;
  docId: string;
  ops: Op[];
}
export interface SelectionSetRequest {
  type: 'selection:set';
  reqId: string;
  docId: string;
  nodeIds: string[];
}
export interface DocOpenRequest {
  type: 'doc:open';
  reqId: string;
  path: string;
}
export interface DocSaveRequest {
  type: 'doc:save';
  reqId: string;
  docId?: string;
}
export interface UndoRequest {
  type: 'undo';
  reqId: string;
  docId?: string;
}
export interface RedoRequest {
  type: 'redo';
  reqId: string;
  docId?: string;
}
export interface ActiveSetRequest {
  type: 'active:set';
  reqId: string;
  docId: string;
}

export interface DocNewRequest {
  type: 'doc:new';
  reqId: string;
  /** Caminho do arquivo (normalizado para `.mockup.json`; nunca sobrescreve). */
  path: string;
  name: string;
}
export interface DocCloseRequest {
  type: 'doc:close';
  reqId: string;
  docId: string;
}

/** Salva o documento em outro caminho (sobrescreve; o diálogo nativo já confirmou) e copia `assets/`. */
export interface DocSaveAsRequest {
  type: 'doc:saveAs';
  reqId: string;
  docId?: string;
  path: string;
}

/** Envia um prompt ao assistente (um turno). Ack: `{ turnId }`; o resto chega por `assistant:event`. */
export interface AssistantSendRequest {
  type: 'assistant:send';
  reqId: string;
  docId: string;
  prompt: string;
  /** Seleção usada como contexto (padrão: a seleção do daemon). */
  selection?: string[];
  /** Backend do turno (padrão: o da configuração). */
  backend?: string;
}
/** Cancela o turno em andamento do documento. Ack: `{ cancelled }`. */
export interface AssistantCancelRequest {
  type: 'assistant:cancel';
  reqId: string;
  docId: string;
}
/** Histórico e estado. Ack: `{ messages, running, backends, config }`. */
export interface AssistantHistoryRequest {
  type: 'assistant:history';
  reqId: string;
  docId: string;
}
export interface AssistantClearRequest {
  type: 'assistant:clear';
  reqId: string;
  docId: string;
}
/** Lê (sem campos) ou grava a configuração. Ack: `{ config, backends }`. */
export interface AssistantConfigRequest {
  type: 'assistant:config';
  reqId: string;
  config?: Partial<AssistantConfig>;
}

/** Executa um script (um grupo de undo). Ack: `ScriptRunResult`. */
export interface ScriptRunRequest {
  type: 'script:run';
  reqId: string;
  docId: string;
  code: string;
  /** Seleção vista por `doc.selection()` (padrão: a do daemon). */
  selection?: string[];
}
/** Biblioteca `scripts/*.js` ao lado do documento. Ack: `{ dir, scripts: ScriptFileInfo[] }`. */
export interface ScriptListRequest {
  type: 'script:list';
  reqId: string;
  docId: string;
}
/** Ack: `{ name, code }`. */
export interface ScriptReadRequest {
  type: 'script:read';
  reqId: string;
  docId: string;
  name: string;
}
/** Ack: `{ name }` (nome normalizado, com `.js`). */
export interface ScriptSaveRequest {
  type: 'script:save';
  reqId: string;
  docId: string;
  name: string;
  code: string;
}
export interface ScriptDeleteRequest {
  type: 'script:delete';
  reqId: string;
  docId: string;
  name: string;
}
/** Gera um script a partir de um prompt (via backend do assistente). Ack: `{ code }`. */
export interface ScriptGenerateRequest {
  type: 'script:generate';
  reqId: string;
  docId: string;
  prompt: string;
}

/** Gera variações de um nó lado a lado. Ack: `RemixResult`. */
export interface RemixRequest {
  type: 'remix';
  reqId: string;
  docId: string;
  nodeId: string;
  kind: RemixKind;
  count?: number;
  /** Obrigatório em `ai`. */
  prompt?: string;
}

export type ClientMessage =
  | OpApplyRequest
  | SelectionSetRequest
  | DocOpenRequest
  | DocSaveRequest
  | UndoRequest
  | RedoRequest
  | ActiveSetRequest
  | DocNewRequest
  | DocCloseRequest
  | DocSaveAsRequest
  | AssistantSendRequest
  | AssistantCancelRequest
  | AssistantHistoryRequest
  | AssistantClearRequest
  | AssistantConfigRequest
  | ScriptRunRequest
  | ScriptListRequest
  | ScriptReadRequest
  | ScriptSaveRequest
  | ScriptDeleteRequest
  | ScriptGenerateRequest
  | RemixRequest;
