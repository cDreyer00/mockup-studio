/**
 * Builders de ops compartilhados pelo MCP e pelo editor (cada um devolve as ops de uma única
 * entrada de undo). Lançam `Error` com mensagem em português quando a entrada não serve.
 */
import type { Op } from '../ops.js';
import type { Document, Node, Vector } from '../types.js';
import type { BooleanOp } from './boolean.js';
import type { Box } from './path.js';

/** `[{ type: 'setVector', changes: [{ nodeId, vector }] }]`. */
export function buildSetVectorOps(nodeId: string, vector: Vector | null): Op[] {
  return [{ type: 'setVector', changes: [{ nodeId, vector }] }];
}

/**
 * Caixa do nó no pai, em px, lida do estilo: `left`/`top` (padrão 0) e `width`/`height` em px
 * (padrão: viewBox do vetor). `null` se width/height não forem px nem houver viewBox.
 */
export function nodeBoxInParent(node: Node): Box | null {
  void node;
  throw new Error('não implementado');
}

/**
 * Booleana entre nós svg irmãos (2 ou mais, com paths editáveis; nós sem `vector` usam
 * `ensureVector`). Cada path vai ao espaço do pai (caixa do nó × viewBox). Resultado: um nó svg
 * novo, no lugar do primeiro (mesmo índice), `position: absolute` na caixa do resultado, com o
 * estilo do nó mais ao fundo (sem left/top/width/height) e a tinta do primeiro path dele; os
 * originais são removidos. Ordem dos nós = ordem no pai (o de baixo é o "primeiro" do subtract).
 */
export function buildBooleanOps(
  doc: Document,
  nodeIds: string[],
  op: BooleanOp,
  opts: { name?: string; id?: string } = {},
): { ops: Op[]; nodeId: string } {
  void doc;
  void nodeIds;
  void op;
  void opts;
  throw new Error('não implementado');
}

/**
 * Achatar. Um nó: junta todos os paths num só (`d` concatenado, tinta do primeiro), via
 * `setVector`. Vários nós svg irmãos: um nó novo com os paths de todos levados ao espaço comum
 * (cada um mantém a tinta), no lugar do mais ao fundo; os originais são removidos.
 */
export function buildFlattenOps(
  doc: Document,
  nodeIds: string[],
  opts: { name?: string; id?: string } = {},
): { ops: Op[]; nodeId: string } {
  void doc;
  void nodeIds;
  void opts;
  throw new Error('não implementado');
}
