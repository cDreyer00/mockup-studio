import type { AssistantMessage, AssistantToolCall } from '@mockup/core';
import { Check, Loader2, X } from 'lucide-react';
import type { PartialTurn } from '../state/assistantStore';
import { opsLabel, toolLabel, toolStatus } from './logic';

export function ToolChip({ tool }: { tool: AssistantToolCall }) {
  const status = toolStatus(tool);
  return (
    <span
      className={`as-chip ${status}`}
      data-testid="assistant-tool"
      data-status={status}
      title={tool.summary ?? tool.name}
    >
      {status === 'running' ? (
        <Loader2 size={10} className="as-spin" />
      ) : status === 'ok' ? (
        <Check size={10} />
      ) : (
        <X size={10} />
      )}
      {toolLabel(tool.name)}
    </span>
  );
}

function Tools({ tools }: { tools: AssistantToolCall[] }) {
  if (tools.length === 0) return null;
  return (
    <div className="as-tools">
      {tools.map((t) => (
        <ToolChip key={t.id} tool={t} />
      ))}
    </div>
  );
}

export function MessageView({ message: m }: { message: AssistantMessage }) {
  if (m.role === 'user') {
    return (
      <div className="as-msg user" data-testid="assistant-msg-user">
        <div className="as-bubble">{m.text}</div>
      </div>
    );
  }
  return (
    <div className={`as-msg assistant ${m.status ?? 'done'}`} data-testid="assistant-msg-assistant">
      {m.tools && <Tools tools={m.tools} />}
      {m.text && <div className="as-bubble">{m.text}</div>}
      {m.status === 'cancelled' && <div className="as-note">Cancelado.</div>}
      {m.status === 'error' && (
        <div className="as-note error" role="alert">
          {m.error ?? 'Erro no turno.'}
        </div>
      )}
      {!!m.opsCount && <div className="as-foot">{opsLabel(m.opsCount)}</div>}
    </div>
  );
}

/** Turno em andamento: texto parcial e ferramentas com status. */
export function PartialView({ partial }: { partial: PartialTurn }) {
  return (
    <div className="as-msg assistant running" data-testid="assistant-partial">
      <Tools tools={partial.tools} />
      {partial.text ? (
        <div className="as-bubble">{partial.text}</div>
      ) : (
        partial.tools.length === 0 && <div className="as-note">Pensando…</div>
      )}
    </div>
  );
}
