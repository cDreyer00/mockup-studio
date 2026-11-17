/** Painel de propriedades: edita estilos, atributos e texto dos nós selecionados via ops. */
import { Lock } from 'lucide-react';
import { getComponent } from '@mockup/core';
import { ComponentSection } from '../components/ComponentSection';
import { InstanceSection } from '../components/InstanceSection';
import { isMainRoot } from '../components/model';
import { canHaveChildren } from '../model/tree';
import { useDoc } from '../state/docStore';
import { useUi } from '../state/uiStore';
import { AppearanceSection } from './AppearanceSection';
import { AttrsSection } from './AttrsSection';
import { ClassesSection } from './ClassesSection';
import { CssSection } from './CssSection';
import { DocumentInfo } from './DocumentInfo';
import { EffectsSection } from './EffectsSection';
import { HeaderSection } from './HeaderSection';
import { LayoutSection } from './LayoutSection';
import { SizeSection } from './SizeSection';
import { TypographySection } from './TypographySection';
import { LockedContext, useSelectionCtx } from './shared';
import './properties.css';

export function PropertiesPanel() {
  const ctxs = useSelectionCtx();
  // Modo de edição do principal: a seção do componente aparece sem seleção e com a raiz dele.
  const editing = useUi((s) => s.editingComponentId);
  const mainDef = useDoc((s) => {
    const raw = s.rawDoc ?? s.doc;
    return editing && raw ? getComponent(raw, editing) : undefined;
  });
  const mainSelected = useDoc(
    (s) => !!s.doc && ctxs.length === 1 && isMainRoot(s.doc, ctxs[0]!.node.id),
  );

  if (ctxs.length === 0) {
    return (
      <aside className="panel panel-right" data-testid="properties-panel">
        {mainDef ? <ComponentSection def={mainDef} /> : <DocumentInfo />}
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
        {mainDef && mainSelected && <ComponentSection def={mainDef} />}
        {nodes.length === 1 && nodes[0]!.componentId !== undefined && (
          <InstanceSection node={nodes[0]!} />
        )}
        <SizeSection ctxs={ctxs} />
        {container && <LayoutSection ctxs={ctxs} />}
        <TypographySection nodes={nodes} />
        <AppearanceSection nodes={nodes} />
        <EffectsSection nodes={nodes} />
        <ClassesSection ctxs={ctxs} />
        <AttrsSection ctxs={ctxs} />
        {nodes.length === 1 && <CssSection node={nodes[0]!} />}
      </aside>
    </LockedContext.Provider>
  );
}
