/** Context menus, text dialog (prompt) and toasts. State lives in its own store. */
import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { create } from 'zustand';
import { useUi } from '../state/uiStore';

/* ---------------- context menu ---------------- */

export interface MenuItem {
  label: string;
  /** Shortcut shown on the right (text only). */
  shortcut?: string;
  disabled?: boolean;
  danger?: boolean;
  onSelect?: () => void;
  /** Separator before this item. */
  separator?: boolean;
}

interface MenuState {
  menu: { x: number; y: number; items: MenuItem[] } | null;
}
const useMenu = create<MenuState>(() => ({ menu: null }));

/** Opens a context menu at the screen position (clientX, clientY). */
export function openContextMenu(x: number, y: number, items: MenuItem[]): void {
  useMenu.setState({ menu: { x, y, items } });
}
export function closeContextMenu(): void {
  useMenu.setState({ menu: null });
}

function ContextMenuHost() {
  const menu = useMenu((s) => s.menu);
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  useEffect(() => {
    if (!menu) return setPos(null);
    const el = ref.current;
    const w = el?.offsetWidth ?? 200;
    const h = el?.offsetHeight ?? 200;
    setPos({
      x: Math.min(menu.x, window.innerWidth - w - 4),
      y: Math.min(menu.y, window.innerHeight - h - 4),
    });
    const close = (e: Event) => {
      if (e instanceof KeyboardEvent && e.key !== 'Escape') return;
      if (e.type === 'pointerdown' && el?.contains(e.target as globalThis.Node)) return;
      closeContextMenu();
    };
    window.addEventListener('pointerdown', close, true);
    window.addEventListener('keydown', close, true);
    window.addEventListener('blur', close);
    return () => {
      window.removeEventListener('pointerdown', close, true);
      window.removeEventListener('keydown', close, true);
      window.removeEventListener('blur', close);
    };
  }, [menu]);
  if (!menu) return null;
  return (
    <div
      ref={ref}
      className="context-menu"
      role="menu"
      style={{
        left: pos?.x ?? menu.x,
        top: pos?.y ?? menu.y,
        visibility: pos ? 'visible' : 'hidden',
      }}
      onContextMenu={(e) => e.preventDefault()}
    >
      {menu.items.map((item, i) => (
        <div key={i}>
          {item.separator && <div className="context-menu-sep" />}
          <button
            type="button"
            role="menuitem"
            className={`context-menu-item${item.danger ? ' danger' : ''}`}
            disabled={item.disabled}
            onClick={() => {
              closeContextMenu();
              item.onSelect?.();
            }}
          >
            <span>{item.label}</span>
            {item.shortcut && <span className="context-menu-shortcut">{item.shortcut}</span>}
          </button>
        </div>
      ))}
    </div>
  );
}

/* ---------------- prompt (text dialog) ---------------- */

export interface PromptField {
  name: string;
  label: string;
  value?: string;
  placeholder?: string;
}

interface PromptRequest {
  title: string;
  message?: ReactNode;
  fields: PromptField[];
  confirmLabel: string;
  /** Destructive confirmation: red confirm button. */
  danger?: boolean;
  resolve: (values: Record<string, string> | null) => void;
}
const usePrompt = create<{ req: PromptRequest | null }>(() => ({ req: null }));

/**
 * Modal dialog with text fields. Resolves with the values or `null` if cancelled.
 * E.g.: `const r = await prompt({ title: 'Open', fields: [{ name: 'path', label: 'Path' }] })`.
 */
export function prompt(opts: {
  title: string;
  message?: ReactNode;
  fields: PromptField[];
  confirmLabel?: string;
  danger?: boolean;
}): Promise<Record<string, string> | null> {
  return new Promise((resolve) => {
    usePrompt.getState().req?.resolve(null);
    usePrompt.setState({
      req: { ...opts, confirmLabel: opts.confirmLabel ?? 'OK', resolve },
    });
  });
}

function PromptHost() {
  const req = usePrompt((s) => s.req);
  const [values, setValues] = useState<Record<string, string>>({});
  useEffect(() => {
    if (req) setValues(Object.fromEntries(req.fields.map((f) => [f.name, f.value ?? ''])));
  }, [req]);
  if (!req) return null;
  const finish = (v: Record<string, string> | null) => {
    usePrompt.setState({ req: null });
    req.resolve(v);
  };
  return (
    <div
      className="modal-backdrop"
      onPointerDown={(e) => e.target === e.currentTarget && finish(null)}
    >
      <form
        className="modal"
        role="dialog"
        aria-label={req.title}
        onSubmit={(e) => {
          e.preventDefault();
          finish(values);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Escape') finish(null);
          e.stopPropagation();
        }}
      >
        <h2>{req.title}</h2>
        {req.message && <div className="modal-message">{req.message}</div>}
        {req.fields.map((f, i) => (
          <label key={f.name} className="modal-field">
            <span>{f.label}</span>
            <input
              name={f.name}
              autoFocus={i === 0}
              value={values[f.name] ?? ''}
              placeholder={f.placeholder}
              spellCheck={false}
              onChange={(e) => setValues((v) => ({ ...v, [f.name]: e.target.value }))}
            />
          </label>
        ))}
        <div className="modal-actions">
          {/* destructive confirmation: focus starts on Cancel (Esc works, Enter does not delete) */}
          <button
            type="button"
            className="btn"
            autoFocus={req.danger && req.fields.length === 0}
            onClick={() => finish(null)}
          >
            Cancel
          </button>
          <button type="submit" className={`btn primary${req.danger ? ' danger' : ''}`}>
            {req.confirmLabel}
          </button>
        </div>
      </form>
    </div>
  );
}

/* ---------------- toast ---------------- */

function ToastHost() {
  const toast = useUi((s) => s.toast);
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    if (!toast) return;
    setVisible(true);
    const t = setTimeout(() => setVisible(false), toast.kind === 'error' ? 6000 : 2500);
    return () => clearTimeout(t);
  }, [toast]);
  if (!toast || !visible) return null;
  return (
    <div className={`toast ${toast.kind}`} role="status">
      {toast.text}
    </div>
  );
}

/** Mount once in the App. */
export function OverlayHost() {
  return (
    <>
      <ContextMenuHost />
      <PromptHost />
      <ToastHost />
    </>
  );
}
