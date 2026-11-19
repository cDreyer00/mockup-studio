import { ui } from '../state/uiStore';
import { presentation } from './presentationStore';

/** Starts a presentation from the UI (button, shortcut, native menu); the error becomes a toast. */
export function startPresentation(from: 'first' | 'selection'): void {
  try {
    presentation.start({ from });
  } catch (e) {
    ui.toast(e instanceof Error ? e.message : String(e), 'error');
  }
}
