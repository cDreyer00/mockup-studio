/** Arrastar um componente da aba Componentes para o canvas (HTML5 drag and drop). */

/** Tipo MIME próprio no `dataTransfer` (o canvas só aceita o drop quando ele está presente). */
export const COMPONENT_DRAG_TYPE = 'application/x-mockup-component';

export interface ComponentDragPayload {
  componentId: string;
  /** Kit de origem (importado se o componente ainda não estiver no documento). */
  kit?: string;
}

export function writeComponentDrag(dt: DataTransfer, payload: ComponentDragPayload): void {
  dt.setData(COMPONENT_DRAG_TYPE, JSON.stringify(payload));
  dt.effectAllowed = 'copy';
}

export function readComponentDrag(dt: DataTransfer): ComponentDragPayload | null {
  const raw = dt.getData(COMPONENT_DRAG_TYPE);
  if (!raw) return null;
  try {
    const p = JSON.parse(raw) as Partial<ComponentDragPayload>;
    if (typeof p.componentId !== 'string' || !p.componentId) return null;
    return { componentId: p.componentId, ...(typeof p.kit === 'string' ? { kit: p.kit } : {}) };
  } catch {
    return null;
  }
}
