/** Scripts panel: editor, execution, output, `scripts/*.js` library and AI generation. */
import { useCallback, useEffect, useState } from 'react';
import { isVirtualId } from '@mockup/core';
import type { ScriptFileInfo } from '@mockup/core';
import { FilePlus, FolderOpen, Play, Save, SaveAll, Sparkles, Trash2 } from 'lucide-react';
import { daemon } from '../client/daemon';
import { useDoc } from '../state/docStore';
import { ui, useUi } from '../state/uiStore';
import { prompt } from '../ui/overlays';
import { SCRIPT_EXAMPLES } from './examples';
import { ScriptEditor } from './ScriptEditor';
import { ScriptOutput } from './ScriptOutput';
import { DEFAULT_SCRIPT, NEW_DRAFT, scriptsStore, useScripts } from './scriptsStore';
import './scripts.css';

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export function ScriptsPanel() {
  const docId = useDoc((s) => s.activeDocId);
  const status = useDoc((s) => s.status);
  const draft = useScripts((s) => (docId ? s.drafts[docId] : undefined)) ?? NEW_DRAFT;
  const [running, setRunning] = useState(false);
  const [library, setLibrary] = useState<{ dir: string | null; scripts: ScriptFileInfo[] } | null>(
    null,
  );
  const [showLibrary, setShowLibrary] = useState(false);
  const [aiPrompt, setAiPrompt] = useState('');
  const [generating, setGenerating] = useState(false);
  const [aiError, setAiError] = useState<string | null>(null);

  const refreshLibrary = useCallback(async () => {
    if (!docId) return;
    try {
      setLibrary(await daemon.scriptList(docId));
    } catch {
      setLibrary(null);
    }
  }, [docId]);

  useEffect(() => {
    setLibrary(null);
    setAiError(null);
    if (docId && status === 'online') void refreshLibrary();
  }, [docId, status, refreshLibrary]);

  const run = useCallback(async () => {
    if (!docId || running) return;
    const code = useScripts.getState().drafts[docId]?.code ?? NEW_DRAFT.code;
    setRunning(true);
    try {
      const selection = useUi.getState().selection.filter((id) => !isVirtualId(id));
      const output = await daemon.scriptRun(code, { selection, docId });
      scriptsStore.patch(docId, { output });
    } catch (e) {
      scriptsStore.patch(docId, {
        output: { ok: false, logs: [], error: message(e), images: [], opsCount: 0, durationMs: 0 },
      });
    } finally {
      setRunning(false);
    }
  }, [docId, running]);

  const saveAs = async (forceAsk: boolean) => {
    if (!docId) return;
    let name = forceAsk ? null : draft.name;
    if (!name) {
      const r = await prompt({
        title: forceAsk ? 'Save script as' : 'Save script',
        fields: [
          {
            name: 'name',
            label: 'File name (in scripts/)',
            value: draft.name ?? '',
            placeholder: 'rename-texts',
          },
        ],
        confirmLabel: 'Save',
      });
      name = r?.name.trim() || null;
      if (!name) return;
    }
    try {
      const res = await daemon.scriptSave(name, draft.code, docId);
      scriptsStore.patch(docId, { name: res.name, dirty: false });
      ui.toast(`Script saved: ${res.name}`);
      void refreshLibrary();
    } catch (e) {
      ui.toast(message(e), 'error');
    }
  };

  const open = async (name: string) => {
    if (!docId) return;
    try {
      const res = await daemon.scriptRead(name, docId);
      scriptsStore.load(docId, res.code, res.name);
    } catch (e) {
      ui.toast(message(e), 'error');
    }
  };

  const remove = async (name: string) => {
    if (!docId) return;
    const ok = await prompt({
      title: 'Delete script',
      message: `Delete "${name}" from the library? This action cannot be undone.`,
      fields: [],
      confirmLabel: 'Delete',
    });
    if (!ok) return;
    try {
      await daemon.scriptDelete(name, docId);
      if (draft.name === name) scriptsStore.patch(docId, { name: null });
      void refreshLibrary();
    } catch (e) {
      ui.toast(message(e), 'error');
    }
  };

  const generate = async () => {
    const text = aiPrompt.trim();
    if (!docId || !text || generating) return;
    setGenerating(true);
    setAiError(null);
    try {
      const res = await daemon.scriptGenerate(text, docId);
      scriptsStore.load(docId, res.code, null, true);
    } catch (e) {
      setAiError(message(e));
    } finally {
      setGenerating(false);
    }
  };

  if (!docId) {
    return (
      <div className="sc-panel" data-testid="scripts-panel">
        <div className="sc-muted sc-pad">Open a document to write scripts.</div>
      </div>
    );
  }

  return (
    <div className="sc-panel" data-testid="scripts-panel">
      <div className="sc-toolbar">
        <button
          type="button"
          className="btn primary sc-run"
          data-testid="script-run"
          title="Run (Ctrl+Enter)"
          disabled={running}
          onClick={() => void run()}
        >
          <Play size={12} /> {running ? 'Running…' : 'Run'}
        </button>
        <select
          className="select-input sc-examples"
          data-testid="script-examples"
          aria-label="Examples"
          value=""
          onChange={(e) => {
            const ex = SCRIPT_EXAMPLES.find((x) => x.id === e.target.value);
            if (ex) scriptsStore.load(docId, ex.code, null, true);
          }}
        >
          <option value="">Examples…</option>
          {SCRIPT_EXAMPLES.map((ex) => (
            <option key={ex.id} value={ex.id}>
              {ex.label}
            </option>
          ))}
        </select>
        <button
          type="button"
          className="icon-btn"
          title="New script"
          data-testid="script-new"
          onClick={() => scriptsStore.load(docId, DEFAULT_SCRIPT, null)}
        >
          <FilePlus size={14} />
        </button>
        <button
          type="button"
          className={`icon-btn${showLibrary ? ' active' : ''}`}
          title="Script library"
          data-testid="script-library-toggle"
          onClick={() => setShowLibrary((v) => !v)}
        >
          <FolderOpen size={14} />
        </button>
        <button
          type="button"
          className="icon-btn"
          title="Save"
          data-testid="script-save"
          onClick={() => void saveAs(false)}
        >
          <Save size={14} />
        </button>
        <button
          type="button"
          className="icon-btn"
          title="Save as…"
          data-testid="script-save-as"
          onClick={() => void saveAs(true)}
        >
          <SaveAll size={14} />
        </button>
      </div>

      {showLibrary && (
        <div className="sc-library" data-testid="script-library">
          {library?.dir === null ? (
            <div className="sc-warn" data-testid="script-library-nopath">
              Save the document to a file to use the script library (the <code>scripts/</code>{' '}
              folder next to it).
            </div>
          ) : !library || library.scripts.length === 0 ? (
            <div className="sc-muted sc-pad">No saved scripts yet.</div>
          ) : (
            library.scripts.map((s) => (
              <div key={s.name} className={`sc-lib-row${draft.name === s.name ? ' active' : ''}`}>
                <button
                  type="button"
                  className="sc-lib-open"
                  data-testid={`script-open-${s.name}`}
                  title={`Open ${s.name}`}
                  onClick={() => void open(s.name)}
                >
                  {s.name}
                </button>
                <button
                  type="button"
                  className="icon-btn"
                  title={`Delete ${s.name}`}
                  data-testid={`script-delete-${s.name}`}
                  onClick={() => void remove(s.name)}
                >
                  <Trash2 size={13} />
                </button>
              </div>
            ))
          )}
        </div>
      )}

      <form
        className="sc-ai"
        onSubmit={(e) => {
          e.preventDefault();
          void generate();
        }}
      >
        <input
          className="text-input"
          data-testid="script-ai-prompt"
          placeholder="Generate with AI: describe the script…"
          value={aiPrompt}
          disabled={generating}
          onChange={(e) => setAiPrompt(e.target.value)}
        />
        <button
          type="submit"
          className="btn"
          data-testid="script-ai-generate"
          disabled={generating || !aiPrompt.trim()}
          title="Generate script with AI"
        >
          <Sparkles size={12} /> {generating ? 'Generating…' : 'Generate'}
        </button>
      </form>
      {aiError && (
        <div className="sc-error-line" role="alert" data-testid="script-ai-error">
          {aiError}
        </div>
      )}

      <div className="sc-name" data-testid="script-name">
        {draft.name ?? 'Untitled'}
        {draft.dirty ? ' •' : ''}
      </div>
      <div className="sc-editor-wrap">
        <ScriptEditor
          value={draft.code}
          onChange={(code) => scriptsStore.setCode(docId, code)}
          onRun={() => void run()}
        />
      </div>
      <ScriptOutput output={draft.output} running={running} />
    </div>
  );
}
