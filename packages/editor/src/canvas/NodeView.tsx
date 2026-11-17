import {
  createContext,
  createElement,
  memo,
  useContext,
  useLayoutEffect,
  useMemo,
  useRef,
} from 'react';
import type { CSSProperties, KeyboardEvent, ReactNode } from 'react';
import { VOID_TAGS, baseNodeId, expandRepeaterChildren } from '@mockup/core';
import type { Node, Op } from '@mockup/core';
import { daemon } from '../client/daemon';
import { ui, useUi } from '../state/uiStore';
import type { NodePreview } from '../state/uiStore';
import { convertStyle, resolveSrc, resolveTag, safeAttrs, svgToDataUri } from './render-utils';

/** Id do documento (resolve o caminho de assets). Estável entre edições. */
export const DocIdContext = createContext('');

const px = (n: number): string => `${n}px`;

/** CSS final do nó: estilo do documento + prévia transitória (arrasto/redimensionamento). */
export function buildNodeStyle(
  node: Node,
  preview: NodePreview | undefined,
  root: boolean,
): CSSProperties {
  const style: Record<string, unknown> = { ...convertStyle(node.style ?? {}) };
  // Filhos absolutos usam `position` como left/top quando não definidos no CSS.
  if (!root && node.position && node.style?.position === 'absolute') {
    style.left ??= px(node.position.x);
    style.top ??= px(node.position.y);
  }
  if (preview?.style) Object.assign(style, convertStyle(preview.style));
  if (root) {
    const pos = preview?.position ?? node.position;
    style.overflow ??= 'hidden';
    style.boxShadow ??= '0 2px 16px rgba(0,0,0,.35)';
    style.position = 'absolute';
    style.left = px(pos?.x ?? 0);
    style.top = px(pos?.y ?? 0);
    style.margin = 0;
  } else if (preview?.position && node.style?.position === 'absolute') {
    style.left = px(preview.position.x);
    style.top = px(preview.position.y);
  }
  return style as CSSProperties;
}

interface EditableProps {
  tag: string;
  props: Record<string, unknown>;
  text: string;
  nodeId: string;
  /** O nó já define `white-space` (então quebras de linha não precisam de `pre-wrap`). */
  hasWhiteSpace: boolean;
}

/** Texto em edição inline: o React não gerencia o conteúdo (evita sobrescrever o que se digita). */
function EditableText({ tag, props, text, nodeId, hasWhiteSpace }: EditableProps) {
  const ref = useRef<HTMLElement | null>(null);
  const done = useRef(false);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.textContent = text;
    el.focus();
    const sel = window.getSelection();
    if (sel) {
      const range = document.createRange();
      range.selectNodeContents(el);
      sel.removeAllRanges();
      sel.addRange(range);
    }
  }, []);

  const finish = (commit: boolean): void => {
    const el = ref.current;
    if (done.current) return;
    done.current = true;
    const value = el?.textContent ?? '';
    if (!commit || value === text) {
      ui.editText(null);
      return;
    }
    const ops: Op[] = [{ type: 'setText', changes: [{ nodeId, text: value }] }];
    // Sem `pre-wrap` o render normal colapsa a quebra do Shift+Enter; vai na mesma chamada (um undo).
    if (value.includes('\n') && !hasWhiteSpace) {
      ops.push({ type: 'updateStyles', changes: [{ nodeId, set: { 'white-space': 'pre-wrap' } }] });
    }
    void daemon.applySafe(ops).then((ack) => {
      if (ack) {
        ui.editText(null);
        return;
      }
      // Falhou (desconectado, nó travado...): mantém a edição aberta para não perder o texto.
      done.current = false;
      if (el?.isConnected) el.focus();
    });
  };

  const onKeyDown = (e: KeyboardEvent): void => {
    e.stopPropagation();
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      finish(true);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      finish(false);
    }
  };

  const baseStyle = props.style as CSSProperties;
  return createElement(tag, {
    ...props,
    ref,
    style: { whiteSpace: 'pre-wrap', ...baseStyle, cursor: 'text', userSelect: 'text' },
    contentEditable: 'plaintext-only',
    suppressContentEditableWarning: true,
    spellCheck: false,
    'data-testid': 'text-editor',
    onKeyDown,
    onKeyUp: (e: KeyboardEvent) => e.stopPropagation(),
    onBlur: () => finish(true),
  });
}

