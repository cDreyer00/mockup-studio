/** AI assistant panel: per-document conversation with streaming, tools and backend. */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import { isVirtualId } from '@mockup/core';
import type { AssistantBackendInfo } from '@mockup/core';
import { Bot, Send, Square, Trash2 } from 'lucide-react';
import { daemon } from '../client/daemon';
import { EMPTY_ASSISTANT, useAssistant } from '../state/assistantStore';
import { useDoc } from '../state/docStore';
import { ui, useUi } from '../state/uiStore';
import { MessageView, PartialView } from './MessageView';
import { contextLabel, noBackendAvailable } from './logic';
import './assistant.css';

export const SUGGESTIONS = [
  'Make the primary button stand out more',
  'Create a dark variation of this screen',
  'Review the spacing and alignment of the selection',
  'Replace hard-coded colors with design system tokens',
];

const toastError = (e: unknown) => ui.toast(e instanceof Error ? e.message : String(e), 'error');

function BackendSelect({ backends, value }: { backends: AssistantBackendInfo[]; value: string }) {
  return (
    <select
      className="select-input as-backend"
      data-testid="assistant-backend"
      title="Assistant backend"
      value={value}
      onChange={(e) => daemon.assistantConfig({ backend: e.target.value }).catch(toastError)}
    >
      <option value="auto">Automatic</option>
      {backends.map((b) => (
        <option key={b.id} value={b.id} disabled={!b.available}>
          {b.name}
          {b.available ? '' : ' (unavailable)'}
        </option>
      ))}
    </select>
  );
}

export function AssistantPanel() {
  const docId = useDoc((s) => s.activeDocId);
  const status = useDoc((s) => s.status);
  const data = useAssistant((s) => (docId ? s.byDoc[docId] : undefined)) ?? EMPTY_ASSISTANT;
  const backends = useAssistant((s) => s.backends);
  const config = useAssistant((s) => s.config);
  const selectionCount = useUi((s) => s.selection.length);
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);

  // Loads history, backends and settings when the panel opens / the document changes / on reconnect.
  useEffect(() => {
    if (!docId || status !== 'online') return;
    daemon.assistantHistory(docId).catch(() => undefined);
  }, [docId, status]);

  const running = data.partial !== null;
  const noBackend = config !== null && noBackendAvailable(backends);
  const ctx = useMemo(() => contextLabel(selectionCount), [selectionCount]);

  // Scrolls to the end when new content arrives.
  const tail = data.partial ? data.partial.text.length + data.partial.tools.length : 0;
  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [data.messages.length, tail, running]);

  const send = useCallback(
    async (prompt: string) => {
      const value = prompt.trim();
      if (!value || !docId || running || sending) return;
      setSending(true);
      try {
        const real = useUi.getState().selection.filter((id) => !isVirtualId(id));
        await daemon.assistantSend(value, { selection: real, docId });
        setText('');
      } catch (e) {
        toastError(e);
      } finally {
        setSending(false);
      }
    },
    [docId, running, sending],
  );

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void send(text);
    }
  };

  if (!docId) {
    return (
      <div className="as-panel" data-testid="assistant-panel">
        <div className="as-empty">Open a document to chat with the assistant.</div>
      </div>
    );
  }

  const empty = data.messages.length === 0 && !data.partial;
  return (
    <div className="as-panel" data-testid="assistant-panel">
      <div className="as-toolbar">
        <BackendSelect backends={backends} value={config?.backend ?? 'auto'} />
        <button
          type="button"
          className="icon-btn"
          title="Clear history"
          data-testid="assistant-clear"
          disabled={empty || running}
          onClick={() => daemon.assistantClear(docId).catch(toastError)}
        >
          <Trash2 size={14} />
        </button>
      </div>

      {noBackend && (
        <div className="as-notice" data-testid="assistant-no-backend">
          No backend available. Install and sign in to <b>Claude Code</b> (<code>claude</code>) or
          <b>Codex</b> (<code>codex</code>) and reopen this panel.
        </div>
      )}

      <div className="as-messages" ref={listRef} data-testid="assistant-messages">
        {empty ? (
          <div className="as-empty" data-testid="assistant-empty">
            <Bot size={22} />
            <p>
              Ask for design changes in natural language. Each turn becomes a single undo entry.
            </p>
            <div className="as-suggestions">
              {SUGGESTIONS.map((s) => (
                <button
                  key={s}
                  type="button"
                  className="as-suggestion"
                  data-testid="assistant-suggestion"
                  onClick={() => setText(s)}
                >
                  {s}
                </button>
              ))}
            </div>
          </div>
        ) : (
          <>
            {data.messages.map((m) => (
              <MessageView key={m.id} message={m} />
            ))}
            {data.partial && <PartialView partial={data.partial} />}
          </>
        )}
      </div>

      <div className="as-composer">
        <div className="as-context" data-testid="assistant-context">
          {ctx}
        </div>
        {running && (
          <div className="as-context as-warn" data-testid="assistant-split-warning">
            Your edits during the turn split the turn's undo into more than one step.
          </div>
        )}
        <div className="as-input-row">
          <textarea
            className="as-input"
            data-testid="assistant-input"
            rows={2}
            value={text}
            placeholder="Describe what the assistant should do…"
            onChange={(e) => setText(e.target.value)}
            onKeyDown={onKeyDown}
          />
          {running ? (
            <button
              type="button"
              className="btn as-cancel"
              data-testid="assistant-cancel"
              title="Cancel the turn"
              onClick={() => daemon.assistantCancel(docId).catch(toastError)}
            >
              <Square size={12} /> Cancel
            </button>
          ) : (
            <button
              type="button"
              className="btn primary as-send"
              data-testid="assistant-send"
              title="Send (Enter)"
              disabled={!text.trim() || sending || noBackend}
              onClick={() => void send(text)}
            >
              <Send size={12} />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
