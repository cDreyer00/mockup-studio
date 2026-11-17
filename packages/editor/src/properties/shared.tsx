/** Common infrastructure for the sections: selection context, op application and style-bound fields. */
import { useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { useShallow } from 'zustand/react/shallow';
import type { Node } from '@mockup/core';
import { getParent, isLockedDeep } from '../model/tree';
import { useDoc } from '../state/docStore';
import { useSelectedNodes } from '../state/hooks';
import { IconButton, Row } from '../ui/controls';
import type { SelectOption } from '../ui/controls';
import {
  BoundColorInput,
  BoundNumberInput,
  BoundSelectInput,
  withTokenBinding,
} from './TokenBinding';
import {
  LockedContext,
  commitStyle,
  commitStyles,
  common,
  previewStyles,
  runOps,
  styleOf,
} from './styleOps';
export { LockedContext, commitStyle, commitStyles, common, previewStyles, runOps, styleOf };
export type { StyleDelta } from './styleOps';

/** Selected node with the context the sections need. */
export interface NodeCtx {
  node: Node;
  /** Immediate parent (`null` for root frames). */
  parent: Node | null;
  isRoot: boolean;
  locked: boolean;
}

/** Current selection with parent and lock state; subscribes only to the selected nodes and their parents. */
export function useSelectionCtx(): NodeCtx[] {
  const nodes = useSelectedNodes();
  const extra = useDoc(
    useShallow((s) => {
      const doc = s.doc;
      if (!doc) return [];
      return nodes.flatMap((n) => [getParent(doc, n.id), isLockedDeep(doc, n.id)]);
    }),
  );
  return useMemo(
    () =>
      nodes.map((node, i) => {
        const parent = (extra[i * 2] as Node | null | undefined) ?? null;
        return { node, parent, isRoot: parent === null, locked: extra[i * 2 + 1] === true };
      }),
    [nodes, extra],
  );
}

/* ------------------------------ style-bound fields ------------------------------ */

/** Section body: disables all native fields when the panel is locked. */
export function Body({ children }: { children: ReactNode }) {
  const locked = useContext(LockedContext);
  return (
    <fieldset className="prop-fieldset" disabled={locked}>
      {children}
    </fieldset>
  );
}

export function StyleNum({
  nodes,
  prop,
  label,
  title,
  unit,
  min,
  max,
  step,
  placeholder,
  preview = true,
  testId,
}: {
  nodes: readonly Node[];
  prop: string;
  label?: ReactNode;
  title?: string;
  unit?: string;
  min?: number;
  max?: number;
  step?: number;
  placeholder?: string;
  preview?: boolean;
  testId?: string;
}) {
  const locked = useContext(LockedContext);
  const value = common(nodes, styleOf(prop));
  return (
    <div className="prop-field" data-testid={testId}>
      <BoundNumberInput
        bind={{ nodes, prop, value }}
        value={value}
        label={label}
        title={title}
        unit={unit}
        min={min}
        max={max}
        step={step}
        placeholder={placeholder}
        disabled={locked}
        onPreview={preview ? (v) => previewStyles(nodes, () => ({ [prop]: v })) : undefined}
        onCommit={(v) => void commitStyle(nodes, prop, v)}
      />
    </div>
  );
}

export function StyleSelect({
  nodes,
  prop,
  options,
  title,
  placeholder,
}: {
  nodes: readonly Node[];
  prop: string;
  options: SelectOption[];
  title?: string;
  placeholder?: string;
}) {
  const value = common(nodes, styleOf(prop));
  return (
    <BoundSelectInput
      bind={{ nodes, prop, value }}
      value={value}
      options={options}
      title={title}
      placeholder={placeholder}
      onChange={(v) => void commitStyle(nodes, prop, v)}
    />
  );
}

export function StyleColor({
  nodes,
  prop,
  title,
}: {
  nodes: readonly Node[];
  prop: string;
  title?: string;
}) {
  const value = common(nodes, styleOf(prop));
  return (
    <BoundColorInput
      bind={{ nodes, prop, value }}
      value={value}
      title={title}
      onPreview={(v) => previewStyles(nodes, () => ({ [prop]: v }))}
      onCommit={(v) => void commitStyle(nodes, prop, v)}
    />
  );
}

/** Group of exclusive buttons (clicking the active one removes the value). */
export function SegButtons({
  value,
  options,
  onChange,
}: {
  value: string | undefined | null;
  options: { value: string; title: string; icon: ReactNode }[];
  onChange: (value: string) => void;
}) {
  return (
    <div className="prop-seg">
      {options.map((o) => (
        <IconButton
          key={o.value}
          title={o.title}
          active={value === o.value}
          onClick={() => onChange(value === o.value ? '' : o.value)}
        >
          {o.icon}
        </IconButton>
      ))}
    </div>
  );
}

export function StyleSeg({
  nodes,
  prop,
  options,
}: {
  nodes: readonly Node[];
  prop: string;
  options: { value: string; title: string; icon: ReactNode }[];
}) {
  return (
    <SegButtons
      value={common(nodes, styleOf(prop))}
      options={options}
      onChange={(v) => void commitStyle(nodes, prop, v)}
    />
  );
}

/** Text field with a local draft (commits on blur/Enter, Esc cancels); accepts testid and datalist. */
export function DraftInput({
  value,
  onCommit,
  placeholder,
  title,
  list,
  testId,
  mono,
}: {
  value: string | undefined | null;
  onCommit: (value: string) => void;
  placeholder?: string;
  title?: string;
  list?: string;
  testId?: string;
  mono?: boolean;
}) {
  const shown = value ?? '';
  const [text, setText] = useState(shown);
  const [focused, setFocused] = useState(false);
  const cancelled = useRef(false);
  useEffect(() => {
    if (!focused) setText(shown);
  }, [shown, focused]);
  return (
    <input
      className={`text-input${mono ? ' mono' : ''}`}
      data-testid={testId}
      value={text}
      list={list}
      title={title}
      spellCheck={false}
      placeholder={value === null ? 'Mixed' : placeholder}
      onChange={(e) => setText(e.target.value)}
      onFocus={() => setFocused(true)}
      onBlur={() => {
        setFocused(false);
        if (cancelled.current) cancelled.current = false;
        else if (text !== shown) onCommit(text);
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
        else if (e.key === 'Escape') {
          cancelled.current = true;
          setText(shown);
          (e.target as HTMLInputElement).blur();
        }
        e.stopPropagation();
      }}
    />
  );
}

export { Row };

/** `DraftInput` with the optional `bind` prop (bind to a token). */
export const BoundDraftInput = withTokenBinding(DraftInput);