interface NodeViewProps {
  node: Node;
  /** Frame raiz da página (posicionado no canvas). */
  root?: boolean;
}

/**
 * Renderiza um nó como elemento HTML real, recursivamente. `memo` por identidade de `node`:
 * seleção e hover não passam por aqui (ficam no overlay); só a prévia do próprio nó assina.
 */
/** O nó tem, em algum nível do template, um descendente com este id exato? */
export function hasDescendant(node: Node, id: string): boolean {
  return node.children.some((c) => c.id === id || hasDescendant(c, id));
}

/**
 * Filhos expandidos do repetidor. Com um texto do template em edição, o item 0 volta ao nó cru
 * (a expansão já resolveu os bindings, mas o editor precisa do `{{campo}}`).
 */
export function withRawEditing(node: Node, editingId: string | null): Node[] {
  const expanded = expandRepeaterChildren(node);
  if (!editingId) return expanded;
  const raw = new Map<string, Node>();
  const index = (n: Node): void => {
    raw.set(n.id, n);
    n.children.forEach(index);
  };
  node.children.forEach(index);
  const swap = (n: Node): Node => {
    if (n.id === editingId) return raw.get(n.id) ?? n;
    return hasDescendant(n, editingId) ? { ...n, children: n.children.map(swap) } : n;
  };
  return expanded.map(swap);
}

export const NodeView = memo(function NodeView({ node, root = false }: NodeViewProps) {
  const docId = useContext(DocIdContext);
  // Clones de repetidor (`id~3`) respondem ao id do template: clique, hover, prévia e overlay.
  const realId = baseNodeId(node.id);
  const preview = useUi((s) => s.preview[realId]);
  const editing = useUi((s) => s.editingTextId === node.id);
  // Em edição inline de um texto do template, o item 0 mostra o texto cru (`{{campo}}`).
  const editingInside = useUi((s) =>
    node.type === 'repeater' && s.editingTextId && hasDescendant(node, s.editingTextId)
      ? s.editingTextId
      : null,
  );
  const repeated = useMemo(
    () => (node.type === 'repeater' ? withRawEditing(node, editingInside) : null),
    [node, editingInside],
  );
  const style = useMemo(() => buildNodeStyle(node, preview, root), [node, preview, root]);
  const attrs = useMemo(() => safeAttrs(node, docId), [node, docId]);
  if (node.hidden) return null;

  const tag = resolveTag(node.tag);

  if (node.type === 'svg') {
    // Nunca injeta HTML: o SVG é isolado em um <img> (sem scripts; `currentColor` não herda).
    if (!node.svg) return createElement('div', { style, 'data-node-id': realId });
    return createElement('img', {
      src: svgToDataUri(node.svg),
      alt: '',
      draggable: false,
      style,
      'data-node-id': realId,
    });
  }

  const props: Record<string, unknown> = { ...attrs, style, 'data-node-id': realId };
  if (tag === 'form') props.onSubmit = (e: { preventDefault(): void }) => e.preventDefault();

  if (node.type === 'image') {
    props.src = node.src ? resolveSrc(docId, node.src) : undefined;
    props.draggable = false;
    return createElement(tag, props);
  }
  if (VOID_TAGS.has(tag)) return createElement(tag, props);

  if (editing && node.type === 'text') {
    return (
      <EditableText
        tag={tag}
        props={props}
        text={node.text ?? ''}
        nodeId={node.id}
        hasWhiteSpace={node.style['white-space'] !== undefined}
      />
    );
  }

  const children: ReactNode[] = [];
  if (node.type === 'text' && node.text) children.push(node.text);
  for (const child of repeated ?? node.children ?? []) {
    if (!child.hidden) children.push(<NodeView key={child.id} node={child} />);
  }
  return createElement(tag, props, ...children);
});
