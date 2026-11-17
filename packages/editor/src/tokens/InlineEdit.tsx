import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { TokenProblem } from '@mockup/core';
import { ui } from '../state/uiStore';

/**
 * Texto editável no lugar: `display` enquanto parado; ao entrar em edição vira um input.
 * Enter confirma, Esc cancela, blur confirma. `validate` pode recusar (`error`: continua editando
 * e mostra a mensagem) ou só avisar (`warning`: aceita e mostra um aviso).
 */
export function InlineEdit({
  value,
  display,
  editing,
  onStart,
  onStop,
  onCommit,
  validate,
  testId,
  inputTestId = 'inline-input',
  mono,
  placeholder,
}: {
  value: string;
  display: ReactNode;
  editing: boolean;
  onStart: () => void;
  onStop: () => void;
  onCommit: (value: string) => void;
  validate?: (value: string) => TokenProblem | null;
  testId?: string;
  inputTestId?: string;
  mono?: boolean;
  placeholder?: string;
}) {
  const [text, setText] = useState(value);
  const [error, setError] = useState<string | null>(null);
  const ref = useRef<HTMLInputElement>(null);
  const settled = useRef(false);

  useEffect(() => {
    if (!editing) return;
    settled.current = false;
    setText(value);
    setError(null);
    const el = ref.current;
    if (el) {
      el.focus();
      el.select();
    }
    // Só reinicia o rascunho ao entrar em edição.
  }, [editing]);

  if (!editing) {
    return (
      <button
        type="button"
        className="tk-inline"
        data-testid={testId}
        title="Clique para editar"
        onClick={onStart}
      >
        {display}
      </button>
    );
  }

  const confirm = (): boolean => {
    if (text === value) {
      onStop();
      return true;
    }
    const problem = validate?.(text) ?? null;
    if (problem?.level === 'error') {
      setError(problem.message);
      return false;
    }
    if (problem) ui.toast(`Aviso: ${problem.message}`, 'info');
    settled.current = true;
    onCommit(text);
    onStop();
    return true;
  };

  return (
    <span className="tk-inline-edit">
      <input
        ref={ref}
        className={`text-input${mono ? ' mono' : ''}${error ? ' invalid' : ''}`}
        data-testid={inputTestId}
        value={text}
        placeholder={placeholder}
        spellCheck={false}
        aria-invalid={error ? true : undefined}
        onChange={(e) => {
          setText(e.target.value);
          setError(null);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            confirm();
          } else if (e.key === 'Escape') {
            e.preventDefault();
            settled.current = true;
            onStop();
          }
          e.stopPropagation();
        }}
        onBlur={() => {
          if (settled.current) return;
          // Valor recusado: o blur descarta em vez de prender o foco.
          if (!confirm()) onStop();
        }}
      />
      {error && (
        <span className="tk-error" role="alert" data-testid="inline-error">
          {error}
        </span>
      )}
    </span>
  );
}
