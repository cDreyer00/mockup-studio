/**
 * "Bind to token": an icon next to the inputs that opens a token picker and, when the current value is
 * `var(--x)`, a chip with the token name and the resolved value (with an unbind button).
 * Generic: the shared components (`StyleNum`, `StyleColor`, `BoxField`...) just wrap it.
 */
import { useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { ComponentType, CSSProperties, ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Diamond, Link2Off, Search } from 'lucide-react';
import { planApplyToken, resolveCssValue, tokenGroup } from '@mockup/core';
import type { Document, Node, TokenInfo } from '@mockup/core';
import { useDoc } from '../state/docStore';
import { nodeScopeVars, tokenListFor } from '../tokens/reportCache';
import { ColorInput, SelectInput } from '../ui/controls';
import { NumberInput } from '../ui/NumberInput';
import { ui } from '../state/uiStore';
import {
  KIND_LABELS,
  bindKindFor,
  groupsForKind,
  pickerTokens,
  previewFor,
  varOf,
  varRefName,
} from '../tokens/tokensLogic';
import type { BindKind } from '../tokens/tokensLogic';
import { LockedContext, commitStyles, common, runOps, styleOf } from './styleOps';

/** Resolved (literal) value of `value` in the node's scope. */
export function resolveForNode(doc: Document, nodeId: string, value: string): string {
  try {
    return resolveCssValue(value, nodeScopeVars(doc, nodeId));
  } catch {
    return value;
  }
}

/** Ops that bind the nodes' property to the token (via `planApplyToken`). */
export function bindOps(doc: Document, nodes: readonly Node[], prop: string, token: string) {
  return planApplyToken(
    doc,
    nodes.map((n) => n.id),
    prop,
    token,
  );
}

/* ------------------------------ swatch ------------------------------ */

function Swatch({
  info,
  resolved,
}: {
  info: Pick<TokenInfo, 'group' | 'name'>;
  resolved?: string;
}) {
  const p = previewFor(info.group, info.name, resolved);
  if (!p) return <span className="tk-prev tk-prev-none" aria-hidden />;
  if (p.kind === 'color')
    return <span className="tk-prev tk-prev-color" style={p.style} aria-hidden />;
  if (p.kind === 'spacing')
    return (
      <span className="tk-prev tk-prev-spacing" aria-hidden>
        <i style={p.style} />
      </span>
    );
  if (p.kind === 'font')
    return (
      <span className="tk-prev tk-prev-font" style={p.style} aria-hidden>
        Aa
      </span>
    );
  return <span className={`tk-prev tk-prev-${p.kind}`} style={p.style} aria-hidden />;
}

export { Swatch as TokenSwatch };

/* ------------------------------ picker (popover) ------------------------------ */

interface PickerProps {
  anchor: DOMRect;
  nodes: readonly Node[];
  kind: BindKind;
  onPick: (token: string) => void;
  onClose: () => void;
}

const POP_W = 232;

function TokenPicker({ anchor, nodes, kind, onPick, onClose }: PickerProps) {
  const doc = useDoc((s) => s.doc);
  const ref = useRef<HTMLDivElement>(null);
  const [query, setQuery] = useState('');
  const [all, setAll] = useState(false);
  const groups = groupsForKind(kind);
  const report = useMemo(() => (doc ? tokenListFor(doc) : null), [doc]);
  const vars = useMemo(() => {
    try {
      return doc && nodes[0] ? nodeScopeVars(doc, nodes[0].id) : {};
    } catch {
      return {};
    }
  }, [doc, nodes]);

  useEffect(() => {
    const away = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as globalThis.Node)) onClose();
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('pointerdown', away, true);
    window.addEventListener('keydown', key, true);
    return () => {
      window.removeEventListener('pointerdown', away, true);
      window.removeEventListener('keydown', key, true);
    };
  }, [onClose]);

  const relevant = report ? pickerTokens(report.tokens, groups, false, query) : [];
  const items = report ? pickerTokens(report.tokens, groups, all, query) : [];
  const left = Math.max(4, Math.min(anchor.right - POP_W, window.innerWidth - POP_W - 4));
  // Below the field; near the bottom of the screen (panel with many sections), opens upward.
  const spaceBelow = window.innerHeight - anchor.bottom - 12;
  const spaceAbove = anchor.top - 12;
  const openBelow = spaceBelow >= 240 || spaceBelow >= spaceAbove;
  const style: CSSProperties = openBelow
    ? { left, top: anchor.bottom + 4, width: POP_W, maxHeight: Math.max(120, spaceBelow) }
    : {
        left,
        bottom: window.innerHeight - anchor.top + 4,
        width: POP_W,
        maxHeight: spaceAbove,
      };

  return createPortal(
    <div
      ref={ref}
      className="tk-picker"
      style={style}
      role="dialog"
      aria-label="Choose token"
      data-testid="token-picker"
    >
      <div className="tk-picker-search">
        <Search size={12} />
        <input
          autoFocus
          value={query}
          placeholder="Search token…"
          spellCheck={false}
          data-testid="token-picker-search"
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && items[0]) onPick(items[0].name);
            e.stopPropagation();
          }}
        />
      </div>
      <div className="tk-picker-filter">
        <button type="button" className={all ? '' : 'on'} onClick={() => setAll(false)}>
          {KIND_LABELS[kind]}
        </button>
        <button
          type="button"
          className={all ? 'on' : ''}
          data-testid="token-picker-all"
          onClick={() => setAll(true)}
        >
          All
        </button>
      </div>
      <div className="tk-picker-list">
        {items.length === 0 && (
          <div className="tk-picker-empty">
            {all || relevant.length > 0 ? 'No tokens.' : 'No tokens of this type.'}
          </div>
        )}
        {items.map((t) => {
          const resolved = resolveCssValue(varOf(t.name), vars);
          return (
            <button
              key={t.name}
              type="button"
              className="tk-picker-item"
              data-testid={`token-option-${t.name.slice(2)}`}
              title={`${t.name}: ${t.value ?? ''}`}
              onClick={() => onPick(t.name)}
            >
              <Swatch info={t} resolved={resolved} />
              <span className="tk-picker-name mono">{t.name}</span>
              <span className="tk-picker-val mono">{resolved}</span>
            </button>
          );
        })}
      </div>
    </div>,
    document.body,
  );
}

