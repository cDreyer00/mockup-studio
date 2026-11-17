/** Left panel with tabs: Layers (existing panel), Assets, Components and Tokens. */
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
  { id: 'layers', label: 'Layers', icon: Layers },
  { id: 'assets', label: 'Assets', icon: Images },
  { id: 'components', label: 'Components', icon: Component },
  { id: 'tokens', label: 'Tokens', icon: Palette },
];

export function LeftDock() {
  const tab = useUi((s) => s.leftTab);
  // Assets stays mounted after the first visit (preserves search, scroll position and uploads in progress).
  const [assetsSeen, setAssetsSeen] = useState(tab === 'assets');
  useEffect(() => {
    if (tab === 'assets') setAssetsSeen(true);
  }, [tab]);

  // Ctrl+F outside the Layers tab goes back to it and focuses the node search.
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
            {/* Four tabs in the narrow panel: only the active one shows its name. */}
            {tab === id && <span>{label}</span>}
          </button>
        ))}
      </div>
      {/* Layers stays mounted (preserves scroll position and state); it is only hidden. */}
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
