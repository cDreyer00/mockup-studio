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
import { VOID_TAGS } from '@mockup/core';
import type { Node, Op } from '@mockup/core';
import { daemon } from '../client/daemon';
import { EffectView } from '../fx/EffectView';
import { EmbedView } from '../fx/EmbedView';
import { VideoView } from '../fx/VideoView';
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
export const NodeView = memo(function NodeView({ node, root = false }: NodeViewProps) {
  const docId = useContext(DocIdContext);
  const preview = useUi((s) => s.preview[node.id]);
  const editing = useUi((s) => s.editingTextId === node.id);
  const style = useMemo(() => buildNodeStyle(node, preview, root), [node, preview, root]);
  const attrs = useMemo(() => safeAttrs(node, docId), [node, docId]);
  if (node.hidden) return null;

  const tag = resolveTag(node.tag);

  if (node.type === 'effect') return <EffectView node={node} style={style} docId={docId} />;
  if (node.type === 'video') return <VideoView node={node} style={style} docId={docId} />;
  if (node.type === 'embed') return <EmbedView node={node} style={style} docId={docId} />;

  if (node.type === 'svg') {
    // Nunca injeta HTML: o SVG é isolado em um <img> (sem scripts; `currentColor` não herda).
    if (!node.svg) return createElement('div', { style, 'data-node-id': node.id });
    return createElement('img', {
      src: svgToDataUri(node.svg),
      alt: '',
      draggable: false,
      style,
      'data-node-id': node.id,
    });
  }

  const props: Record<string, unknown> = { ...attrs, style, 'data-node-id': node.id };
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
  for (const child of node.children ?? []) {
    if (!child.hidden) children.push(<NodeView key={child.id} node={child} />);
  }
  return createElement(tag, props, ...children);
});
