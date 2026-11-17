/** Painel de propriedades: edita estilos, atributos e texto dos nós selecionados via ops. */
import { Lock } from 'lucide-react';
import { canHaveChildren } from '../model/tree';
import { AppearanceSection } from './AppearanceSection';
import { AttrsSection } from './AttrsSection';
import { CssSection } from './CssSection';
import { DocumentInfo } from './DocumentInfo';
import { EffectSection } from './EffectSection';
import { EffectsSection } from './EffectsSection';
import { HeaderSection } from './HeaderSection';
import { LayoutSection } from './LayoutSection';
import { SizeSection } from './SizeSection';
import { TypographySection } from './TypographySection';
import { LockedContext, useSelectionCtx } from './shared';
import './properties.css';

export function PropertiesPanel() {
  const ctxs = useSelectionCtx();

  if (ctxs.length === 0) {
    return (
      <aside className="panel panel-right" data-testid="properties-panel">
        <DocumentInfo />
      </aside>
    );
  }

  const nodes = ctxs.map((c) => c.node);
  const locked = ctxs.some((c) => c.locked);
  const container = nodes.every(canHaveChildren);

  return (
    <LockedContext.Provider value={locked}>
      <aside className="panel panel-right" data-testid="properties-panel">
        {locked && (
          <div className="prop-locked" data-testid="prop-locked">
            <Lock size={12} /> Seleção travada: somente leitura
          </div>
        )}
        <HeaderSection nodes={nodes} locked={locked} />
        <SizeSection ctxs={ctxs} />
        {container && <LayoutSection ctxs={ctxs} />}
        <TypographySection nodes={nodes} />
        <AppearanceSection nodes={nodes} />
        <EffectSection nodes={nodes} />
        <EffectsSection nodes={nodes} />
        <AttrsSection ctxs={ctxs} />
        {nodes.length === 1 && <CssSection node={nodes[0]!} />}
      </aside>
    </LockedContext.Provider>
  );
}
