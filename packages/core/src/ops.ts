/**
 * Operações (commands) puras e serializáveis sobre o documento.
 * Cada op tem um inverso exato, calculado em `applyOp` (ver `apply.ts`).
 */
import type { Document, Node, Position } from './types.js';

export interface CreateNodeOp {
  type: 'createNode';
  /** Pai do novo nó. Omitido/null quando o nó é um frame raiz (então `pageId` é obrigatório). */
  parentId?: string | null;
  /** Página destino (obrigatório para frames raiz; opcional caso contrário). */
  pageId?: string;
  /** Nó completo, com id já gerado (ids dos descendentes também). */
  node: Node;
  /** Índice de inserção; omitido = ao final. */
  index?: number;
}

export interface DeleteNodesOp {
  type: 'deleteNodes';
  nodeIds: string[];
}

export interface MoveNodesOp {
  type: 'moveNodes';
  nodeIds: string[];
  /** Novo pai; omitido = mantém o pai atual (reordenação). `null` = virar frame raiz em `pageId`. */
  parentId?: string | null;
  pageId?: string;
  /** Índice destino no novo pai; omitido = ao final. */
  index?: number;
}

export interface StyleChange {
  nodeId: string;
  set?: Record<string, string>;
  unset?: string[];
}
export interface UpdateStylesOp {
  type: 'updateStyles';
  /** Forma em lote: uma entrada por nó. */
  changes?: StyleChange[];
  /** Forma simples: os mesmos estilos para vários nós. */
  nodeIds?: string[];
  styles?: Record<string, string>;
  unset?: string[];
}

export interface SetTextOp {
  type: 'setText';
  /** `null` remove o campo `text` do nó. */
  changes: { nodeId: string; text: string | null }[];
}

export interface SetAttrsOp {
  type: 'setAttrs';
  changes: { nodeId: string; set?: Record<string, string>; unset?: string[] }[];
}

export interface RenameNodesOp {
  type: 'renameNodes';
  changes: { nodeId: string; name: string }[];
}

export interface DuplicateNodesOp {
  type: 'duplicateNodes';
  nodeIds: string[];
  /**
   * Mapa oldId → newId para o nó e todos os descendentes. Se omitido, `applyOp` gera os ids
   * e os devolve em `result.idMap`; a op inversa/registrada deve conter o mapa para ser determinística.
   */
  idMap?: Record<string, string>;
}

export interface SetPositionOp {
  type: 'setPosition';
  /** `null` remove o campo `position` do nó. */
  changes: { nodeId: string; position: Position | null }[];
}

export interface CreatePageOp {
  type: 'createPage';
  pageId: string;
  name: string;
  index?: number;
  background?: string;
  /** Frames já existentes da página (usado pelo inverso de deletePage). */
  frames?: Node[];
}

export interface DeletePageOp {
  type: 'deletePage';
  pageId: string;
}

export interface RenamePageOp {
  type: 'renamePage';
  pageId: string;
  name: string;
}

export interface SetTokensOp {
  type: 'setTokens';
  set?: Record<string, string>;
  unset?: string[];
}

/** Toggle de `locked`/`hidden`. */
export interface SetNodeFlagsOp {
  type: 'setNodeFlags';
  changes: { nodeId: string; locked?: boolean; hidden?: boolean }[];
}

export type Op =
  | CreateNodeOp
  | DeleteNodesOp
  | MoveNodesOp
  | UpdateStylesOp
  | SetTextOp
  | SetAttrsOp
  | RenameNodesOp
  | DuplicateNodesOp
  | SetPositionOp
  | CreatePageOp
  | DeletePageOp
  | RenamePageOp
  | SetTokensOp
  | SetNodeFlagsOp;

export type OpType = Op['type'];

export interface ApplyResult {
  /** Novo documento (o original não é mutado). */
  doc: Document;
  /** Op(s) que desfazem exatamente esta op. */
  inverse: Op[];
  /** Dados extras, ex. `{ idMap }` em duplicateNodes, `{ nodeIds }` em createNode. */
  result?: Record<string, unknown>;
}
