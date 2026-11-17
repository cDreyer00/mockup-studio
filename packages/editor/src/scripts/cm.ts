/**
 * CodeMirror 6 do painel de scripts. Este módulo só é importado sob demanda (`import()`), para o
 * CodeMirror não entrar no chunk principal do editor.
 */
import type { Completion, CompletionContext, CompletionResult } from '@codemirror/autocomplete';
import { javascript, javascriptLanguage } from '@codemirror/lang-javascript';
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { Prec } from '@codemirror/state';
import { EditorView, keymap } from '@codemirror/view';
import { tags as t } from '@lezer/highlight';
import { basicSetup } from 'codemirror';

export type { EditorView };

const method = (label: string, detail: string, info?: string): Completion => ({
  label,
  type: 'method',
  detail,
  info,
});
const prop = (label: string, detail: string, info?: string): Completion => ({
  label,
  type: 'property',
  detail,
  info,
});

/** `doc.` */
export const DOC_COMPLETIONS: Completion[] = [
  method('select', '(query)', 'Nós que casam com o seletor (tipo, tag, #id, nome...).'),
  method('selectOne', '(query)', 'Primeiro nó que casa com o seletor.'),
  method('get', '(id)', 'Nó pelo id.'),
  method('selection', '()', 'Nós selecionados no editor.'),
  method('frames', '()', 'Frames da página.'),
  method('pages', '()', 'Páginas do documento.'),
  method('create', '(parent, spec)', 'Cria um nó dentro de parent (null = novo frame).'),
  method('apply', '(op)', 'Aplica uma op do protocolo diretamente.'),
  method('screenshot', '(nodeId?)', 'Imagem do nó (ou do frame); aparece na saída.'),
  method('tokens', '()', 'Tokens de design do documento.'),
  method('setTokens', '(tokens)', 'Define tokens de design.'),
];

/** Membros de um handle de nó. */
export const HANDLE_COMPLETIONS: Completion[] = [
  prop('id', 'string'),
  prop('type', 'string'),
  prop('tag', 'string'),
  prop('name', 'string', 'Nome da camada (atribuível).'),
  prop('text', 'string', 'Texto do nó (atribuível).'),
  prop('style', 'proxy', 'Estilos CSS (leitura e atribuição).'),
  prop('attrs', 'object'),
  prop('children', 'Handle[]'),
  prop('parent', 'Handle'),
  prop('frame', 'Handle'),
  method('setStyle', '(obj)', 'Define vários estilos de uma vez.'),
  method('remove', '()', 'Exclui o nó.'),
  method('duplicate', '()', 'Duplica o nó.'),
  method('select', '(query)', 'Descendentes que casam com o seletor.'),
];

const CONSOLE_COMPLETIONS: Completion[] = ['log', 'info', 'warn', 'error'].map((l) =>
  method(l, '(...args)'),
);

const GLOBALS: Completion[] = [
  { label: 'doc', type: 'variable', detail: 'API do documento' },
  { label: 'console', type: 'variable' },
];

/** Fonte de autocomplete da API de scripts. */
export function scriptCompletions(context: CompletionContext): CompletionResult | null {
  const member = context.matchBefore(/([A-Za-z_$][\w$]*)\.([\w$]*)$/);
  if (member) {
    const dot = member.text.indexOf('.');
    const obj = member.text.slice(0, dot);
    const options =
      obj === 'doc'
        ? DOC_COMPLETIONS
        : obj === 'console'
          ? CONSOLE_COMPLETIONS
          : HANDLE_COMPLETIONS;
    return { from: member.from + dot + 1, options, validFor: /^[\w$]*$/ };
  }
  const word = context.matchBefore(/[A-Za-z_$][\w$]*$/);
  if (!word || (word.from === word.to && !context.explicit)) return null;
  return { from: word.from, options: GLOBALS, validFor: /^[\w$]*$/ };
}

const theme = EditorView.theme(
  {
    '&': { height: '100%', backgroundColor: 'var(--surface-2)', color: 'var(--text)' },
    '&.cm-focused': { outline: 'none' },
    '.cm-scroller': { fontFamily: 'var(--mono)', fontSize: '12px', lineHeight: '1.5' },
    '.cm-content': { caretColor: 'var(--accent)' },
    '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--accent)' },
    '&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, ::selection':
      { backgroundColor: 'rgba(45, 212, 191, 0.28)' },
    '.cm-gutters': {
      backgroundColor: 'var(--surface)',
      color: 'var(--muted)',
      border: 'none',
      borderRight: '1px solid var(--border)',
    },
    '.cm-activeLine': { backgroundColor: 'rgba(255, 255, 255, 0.04)' },
    '.cm-activeLineGutter': { backgroundColor: 'rgba(255, 255, 255, 0.06)', color: 'var(--text)' },
    '.cm-matchingBracket': { backgroundColor: 'rgba(45, 212, 191, 0.25)', outline: 'none' },
    '.cm-tooltip': {
      backgroundColor: 'var(--surface-3)',
      border: '1px solid var(--border-strong)',
      color: 'var(--text)',
    },
    '.cm-tooltip-autocomplete > ul > li[aria-selected]': {
      backgroundColor: 'var(--accent-soft)',
      color: 'var(--text)',
    },
    '.cm-completionDetail': { color: 'var(--muted)' },
    '.cm-panels': { backgroundColor: 'var(--surface)', color: 'var(--text)' },
  },
  { dark: true },
);

const highlight = HighlightStyle.define([
  { tag: [t.keyword, t.controlKeyword, t.operatorKeyword, t.modifier], color: '#c4b5fd' },
  { tag: [t.string, t.special(t.string), t.regexp], color: '#86efac' },
  { tag: [t.number, t.bool, t.null], color: '#fdba74' },
  { tag: [t.comment, t.lineComment, t.blockComment], color: '#7d818d', fontStyle: 'italic' },
  { tag: [t.function(t.variableName), t.function(t.propertyName)], color: '#7dd3fc' },
  { tag: [t.propertyName, t.attributeName], color: '#e6e7eb' },
  { tag: [t.definition(t.variableName), t.className, t.typeName], color: '#5eead4' },
  { tag: [t.operator, t.punctuation, t.bracket], color: '#b4b7c0' },
]);

export interface CreateEditorOptions {
  parent: HTMLElement;
  doc: string;
  onChange: (code: string) => void;
  /** Ctrl/Cmd+Enter. */
  onRun: () => void;
}

/** Cria o editor (JavaScript, tema escuro, autocomplete da API `doc.`). */
export function createScriptEditor({ parent, doc, onChange, onRun }: CreateEditorOptions) {
  return new EditorView({
    parent,
    doc,
    extensions: [
      Prec.highest(
        keymap.of([
          {
            key: 'Mod-Enter',
            run: () => {
              onRun();
              return true;
            },
          },
        ]),
      ),
      basicSetup,
      javascript(),
      javascriptLanguage.data.of({ autocomplete: scriptCompletions }),
      theme,
      syntaxHighlighting(highlight),
      EditorView.updateListener.of((u) => {
        if (u.docChanged) onChange(u.state.doc.toString());
      }),
    ],
  });
}
