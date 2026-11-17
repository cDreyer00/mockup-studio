/** Resolução pura tecla → comando (estilo Figma). Ctrl ≡ Meta. Espaço e Alt são tratados à parte. */
import type { ReorderKind } from '../actions';
import type { Tool } from '../state/uiStore';

export type ShortcutCommand =
  | { type: 'tool'; tool: Tool }
  | { type: 'pickImage' }
  | { type: 'save' }
  | { type: 'saveAs' }
  | { type: 'delete' }
  | { type: 'duplicate' }
  | { type: 'group' }
  | { type: 'ungroup' }
  | { type: 'reorder'; kind: ReorderKind }
  | { type: 'toggleHidden' }
  | { type: 'toggleLocked' }
  | { type: 'nudge'; dx: number; dy: number }
  | { type: 'escape' }
  | { type: 'selectChildren' }
  | { type: 'selectParent' }
  | { type: 'selectAll' }
  | { type: 'undo' }
  | { type: 'redo' }
  | { type: 'zoomIn' }
  | { type: 'zoomOut' }
  | { type: 'zoom100' }
  | { type: 'zoomFit' }
  | { type: 'zoomSelection' }
  | { type: 'createComponent' };

export type KeyInfo = Pick<
  KeyboardEvent,
  'key' | 'code' | 'ctrlKey' | 'metaKey' | 'shiftKey' | 'altKey'
>;

const TOOL_KEYS: Record<string, Tool> = {
  v: 'select',
  h: 'hand',
  f: 'frame',
  a: 'frame',
  r: 'rect',
  t: 'text',
};

/** Letra da tecla: `key` quando for uma letra ASCII, senão a partir do `code` (`KeyV` → `v`). */
function letterOf(e: KeyInfo): string {
  if (/^[a-z]$/i.test(e.key)) return e.key.toLowerCase();
  const m = /^Key([A-Z])$/.exec(e.code);
  return m ? m[1]!.toLowerCase() : '';
}

/** `[`/`]` independente de layout (ABNT2 e US): prefere `key`, cai no `code`. */
function bracketOf(e: KeyInfo): '[' | ']' | null {
  if (e.key === ']' || e.key === '}') return ']';
  if (e.key === '[' || e.key === '{') return '[';
  if (e.code === 'BracketRight') return ']';
  if (e.code === 'BracketLeft') return '[';
  return null;
}

/** Dígito 0-9 pelo `code` (Digit/Numpad) ou, na falta, pelo `key`. */
function digitOf(e: KeyInfo): string | null {
  const m = /^(?:Digit|Numpad)(\d)$/.exec(e.code);
  if (m) return m[1]!;
  return /^\d$/.test(e.key) ? e.key : null;
}

export function resolveShortcut(e: KeyInfo): ShortcutCommand | null {
  const mod = e.ctrlKey || e.metaKey;
  const { shiftKey: shift, altKey: alt } = e;

  if (mod && !alt) {
    const letter = letterOf(e);
    const bracket = bracketOf(e);
    if (bracket) {
      if (shift) return { type: 'reorder', kind: bracket === ']' ? 'front' : 'back' };
      return { type: 'reorder', kind: bracket === ']' ? 'forward' : 'backward' };
    }
    switch (letter) {
      case 's':
        return { type: shift ? 'saveAs' : 'save' };
      case 'd':
        return shift ? null : { type: 'duplicate' };
      case 'g':
        return { type: shift ? 'ungroup' : 'group' };
      case 'a':
        return shift ? null : { type: 'selectAll' };
      case 'z':
        return { type: shift ? 'redo' : 'undo' };
      case 'y':
        return shift ? null : { type: 'redo' };
      case 'k':
        return shift ? { type: 'pickImage' } : null;
      case 'h':
        return shift ? { type: 'toggleHidden' } : null;
      case 'l':
        return shift ? { type: 'toggleLocked' } : null;
      default:
        return null;
    }
  }
  // Ctrl+Alt+K: criar componente da seleção (como no Figma).
  if (mod && alt && !shift && letterOf(e) === 'k') return { type: 'createComponent' };
  if (mod || alt) return null;

  switch (e.key) {
    case 'Delete':
    case 'Backspace':
      return { type: 'delete' };
    case 'Escape':
      return { type: 'escape' };
    case 'Enter':
      return { type: shift ? 'selectParent' : 'selectChildren' };
    case 'ArrowLeft':
      return { type: 'nudge', dx: shift ? -10 : -1, dy: 0 };
    case 'ArrowRight':
      return { type: 'nudge', dx: shift ? 10 : 1, dy: 0 };
    case 'ArrowUp':
      return { type: 'nudge', dx: 0, dy: shift ? -10 : -1 };
    case 'ArrowDown':
      return { type: 'nudge', dx: 0, dy: shift ? 10 : 1 };
  }

  if (shift) {
    const d = digitOf(e);
    if (d === '0') return { type: 'zoom100' };
    if (d === '1') return { type: 'zoomFit' };
    if (d === '2') return { type: 'zoomSelection' };
    if (e.key === '+' || e.code === 'Equal' || e.code === 'NumpadAdd') return { type: 'zoomIn' };
    return null;
  }

  if (e.key === '+' || e.key === '=' || e.code === 'Equal' || e.code === 'NumpadAdd') {
    return { type: 'zoomIn' };
  }
  if (e.key === '-' || e.code === 'Minus' || e.code === 'NumpadSubtract')
    return { type: 'zoomOut' };

  const tool = TOOL_KEYS[letterOf(e)];
  return tool ? { type: 'tool', tool } : null;
}
