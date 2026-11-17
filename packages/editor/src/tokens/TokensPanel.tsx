/** Aba "Tokens" do painel esquerdo: tokens por grupo, temas, importar/exportar. */
import { useMemo, useState } from 'react';
import type { KeyboardEvent } from 'react';
import { ChevronDown, ChevronRight, Download, Pencil, Plus, Trash2, Upload } from 'lucide-react';
import { TOKEN_GROUPS, planCreateTheme, planDeleteTheme, planRenameTheme } from '@mockup/core';
import type { Document, Op } from '@mockup/core';
import { daemon } from '../client/daemon';
import { useDoc } from '../state/docStore';
import { ui } from '../state/uiStore';
import { prompt } from '../ui/overlays';
import { tokenReportFor } from './reportCache';
import { GroupsDatalist, TokenRow } from './TokenRow';
import { ExportDialog, ImportDialog } from './TokensDialogs';
import { groupTokens, planCreateToken, summarizeTokens, themeNameError } from './tokensLogic';

/** Envia as ops numa única entrada de undo (erros já viram toast no cliente). */
function run(ops: Op[]): void {
  if (ops.length) void daemon.applySafe(ops);
}

const collapsedGroups = new Set<string>();

function NewTokenForm({ doc, onDone }: { doc: Document; onDone: () => void }) {
  const [name, setName] = useState('');
  const [value, setValue] = useState('');
  const [group, setGroup] = useState('');
  const [error, setError] = useState<string | null>(null);

  const submit = () => {
    try {
      run(planCreateToken(doc, { name, value, group: group || undefined }));
      onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      submit();
    } else if (e.key === 'Escape') onDone();
    e.stopPropagation();
  };

  return (
    <div className="tk-new" data-testid="tokens-new-form">
      <input
        className="text-input mono"
        data-testid="new-token-name"
        value={name}
        autoFocus
        placeholder="nome (ex.: color-primary)"
        spellCheck={false}
        onChange={(e) => {
          setName(e.target.value);
          setError(null);
        }}
        onKeyDown={onKey}
      />
      <input
        className="text-input mono"
        data-testid="new-token-value"
        value={value}
        placeholder="valor (ex.: #2dd4bf)"
        spellCheck={false}
        onChange={(e) => {
          setValue(e.target.value);
          setError(null);
        }}
        onKeyDown={onKey}
      />
      <div className="tk-new-row">
        <select
          className="select-input"
          data-testid="new-token-group"
          value={group}
          title="Grupo"
          onChange={(e) => setGroup(e.target.value)}
        >
          <option value="">Grupo: automático</option>
          {TOKEN_GROUPS.map((g) => (
            <option key={g.id} value={g.id}>
              {g.label}
            </option>
          ))}
        </select>
        <button
          type="button"
          className="btn primary"
          data-testid="new-token-submit"
          onClick={submit}
        >
          Criar
        </button>
        <button type="button" className="btn" onClick={onDone}>
          Cancelar
        </button>
      </div>
      {error && (
        <div className="tk-error" role="alert" data-testid="new-token-error">
          {error}
        </div>
      )}
    </div>
  );
}

