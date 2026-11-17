import { useMemo } from 'react';
import { daemon } from '../client/daemon';
import { useDoc } from '../state/docStore';
import { useActivePage } from '../state/hooks';
import { ui } from '../state/uiStore';
import { tokenReportFor } from '../tokens/reportCache';
import { summarizeTokens } from '../tokens/tokensLogic';

/** No selection: document name, active page and a tokens summary (edited in the Tokens tab). */
export function DocumentInfo() {
  const name = useDoc((s) => s.doc?.name);
  const doc = useDoc((s) => s.doc);
  const cssBase = useDoc((s) => s.doc?.cssBase ?? 'default');
  const page = useActivePage();
  const summary = useMemo(() => (doc ? summarizeTokens(tokenReportFor(doc)) : null), [doc]);
  return (
    <div className="prop-doc" data-testid="prop-document">
      <div className="prop-doc-title">Document</div>
      <div className="prop-doc-name">{name ?? '—'}</div>
      <div className="prop-subtitle">Page: {page?.name ?? '—'}</div>
      <div className="prop-subhead">Tokens and themes</div>
      {summary && (
        <div className="prop-doc-summary" data-testid="tokens-summary">
          <div>
            {summary.tokens} {summary.tokens === 1 ? 'token' : 'tokens'} · {summary.themes}{' '}
            {summary.themes === 1 ? 'theme' : 'themes'}
          </div>
          {summary.unused > 0 && (
            <div className="prop-doc-warn" data-testid="tokens-summary-unused">
              {summary.unused} unused
            </div>
          )}
          {summary.broken > 0 && (
            <div className="prop-doc-error" data-testid="tokens-summary-broken">
              {summary.broken} with issues
            </div>
          )}
          {summary.tokens === 0 && <div className="prop-subtitle">No tokens defined.</div>}
        </div>
      )}
      <div className="prop-subhead">CSS base</div>
      <select
        className="select-input"
        data-testid="css-base"
        value={cssBase}
        title="Document CSS base (canvas, screenshots and exported code)"
        onChange={(e) =>
          void daemon.applySafe([
            { type: 'setCssBase', base: e.target.value === 'tailwind' ? 'tailwind' : 'default' },
          ])
        }
      >
        <option value="default">Default</option>
        <option value="tailwind">Tailwind (preflight)</option>
      </select>
      <button
        type="button"
        className="btn"
        data-testid="open-tokens"
        onClick={() => ui.setLeftTab('tokens')}
      >
        Open tokens panel
      </button>
    </div>
  );
}
