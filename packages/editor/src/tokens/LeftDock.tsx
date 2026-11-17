/** Painel esquerdo com abas: Camadas (painel existente), Assets, Componentes e Tokens. */
import { useEffect, useState } from 'react';
import { Component, Images, Layers, Palette } from 'lucide-react';
import { AssetsPanel } from '../assets/AssetsPanel';
import '../assets/assets.css';
import { ComponentsPanel } from '../components/ComponentsPanel';
import { LayersPanel } from '../layers/LayersPanel';
import { requestNodeSearchFocus } from '../layers/NodeSearch';
import { ui, useUi } from '../state/uiStore';
import type { LeftTab } from '../state/uiStore';
import { TokensPanel } from './TokensPanel';
import './tokens.css';

const TABS: { id: LeftTab; label: string; icon: typeof Layers }[] = [
  { id: 'layers', label: 'Camadas', icon: Layers },
  { id: 'assets', label: 'Assets', icon: Images },
  { id: 'components', label: 'Componentes', icon: Component },
  { id: 'tokens', label: 'Tokens', icon: Palette },
];

export function LeftDock() {
  const tab = useUi((s) => s.leftTab);
  // Assets fica montado depois da primeira visita (preserva busca, rolagem e uploads em curso).
  const [assetsSeen, setAssetsSeen] = useState(tab === 'assets');
  useEffect(() => {
    if (tab === 'assets') setAssetsSeen(true);
  }, [tab]);

  // Ctrl+F fora da aba Camadas volta para ela e foca a busca de nós.
  useEffect(() => {
    if (tab === 'layers') return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'f') {
        const el = e.target as HTMLElement | null;
        if (el?.tagName === 'INPUT' && el.getAttribute('data-testid') === 'assets-search') return;
        e.preventDefault();
        ui.setLeftTab('layers');
        requestNodeSearchFocus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [tab]);

  return (
    <div className="left-dock" data-testid="left-dock">
      <div className="left-tabs" role="tablist">
        {TABS.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={tab === id}
            aria-label={label}
            title={label}
            className={`left-tab${tab === id ? ' active' : ''}`}
            data-testid={`tab-${id}`}
            onClick={() => ui.setLeftTab(id)}
          >
            <Icon size={13} />
            {/* Quatro abas no painel estreito: só a ativa mostra o nome. */}
            {tab === id && <span>{label}</span>}
          </button>
        ))}
      </div>
      {/* Camadas continua montado (preserva rolagem e estado); só fica oculto. */}
      <div className="left-dock-body" hidden={tab !== 'layers'}>
        <LayersPanel />
      </div>
      {assetsSeen && (
        <div className="left-dock-body" hidden={tab !== 'assets'}>
          <AssetsPanel />
        </div>
      )}
      {tab === 'components' && (
        <div className="left-dock-body">
          <ComponentsPanel />
        </div>
      )}
      {tab === 'tokens' && (
        <div className="left-dock-body">
          <TokensPanel />
        </div>
      )}
    </div>
  );
}
