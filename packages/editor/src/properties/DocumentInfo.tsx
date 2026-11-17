import { useMemo } from 'react';
import { useDoc } from '../state/docStore';
import { useActivePage } from '../state/hooks';
import { ui } from '../state/uiStore';
import { tokenReportFor } from '../tokens/reportCache';
import { summarizeTokens } from '../tokens/tokensLogic';

/** Sem seleção: nome do documento, página ativa e resumo dos tokens (edição na aba Tokens). */
export function DocumentInfo() {
  const name = useDoc((s) => s.doc?.name);
  const doc = useDoc((s) => s.doc);
  const page = useActivePage();
  const summary = useMemo(() => (doc ? summarizeTokens(tokenReportFor(doc)) : null), [doc]);
  return (
    <div className="prop-doc" data-testid="prop-document">
      <div className="prop-doc-title">Documento</div>
      <div className="prop-doc-name">{name ?? '—'}</div>
      <div className="prop-subtitle">Página: {page?.name ?? '—'}</div>
      <div className="prop-subhead">Tokens e temas</div>
      {summary && (
        <div className="prop-doc-summary" data-testid="tokens-summary">
          <div>
            {summary.tokens} {summary.tokens === 1 ? 'token' : 'tokens'} · {summary.themes}{' '}
            {summary.themes === 1 ? 'tema' : 'temas'}
          </div>
          {summary.unused > 0 && (
            <div className="prop-doc-warn" data-testid="tokens-summary-unused">
              {summary.unused} não {summary.unused === 1 ? 'usado' : 'usados'}
            </div>
          )}
          {summary.broken > 0 && (
            <div className="prop-doc-error" data-testid="tokens-summary-broken">
              {summary.broken} com problema
            </div>
          )}
          {summary.tokens === 0 && <div className="prop-subtitle">Nenhum token definido.</div>}
        </div>
      )}
      <button
        type="button"
        className="btn"
        data-testid="open-tokens"
        onClick={() => ui.setLeftTab('tokens')}
      >
        Abrir painel de tokens
      </button>
    </div>
  );
}
