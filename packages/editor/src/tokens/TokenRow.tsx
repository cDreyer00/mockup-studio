import { useState } from 'react';
import { CircleOff, MoreHorizontal, TriangleAlert, Undo2 } from 'lucide-react';
import { TOKEN_GROUPS, planDeleteTokens, tokenGroupLabel } from '@mockup/core';
import type { Document, Op, TokenInfo, TokenReport } from '@mockup/core';
import { DraftInput } from '../properties/shared';
import { TokenSwatch } from '../properties/TokenBinding';
import { ui } from '../state/uiStore';
import { openContextMenu } from '../ui/overlays';
import { InlineEdit } from './InlineEdit';
import {
  isUnused,
  opClearOverride,
  opSetMeta,
  opSetValue,
  planRenameToken,
  rowProblem,
  shownValue,
  tokenNameError,
  validateEdit,
} from './tokensLogic';

export const slugOf = (name: string): string => name.replace(/^--/, '');

interface Props {
  doc: Document;
  report: TokenReport;
  info: TokenInfo;
  /** Theme being edited (`null` = base). */
  theme: string | null;
  run: (ops: Op[]) => void;
}

export function TokenRow({ doc, report, info, theme, run }: Props) {
  const slug = slugOf(info.name);
  const [editing, setEditing] = useState<'name' | 'value' | null>(null);
  const [open, setOpen] = useState(false);
  const shown = shownValue(info, theme);
  const problem = rowProblem(info, report);
  const unused = isUnused(info, report);
  const uses = info.usage.nodeIds.length + info.usage.tokens.length;
  const inherited = theme !== null && !shown.overridden;

  const remove = () => {
    try {
      run(planDeleteTokens(doc, [info.name]));
      if (uses > 0)
        ui.toast(`${info.name} removed; ${uses} use(s) were left without a value`, 'info');
    } catch (e) {
      ui.toast(e instanceof Error ? e.message : String(e), 'error');
    }
  };

  const menu = (x: number, y: number) =>
    openContextMenu(x, y, [
      { label: 'Rename', onSelect: () => setEditing('name') },
      { label: 'Edit value', onSelect: () => setEditing('value') },
      { label: 'Group and description…', onSelect: () => setOpen(true) },
      {
        label: 'Copy var()',
        onSelect: () => void navigator.clipboard?.writeText(`var(${info.name})`),
      },
      ...(theme && shown.overridden
        ? [
            {
              label: 'Remove theme override',
              onSelect: () => run([opClearOverride(info.name, theme)]),
            },
          ]
        : []),
      { label: 'Delete', danger: true, separator: true, onSelect: remove },
    ]);

  return (
    <div
      className={`tk-row${problem ? ` has-${problem.level}` : ''}`}
      data-testid={`token-row-${slug}`}
      onContextMenu={(e) => {
        e.preventDefault();
        menu(e.clientX, e.clientY);
      }}
    >
      <div className="tk-row-head">
        <TokenSwatch info={info} resolved={shown.resolved} />
        <div className="tk-row-name" onDoubleClick={() => setEditing('name')}>
          <InlineEdit
            value={info.name}
            display={<span className="mono">{info.name}</span>}
            editing={editing === 'name'}
            onStart={() => undefined}
            onStop={() => setEditing(null)}
            testId={`token-name-${slug}`}
            inputTestId="token-name-input"
            mono
            validate={(v) => {
              const err = tokenNameError(doc, v, info.name);
              return err ? { level: 'error', message: err } : null;
            }}
            onCommit={(v) => {
              try {
                run(planRenameToken(doc, info.name, v));
              } catch (e) {
                ui.toast(e instanceof Error ? e.message : String(e), 'error');
              }
            }}
          />
        </div>
        {unused && !problem && (
          <span
            className="tk-badge unused"
            data-testid={`token-unused-${slug}`}
            title="Unused: no element or other token references this token"
          >
            <CircleOff size={11} />
          </span>
        )}
        {problem && (
          <span
            className={`tk-badge ${problem.level}`}
            data-testid={`token-problem-${slug}`}
            title={problem.message}
          >
            <TriangleAlert size={11} />
          </span>
        )}
        {theme && shown.overridden && (
          <span
            className="tk-badge override"
            data-testid={`token-override-${slug}`}
            title={`Overridden in theme ${theme}`}
          >
            {theme}
          </span>
        )}
        <button
          type="button"
          className="tk-more"
          title="More options"
          aria-label="More options"
          aria-expanded={open}
          data-testid={`token-menu-${slug}`}
          onClick={(e) => {
            if (e.shiftKey) return menu(e.clientX, e.clientY);
            setOpen((o) => !o);
          }}
        >
          <MoreHorizontal size={13} />
        </button>
      </div>

      <div className={`tk-row-value${inherited ? ' inherited' : ''}`}>
        <InlineEdit
          value={shown.value}
          display={<span className="mono">{shown.value || '—'}</span>}
          editing={editing === 'value'}
          onStart={() => setEditing('value')}
          onStop={() => setEditing(null)}
          testId={`token-value-${slug}`}
          inputTestId="token-value-input"
          mono
          validate={(v) => validateEdit(doc, info.name, v, { group: info.group, theme })}
          onCommit={(v) => run([opSetValue(info.name, v, theme)])}
        />
        {shown.resolved !== undefined && shown.resolved !== shown.value && (
          <span
            className="tk-resolved mono"
            data-testid={`token-resolved-${slug}`}
            title="Resolved value"
          >
            = {shown.resolved}
          </span>
        )}
        {theme && shown.overridden && (
          <button
            type="button"
            className="tk-more"
            title="Remove override (goes back to the base value)"
            aria-label="Remove override"
            data-testid={`token-clear-override-${slug}`}
            onClick={() => run([opClearOverride(info.name, theme)])}
          >
            <Undo2 size={12} />
          </button>
        )}
      </div>

      {problem && <div className={`tk-problem ${problem.level}`}>{problem.message}</div>}

      {open && (
        <div className="tk-detail" data-testid={`token-detail-${slug}`}>
          <label>
            <span>Group</span>
            <DraftInput
              value={doc.tokenMeta?.[info.name]?.group ?? ''}
              list="tk-groups"
              placeholder={`automatic (${tokenGroupLabel(info.group)})`}
              testId={`token-group-${slug}`}
              onCommit={(v) => {
                const op = opSetMeta(doc, info.name, { group: v.trim() });
                if (op) run([op]);
              }}
            />
          </label>
          <label>
            <span>Description</span>
            <DraftInput
              value={info.description ?? ''}
              placeholder="what it is for"
              testId={`token-desc-${slug}`}
              onCommit={(v) => {
                const op = opSetMeta(doc, info.name, { description: v.trim() });
                if (op) run([op]);
              }}
            />
          </label>
          <div className="tk-detail-actions">
            <span className="tk-uses">{uses === 0 ? 'No uses' : `${uses} use(s)`}</span>
            <button
              type="button"
              className="btn danger"
              data-testid={`token-delete-${slug}`}
              onClick={remove}
            >
              Delete
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/** Group options for the `<datalist>` of the row editor. */
export function GroupsDatalist({ doc }: { doc: Document }) {
  const free = new Set(
    Object.values(doc.tokenMeta ?? {}).flatMap((m) => (m.group ? [m.group] : [])),
  );
  for (const g of TOKEN_GROUPS) free.add(g.id);
  return (
    <datalist id="tk-groups">
      {[...free].map((g) => (
        <option key={g} value={g} label={tokenGroupLabel(g)} />
      ))}
    </datalist>
  );
}
