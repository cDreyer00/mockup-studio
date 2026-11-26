/** Properties panel: edits styles, attributes and text of the selected nodes via ops. */
import { Lock } from 'lucide-react';
import { getComponent } from '@mockup/core';
import { ComponentSection } from '../components/ComponentSection';
import { InstanceSection } from '../components/InstanceSection';
import { isMainRoot } from '../components/model';
import { MotionSection } from '../motion/MotionSection';
import { TransitionSection } from '../motion/TransitionSection';
import { canHaveChildren } from '../model/tree';
import { useDoc } from '../state/docStore';
import { useUi } from '../state/uiStore';
import { AppearanceSection } from './AppearanceSection';
import { AttrsSection } from './AttrsSection';
import { ClassesSection } from './ClassesSection';
import { CssSection } from './CssSection';
import { ConvertToRepeater, DataSection } from './DataSection';
import { DocumentInfo } from './DocumentInfo';
import { EffectSection } from './EffectSection';
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
  // Main edit mode: the component section appears with no selection and with its root.
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
  const single = nodes.length === 1 ? ctxs[0]! : null;

  return (
    <LockedContext.Provider value={locked}>
      <aside className="panel panel-right" data-testid="properties-panel">
        {locked && (
          <div className="prop-locked" data-testid="prop-locked">
            <Lock size={12} /> Selection locked: read-only
          </div>
        )}
        <HeaderSection nodes={nodes} locked={locked} />
        {mainDef && mainSelected && <ComponentSection def={mainDef} />}
        {nodes.length === 1 && nodes[0]!.componentId !== undefined && (
          <InstanceSection node={nodes[0]!} />
        )}
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
        <EffectSection nodes={nodes} />
        <EffectsSection nodes={nodes} />
        <MotionSection nodes={nodes} />
        {ctxs.every((c) => c.isRoot) && <TransitionSection frames={nodes} />}
        <ClassesSection ctxs={ctxs} />
        <AttrsSection ctxs={ctxs} />
        {nodes.length === 1 && <CssSection node={nodes[0]!} />}
      </aside>
    </LockedContext.Provider>
  );
}
