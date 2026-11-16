import { useDoc } from '../state/docStore';
import { useActivePage } from '../state/hooks';
import { toHexColor } from '../ui/controls';

/** Sem seleção: nome do documento, página ativa e tokens (somente leitura). */
export function DocumentInfo() {
  const name = useDoc((s) => s.doc?.name);
  const tokens = useDoc((s) => s.doc?.tokens);
  const page = useActivePage();
  const entries = Object.entries(tokens ?? {});
  return (
    <div className="prop-doc" data-testid="prop-document">
      <div className="prop-doc-title">Documento</div>
      <div className="prop-doc-name">{name ?? '—'}</div>
      <div className="prop-subtitle">Página: {page?.name ?? '—'}</div>
      <div className="prop-subhead">Tokens</div>
      {entries.length === 0 && <div className="prop-subtitle">Nenhum token definido.</div>}
      {entries.map(([k, v]) => (
        <div className="prop-token" key={k} title={`${k}: ${v}`}>
          <span
            className="prop-token-swatch"
            style={{ background: toHexColor(v) || /^(#|rgb|hsl)/i.test(v) ? v : 'transparent' }}
          />
          <span className="prop-token-key mono">{k}</span>
          <span className="prop-token-val mono">{v}</span>
        </div>
      ))}
    </div>
  );
}
