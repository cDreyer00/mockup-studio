/** Quando os atalhos e o clipboard do editor devem deixar o navegador agir. */
import { useUi } from '../state/uiStore';

/** Alvo editável: input, textarea, select ou contentEditable. */
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

/** `true` se há modal aberto ou texto em edição inline. */
export function isInteractionBlocked(): boolean {
  return !!document.querySelector('.modal-backdrop') || useUi.getState().editingTextId !== null;
}
