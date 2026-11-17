/** Painel de dados do repetidor: origem, tabela editável, mapeamento de campos e conversão. */
import { useContext, useState } from 'react';
import { createPortal } from 'react-dom';
import { Link2, Plus, RefreshCw, Repeat, Trash2 } from 'lucide-react';
import { dataColumns } from '@mockup/core';
import type { Node } from '@mockup/core';
import { daemon } from '../client/daemon';
import { convertToRepeater, features } from '../client/features';
import { ui } from '../state/uiStore';
import { Section, SelectInput } from '../ui/controls';
import {
  addColumn,
  addRow,
  cellText,
  describeSource,
  removeColumn,
  removeRow,
  setCell,
  setDataOp,
  tableColumns,
  unmappedFields,
  withMapping,
} from './dataTable';
import { Body, LockedContext } from './shared';
import { prompt } from '../ui/overlays';

/** Linhas além disto não são desenhadas (a lista continua inteira no documento). */
const MAX_ROWS_SHOWN = 500;

const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

function formatFetched(iso: string | undefined): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString('pt-BR');
}

/** Célula editável: confirma no blur/Enter, Esc descarta. */
function Cell({
  row,
  column,
  value,
  onCommit,
}: {
  row: number;
  column: string;
  value: unknown;
  onCommit: (text: string) => void;
}) {
  const shown = cellText(value);
  const [text, setText] = useState<string | null>(null);
  return (
    <input
      className="data-cell"
      data-testid={`data-cell-${row}-${column}`}
      value={text ?? shown}
      spellCheck={false}
      onChange={(e) => setText(e.target.value)}
      onBlur={() => {
        if (text !== null && text !== shown) onCommit(text);
        setText(null);
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
        else if (e.key === 'Escape') {
          setText(null);
          (e.target as HTMLInputElement).blur();
        }
        e.stopPropagation();
      }}
    />
  );
}

