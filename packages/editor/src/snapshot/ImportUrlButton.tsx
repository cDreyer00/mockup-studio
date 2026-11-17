/** "Import from URL" toolbar button and its dialog. */
import { useState } from 'react';
import { createPortal } from 'react-dom';
import { Globe } from 'lucide-react';
import { DEFAULT_IMPORT_VIEWPORT, IMPORT_VIEWPORT_LIMITS } from '@mockup/snapshot-core';
import { useDoc } from '../state/docStore';
import { currentPageId } from '../state/hooks';
import { ui } from '../state/uiStore';
import { IconButton } from '../ui/controls';
import { ImportError, postImportUrl, selectImported } from './importApi';
import { importToastText } from './pasteSnapshot';

export const NO_RENDER_MESSAGE =
  'Import from URL needs the render engine: open the desktop app (or `mockup serve --render`).';

/** Validates the URL (http/https); returns the error message or `null`. */
export function validateImportUrl(raw: string): string | null {
  const value = raw.trim();
  if (!value) return 'Enter the URL';
  try {
    const u = new URL(value);
    if (u.protocol !== 'http:' && u.protocol !== 'https:')
      return 'The URL must start with http:// or https://';
  } catch {
    return 'Invalid URL';
  }
  return null;
}

export function ImportUrlDialog({ onClose }: { onClose: () => void }) {
  const [url, setUrl] = useState('');
  const [selector, setSelector] = useState('');
  const [width, setWidth] = useState(String(DEFAULT_IMPORT_VIEWPORT.width));
  const [reference, setReference] = useState(true);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (): Promise<void> => {
    const invalid = validateImportUrl(url);
    const w = Number(width);
    if (invalid) return setError(invalid);
    const { minWidth, maxWidth } = IMPORT_VIEWPORT_LIMITS;
    if (!Number.isFinite(w) || w < minWidth || w > maxWidth) {
      return setError(`Viewport width between ${minWidth} and ${maxWidth}`);
    }
    setError(null);
    setLoading(true);
    try {
      const docId = useDoc.getState().activeDocId;
      const result = await postImportUrl({
        url: url.trim(),
        ...(selector.trim() ? { selector: selector.trim() } : {}),
        viewport: { width: Math.round(w) },
        reference,
        ...(docId ? { docId } : {}),
        ...(currentPageId() ? { pageId: currentPageId()! } : {}),
      });
      await selectImported(result.frameId, { fit: true });
      ui.toast(importToastText(result));
      onClose();
    } catch (e) {
      setError(
        e instanceof ImportError && e.status === 503
          ? NO_RENDER_MESSAGE
          : e instanceof Error
            ? e.message
            : String(e),
      );
      setLoading(false);
    }
  };

  return (
    <div
      className="modal-backdrop"
      onPointerDown={(e) => e.target === e.currentTarget && !loading && onClose()}
    >
      <form
        className="modal"
        role="dialog"
        aria-label="Import from URL"
        data-testid="import-url-dialog"
        onSubmit={(e) => {
          e.preventDefault();
          if (!loading) void submit();
        }}
        onKeyDown={(e) => {
          if (e.key === 'Escape' && !loading) onClose();
          e.stopPropagation();
        }}
      >
        <h2>Import from URL</h2>
        <label className="modal-field">
          <span>URL</span>
          <input
            name="url"
            autoFocus
            value={url}
            placeholder="https://example.com"
            spellCheck={false}
            onChange={(e) => setUrl(e.target.value)}
          />
        </label>
        <label className="modal-field">
          <span>CSS selector (optional; empty = whole page)</span>
          <input
            name="selector"
            value={selector}
            placeholder="body"
            spellCheck={false}
            onChange={(e) => setSelector(e.target.value)}
          />
        </label>
        <label className="modal-field">
          <span>Viewport width</span>
          <input
            name="width"
            inputMode="numeric"
            value={width}
            onChange={(e) => setWidth(e.target.value)}
          />
        </label>
        <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <input
            type="checkbox"
            name="reference"
            checked={reference}
            onChange={(e) => setReference(e.target.checked)}
          />
          <span>Attach reference image</span>
        </label>
        {error && (
          <div
            className="modal-message"
            role="alert"
            data-testid="import-url-error"
            style={{ color: '#fecaca' }}
          >
            {error}
          </div>
        )}
        <div className="modal-actions">
          <button type="button" className="btn" disabled={loading} onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn primary" disabled={loading}>
            {loading ? 'Importing…' : 'Import'}
          </button>
        </div>
      </form>
    </div>
  );
}

export function ImportUrlButton() {
  const [open, setOpen] = useState(false);
  const hasDoc = useDoc((s) => !!s.doc);
  return (
    <>
      <IconButton
        title="Import from URL"
        disabled={!hasDoc}
        data-testid="import-url"
        onClick={() => setOpen(true)}
      >
        <Globe size={16} />
      </IconButton>
      {open && createPortal(<ImportUrlDialog onClose={() => setOpen(false)} />, document.body)}
    </>
  );
}
