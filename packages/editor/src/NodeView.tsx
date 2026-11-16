import { createContext, createElement, useContext } from 'react';
import type { CSSProperties, FormEvent, MouseEvent, ReactNode } from 'react';
import { VOID_TAGS } from '@mockup/core';
import type { Node } from '@mockup/core';
import { convertStyle, resolveSrc, resolveTag, safeAttrs, svgToDataUri } from './render-utils';

/** Contexto de renderização compartilhado pela árvore (evita prop drilling). */
export interface RenderContext {
  docId: string;
  selection: ReadonlySet<string>;
  onSelect: (nodeId: string) => void;
}

export const RenderCtx = createContext<RenderContext>({
  docId: '',
  selection: new Set(),
  onSelect: () => undefined,
});

interface NodeViewProps {
  node: Node;
  /** Estilo extra aplicado por último (usado pelo frame raiz para posicionamento). */
  extraStyle?: CSSProperties;
}

/** Renderiza um nó como elemento HTML real, recursivamente. */
export function NodeView({ node, extraStyle }: NodeViewProps) {
  const { docId, selection, onSelect } = useContext(RenderCtx);
  if (node.hidden) return null;

  const tag = resolveTag(node.tag);
  const style = convertStyle(node.style ?? {});
  // Filhos absolutos usam `position` como left/top quando não definidos no CSS.
  if (node.position && node.style?.position === 'absolute') {
    style.left ??= node.position.x;
    style.top ??= node.position.y;
  }
  Object.assign(style, extraStyle);
  if (selection.has(node.id)) {
    style.outline = '1px solid #6c5ce7';
    style.outlineOffset = '-1px';
  }

  const onClick = (e: MouseEvent) => {
    // Links, botões e submits não devem navegar/agir dentro do canvas.
    e.preventDefault();
    e.stopPropagation();
    onSelect(node.id);
  };

  if (node.type === 'svg') {
    // Nunca injeta HTML: o SVG é isolado em um <img> (sem scripts; `currentColor` não herda).
    if (!node.svg) return createElement('div', { style, 'data-node-id': node.id, onClick });
    return createElement('img', {
      src: svgToDataUri(node.svg),
      alt: '',
      draggable: false,
      style,
      'data-node-id': node.id,
      onClick,
    });
  }

  const props: Record<string, unknown> = {
    ...safeAttrs(node, docId),
    style,
    'data-node-id': node.id,
    onClick,
  };
  if (tag === 'form') props.onSubmit = (e: FormEvent) => e.preventDefault();

  if (node.type === 'image') {
    props.src = node.src ? resolveSrc(docId, node.src) : undefined;
    props.draggable = false;
    return createElement(tag, props);
  }
  if (VOID_TAGS.has(tag)) return createElement(tag, props);

  const children: ReactNode[] = [];
  if (node.type === 'text' && node.text) children.push(node.text);
  for (const child of node.children ?? []) children.push(<NodeView key={child.id} node={child} />);
  return createElement(tag, props, ...children);
}