/** Diálogo "Vincular…": cola JSON/CSV, caminho de arquivo ou URL. */
function BindDialog({ node, onClose }: { node: Node; onClose: () => void }) {
  const [text, setText] = useState('');
  const [origin, setOrigin] = useState('');
  const [format, setFormat] = useState('');
  const [select, setSelect] = useState('');
  const [limit, setLimit] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (): Promise<void> => {
    const body: Parameters<typeof features.bindData>[1] = {};
    if (text.trim()) {
      body.text = text;
      if (format) body.format = format as 'json' | 'csv';
      else body.format = /^\s*[[{]/.test(text) ? 'json' : 'csv';
    } else if (/^https?:\/\//i.test(origin.trim())) body.url = origin.trim();
    else if (origin.trim()) body.path = origin.trim();
    else return setError('Cole os dados, informe o caminho de um arquivo ou uma URL.');
    if (select.trim()) body.select = select.trim();
    const n = Number(limit);
    if (limit.trim() && Number.isInteger(n) && n > 0) body.limit = n;
    if (node.dataSource?.mapping) body.mapping = node.dataSource.mapping;
    setBusy(true);
    setError(null);
    try {
      const res = await features.bindData(node.id, body);
      ui.toast(`${res.count} itens vinculados`);
      onClose();
    } catch (e) {
      setError(errMsg(e));
    } finally {
      setBusy(false);
    }
  };

  return createPortal(
    <div
      className="modal-backdrop"
      onPointerDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <form
        className="modal data-bind-dialog"
        role="dialog"
        aria-label="Vincular dados"
        data-testid="data-bind-dialog"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
        onKeyDown={(e) => {
          if (e.key === 'Escape') onClose();
          e.stopPropagation();
        }}
      >
        <h2>Vincular dados</h2>
        <label className="modal-field">
          <span>Colar JSON ou CSV</span>
          <textarea
            className="data-bind-text"
            data-testid="data-bind-text"
            value={text}
            rows={6}
            spellCheck={false}
            placeholder={'[{"nome": "Ana"}, {"nome": "Bia"}]\nou\nnome,cargo\nAna,Dev'}
            onChange={(e) => setText(e.target.value)}
          />
        </label>
        <label className="modal-field">
          <span>ou caminho de arquivo / URL</span>
          <input
            data-testid="data-bind-origin"
            value={origin}
            placeholder="C:\dados\clientes.csv ou https://..."
            spellCheck={false}
            onChange={(e) => setOrigin(e.target.value)}
          />
        </label>
        <div className="data-bind-row">
          <label className="modal-field">
            <span>Formato</span>
            <select
              className="select-input"
              data-testid="data-bind-format"
              value={format}
              onChange={(e) => setFormat(e.target.value)}
            >
              <option value="">Automático</option>
              <option value="json">JSON</option>
              <option value="csv">CSV</option>
            </select>
          </label>
          <label className="modal-field">
            <span>Caminho da lista (select)</span>
            <input
              data-testid="data-bind-select"
              value={select}
              placeholder="data.items"
              spellCheck={false}
              onChange={(e) => setSelect(e.target.value)}
            />
          </label>
          <label className="modal-field">
            <span>Limite</span>
            <input
              data-testid="data-bind-limit"
              value={limit}
              placeholder="todos"
              inputMode="numeric"
              onChange={(e) => setLimit(e.target.value)}
            />
          </label>
        </div>
        {error && (
          <div className="data-error" role="alert" data-testid="data-bind-error">
            {error}
          </div>
        )}
        <div className="modal-actions">
          <button type="button" className="btn" onClick={onClose}>
            Cancelar
          </button>
          <button
            type="submit"
            className="btn primary"
            data-testid="data-bind-submit"
            disabled={busy}
          >
            Vincular
          </button>
        </div>
      </form>
    </div>,
    document.body,
  );
}

/** Seção "Dados" de um único repetidor. */
export function DataSection({ node }: { node: Node }) {
  const locked = useContext(LockedContext);
  const [binding, setBinding] = useState(false);
  const [busy, setBusy] = useState(false);
  const data = Array.isArray(node.data) ? node.data : [];
  const columns = tableColumns(node);
  const dataCols = dataColumns(data);
  const source = node.dataSource;
  const fetched = formatFetched(source?.fetchedAt);
  const refreshable = !!source && source.kind !== 'inline';
  const unmapped = unmappedFields(node);
  const mapping = source?.mapping ?? {};

  const save = (next: unknown[]): void =>
    void daemon.applySafe([setDataOp(node.id, { data: next })]);

  const refresh = async (): Promise<void> => {
    setBusy(true);
    try {
      const res = await features.refreshData(node.id);
      ui.toast(`${res.count} itens atualizados`);
    } catch (e) {
      ui.toast(errMsg(e), 'error');
    } finally {
      setBusy(false);
    }
  };

  const newColumn = async (): Promise<void> => {
    const r = await prompt({
      title: 'Nova coluna',
      fields: [{ name: 'name', label: 'Nome da coluna', placeholder: 'titulo' }],
      confirmLabel: 'Adicionar',
    });
    const name = r?.name?.trim();
    if (!name) return;
    if (columns.includes(name) && dataCols.includes(name)) return ui.toast('A coluna já existe.');
    save(data.length ? addColumn(data, name) : [{ [name]: '' }]);
  };

  return (
    <Section id="props-data" title="Dados" defaultOpen>
      <div data-testid="data-section">
        <Body>
          <div className="data-source" data-testid="data-source">
            <div className="data-source-kind">{describeSource(source)}</div>
            {fetched && <div className="data-source-meta">Atualizado em {fetched}</div>}
            {source?.select && <div className="data-source-meta">select: {source.select}</div>}
            <div className="data-count" data-testid="data-count">
              {data.length} {data.length === 1 ? 'item' : 'itens'}
            </div>
          </div>
          <div className="img-actions">
            <button
              type="button"
              className="btn"
              data-testid="data-refresh"
              disabled={locked || busy || !refreshable}
              title={refreshable ? 'Reler a origem' : 'Dados inline não têm origem para atualizar'}
              onClick={() => void refresh()}
            >
              <RefreshCw size={12} /> Atualizar
            </button>
            <button
              type="button"
              className="btn"
              data-testid="data-bind-button"
              disabled={locked}
              onClick={() => setBinding(true)}
            >
              <Link2 size={12} /> Vincular…
            </button>
          </div>

          {unmapped.length > 0 && (
            <div className="data-mapping" data-testid="data-mapping">
              <div className="img-title">Mapeamento</div>
              {unmapped.map((f) => (
                <div key={f} className="data-map-row">
                  <code>{`{{${f}}}`}</code>
                  <SelectInput
                    value=""
                    placeholder="coluna…"
                    options={dataCols.map((c) => ({ value: c, label: c }))}
                    onChange={(c) =>
                      c &&
                      void daemon.applySafe([
                        setDataOp(node.id, { source: withMapping(source, f, c) }),
                      ])
                    }
                  />
                </div>
              ))}
            </div>
          )}
          {Object.keys(mapping).length > 0 && (
            <div className="data-mapping" data-testid="data-mapping-current">
              {Object.entries(mapping).map(([f, c]) => (
                <div key={f} className="data-map-row">
                  <code>{`{{${f}}}`}</code>
                  <span className="data-map-arrow">→</span>
                  <code>{c}</code>
                  <button
                    type="button"
                    className="icon-btn"
                    title="Remover mapeamento"
                    onClick={() =>
                      void daemon.applySafe([
                        setDataOp(node.id, { source: withMapping(source, f, '') }),
                      ])
                    }
                  >
                    <Trash2 size={11} />
                  </button>
                </div>
              ))}
            </div>
          )}

          <div className="data-table-wrap" data-testid="data-table-wrap">
            <table className="data-table" data-testid="data-table">
              <thead>
                <tr>
                  <th className="data-idx">#</th>
                  {columns.map((c) => (
                    <th key={c}>
                      <span className="data-col-name" title={c}>
                        {c}
                      </span>
                      {dataCols.includes(c) && (
                        <button
                          type="button"
                          className="data-col-del"
                          title={`Remover a coluna ${c}`}
                          data-testid={`data-remove-column-${c}`}
                          onClick={() => save(removeColumn(data, c))}
                        >
                          ×
                        </button>
                      )}
                    </th>
                  ))}
                  <th />
                </tr>
              </thead>
              <tbody>
                {data.slice(0, MAX_ROWS_SHOWN).map((row, i) => (
                  <tr key={i}>
                    <td className="data-idx">{i + 1}</td>
                    {columns.map((c) => (
                      <td key={c}>
                        <Cell
                          row={i}
                          column={c}
                          value={
                            row && typeof row === 'object' && !Array.isArray(row)
                              ? (row as Record<string, unknown>)[c]
                              : c === '$item'
                                ? row
                                : undefined
                          }
                          onCommit={(t) => save(setCell(data, i, c, t))}
                        />
                      </td>
                    ))}
                    <td>
                      <button
                        type="button"
                        className="data-col-del"
                        title="Remover linha"
                        data-testid={`data-remove-row-${i}`}
                        onClick={() => save(removeRow(data, i))}
                      >
                        <Trash2 size={11} />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {data.length > MAX_ROWS_SHOWN && (
              <div className="img-hint">
                Mostrando {MAX_ROWS_SHOWN} de {data.length} itens.
              </div>
            )}
          </div>
          <div className="img-actions">
            <button
              type="button"
              className="btn"
              data-testid="data-add-row"
              disabled={locked}
              onClick={() => save(addRow(data, columns))}
            >
              <Plus size={12} /> Linha
            </button>
            <button
              type="button"
              className="btn"
              data-testid="data-add-column"
              disabled={locked}
              onClick={() => void newColumn()}
            >
              <Plus size={12} /> Coluna
            </button>
          </div>
        </Body>
      </div>
      {binding && <BindDialog node={node} onClose={() => setBinding(false)} />}
    </Section>
  );
}

/** Ação "Converter em repetidor" para um contêiner com filhos. */
export function ConvertToRepeater({ node }: { node: Node }) {
  const locked = useContext(LockedContext);
  return (
    <Section id="props-repeater" title="Repetidor">
      <Body>
        <div className="img-hint">
          Transforma este contêiner em repetidor: os filhos viram o template, repetido por item dos
          dados (<code>{'{{campo}}'}</code>).
        </div>
        <button
          type="button"
          className="btn img-wide"
          data-testid="convert-to-repeater"
          disabled={locked}
          onClick={() => void convertToRepeater(node.id)}
        >
          <Repeat size={12} /> Converter em repetidor
        </button>
      </Body>
    </Section>
  );
}
