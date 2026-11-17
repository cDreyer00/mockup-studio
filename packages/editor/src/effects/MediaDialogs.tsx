/** Media dialogs: URL embed and the Three.js island code editor. */
import { Suspense, lazy, useEffect, useMemo, useRef, useState } from 'react';
import type { ComponentType, CSSProperties } from 'react';
import { basicSetup, EditorView } from 'codemirror';
import { javascript } from '@codemirror/lang-javascript';
import { oneDark } from '@codemirror/theme-one-dark';
import type { MediaParamValue } from '@mockup/core';
import { runOps } from '../properties/shared';
import { useNode } from '../state/hooks';
import { ui } from '../state/uiStore';
import { PROVIDER_LABELS, specFromUrl } from './embedUrl';
import { insertFromUrl } from './mediaFlows';
import { mediaDialogs, useMediaDialogs } from './mediaStore';
import './effects.css';

/* ---------------- URL embed ---------------- */

function EmbedUrlDialog() {
  const [url, setUrl] = useState('');
  const spec = specFromUrl(url);
  const providerKey = spec ? (spec.kind === 'video' ? 'video' : spec.spec.provider) : null;
  const submit = () => {
    if (!spec) return;
    mediaDialogs.closeEmbedUrl();
    void insertFromUrl(url);
  };
  return (
    <div
      className="modal-backdrop"
      onPointerDown={(e) => e.target === e.currentTarget && mediaDialogs.closeEmbedUrl()}
    >
      <form
        className="modal"
        role="dialog"
        aria-label="Embed from URL"
        data-testid="embed-dialog"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
        onKeyDown={(e) => {
          if (e.key === 'Escape') mediaDialogs.closeEmbedUrl();
          e.stopPropagation();
        }}
      >
        <h2>Embed from URL</h2>
        <div className="modal-message">
          YouTube, Lottie (.json), Rive (.riv), video (.mp4, .webm) or any page (iframe).
        </div>
        <label className="modal-field">
          <span>URL</span>
          <input
            autoFocus
            data-testid="embed-url-input"
            value={url}
            placeholder="https://"
            spellCheck={false}
            onChange={(e) => setUrl(e.target.value)}
          />
        </label>
        <div className="fx-embed-provider" data-testid="embed-provider-line">
          {url.trim() &&
            (providerKey ? (
              <>
                Detected provider:{' '}
                <strong data-testid="embed-provider">{PROVIDER_LABELS[providerKey]}</strong>
              </>
            ) : (
              <span data-testid="embed-provider-none">URL not recognized</span>
            ))}
        </div>
        <div className="modal-actions">
          <button type="button" className="btn" onClick={mediaDialogs.closeEmbedUrl}>
            Cancel
          </button>
          <button type="submit" className="btn primary" data-testid="embed-insert" disabled={!spec}>
            Insert
          </button>
        </div>
      </form>
    </div>
  );
}

/* ---------------- Three.js code editor ---------------- */

type ThreeViewProps = {
  code: string;
  params: Record<string, MediaParamValue>;
  style?: CSSProperties;
};

// ThreeView lives in fx/ (another module): if it does not exist yet, the preview falls back to the notice.
const threeModules = import.meta.glob('../fx/ThreeView.tsx') as Record<
  string,
  () => Promise<{
    ThreeView?: ComponentType<ThreeViewProps>;
    default?: ComponentType<ThreeViewProps>;
  }>
>;
const loadThreeView = Object.values(threeModules)[0];
const LazyThreeView = loadThreeView
  ? lazy(async () => {
      const m = await loadThreeView();
      return { default: (m.ThreeView ?? m.default) as ComponentType<ThreeViewProps> };
    })
  : null;

function ThreeEditorDialog({ nodeId }: { nodeId: string }) {
  const node = useNode(nodeId);
  const initial = useRef(node?.embed?.code ?? '').current;
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const [previewCode, setPreviewCode] = useState(initial);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const params = useMemo(() => node?.embed?.params ?? {}, [node?.embed?.params]);

  useEffect(() => {
    if (!host.current) return;
    const v = new EditorView({
      doc: initial,
      parent: host.current,
      extensions: [
        basicSetup,
        javascript(),
        oneDark,
        EditorView.updateListener.of((u) => {
          if (!u.docChanged) return;
          clearTimeout(timer.current);
          timer.current = setTimeout(() => setPreviewCode(u.state.doc.toString()), 600);
        }),
      ],
    });
    view.current = v;
    v.focus();
    return () => {
      clearTimeout(timer.current);
      v.destroy();
      view.current = null;
    };
  }, [initial]);

  // The node is gone (undo, remote deletion): close.
  useEffect(() => {
    if (!node?.embed) mediaDialogs.closeThree();
  }, [node?.embed]);

  const apply = () => {
    const embed = node?.embed;
    const v = view.current;
    if (!embed || !v) return;
    const code = v.state.doc.toString();
    mediaDialogs.closeThree();
    if (code === embed.code) return;
    void runOps([{ type: 'setMedia', changes: [{ nodeId, embed: { ...embed, code } }] }]).catch(
      (e) => ui.toast(e instanceof Error ? e.message : String(e), 'error'),
    );
  };

  return (
    <div className="modal-backdrop">
      <div
        className="modal fx-modal-wide"
        role="dialog"
        aria-label="Three.js code editor"
        data-testid="three-editor"
        // Capture: Ctrl+Enter and Esc are handled before CodeMirror; nothing leaks to the canvas shortcuts.
        onKeyDownCapture={(e) => {
          if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            e.stopPropagation();
            apply();
          } else if (e.key === 'Escape') {
            e.preventDefault();
            e.stopPropagation();
            mediaDialogs.closeThree();
          }
        }}
        onKeyDown={(e) => e.stopPropagation()}
      >
        <h2>Three.js island</h2>
        <div className="fx-three">
          <div className="fx-three-code" ref={host} data-testid="three-code" />
          <div className="fx-three-preview" data-testid="three-preview">
            {LazyThreeView ? (
              <Suspense fallback="Loading preview…">
                <LazyThreeView
                  code={previewCode}
                  params={params}
                  style={{ width: '100%', height: '100%' }}
                />
              </Suspense>
            ) : (
              <span>Preview unavailable: apply the code to see it on the canvas.</span>
            )}
          </div>
        </div>
        <div className="modal-actions">
          <span className="modal-message" style={{ marginRight: 'auto' }}>
            Ctrl+Enter applies · Esc discards
          </span>
          <button type="button" className="btn" onClick={mediaDialogs.closeThree}>
            Close
          </button>
          <button type="button" className="btn primary" data-testid="three-apply" onClick={apply}>
            Apply
          </button>
        </div>
      </div>
    </div>
  );
}

/** Mount once (in the bar): renders the open dialog, if any. */
export function MediaDialogsHost() {
  const embedOpen = useMediaDialogs((s) => s.embedUrlOpen);
  const threeId = useMediaDialogs((s) => s.threeNodeId);
  return (
    <>
      {embedOpen && <EmbedUrlDialog />}
      {threeId && <ThreeEditorDialog key={threeId} nodeId={threeId} />}
    </>
  );
}
