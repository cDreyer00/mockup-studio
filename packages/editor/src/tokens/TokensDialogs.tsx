/** Import and export dialogs for tokens (CSS, W3C/JSON and Tailwind). */
import { useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { exportTokens, parseTokens, planImportTokens } from '@mockup/core';
import type { Document, Op, TokenExportFormat, TokenSet } from '@mockup/core';
import { ui } from '../state/uiStore';

function Modal({
  title,
  onClose,
  children,
  testId,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  testId: string;
}) {
  // Esc closes even when focus is still outside the dialog.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div
      className="modal-backdrop"
      onPointerDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <div
        className="modal tk-modal"
        role="dialog"
        aria-label={title}
        data-testid={testId}
        onKeyDown={(e) => {
          if (e.key === 'Escape') onClose();
          e.stopPropagation();
        }}
      >
        <h2>{title}</h2>
        {children}
      </div>
    </div>
  );
}

/** Parses the pasted text (CSS or W3C JSON); returns the set or the error message. */
export function tryParseTokens(text: string): { set?: TokenSet; error?: string } {
  if (!text.trim()) return {};
  try {
    return { set: parseTokens(text) };
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}

export function ImportDialog({
  doc,
  run,
  onClose,
}: {
  doc: Document;
  run: (ops: Op[]) => void;
  onClose: () => void;
}) {
  const [text, setText] = useState('');
  const [mode, setMode] = useState<'merge' | 'replace'>('merge');
  const parsed = useMemo(() => tryParseTokens(text), [text]);
  const set = parsed.set;
  const count = set ? Object.keys(set.tokens).length : 0;
  const themeCount = set?.themes.length ?? 0;

  const confirm = () => {
    if (!set) return;
    try {
      run(planImportTokens(doc, set, mode));
      onClose();
    } catch (e) {
      ui.toast(e instanceof Error ? e.message : String(e), 'error');
    }
  };

  return (
    <Modal title="Import tokens" onClose={onClose} testId="tokens-import-dialog">
      <div className="modal-message">
        Paste CSS (<code>:root {'{ --x: … }'}</code> and <code>[data-theme]</code>) or JSON in the
        W3C Design Tokens format.
      </div>
      <textarea
        className="tk-textarea mono"
        data-testid="tokens-import-text"
        value={text}
        rows={10}
        autoFocus
        spellCheck={false}
        placeholder={':root {\n  --color-primary: #2dd4bf;\n}'}
        onChange={(e) => setText(e.target.value)}
      />
      <label className="tk-mode">
        <span>Mode</span>
        <select
          className="select-input"
          data-testid="tokens-import-mode"
          value={mode}
          onChange={(e) => setMode(e.target.value as 'merge' | 'replace')}
        >
          <option value="merge">Merge (keeps what exists)</option>
          <option value="replace">Replace all</option>
        </select>
      </label>
      <div className="tk-import-info" data-testid="tokens-import-info">
        {parsed.error && <div className="tk-error">{parsed.error}</div>}
        {set && (
          <div>
            {count} {count === 1 ? 'token' : 'tokens'}, {themeCount}{' '}
            {themeCount === 1 ? 'theme' : 'themes'} found.
          </div>
        )}
        {set?.warnings.map((w, i) => (
          <div key={i} className="tk-warning" data-testid="tokens-import-warning">
            {w}
          </div>
        ))}
        {mode === 'replace' && set && (
          <div className="tk-warning">Replace swaps out all current tokens and themes.</div>
        )}
      </div>
      <div className="modal-actions">
        <button type="button" className="btn" onClick={onClose}>
          Cancel
        </button>
        <button
          type="button"
          className="btn primary"
          data-testid="tokens-import-confirm"
          disabled={!set || (count === 0 && themeCount === 0)}
          onClick={confirm}
        >
          Import
        </button>
      </div>
    </Modal>
  );
}

const FORMATS: { id: TokenExportFormat; label: string }[] = [
  { id: 'css', label: 'CSS (variables)' },
  { id: 'json', label: 'JSON (W3C Design Tokens)' },
  { id: 'tailwind', label: 'Tailwind v4 (@theme)' },
];

/** Copies text to the clipboard (with a fallback for contexts without the API). */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand?.('copy') ?? false;
    ta.remove();
    return ok;
  }
}

export function ExportDialog({ doc, onClose }: { doc: Document; onClose: () => void }) {
  const [format, setFormat] = useState<TokenExportFormat>('css');
  const out = useMemo(() => {
    try {
      return exportTokens(doc, format);
    } catch (e) {
      return `/* ${e instanceof Error ? e.message : String(e)} */`;
    }
  }, [doc, format]);

  return (
    <Modal title="Export tokens" onClose={onClose} testId="tokens-export-dialog">
      <label className="tk-mode">
        <span>Format</span>
        <select
          className="select-input"
          data-testid="tokens-export-format"
          value={format}
          onChange={(e) => setFormat(e.target.value as TokenExportFormat)}
        >
          {FORMATS.map((f) => (
            <option key={f.id} value={f.id}>
              {f.label}
            </option>
          ))}
        </select>
      </label>
      <textarea
        className="tk-textarea mono"
        data-testid="tokens-export-text"
        value={out}
        rows={12}
        readOnly
        spellCheck={false}
      />
      <div className="modal-actions">
        <button type="button" className="btn" onClick={onClose}>
          Close
        </button>
        <button
          type="button"
          className="btn primary"
          data-testid="tokens-export-copy"
          onClick={() =>
            void copyText(out).then((ok) =>
              ui.toast(ok ? 'Copied to the clipboard' : 'Could not copy', ok ? 'info' : 'error'),
            )
          }
        >
          Copy
        </button>
      </div>
    </Modal>
  );
}
