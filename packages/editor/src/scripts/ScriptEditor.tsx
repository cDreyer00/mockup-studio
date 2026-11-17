/**
 * Code editor of the scripts panel. CodeMirror is loaded on demand; meanwhile (and if loading
 * fails) a plain textarea acts as the editor. The container exposes the `EditorView` as
 * `element.mockupEditorView` for the e2e tests.
 */
import { useEffect, useRef, useState } from 'react';
import type { EditorView } from '@codemirror/view';

export type EditorHost = HTMLDivElement & { mockupEditorView?: EditorView };

interface Props {
  value: string;
  onChange: (code: string) => void;
  onRun: () => void;
}

export function ScriptEditor({ value, onChange, onRun }: Props) {
  const hostRef = useRef<EditorHost>(null);
  const viewRef = useRef<EditorView | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'failed'>('loading');
  // Latest callbacks and value, read by the editor without recreating it.
  const latest = useRef({ value, onChange, onRun });
  latest.current = { value, onChange, onRun };

  useEffect(() => {
    let cancelled = false;
    let view: EditorView | null = null;
    import('./cm').then(
      ({ createScriptEditor }) => {
        const host = hostRef.current;
        if (cancelled || !host) return;
        view = createScriptEditor({
          parent: host,
          doc: latest.current.value,
          onChange: (code) => latest.current.onChange(code),
          onRun: () => latest.current.onRun(),
        });
        viewRef.current = view;
        host.mockupEditorView = view;
        setState('ready');
      },
      () => {
        if (!cancelled) setState('failed');
      },
    );
    return () => {
      cancelled = true;
      view?.destroy();
      viewRef.current = null;
      if (hostRef.current) delete hostRef.current.mockupEditorView;
    };
  }, []);

  // Value changed from outside (open script, example, generation): sync the editor.
  useEffect(() => {
    const view = viewRef.current;
    if (!view || state !== 'ready') return;
    const cur = view.state.doc.toString();
    if (cur !== value) view.dispatch({ changes: { from: 0, to: cur.length, insert: value } });
  }, [value, state]);

  return (
    <>
      <div
        ref={hostRef}
        className="sc-editor"
        data-testid="script-editor"
        data-ready={state === 'ready'}
        hidden={state !== 'ready'}
      />
      {state !== 'ready' && (
        <textarea
          className="sc-fallback mono"
          data-testid="script-editor-fallback"
          spellCheck={false}
          value={value}
          placeholder={state === 'loading' ? 'Loading editor…' : ''}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
              e.preventDefault();
              onRun();
            }
          }}
        />
      )}
    </>
  );
}
