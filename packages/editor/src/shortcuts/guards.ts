/** When the editor's shortcuts and clipboard should let the browser act. */
import { useUi } from '../state/uiStore';

/** Editable target: input, textarea, select or contentEditable. */
export function isEditableTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el || typeof el.tagName !== 'string') return false;
  const tag = el.tagName.toLowerCase();
  if (tag === 'textarea' || tag === 'select') return true;
  if (tag === 'input') {
    const type = (el as HTMLInputElement).type;
    return !['button', 'checkbox', 'radio', 'range', 'color', 'submit', 'reset'].includes(type);
  }
  return el.isContentEditable === true || el.contentEditable === 'true';
}

/** `true` if a modal is open or text is being edited inline. */
export function isInteractionBlocked(): boolean {
  return !!document.querySelector('.modal-backdrop') || useUi.getState().editingTextId !== null;
}
