import { useEffect, useRef, useState } from 'react';
import type { KeyboardEvent, PointerEvent as ReactPointerEvent, ReactNode } from 'react';
import { formatCssNumber, normalizeInput, parseCssNumber, round } from './units';

export interface NumberInputProps {
  /** Current CSS value (e.g. '120px', '50%', 'auto'); `undefined` = empty; `null` = mixed. */
  value: string | undefined | null;
  /** Commits the new value ('' = remove the property). Called on Enter, blur and drag end. */
  onCommit: (value: string) => void;
  /** Preview while dragging the label (optional; e.g. `ui.setPreview`). */
  onPreview?: (value: string) => void;
  /** Label/icon that also serves as a horizontal drag handle. */
  label?: ReactNode;
  title?: string;
  /** Unit applied to numbers typed without a unit (default 'px'; '' for unitless). */
  unit?: string;
  min?: number;
  max?: number;
  /** Increment per dragged pixel and per arrow key (Shift = ×10). */
  step?: number;
  placeholder?: string;
  disabled?: boolean;
  className?: string;
}

/**
 * Numeric input with units: accepts `12`, `12px`, `50%`, `2rem`, `auto`, `calc(...)`.
 * Dragging the label horizontally adjusts the value; ↑/↓ arrows increment.
 */
export function NumberInput({
  value,
  onCommit,
  onPreview,
  label,
  title,
  unit = 'px',
  min,
  max,
  step = 1,
  placeholder,
  disabled,
  className,
}: NumberInputProps) {
  const shown = value === null ? '' : (value ?? '');
  const [text, setText] = useState(shown);
  const [focused, setFocused] = useState(false);
  const scrub = useRef<{ startX: number; base: number; unit: string; last: string } | null>(null);
  // Enter/Esc already resolved the edit: the blur that follows (before the ack) doesn't commit again.
  const settled = useRef(false);

  useEffect(() => {
    if (!focused && !scrub.current) setText(shown);
  }, [shown, focused]);

  const clamp = (n: number) => Math.min(max ?? Infinity, Math.max(min ?? -Infinity, n));

  const commit = (t: string) => {
    const v = normalizeInput(t, unit);
    if (v !== (value ?? '')) onCommit(v);
  };

  const bump = (delta: number) => {
    const n = parseCssNumber(text) ?? (text.trim() === '' ? { value: 0, unit } : null);
    if (!n) return;
    const next = formatCssNumber({ value: clamp(round(n.value + delta)), unit: n.unit || unit });
    setText(next);
    onCommit(next);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      settled.current = true;
      commit(text);
      (e.target as HTMLInputElement).blur();
    } else if (e.key === 'Escape') {
      settled.current = true;
      setText(shown);
      (e.target as HTMLInputElement).blur();
    } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault();
      bump((e.key === 'ArrowUp' ? 1 : -1) * step * (e.shiftKey ? 10 : 1));
    }
    e.stopPropagation();
  };

  const onScrubDown = (e: ReactPointerEvent<HTMLSpanElement>) => {
    if (disabled || e.button !== 0) return;
    const n = parseCssNumber(shown) ?? (shown === '' ? { value: 0, unit } : null);
    if (!n) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    scrub.current = { startX: e.clientX, base: n.value, unit: n.unit || unit, last: shown };
  };
  const onScrubMove = (e: ReactPointerEvent<HTMLSpanElement>) => {
    const s = scrub.current;
    if (!s) return;
    const dx = e.clientX - s.startX;
    const next = formatCssNumber({
      value: clamp(round(s.base + dx * step * (e.shiftKey ? 10 : 1))),
      unit: s.unit,
    });
    if (next === s.last) return;
    s.last = next;
    setText(next);
    onPreview?.(next);
  };
  const onScrubUp = () => {
    const s = scrub.current;
    scrub.current = null;
    if (s && s.last !== shown) onCommit(s.last);
  };

  return (
    <label
      className={`num-input${disabled ? ' disabled' : ''}${className ? ` ${className}` : ''}`}
      title={title}
    >
      {label !== undefined && (
        <span
          className="num-input-label"
          onPointerDown={onScrubDown}
          onPointerMove={onScrubMove}
          onPointerUp={onScrubUp}
          onPointerCancel={onScrubUp}
        >
          {label}
        </span>
      )}
      <input
        value={text}
        disabled={disabled}
        placeholder={value === null ? 'Mixed' : placeholder}
        spellCheck={false}
        onChange={(e) => setText(e.target.value)}
        onFocus={(e) => {
          settled.current = false;
          setFocused(true);
          e.target.select();
        }}
        onBlur={() => {
          setFocused(false);
          if (settled.current) {
            settled.current = false;
            return;
          }
          commit(text);
        }}
        onKeyDown={onKeyDown}
      />
    </label>
  );
}
