/** Pure functions of the assistant panel. */
import type { AssistantBackendInfo, AssistantToolCall } from '@mockup/core';

/** Text of the context indicator below the message field. */
export function contextLabel(selectionCount: number): string {
  if (selectionCount === 0) return 'no selection — the whole document';
  if (selectionCount === 1) return '1 node selected';
  return `${selectionCount} nodes selected`;
}

/** Footer of a turn that changed the document. */
export function opsLabel(opsCount: number): string {
  return `${opsCount} ${opsCount === 1 ? 'change' : 'changes'} — Ctrl+Z undoes the turn`;
}

/** `true` if no known backend is available. */
export function noBackendAvailable(backends: AssistantBackendInfo[]): boolean {
  return !backends.some((b) => b.available);
}

/** Short tool name (strips the `mcp__server__` prefix). */
export function toolLabel(name: string): string {
  const i = name.lastIndexOf('__');
  return i >= 0 ? name.slice(i + 2) : name;
}

export type ToolStatus = 'running' | 'ok' | 'error';
export function toolStatus(tool: AssistantToolCall): ToolStatus {
  return tool.ok === undefined ? 'running' : tool.ok ? 'ok' : 'error';
}
