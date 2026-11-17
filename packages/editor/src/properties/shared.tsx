/** Infraestrutura comum das seções: contexto de seleção, aplicação de ops e campos ligados a estilos. */
import { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { useShallow } from 'zustand/react/shallow';
import type { Node, Op } from '@mockup/core';
import { daemon } from '../client/daemon';
import { getParent, isLockedDeep } from '../model/tree';
import { useDoc } from '../state/docStore';
import { useSelectedNodes } from '../state/hooks';
import { ui } from '../state/uiStore';
import { ColorInput, IconButton, Row, SelectInput } from '../ui/controls';
import type { SelectOption } from '../ui/controls';
import { NumberInput } from '../ui/NumberInput';
import { TokenBound } from './TokenBinding';

/** Nó selecionado com o contexto necessário às seções. */
export interface NodeCtx {
  node: Node;
  /** Pai imediato (`null` para frames raiz). */
  parent: Node | null;
  isRoot: boolean;
  locked: boolean;
}

export const LockedContext = createContext(false);

/** Seleção atual com pai e estado de trava; assina apenas os nós selecionados e seus pais. */
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

/* ------------------------------ leitura de valores ------------------------------ */

/**
 * Valor comum: o valor, se todos iguais (`undefined` se todos sem valor); `null` se misto.
 */
export function common<T>(
  items: readonly T[],
  get: (item: T) => string | undefined,
): string | undefined | null {
  if (items.length === 0) return undefined;
  const first = get(items[0]!);
  for (let i = 1; i < items.length; i++) if (get(items[i]!) !== first) return null;
  return first;
}

export const styleOf = (prop: string) => (n: Node) => n.style[prop];

/* ------------------------------ aplicação de ops ------------------------------ */

export type StyleDelta = { set?: Record<string, string>; unset?: string[] };

/** Aplica ops numa única chamada e descarta a prévia depois do ack. */
export async function runOps(ops: Op[]): Promise<void> {
  if (ops.length) await daemon.applySafe(ops);
  ui.clearPreview();
}

/** Aplica estilos a todos os nós; `fn` pode devolver deltas distintos por nó. */
export function commitStyles(
  nodes: readonly Node[],
  fn: (node: Node) => StyleDelta | null,
): Promise<void> {
  const changes: { nodeId: string; set?: Record<string, string>; unset?: string[] }[] = [];
  for (const node of nodes) {
    const d = fn(node);
    if (!d) continue;
    const set = d.set && Object.keys(d.set).length ? d.set : undefined;
    const unset = d.unset?.length ? d.unset : undefined;
    if (!set && !unset) continue;
    changes.push({ nodeId: node.id, ...(set ? { set } : {}), ...(unset ? { unset } : {}) });
  }
  return runOps(changes.length ? [{ type: 'updateStyles', changes }] : []);
}

/** Define (ou remove, se vazio) uma propriedade em todos os nós. */
export function commitStyle(nodes: readonly Node[], prop: string, value: string): Promise<void> {
  const v = value.trim();
  return commitStyles(nodes, () => (v === '' ? { unset: [prop] } : { set: { [prop]: v } }));
}

/** Prévia transitória de estilos por nó. */
export function previewStyles(
  nodes: readonly Node[],
  fn: (node: Node) => Record<string, string>,
): void {
  ui.setPreview(Object.fromEntries(nodes.map((n) => [n.id, { style: fn(n) }])));
}

/* ------------------------------ campos ligados a estilos ------------------------------ */

/** Corpo de seção: desabilita todos os campos nativos quando o painel está travado. */
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
      <TokenBound nodes={nodes} prop={prop} value={value}>
        <NumberInput
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
      </TokenBound>
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
    <TokenBound nodes={nodes} prop={prop} value={value}>
      <SelectInput
        value={value}
        options={options}
        title={title}
        placeholder={placeholder}
        onChange={(v) => void commitStyle(nodes, prop, v)}
      />
    </TokenBound>
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
    <TokenBound nodes={nodes} prop={prop} value={value}>
      <ColorInput
        value={value}
        title={title}
        onPreview={(v) => previewStyles(nodes, () => ({ [prop]: v }))}
        onCommit={(v) => void commitStyle(nodes, prop, v)}
      />
    </TokenBound>
  );
}

/** Grupo de botões exclusivos (clicar no ativo remove o valor). */
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

/** Campo de texto com rascunho local (confirma no blur/Enter, Esc cancela); aceita testid e datalist. */
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
      placeholder={value === null ? 'Misto' : placeholder}
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
