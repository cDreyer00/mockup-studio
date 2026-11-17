/** Painel esquerdo com abas: Camadas (painel existente) e Tokens. */
import { Layers, Palette } from 'lucide-react';
import { LayersPanel } from '../layers/LayersPanel';
import { ui, useUi } from '../state/uiStore';
import type { LeftTab } from '../state/uiStore';
import { TokensPanel } from './TokensPanel';
import './tokens.css';

const TABS: { id: LeftTab; label: string; icon: typeof Layers }[] = [
  { id: 'layers', label: 'Camadas', icon: Layers },
  { id: 'tokens', label: 'Tokens', icon: Palette },
];

export function LeftDock() {
  const tab = useUi((s) => s.leftTab);
  return (
    <div className="left-dock" data-testid="left-dock">
      <div className="left-tabs" role="tablist">
        {TABS.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={tab === id}
            className={`left-tab${tab === id ? ' active' : ''}`}
            data-testid={`tab-${id}`}
            onClick={() => ui.setLeftTab(id)}
          >
            <Icon size={13} />
            <span>{label}</span>
          </button>
        ))}
      </div>
      {/* Camadas continua montado (preserva rolagem e estado); só fica oculto. */}
      <div className="left-dock-body" hidden={tab !== 'layers'}>
        <LayersPanel />
      </div>
      {tab === 'tokens' && (
        <div className="left-dock-body">
          <TokensPanel />
        </div>
      )}
    </div>
  );
}