/* ------------------------------ chip ------------------------------ */

function Chip({
  name,
  value,
  nodes,
  kind,
  onChange,
  onUnbind,
}: {
  name: string;
  value: string;
  nodes: readonly Node[];
  kind: BindKind;
  onChange: (rect: DOMRect) => void;
  onUnbind: () => void;
}) {
  const doc = useDoc((s) => s.doc);
  const locked = useContext(LockedContext);
  const resolved = doc && nodes[0] ? resolveForNode(doc, nodes[0].id, value) : value;
  const missing =
    !!doc && !(name in (doc.tokens ?? {})) && !doc.themes?.some((t) => name in t.overrides);
  const group = doc ? tokenGroup(doc, name) : kind;
  return (
    <div
      className={`tk-chip${missing ? ' broken' : ''}`}
      data-testid="token-chip"
      title={`${value} → ${resolved}`}
    >
      <button
        type="button"
        className="tk-chip-main"
        disabled={locked}
        title="Change token"
        onClick={(e) => onChange(e.currentTarget.getBoundingClientRect())}
      >
        <Swatch info={{ group, name }} resolved={resolved} />
        <span className="tk-chip-name mono" data-testid="token-chip-name">
          {name}
        </span>
        <span className="tk-chip-val mono" data-testid="token-chip-value">
          {resolved === value ? '' : resolved}
        </span>
      </button>
      <button
        type="button"
        className="tk-chip-x"
        title="Unbind from token (keeps the current value)"
        aria-label="Unbind from token"
        data-testid="token-unbind"
        disabled={locked}
        onClick={onUnbind}
      >
        <Link2Off size={12} />
      </button>
    </div>
  );
}

/* ------------------------------ public component ------------------------------ */

