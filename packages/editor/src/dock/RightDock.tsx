/**
 * Painel direito com abas: Design (propriedades), Assistente (IA) e Scripts.
 * Design fica sempre montado (só oculto); Assistente e Scripts montam na primeira visita e depois
 * também ficam montados (preservam o texto digitado, o código e a rolagem).
 */
import { useEffect, useState } from 'react';
import { Bot, Code2, SlidersHorizontal } from 'lucide-react';
import { AssistantPanel } from '../assistant/AssistantPanel';
import { PropertiesPanel } from '../properties/PropertiesPanel';
import { ScriptsPanel } from '../scripts/ScriptsPanel';
import { ui, useUi } from '../state/uiStore';
import type { RightTab } from '../state/uiStore';
import './dock.css';

const TABS: { id: RightTab; label: string; icon: typeof Bot }[] = [
  { id: 'design', label: 'Design', icon: SlidersHorizontal },
  { id: 'assistant', label: 'Assistente', icon: Bot },
  { id: 'scripts', label: 'Scripts', icon: Code2 },
];

export function RightDock() {
  const tab = useUi((s) => s.rightTab);
  const [visited, setVisited] = useState<Record<RightTab, boolean>>({
    design: true,
    assistant: tab === 'assistant',
    scripts: tab === 'scripts',
  });
  useEffect(() => {
    setVisited((v) => (v[tab] ? v : { ...v, [tab]: true }));
  }, [tab]);

  return (
    <div className="right-dock" data-testid="right-dock">
      <div className="right-tabs" role="tablist">
        {TABS.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={tab === id}
            className={`right-tab${tab === id ? ' active' : ''}`}
            data-testid={`tab-${id}`}
            onClick={() => ui.setRightTab(id)}
          >
            <Icon size={13} />
            <span>{label}</span>
          </button>
        ))}
      </div>
      <div className="right-dock-body" hidden={tab !== 'design'}>
        <PropertiesPanel />
      </div>
      {visited.assistant && (
        <div className="right-dock-body" hidden={tab !== 'assistant'}>
          <AssistantPanel />
        </div>
      )}
      {visited.scripts && (
        <div className="right-dock-body" hidden={tab !== 'scripts'}>
          <ScriptsPanel />
        </div>
      )}
    </div>
  );
}
