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

export type ServerMessage =
  | HelloEvent
  | DocOpenedEvent
  | DocChangedEvent
  | DocSavedEvent
  | DocClosedEvent
  | SelectionChangedEvent
  | ActiveChangedEvent
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

export type ClientMessage =
  | OpApplyRequest
  | SelectionSetRequest
  | DocOpenRequest
  | DocSaveRequest
  | UndoRequest
  | RedoRequest
  | ActiveSetRequest
  | DocNewRequest
  | DocCloseRequest;
