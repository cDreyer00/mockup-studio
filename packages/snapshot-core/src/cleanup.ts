/**
 * Simplificação pós-import (pura, sem DOM): calcula as ops que limpam um frame importado.
 * Usada pela ferramenta MCP `cleanup_imported` e pelo botão do editor (mesma lógica).
 */
import type { Document, Op } from '@mockup/core';

export interface CleanupOptions {
  /** Remove wrappers vazios (sem filhos, sem texto e sem estilo visual). Padrão true. */
  removeEmpty?: boolean;
  /** Desembrulha wrappers sem estilo visual que têm um único filho. Padrão true. */
  unwrap?: boolean;
  /** Converte px fixos em auto/fill quando equivalem ao tamanho do pai ou do conteúdo. Padrão true. */
  fluid?: boolean;
}

export interface CleanupPlan {
  /** Ops na ordem de aplicação (uma única entrada no histórico). */
  ops: Op[];
  removed: number;
  unwrapped: number;
  /** Propriedades de tamanho convertidas. */
  fluid: number;
}

/** Calcula a limpeza da subárvore de `nodeId` (o próprio nó nunca é removido). */
export function planCleanup(doc: Document, nodeId: string, opts: CleanupOptions = {}): CleanupPlan {
  void doc;
  void nodeId;
  void opts;
  throw new Error('planCleanup: não implementado');
}
