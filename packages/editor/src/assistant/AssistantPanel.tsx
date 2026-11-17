/** Painel do assistente de IA: conversa por documento com streaming, ferramentas e backend. */
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
  'Deixe o botão primário mais destacado',
  'Crie uma variação escura desta tela',
  'Revise o espaçamento e o alinhamento da seleção',
  'Troque as cores fixas por tokens do design system',
];

const toastError = (e: unknown) => ui.toast(e instanceof Error ? e.message : String(e), 'error');

function BackendSelect({ backends, value }: { backends: AssistantBackendInfo[]; value: string }) {
  return (
    <select
      className="select-input as-backend"
      data-testid="assistant-backend"
      title="Backend do assistente"
      value={value}
      onChange={(e) => daemon.assistantConfig({ backend: e.target.value }).catch(toastError)}
    >
      <option value="auto">Automático</option>
      {backends.map((b) => (
        <option key={b.id} value={b.id} disabled={!b.available}>
          {b.name}
          {b.available ? '' : ' (indisponível)'}
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

  // Carrega histórico, backends e configuração ao abrir o painel / trocar de documento / reconectar.
  useEffect(() => {
    if (!docId || status !== 'online') return;
    daemon.assistantHistory(docId).catch(() => undefined);
  }, [docId, status]);

  const running = data.partial !== null;
  const noBackend = config !== null && noBackendAvailable(backends);
  const ctx = useMemo(() => contextLabel(selectionCount), [selectionCount]);

  // Rola para o fim quando chega conteúdo novo.
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
        <div className="as-empty">Abra um documento para conversar com o assistente.</div>
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
          title="Limpar histórico"
          data-testid="assistant-clear"
          disabled={empty || running}
          onClick={() => daemon.assistantClear(docId).catch(toastError)}
        >
          <Trash2 size={14} />
        </button>
      </div>

      {noBackend && (
        <div className="as-notice" data-testid="assistant-no-backend">
          Nenhum backend disponível. Instale e faça login no <b>Claude Code</b> (<code>claude</code>
          ) ou no <b>Codex</b> (<code>codex</code>) e reabra este painel.
        </div>
      )}

      <div className="as-messages" ref={listRef} data-testid="assistant-messages">
        {empty ? (
          <div className="as-empty" data-testid="assistant-empty">
            <Bot size={22} />
            <p>
              Peça alterações no design em linguagem natural. Cada turno vira uma só entrada de
              undo.
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
        <div className="as-input-row">
          <textarea
            className="as-input"
            data-testid="assistant-input"
            rows={2}
            value={text}
            placeholder="Descreva o que o assistente deve fazer…"
            onChange={(e) => setText(e.target.value)}
            onKeyDown={onKeyDown}
          />
          {running ? (
            <button
              type="button"
              className="btn as-cancel"
              data-testid="assistant-cancel"
              title="Cancelar o turno"
              onClick={() => daemon.assistantCancel(docId).catch(toastError)}
            >
              <Square size={12} /> Cancelar
            </button>
          ) : (
            <button
              type="button"
              className="btn primary as-send"
              data-testid="assistant-send"
              title="Enviar (Enter)"
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
