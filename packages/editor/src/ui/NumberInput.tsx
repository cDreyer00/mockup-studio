import { useEffect, useRef, useState } from 'react';
import type { KeyboardEvent, PointerEvent as ReactPointerEvent, ReactNode } from 'react';
import { formatCssNumber, normalizeInput, parseCssNumber, round } from './units';

export interface NumberInputProps {
  /** Valor CSS atual (ex.: '120px', '50%', 'auto'); `undefined` = vazio; `null` = misto. */
  value: string | undefined | null;
  /** Confirma o novo valor ('' = remover a propriedade). Chamado no Enter, blur e fim do arrasto. */
  onCommit: (value: string) => void;
  /** Prévia durante o arrasto do rótulo (opcional; ex.: `ui.setPreview`). */
  onPreview?: (value: string) => void;
  /** Rótulo/ícone que também serve de alça de arrasto horizontal. */
  label?: ReactNode;
  title?: string;
  /** Unidade aplicada a números digitados sem unidade (padrão 'px'; '' para adimensional). */
  unit?: string;
  min?: number;
  max?: number;
  /** Incremento por pixel arrastado e por seta (Shift = ×10). */
  step?: number;
  placeholder?: string;
  disabled?: boolean;
  className?: string;
}

/**
 * Input numérico com unidades: aceita `12`, `12px`, `50%`, `2rem`, `auto`, `calc(...)`.
 * Arrastar o rótulo na horizontal ajusta o valor; setas ↑/↓ incrementam.
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
  // Enter/Esc já resolveram a edição: o blur que vem em seguida (antes do ack) não confirma de novo.
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
        placeholder={value === null ? 'Misto' : placeholder}
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
