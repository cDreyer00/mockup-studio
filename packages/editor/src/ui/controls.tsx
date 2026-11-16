/** Controles compartilhados: seção recolhível, select, cor, botão de ícone, campo de texto. */
import { useEffect, useState } from 'react';
import type { ButtonHTMLAttributes, KeyboardEvent, ReactNode } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';

const collapsedSections = new Set<string>();

/** Seção recolhível do painel; o estado aberto/fechado é lembrado por `id` durante a sessão. */
export function Section({
  id,
  title,
  actions,
  children,
  defaultOpen = true,
}: {
  id: string;
  title: string;
  actions?: ReactNode;
  children: ReactNode;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(() =>
    collapsedSections.has(id) ? false : defaultOpen || false,
  );
  const toggle = () => {
    setOpen((o) => {
      if (o) collapsedSections.add(id);
      else collapsedSections.delete(id);
      return !o;
    });
  };
  return (
    <section className={`panel-section${open ? ' open' : ''}`} data-section={id}>
      <header className="panel-section-header">
        <button type="button" className="panel-section-toggle" onClick={toggle}>
          {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
          <span>{title}</span>
        </button>
        {actions && <div className="panel-section-actions">{actions}</div>}
      </header>
      {open && <div className="panel-section-body">{children}</div>}
    </section>
  );
}

export function IconButton({
  title,
  active,
  className,
  children,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { title: string; active?: boolean }) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      aria-pressed={active}
      className={`icon-btn${active ? ' active' : ''}${className ? ` ${className}` : ''}`}
      {...rest}
    >
      {children}
    </button>
  );
}

export interface SelectOption {
  value: string;
  label: string;
}

/** Select nativo estilizado. `value` vazio mostra o placeholder (ex.: "—" ou "Misto"). */
export function SelectInput({
  value,
  options,
  onChange,
  placeholder = '—',
  title,
  className,
}: {
  value: string | undefined | null;
  options: SelectOption[];
  onChange: (value: string) => void;
  placeholder?: string;
  title?: string;
  className?: string;
}) {
  const v = value ?? '';
  const known = options.some((o) => o.value === v);
  return (
    <select
      className={`select-input${className ? ` ${className}` : ''}`}
      value={v}
      title={title}
      onChange={(e) => onChange(e.target.value)}
    >
      <option value="">{value === null ? 'Misto' : placeholder}</option>
      {!known && v && <option value={v}>{v}</option>}
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

/** Campo de texto que confirma no Enter/blur e cancela no Esc. */
export function TextInput({
  value,
  onCommit,
  placeholder,
  title,
  className,
  monospace,
}: {
  value: string | undefined | null;
  onCommit: (value: string) => void;
  placeholder?: string;
  title?: string;
  className?: string;
  monospace?: boolean;
}) {
  const shown = value ?? '';
  const [text, setText] = useState(shown);
  const [focused, setFocused] = useState(false);
  useEffect(() => {
    if (!focused) setText(shown);
  }, [shown, focused]);
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
    else if (e.key === 'Escape') {
      setText(shown);
      setFocused(false);
      requestAnimationFrame(() => (e.target as HTMLInputElement).blur());
    }
    e.stopPropagation();
  };
  return (
    <input
      className={`text-input${monospace ? ' mono' : ''}${className ? ` ${className}` : ''}`}
      value={text}
      title={title}
      placeholder={value === null ? 'Misto' : placeholder}
      spellCheck={false}
      onChange={(e) => setText(e.target.value)}
      onFocus={() => setFocused(true)}
      onBlur={() => {
        setFocused(false);
        if (text !== shown) onCommit(text);
      }}
      onKeyDown={onKeyDown}
    />
  );
}

/** Converte cores CSS simples para `#rrggbb` (para o `<input type=color>`); `null` se não der. */
export function toHexColor(v: string | undefined | null): string | null {
  if (!v) return null;
  const t = v.trim().toLowerCase();
  let m = /^#([0-9a-f]{3})$/.exec(t);
  if (m) return '#' + [...m[1]!].map((c) => c + c).join('');
  m = /^#([0-9a-f]{6})([0-9a-f]{2})?$/.exec(t);
  if (m) return '#' + m[1];
  m = /^rgba?\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)/.exec(t);
  if (m) {
    return (
      '#' +
      [m[1], m[2], m[3]].map((n) => Math.min(255, Number(n)).toString(16).padStart(2, '0')).join('')
    );
  }
  if (t === 'white') return '#ffffff';
  if (t === 'black') return '#000000';
  return null;
}

/** Amostra de cor + campo de texto (aceita qualquer valor CSS: hex, rgb(), var(--token)...). */
export function ColorInput({
  value,
  onCommit,
  onPreview,
  placeholder = 'nenhuma',
  title,
}: {
  value: string | undefined | null;
  onCommit: (value: string) => void;
  onPreview?: (value: string) => void;
  placeholder?: string;
  title?: string;
}) {
  const hex = toHexColor(value);
  return (
    <div className="color-input" title={title}>
      <label className="color-swatch" style={{ background: value ?? 'transparent' }}>
        <input
          type="color"
          value={hex ?? '#000000'}
          onInput={(e) => onPreview?.((e.target as HTMLInputElement).value)}
          onChange={(e) => onCommit(e.target.value)}
        />
      </label>
      <TextInput value={value} onCommit={onCommit} placeholder={placeholder} monospace />
    </div>
  );
}

/** Linha rotulada do painel: `<Row label="Gap">{input}</Row>`. */
export function Row({ label, children }: { label?: ReactNode; children: ReactNode }) {
  return (
    <div className="panel-row">
      {label !== undefined && <span className="panel-row-label">{label}</span>}
      <div className="panel-row-controls">{children}</div>
    </div>
  );
}
