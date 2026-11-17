/** Painel esquerdo com abas Camadas | Assets. Ambas ficam montadas depois da primeira visita. */
import { useEffect, useState } from 'react';
import { LayersPanel } from '../layers/LayersPanel';
import { requestNodeSearchFocus } from '../layers/NodeSearch';
import { AssetsPanel } from './AssetsPanel';
import './assets.css';

type Tab = 'layers' | 'assets';

export function LeftPanel() {
  const [tab, setTab] = useState<Tab>('layers');
  const [assetsSeen, setAssetsSeen] = useState(false);

  const show = (t: Tab) => {
    setTab(t);
    if (t === 'assets') setAssetsSeen(true);
  };

  // Ctrl+F estando na aba Assets volta para Camadas e foca a busca de nós.
  useEffect(() => {
    if (tab === 'layers') return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'f') {
        const el = e.target as HTMLElement | null;
        if (el?.tagName === 'INPUT' && el.getAttribute('data-testid') === 'assets-search') return;
        e.preventDefault();
        setTab('layers');
        requestNodeSearchFocus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [tab]);

  return (
    <div className="left-panel" data-testid="left-panel">
      <div className="left-tabs" role="tablist">
        {(
          [
            ['layers', 'Camadas'],
            ['assets', 'Assets'],
          ] as const
        ).map(([id, label]) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={tab === id}
            className={`left-tab${tab === id ? ' active' : ''}`}
            data-testid={`left-tab-${id}`}
            onClick={() => show(id)}
          >
            {label}
          </button>
        ))}
      </div>
      <div className="left-pane" hidden={tab !== 'layers'}>
        <LayersPanel />
      </div>
      {assetsSeen && (
        <div className="left-pane" hidden={tab !== 'assets'}>
          <AssetsPanel />
        </div>
      )}
    </div>
  );
}
