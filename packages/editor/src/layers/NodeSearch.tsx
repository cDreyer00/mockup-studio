/** Busca de nós no documento ativo (cliente, sem rede): nome, tag, texto, classe, id, atributos e dados. */
import { useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import { Search, X } from 'lucide-react';
import { searchNodes } from '@mockup/core';
import { useDoc } from '../state/docStore';
import { revealNodes } from './reveal';
import './nodeSearch.css';

const MAX_RESULTS = 50;

/** Pedido de foco feito antes do campo existir (Ctrl+F estando na aba Assets). */
let pendingFocus = false;
export function requestNodeSearchFocus(): void {
  pendingFocus = true;
  window.dispatchEvent(new Event('mockup:node-search-focus'));
}

export function NodeSearch() {
  const doc = useDoc((s) => s.doc);
  const [query, setQuery] = useState('');
  const deferred = useDeferredValue(query);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const focus = () => {
      pendingFocus = false;
      inputRef.current?.focus();
      inputRef.current?.select();
    };
    if (pendingFocus) focus();
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'f') {
        if (document.querySelector('.modal-backdrop')) return;
        e.preventDefault();
        focus();
      }
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('mockup:node-search-focus', focus);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('mockup:node-search-focus', focus);
    };
  }, []);

  const matches = useMemo(
    () => (doc && deferred.trim() ? searchNodes(doc, deferred, { limit: MAX_RESULTS }) : []),
    [doc, deferred],
  );
  const active = query.trim().length > 0;

  return (
    <div className="node-search" data-testid="node-search">
      <div className="node-search-field">
        <Search size={12} className="node-search-icon" />
        <input
          ref={inputRef}
          className="node-search-input"
          data-testid="node-search-input"
          placeholder="Buscar nós (tag:button, text:preço)"
          spellCheck={false}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === 'Escape') setQuery('');
            if (e.key === 'Enter' && matches[0]) revealNodes([matches[0].nodeId]);
          }}
        />
        {active && (
          <button
            type="button"
            className="node-search-clear"
            title="Limpar busca"
            aria-label="Limpar busca"
            onClick={() => setQuery('')}
          >
            <X size={12} />
          </button>
        )}
      </div>
      {active && (
        <div className="node-search-results" data-testid="node-search-results" role="listbox">
          {matches.length === 0 ? (
            <div className="node-search-empty">Nenhum nó encontrado.</div>
          ) : (
            matches.map((m) => (
              <button
                key={m.nodeId}
                type="button"
                role="option"
                className="node-search-result"
                data-testid="node-search-result"
                data-node-id={m.nodeId}
                onClick={() => revealNodes([m.nodeId])}
              >
                <span className="node-search-name">
                  {m.name}
                  <span className="layer-tag">{`<${m.tag}>`}</span>
                </span>
                <span className="node-search-snippet">
                  {m.field !== 'name' && <em>{m.field}: </em>}
                  {m.snippet}
                </span>
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
}
