import { createContext, createElement, useContext } from 'react';
import type { CSSProperties, MouseEvent, ReactNode } from 'react';
import type { Node } from '@mockup/core';

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

const VOID_TAGS = new Set(['img', 'input', 'br', 'hr', 'source', 'area', 'col', 'wbr']);
const BLOCKED_TAGS = new Set([
  'script',
  'iframe',
  'object',
  'embed',
  'link',
  'meta',
  'base',
  'style',
]);

/** `background-color` → `backgroundColor`; custom properties (`--x`) ficam intactas. */
export function kebabToCamel(prop: string): string {
  if (prop.startsWith('--')) return prop;
  const p = prop.startsWith('-ms-') ? prop.slice(1) : prop;
  return p.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
}

export function convertStyle(style: Record<string, string>): CSSProperties {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(style)) out[kebabToCamel(k)] = v;
  return out as CSSProperties;
}

/** Resolve o `src` de imagens: data:/http(s) passam; relativo vira `/assets/<docId>/<src>`. */
export function resolveSrc(docId: string, src: string): string {
  if (/^(data:|https?:)/i.test(src)) return src;
  return `/assets/${docId}/${src.replace(/^\/+/, '')}`;
}

/** Repassa atributos seguros (sem `on*`; `href` vira `data-href`; `src` só em img). */
function safeAttrs(node: Node, docId: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(node.attrs ?? {})) {
    const key = k.toLowerCase();
    if (key.startsWith('on') || key === 'style' || key === 'srcdoc') continue;
    if (key === 'href') out['data-href'] = v;
    else if (key === 'src') {
      if (node.tag === 'img') out.src = resolveSrc(docId, v);
    } else if (key === 'class') out.className = v;
    else if (key === 'for') out.htmlFor = v;
    else out[k] = v;
  }
  return out;
}

interface NodeViewProps {
  node: Node;
  /** Estilo extra aplicado por último (usado pelo frame raiz para posicionamento). */
  extraStyle?: CSSProperties;
}

/** Renderiza um nó como elemento HTML real, recursivamente. */
export function NodeView({ node, extraStyle }: NodeViewProps) {
  const { docId, selection, onSelect } = useContext(RenderCtx);
  if (node.hidden) return null;

  const tag = BLOCKED_TAGS.has(node.tag) ? 'div' : node.tag || 'div';
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

  const props: Record<string, unknown> = {
    ...safeAttrs(node, docId),
    style,
    'data-node-id': node.id,
    onClick: (e: MouseEvent) => {
      e.stopPropagation();
      onSelect(node.id);
    },
  };

  if (node.type === 'image') {
    props.src = node.src ? resolveSrc(docId, node.src) : undefined;
    props.draggable = false;
    return createElement(tag, props);
  }
  if (node.type === 'svg') {
    props.dangerouslySetInnerHTML = { __html: node.svg ?? '' };
    return createElement(tag, props);
  }
  if (VOID_TAGS.has(tag)) return createElement(tag, props);

  const children: ReactNode[] = [];
  if (node.type === 'text' && node.text) children.push(node.text);
  for (const child of node.children ?? []) children.push(<NodeView key={child.id} node={child} />);
  return createElement(tag, props, ...children);
}
