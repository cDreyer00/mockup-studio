import { useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import { Copy, X } from 'lucide-react';
import type { Node } from '@mockup/core';
import { sortStateKeys } from '@mockup/core';
import { ui, useUi } from '../state/uiStore';
import { useTailwind } from '../tailwind/useTailwind';
import type { TailwindEngine, TailwindModule } from '../tailwind/loader';
import { IconButton, Section } from '../ui/controls';
import { stylesToCssText } from './css';
import { Body, LockedContext, common, runOps } from './shared';
import type { NodeCtx } from './shared';

const MAX_SUGGESTIONS = 8;

/** Token (class) under the caret: from its start to the caret, and the extent up to the next space. */
export function tokenAt(
  text: string,
  caret: number,
): { start: number; end: number; prefix: string } {
  let start = caret;
  while (start > 0 && !/\s/.test(text[start - 1]!)) start--;
  let end = caret;
  while (end < text.length && !/\s/.test(text[end]!)) end++;
  return { start, end, prefix: text.slice(start, caret) };
}

const normalize = (value: string): string => value.split(/\s+/).filter(Boolean).join(' ');

/** Classes field with autocomplete and warnings (engine already loaded). */
function ClassesField({
  ctxs,
  engine,
  mod,
}: {
  ctxs: NodeCtx[];
  engine: TailwindEngine;
  mod: TailwindModule;
}) {
  const locked = useContext(LockedContext);
  const nodes = useMemo(() => ctxs.map((c) => c.node), [ctxs]);
  // Node without `node.classes`: the field starts from the classes equivalent to the current style, so
  // editing (which replaces the style) doesn't erase what already exists.
  const mixed = useMemo(
    () => common(nodes, (n) => n.classes || engine.nodeClasses(n).classes.join(' ')),
    [nodes, engine],
  );
  const shown = mixed ?? '';
  const [text, setText] = useState(shown);
  const [focused, setFocused] = useState(false);
  const [caret, setCaret] = useState(0);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const area = useRef<HTMLTextAreaElement>(null);
  const cancelled = useRef(false);
  const pendingCaret = useRef<number | null>(null);

  useEffect(() => {
    if (!focused) setText(shown);
  }, [shown, focused, nodes[0]?.id]);

  useEffect(() => {
    if (pendingCaret.current !== null && area.current) {
      area.current.setSelectionRange(pendingCaret.current, pendingCaret.current);
      setCaret(pendingCaret.current);
      pendingCaret.current = null;
    }
  });

  const token = tokenAt(text, caret);
  const suggestions = useMemo(
    () => (open && focused && token.prefix ? engine.suggest(token.prefix, MAX_SUGGESTIONS) : []),
    [engine, open, focused, token.prefix],
  );
  const highlighted = active >= 0 ? suggestions[active] : undefined;
  const css = useMemo(
    () => (highlighted ? engine.classCss(highlighted) : null),
    [engine, highlighted],
  );

  const infos = useMemo(() => (text.trim() ? engine.inspect(text) : []), [engine, text]);
  const unknown = [...new Set(infos.filter((i) => i.status === 'unknown').map((i) => i.cls))];
  const unsupported = infos.filter((i) => i.status === 'unsupported');

  const commit = (): void => {
    const value = normalize(text);
    if (value === normalize(shown)) return;
    const plan = mod.planSetClasses(
      ctxs.map((c) => ({ node: c.node, root: c.isRoot })),
      value,
      engine,
      'replace',
    );
    void runOps(plan.ops);
  };

  const accept = (cls: string): void => {
    const next = text.slice(0, token.start) + cls + ' ' + text.slice(token.end).replace(/^\s+/, '');
    pendingCaret.current = token.start + cls.length + 1;
    setText(next);
    setActive(-1);
    setOpen(false);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>): void => {
    e.stopPropagation();
    const list = suggestions.length > 0;
    if (e.key === 'ArrowDown' && list) {
      e.preventDefault();
      setActive((a) => (a + 1) % suggestions.length);
    } else if (e.key === 'ArrowUp' && list) {
      e.preventDefault();
      setActive((a) => (a <= 0 ? suggestions.length - 1 : a - 1));
    } else if (e.key === 'Tab' && list) {
      e.preventDefault();
      accept(suggestions[Math.max(active, 0)]!);
    } else if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if (list && highlighted) accept(highlighted);
      else area.current?.blur();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      if (list) {
        setOpen(false);
        setActive(-1);
      } else {
        cancelled.current = true;
        setText(shown);
        area.current?.blur();
      }
    }
  };

  return (
    <div className="prop-classes" data-testid="prop-classes-field">
      <textarea
        ref={area}
        className="mono prop-textarea prop-classes-input"
        data-testid="prop-classes"
        value={text}
        rows={3}
        spellCheck={false}
        disabled={locked}
        placeholder={
          mixed === null ? 'Mixed' : 'flex gap-4 p-6 rounded-lg hover:bg-primary/90 md:p-8'
        }
        title="Tailwind classes (replace the node style; with no classes, starts from those equivalent to the current style). Enter confirms, Shift+Enter inserts a line break."
        onChange={(e) => {
          setText(e.target.value);
          setCaret(e.target.selectionStart);
          setOpen(true);
          setActive(-1);
        }}
        onSelect={(e) => setCaret((e.target as HTMLTextAreaElement).selectionStart)}
        onFocus={() => {
          setFocused(true);
          cancelled.current = false;
        }}
        onBlur={() => {
          setFocused(false);
          setOpen(false);
          setActive(-1);
          if (cancelled.current) cancelled.current = false;
          else commit();
        }}
        onKeyDown={onKeyDown}
        onKeyUp={(e) => e.stopPropagation()}
      />
      {suggestions.length > 0 && (
        <div className="prop-classes-pop" data-testid="classes-suggestions">
          <ul
            className="prop-classes-list"
            role="listbox"
            // Keeps focus on the field when clicking a suggestion.
            onMouseDown={(e) => e.preventDefault()}
          >
            {suggestions.map((s, i) => (
              <li
                key={s}
                role="option"
                aria-selected={i === active}
                className={`mono prop-classes-item${i === active ? ' active' : ''}`}
                data-testid="classes-suggestion"
                onMouseEnter={() => setActive(i)}
                onClick={() => accept(s)}
              >
                {s}
              </li>
            ))}
          </ul>
          {css && (
            <pre className="mono prop-classes-css" data-testid="classes-css">
              {css}
            </pre>
          )}
        </div>
      )}
      {(unknown.length > 0 || unsupported.length > 0) && (
        <div className="prop-classes-warn" data-testid="classes-warnings">
          {unknown.length > 0 && (
            <div data-testid="classes-unknown" title="Tailwind does not recognize these classes">
              Unknown: <span className="mono">{unknown.join(' ')}</span>
            </div>
          )}
          {unsupported.map((i) => (
            <div key={i.cls} data-testid="classes-unsupported" title={i.reason}>
              No effect: <span className="mono">{i.cls}</span>
              {i.reason ? ` (${i.reason})` : ''}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** Current node style as idiomatic Tailwind classes (read-only) + the leftover CSS. */
function AsTailwind({ node, engine }: { node: Node; engine: TailwindEngine }) {
  const out = useMemo(() => engine.nodeClasses(node), [engine, node]);
  const classes = out.classes.join(' ');
  const rest = useMemo(() => stylesToCssText(out.rest), [out.rest]);
  const copy = (): void => {
    void navigator.clipboard?.writeText(classes).then(
      () => ui.toast('Classes copied'),
      () => ui.toast('Could not copy', 'error'),
    );
  };
  return (
    <div className="prop-classes-as" data-testid="classes-as-tailwind">
      <div className="prop-classes-as-head">
        <span className="prop-subtitle">Tailwind classes for the current style</span>
        <IconButton title="Copy classes" data-testid="classes-copy" onClick={copy}>
          <Copy size={12} />
        </IconButton>
      </div>
      <pre className="mono prop-classes-out" data-testid="classes-as-tailwind-text">
        {classes || '—'}
      </pre>
      {rest && (
        <>
          <span className="prop-subtitle">CSS with no equivalent class</span>
          <pre className="mono prop-classes-out" data-testid="classes-rest">
            {rest}
          </pre>
        </>
      )}
    </div>
  );
}

/** Node states (`hover`, `md`, `dark`...) with the CSS of each one and a button to remove. */
export function StatesList({ node }: { node: Node }) {
  const keys = sortStateKeys(Object.keys(node.states ?? {}));
  if (keys.length === 0) return null;
  const remove = (key: string): void => {
    const rest = Object.fromEntries(Object.entries(node.states ?? {}).filter(([k]) => k !== key));
    void runOps([
      {
        type: 'setStates',
        changes: [{ nodeId: node.id, states: Object.keys(rest).length ? rest : null }],
      },
    ]);
  };
  return (
    <div className="prop-states" data-testid="prop-states">
      <span className="prop-subtitle">States</span>
      {keys.map((key) => (
        <div className="prop-state" key={key} data-testid={`state-row-${key}`}>
          <div className="prop-state-head">
            <span className="prop-state-key mono">{key}</span>
            <IconButton
              title={`Remove the ${key} state`}
              data-testid={`state-remove-${key}`}
              onClick={() => remove(key)}
            >
              <X size={12} />
            </IconButton>
          </div>
          <pre className="mono prop-classes-out" data-testid={`state-css-${key}`}>
            {stylesToCssText(node.states![key]!)}
          </pre>
        </div>
      ))}
    </div>
  );
}

/** "Classes" section: the node's Tailwind classes, "show as Tailwind" and states. */
export function ClassesSection({ ctxs }: { ctxs: NodeCtx[] }) {
  const tw = useTailwind();
  const show = useUi((s) => s.showAsTailwind);
  const single = ctxs.length === 1 ? ctxs[0]!.node : null;

  return (
    <Section id="props-classes" title="Classes">
      <Body>
        {tw.status === 'loading' && (
          <div className="prop-subtitle" data-testid="classes-loading">
            Loading Tailwind…
          </div>
        )}
        {tw.status === 'error' && (
          <div className="prop-doc-error" data-testid="classes-error">
            Could not load Tailwind: {tw.message}
          </div>
        )}
        {tw.status === 'ready' && <ClassesField ctxs={ctxs} engine={tw.engine} mod={tw.mod} />}
        {tw.status === 'ready' && (
          <label className="prop-check" title="Shows the node style as Tailwind classes">
            <input
              type="checkbox"
              data-testid="classes-as-tailwind-toggle"
              checked={show}
              onChange={(e) => ui.setShowAsTailwind(e.target.checked)}
            />
            Show as Tailwind
          </label>
        )}
        {tw.status === 'ready' &&
          show &&
          (single ? (
            <AsTailwind node={single} engine={tw.engine} />
          ) : (
            <div className="prop-subtitle">Select a single node to see its classes.</div>
          ))}
        {single && <StatesList node={single} />}
      </Body>
    </Section>
  );
}
