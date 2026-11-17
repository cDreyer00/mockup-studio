/** Saída da última execução: logs, resultado, erro, imagens e resumo. */
import type { ScriptRunResult } from '@mockup/core';

export function formatResult(value: unknown): string {
  if (value === undefined) return '';
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}

export function ScriptOutput({
  output,
  running,
}: {
  output: ScriptRunResult | null;
  running: boolean;
}) {
  if (running) {
    return (
      <div className="sc-output" data-testid="script-output" data-state="running">
        <div className="sc-muted">Executando…</div>
      </div>
    );
  }
  if (!output) {
    return (
      <div className="sc-output" data-testid="script-output" data-state="empty">
        <div className="sc-muted">A saída da execução aparece aqui.</div>
      </div>
    );
  }
  const result = formatResult(output.result);
  return (
    <div className="sc-output" data-testid="script-output" data-state={output.ok ? 'ok' : 'error'}>
      {output.logs.length > 0 && (
        <pre className="sc-logs" data-testid="script-logs">
          {output.logs.join('\n')}
        </pre>
      )}
      {result && (
        <pre className="sc-result" data-testid="script-result">
          {result}
        </pre>
      )}
      {output.error && (
        <pre className="sc-error" role="alert" data-testid="script-error">
          {output.error}
        </pre>
      )}
      {output.images.length > 0 && (
        <div className="sc-images">
          {output.images.map((img, i) => (
            <img
              key={`${img.nodeId}-${i}`}
              data-testid="script-image"
              alt={`Captura de ${img.nodeId}`}
              width={img.width}
              height={img.height}
              src={`data:${img.mime};base64,${img.data}`}
            />
          ))}
        </div>
      )}
      <div className="sc-meta" data-testid="script-meta">
        {output.opsCount} {output.opsCount === 1 ? 'op' : 'ops'} • {Math.round(output.durationMs)}{' '}
        ms
        {output.opsCount > 0 && ' • Ctrl+Z desfaz tudo'}
      </div>
    </div>
  );
}
