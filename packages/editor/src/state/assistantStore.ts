/**
 * AI assistant state, per document: message history, turn in progress (partial text
 * and tools with status), plus the backends and the settings (global to the daemon).
 * Only the client (`client/daemon.ts`) and the assistant panel write here.
 */
import { create } from 'zustand';
import type {
  AssistantBackendInfo,
  AssistantConfig,
  AssistantEvent,
  AssistantMessage,
  AssistantToolCall,
} from '@mockup/core';

/** Turn in progress: what has already arrived by streaming. */
export interface PartialTurn {
  turnId: string;
  text: string;
  tools: AssistantToolCall[];
}

export interface DocAssistant {
  messages: AssistantMessage[];
  partial: PartialTurn | null;
  /** `assistant:history` has already been loaded for this document. */
  loaded: boolean;
}

export interface AssistantState {
  byDoc: Record<string, DocAssistant>;
  backends: AssistantBackendInfo[];
  /** `null` until the first daemon response. */
  config: AssistantConfig | null;
}

export const EMPTY_ASSISTANT: DocAssistant = { messages: [], partial: null, loaded: false };

export const useAssistant = create<AssistantState>(() => ({
  byDoc: {},
  backends: [],
  config: null,
}));

function upsertMessage(list: AssistantMessage[], msg: AssistantMessage): AssistantMessage[] {
  const i = list.findIndex((m) => m.id === msg.id);
  if (i < 0) return [...list, msg];
  const next = list.slice();
  next[i] = msg;
  return next;
}

function upsertTool(list: AssistantToolCall[], tool: AssistantToolCall): AssistantToolCall[] {
  const i = list.findIndex((t) => t.id === tool.id);
  if (i < 0) return [...list, tool];
  const next = list.slice();
  next[i] = { ...next[i]!, ...tool };
  return next;
}

/** Applies a streaming event to a document's state. */
export function reduceEvent(cur: DocAssistant, event: AssistantEvent): DocAssistant {
  switch (event.kind) {
    case 'turn-start':
      return {
        ...cur,
        messages: upsertMessage(cur.messages, event.user),
        partial: { turnId: event.turnId, text: '', tools: [] },
      };
    case 'text': {
      const p = cur.partial?.turnId === event.turnId ? cur.partial : null;
      return {
        ...cur,
        partial: {
          turnId: event.turnId,
          text: (p?.text ?? '') + event.text,
          tools: p?.tools ?? [],
        },
      };
    }
    case 'tool': {
      const p = cur.partial?.turnId === event.turnId ? cur.partial : null;
      return {
        ...cur,
        partial: {
          turnId: event.turnId,
          text: p?.text ?? '',
          tools: upsertTool(p?.tools ?? [], event.tool),
        },
      };
    }
    case 'tool-result': {
      const p = cur.partial;
      if (!p || p.turnId !== event.turnId) return cur;
      return {
        ...cur,
        partial: {
          ...p,
          tools: p.tools.map((t) =>
            t.id === event.toolId ? { ...t, ok: event.ok, summary: event.summary ?? t.summary } : t,
          ),
        },
      };
    }
    case 'turn-end':
      return {
        ...cur,
        messages: upsertMessage(cur.messages, event.message),
        partial: cur.partial?.turnId === event.turnId ? null : cur.partial,
      };
    case 'cleared':
      return { ...cur, messages: [], partial: null };
  }
}

export const assistantStore = {
  applyEvent(docId: string, event: AssistantEvent): void {
    useAssistant.setState((s) => ({
      byDoc: { ...s.byDoc, [docId]: reduceEvent(s.byDoc[docId] ?? EMPTY_ASSISTANT, event) },
    }));
  },

  /** `assistant:history` response: replaces the messages and rebuilds the turn in progress. */
  setHistory(
    docId: string,
    res: {
      messages: AssistantMessage[];
      running: string | null;
      backends: AssistantBackendInfo[];
      config: AssistantConfig;
    },
  ): void {
    useAssistant.setState((s) => {
      const prev = s.byDoc[docId] ?? EMPTY_ASSISTANT;
      // An assistant message still "running" in the history becomes the partial turn.
      const live = res.messages.find((m) => m.role === 'assistant' && m.status === 'running');
      const messages = res.messages.filter((m) => m !== live);
      let partial: PartialTurn | null = null;
      if (res.running) {
        partial =
          prev.partial?.turnId === res.running
            ? prev.partial
            : {
                turnId: res.running,
                text: live?.text ?? '',
                tools: live?.tools ?? [],
              };
      }
      return {
        backends: res.backends,
        config: res.config,
        byDoc: { ...s.byDoc, [docId]: { messages, partial, loaded: true } },
      };
    });
  },

  setConfig(config: AssistantConfig, backends?: AssistantBackendInfo[]): void {
    useAssistant.setState((s) => ({ config, backends: backends ?? s.backends }));
  },

  drop(docId: string): void {
    useAssistant.setState((s) => {
      if (!(docId in s.byDoc)) return s;
      const byDoc = { ...s.byDoc };
      delete byDoc[docId];
      return { byDoc };
    });
  },
};
