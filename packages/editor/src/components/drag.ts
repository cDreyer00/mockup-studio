/** Drag a component from the Components tab onto the canvas (HTML5 drag and drop). */

/** Custom MIME type in `dataTransfer` (the canvas only accepts the drop when it is present). */
export const COMPONENT_DRAG_TYPE = 'application/x-mockup-component';

export interface ComponentDragPayload {
  componentId: string;
  /** Source kit (imported if the component is not yet in the document). */
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