export interface TokenBoundProps {
  nodes: readonly Node[];
  /** Bound CSS property (also decides the picker groups). */
  prop: string;
  /** Common current value (`null` = mixed). When it is `var(--x)` it shows the chip in place of the input. */
  value: string | undefined | null;
  /** Custom write (e.g. background, border, shadow); default: `planApplyToken` / literal value. */
  write?: (value: string) => void;
  /** Forces the token type (default: inferred from `prop`). */
  kind?: BindKind;
  children: ReactNode;
  className?: string;
}

export function TokenBound({
  nodes,
  prop,
  value,
  write,
  kind,
  children,
  className,
}: TokenBoundProps) {
  const k = kind ?? bindKindFor(prop);
  const locked = useContext(LockedContext);
  const [rect, setRect] = useState<DOMRect | null>(null);
  const name = varRefName(value);
  if (!k || nodes.length === 0) return <>{children}</>;

  const pick = (token: string) => {
    setRect(null);
    const doc = useDoc.getState().doc;
    if (!doc) return;
    if (write) return write(varOf(token));
    try {
      void runOps(bindOps(doc, nodes, prop, token));
    } catch (e) {
      ui.toast(e instanceof Error ? e.message : String(e), 'error');
    }
  };

  const unbind = () => {
    const doc = useDoc.getState().doc;
    if (!doc) return;
    const literal = (n: Node, v: string): string => resolveForNode(doc, n.id, v);
    if (write) return write(literal(nodes[0]!, value ?? ''));
    const bad = nodes.some((n) => /var\(/.test(literal(n, n.style[prop] ?? '')));
    if (bad) return ui.toast('Could not resolve the token value', 'error');
    void commitStyles(nodes, (n) => {
      const v = n.style[prop];
      return v ? { set: { [prop]: literal(n, v) } } : null;
    });
  };

  return (
    <div className={`tk-bound${className ? ` ${className}` : ''}`}>
      {name && value ? (
        <Chip
          name={name}
          value={value}
          nodes={nodes}
          kind={k}
          onChange={setRect}
          onUnbind={unbind}
        />
      ) : (
        <>
          <div className="tk-bound-input">{children}</div>
          <button
            type="button"
            className="tk-bind-btn"
            title="Bind to a token"
            aria-label="Bind to a token"
            data-testid="token-bind"
            disabled={locked}
            onClick={(e) => setRect(e.currentTarget.getBoundingClientRect())}
          >
            <Diamond size={11} />
          </button>
        </>
      )}
      {rect && (
        <TokenPicker
          anchor={rect}
          nodes={nodes}
          kind={k}
          onPick={pick}
          onClose={() => setRect(null)}
        />
      )}
    </div>
  );
}

/** Shortcut for common style properties: reads the nodes' common value. */
export function StyleTokenBound({
  nodes,
  prop,
  children,
  kind,
}: {
  nodes: readonly Node[];
  prop: string;
  children: ReactNode;
  kind?: BindKind;
}) {
  return (
    <TokenBound nodes={nodes} prop={prop} value={common(nodes, styleOf(prop))} kind={kind}>
      {children}
    </TokenBound>
  );
}

/* ------------------------------ inputs with `bind` ------------------------------ */

/** `bind` options (those of `TokenBoundProps`, without the children). */
export type TokenBindProps = Omit<TokenBoundProps, 'children'>;

/**
 * Returns the input with an optional `bind` prop: with it, the input comes wrapped in `TokenBound`;
 * without it, it is the original input. Avoids re-indenting the sections' JSX just to wrap it.
 */
export function withTokenBinding<P extends object>(Input: ComponentType<P>) {
  return function Bindable(props: P & { bind?: TokenBindProps }) {
    const { bind, ...rest } = props;
    const input = <Input {...(rest as unknown as P)} />;
    return bind ? <TokenBound {...bind}>{input}</TokenBound> : input;
  };
}

export const BoundNumberInput = withTokenBinding(NumberInput);
export const BoundSelectInput = withTokenBinding(SelectInput);
export const BoundColorInput = withTokenBinding(ColorInput);
