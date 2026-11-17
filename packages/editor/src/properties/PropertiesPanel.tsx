/** Painel de propriedades: edita estilos, atributos e texto dos nós selecionados via ops. */
import { Lock } from 'lucide-react';
import { canHaveChildren } from '../model/tree';
import { AppearanceSection } from './AppearanceSection';
import { AttrsSection } from './AttrsSection';
import { CssSection } from './CssSection';
import { ConvertToRepeater, DataSection } from './DataSection';
import { DocumentInfo } from './DocumentInfo';
import { EffectsSection } from './EffectsSection';
import { GridCellSection } from './GridEditor';
import { HeaderSection } from './HeaderSection';
import { ImageSection } from './ImageSection';
import { LayoutSection } from './LayoutSection';
import { SizeSection } from './SizeSection';
import { TypographySection } from './TypographySection';
import { VectorSection } from './VectorSection';
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
  const single = nodes.length === 1 ? ctxs[0]! : null;

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
        {nodes.every((n) => n.type === 'image') && <ImageSection nodes={nodes} />}
        {single?.node.type === 'repeater' && <DataSection node={single.node} />}
        {single &&
          !single.isRoot &&
          single.node.type === 'element' &&
          single.node.children.length > 0 && <ConvertToRepeater node={single.node} />}
        {container && <LayoutSection ctxs={ctxs} />}
        <GridCellSection ctxs={ctxs} />
        <TypographySection nodes={nodes} />
        {nodes.every((n) => n.type === 'svg') && <VectorSection nodes={nodes} />}
        <AppearanceSection nodes={nodes} />
        <EffectsSection nodes={nodes} />
        <AttrsSection ctxs={ctxs} />
        {nodes.length === 1 && <CssSection node={nodes[0]!} />}
      </aside>
    </LockedContext.Provider>
  );
}
