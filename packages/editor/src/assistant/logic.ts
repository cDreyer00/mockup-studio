/** Funções puras do painel do assistente. */
import type { AssistantBackendInfo, AssistantToolCall } from '@mockup/core';

/** Texto do indicador de contexto sob o campo de mensagem. */
export function contextLabel(selectionCount: number): string {
  if (selectionCount === 0) return 'sem seleção — o documento inteiro';
  if (selectionCount === 1) return '1 nó selecionado';
  return `${selectionCount} nós selecionados`;
}

/** Rodapé de um turno que alterou o documento. */
export function opsLabel(opsCount: number): string {
  return `${opsCount} ${opsCount === 1 ? 'alteração' : 'alterações'} — Ctrl+Z desfaz o turno`;
}

/** `true` se nenhum backend conhecido está disponível. */
export function noBackendAvailable(backends: AssistantBackendInfo[]): boolean {
  return !backends.some((b) => b.available);
}

/** Nome curto da ferramenta (tira o prefixo `mcp__servidor__`). */
export function toolLabel(name: string): string {
  const i = name.lastIndexOf('__');
  return i >= 0 ? name.slice(i + 2) : name;
}

export type ToolStatus = 'running' | 'ok' | 'error';
export function toolStatus(tool: AssistantToolCall): ToolStatus {
  return tool.ok === undefined ? 'running' : tool.ok ? 'ok' : 'error';
}