export function TokensPanel() {
  const doc = useDoc((s) => s.doc);
  const [themeSel, setThemeSel] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [adding, setAdding] = useState(false);
  const [dialog, setDialog] = useState<'import' | 'export' | null>(null);
  const [, bump] = useState(0);

  const report = useMemo(() => (doc ? tokenReportFor(doc) : null), [doc]);
  const groups = useMemo(() => (report ? groupTokens(report.tokens, query) : []), [report, query]);
  const summary = useMemo(() => (report ? summarizeTokens(report) : null), [report]);

  if (!doc || !report) {
    return (
      <aside className="panel panel-left tk-panel" data-testid="tokens-panel">
        <div className="tk-empty">Nenhum documento aberto.</div>
      </aside>
    );
  }

  const theme = themeSel && doc.themes?.some((t) => t.name === themeSel) ? themeSel : null;

  const newTheme = async () => {
    const r = await prompt({
      title: 'Novo tema',
      message: theme ? `Copia as sobrescritas de "${theme}".` : undefined,
      fields: [{ name: 'name', label: 'Nome do tema', placeholder: 'dark' }],
      confirmLabel: 'Criar',
    });
    if (!r) return;
    const name = r.name!.trim();
    const err = themeNameError(doc, name);
    if (err) return ui.toast(`Tema inválido: ${err}`, 'error');
    run(planCreateTheme(doc, name, theme ? { copyFrom: theme } : {}));
    setThemeSel(name);
  };

  const renameTheme = async () => {
    if (!theme) return;
    const r = await prompt({
      title: `Renomear tema "${theme}"`,
      fields: [{ name: 'name', label: 'Novo nome', value: theme }],
      confirmLabel: 'Renomear',
    });
    if (!r) return;
    const name = r.name!.trim();
    if (name === theme) return;
    const err = themeNameError(doc, name, theme);
    if (err) return ui.toast(`Tema inválido: ${err}`, 'error');
    run(planRenameTheme(doc, theme, name));
    setThemeSel(name);
  };

  const deleteTheme = () => {
    if (!theme) return;
    run(planDeleteTheme(doc, theme));
    setThemeSel(null);
    ui.toast(`Tema "${theme}" excluído (Ctrl+Z desfaz)`);
  };

  return (
    <aside className="panel panel-left tk-panel" data-testid="tokens-panel">
      <GroupsDatalist doc={doc} />
      <div className="tk-toolbar">
        <div className="tk-theme">
          <select
            className="select-input"
            data-testid="tokens-theme-select"
            value={theme ?? ''}
            title="Tema em edição"
            onChange={(e) => setThemeSel(e.target.value || null)}
          >
            <option value="">Base</option>
            {(doc.themes ?? []).map((t) => (
              <option key={t.name} value={t.name}>
                {t.name}
              </option>
            ))}
          </select>
          <button
            type="button"
            className="icon-btn"
            title="Novo tema"
            aria-label="Novo tema"
            data-testid="tokens-theme-add"
            onClick={() => void newTheme()}
          >
            <Plus size={13} />
          </button>
          <button
            type="button"
            className="icon-btn"
            title="Renomear tema"
            aria-label="Renomear tema"
            data-testid="tokens-theme-rename"
            disabled={!theme}
            onClick={() => void renameTheme()}
          >
            <Pencil size={12} />
          </button>
          <button
            type="button"
            className="icon-btn"
            title="Excluir tema"
            aria-label="Excluir tema"
            data-testid="tokens-theme-delete"
            disabled={!theme}
            onClick={deleteTheme}
          >
            <Trash2 size={12} />
          </button>
        </div>
        <div className="tk-actions">
          <button
            type="button"
            className="icon-btn"
            title="Novo token"
            aria-label="Novo token"
            data-testid="tokens-add"
            onClick={() => setAdding((a) => !a)}
          >
            <Plus size={14} />
          </button>
          <button
            type="button"
            className="icon-btn"
            title="Importar tokens"
            aria-label="Importar tokens"
            data-testid="tokens-import"
            onClick={() => setDialog('import')}
          >
            <Upload size={13} />
          </button>
          <button
            type="button"
            className="icon-btn"
            title="Exportar tokens"
            aria-label="Exportar tokens"
            data-testid="tokens-export"
            onClick={() => setDialog('export')}
          >
            <Download size={13} />
          </button>
        </div>
      </div>
      {theme && (
        <div className="tk-theme-hint" data-testid="tokens-theme-hint">
          Editando o tema <b>{theme}</b>: valores novos viram sobrescritas; o resto herda da base.
        </div>
      )}
      <div className="tk-search">
        <input
          className="text-input"
          data-testid="tokens-search"
          value={query}
          placeholder="Buscar por nome ou valor…"
          spellCheck={false}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') setQuery('');
            e.stopPropagation();
          }}
        />
      </div>
      {adding && <NewTokenForm doc={doc} onDone={() => setAdding(false)} />}
      <div className="tk-list" data-testid="tokens-list">
        {report.tokens.length === 0 && !adding && (
          <div className="tk-empty">Nenhum token. Crie um com + ou importe CSS/JSON.</div>
        )}
        {report.tokens.length > 0 && groups.length === 0 && (
          <div className="tk-empty">Nada encontrado para “{query}”.</div>
        )}
        {groups.map((g) => {
          const closed = collapsedGroups.has(g.id) && !query;
          return (
            <section key={g.id} className="tk-group" data-testid={`token-group-section-${g.id}`}>
              <button
                type="button"
                className="tk-group-head"
                aria-expanded={!closed}
                onClick={() => {
                  if (closed) collapsedGroups.delete(g.id);
                  else collapsedGroups.add(g.id);
                  bump((n) => n + 1);
                }}
              >
                {closed ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
                <span>{g.label}</span>
                <span className="tk-count">{g.tokens.length}</span>
              </button>
              {!closed &&
                g.tokens.map((t) => (
                  <TokenRow
                    key={t.name}
                    doc={doc}
                    report={report}
                    info={t}
                    theme={theme}
                    run={run}
                  />
                ))}
            </section>
          );
        })}
      </div>
      {summary && (summary.unused > 0 || summary.broken > 0) && (
        <div className="tk-footer" data-testid="tokens-footer">
          {summary.broken > 0 && <span className="error">{summary.broken} com problema</span>}
          {summary.unused > 0 && <span>{summary.unused} não usados</span>}
        </div>
      )}
      {dialog === 'import' && <ImportDialog doc={doc} run={run} onClose={() => setDialog(null)} />}
      {dialog === 'export' && <ExportDialog doc={doc} onClose={() => setDialog(null)} />}
    </aside>
  );
}
