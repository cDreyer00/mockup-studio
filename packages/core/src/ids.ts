import { customAlphabet } from 'nanoid';
import type { NodeType } from './types.js';

const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz';
const nano = customAlphabet(ALPHABET, 8);

export const ID_PREFIX: Record<NodeType, string> = {
  frame: 'fr_',
  element: 'el_',
  text: 'tx_',
  image: 'im_',
  svg: 'sv_',
  instance: 'in_',
};

/** Gera id curto e estável: `<prefixo>` + 8 chars [0-9a-z]. */
export function newId(prefix: string): string {
  return prefix + nano();
}

export const newNodeId = (type: NodeType): string => newId(ID_PREFIX[type]);
export const newPageId = (): string => newId('pg_');
export const newDocumentId = (): string => newId('doc_');
export const newComponentId = (): string => newId('cp_');

/** Infere o tipo de nó a partir do prefixo do id (ou `undefined` se não reconhecido). */
export function typeFromId(id: string): NodeType | undefined {
  const prefix = id.slice(0, 3);
  return (Object.keys(ID_PREFIX) as NodeType[]).find((t) => ID_PREFIX[t] === prefix);
}
