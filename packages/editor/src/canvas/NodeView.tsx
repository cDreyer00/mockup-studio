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
import { VOID_TAGS, inlineSvgVars, resolveStateStyle } from '@mockup/core';
import type { Document, Node, Op, StateContext } from '@mockup/core';
import { daemon } from '../client/daemon';
import { useDoc } from '../state/docStore';
import { nodeScopeVars } from '../tokens/reportCache';
import { ui, useUi } from '../state/uiStore';
import type { NodePreview } from '../state/uiStore';
import { convertStyle, resolveSrc, resolveTag, safeAttrs, svgToDataUri } from './render-utils';
import { StateCtxContext, rootStateCtx, themedStateCtx, toCoreContext } from './stateContext';
import type { StateCtx } from './stateContext';

/** Id do documento (resolve o caminho de assets). Estável entre edições. */
export const DocIdContext = createContext('');

/**
 * Documento da página de render (que não usa o store). No canvas fica `null` e o SVG lê o
 * documento do store.
 */
export const RenderDocContext = createContext<Document | null>(null);

const px = (n: number): string => `${n}px`;

/**
 * CSS final do nó: estilo do documento (com os estados ativos de `states`, quando há contexto) +
 * prévia transitória (arrasto/redimensionamento).
 */
export function buildNodeStyle(
  node: Node,
  preview: NodePreview | undefined,
  root: boolean,
  states?: StateContext,
): CSSProperties {
  const base = (states && node.states ? resolveStateStyle(node, states) : node.style) ?? {};
  const style: Record<string, unknown> = { ...convertStyle(base) };
  // Filhos absolutos usam `position` como left/top quando não definidos no CSS.
  if (!root && node.position && base.position === 'absolute') {
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
  } else if (preview?.position && base.position === 'absolute') {
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

const hasVar = (svg: string): boolean => /var\(/i.test(svg);

/** Markup com as `var()` resolvidas no escopo do nó (sem o nó no documento, fica como está). */
function svgWithScope(doc: Document, node: Node, svg: string): string {
  try {
    return inlineSvgVars(svg, nodeScopeVars(doc, node.id));
  } catch {
    return svg;
  }
}

/**
 * Nó SVG. Nunca injeta HTML: o markup é isolado num `<img>` (sem scripts; `currentColor` não
 * herda). Como as custom properties do documento não chegam dentro da imagem, as `var()` do markup
 * são trocadas pelos valores do escopo do nó (tokens, tema efetivo e variáveis dos ancestrais).
 */
function SvgView({ node, style }: { node: Node; style: CSSProperties }) {
  const svg = node.svg ?? '';
  const renderDoc = useContext(RenderDocContext);
  const withVars = hasVar(svg);
  // No canvas, o seletor devolve a string final: só re-renderiza quando o resultado muda.
  const fromStore = useDoc((s) =>
    withVars && !renderDoc && s.doc ? svgWithScope(s.doc, node, svg) : null,
  );
  const markup = useMemo(
    () => fromStore ?? (withVars && renderDoc ? svgWithScope(renderDoc, node, svg) : svg),
    [fromStore, withVars, renderDoc, svg, node.id],
  );
  const src = useMemo(() => svgToDataUri(markup), [markup]);
  return createElement('img', {
    src,
    alt: '',
    draggable: false,
    style,
    'data-node-id': node.id,
  });
}

/**
 * Contexto de estados deste nó: o frame raiz usa a própria largura; nós com data-theme trocam o
 * dark da subárvore. Devolve o mesmo objeto enquanto nada muda (o contexto não re-renderiza a árvore).
 */
function useStableCtx(
  node: Node,
  root: boolean,
  base: StateCtx,
  rootWidth: string | undefined,
): StateCtx {
  const prev = useRef<StateCtx | null>(null);
  let next = root ? rootStateCtx(base, rootWidth) : base;
  const theme = node.attrs?.['data-theme'];
  if (theme !== undefined) next = themedStateCtx(next, theme);
  const same = (a: StateCtx): boolean =>
    a.preview === next.preview && a.bpWidth === next.bpWidth && a.dark === next.dark;
  if (same(base)) next = base;
  else if (prev.current && same(prev.current)) next = prev.current;
  prev.current = next;
  return next;
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
  const baseCtx = useContext(StateCtxContext);
  const ctx = useStableCtx(
    node,
    root,
    baseCtx,
    root ? (preview?.style?.width ?? node.style.width) : undefined,
  );
  // Só quem tem estados reprocessa o estilo quando o contexto muda.
  const statesCtx = node.states ? ctx : null;
  const style = useMemo(
    () => buildNodeStyle(node, preview, root, statesCtx ? toCoreContext(statesCtx) : undefined),
    [node, preview, root, statesCtx],
  );
  /** A subárvore enxerga o contexto do frame raiz / do tema deste nó. */
  const scoped = (el: ReactNode): ReactNode =>
    ctx === baseCtx ? el : <StateCtxContext.Provider value={ctx}>{el}</StateCtxContext.Provider>;
  const attrs = useMemo(() => safeAttrs(node, docId), [node, docId]);
  if (node.hidden) return null;

  const tag = resolveTag(node.tag);

  if (node.type === 'svg') {
    if (!node.svg) return createElement('div', { style, 'data-node-id': node.id });
    return <SvgView node={node} style={style} />;
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
    return scoped(
      <EditableText
        tag={tag}
        props={props}
        text={node.text ?? ''}
        nodeId={node.id}
        hasWhiteSpace={node.style['white-space'] !== undefined}
      />,
    );
  }

  const children: ReactNode[] = [];
  if (node.type === 'text' && node.text) children.push(node.text);
  for (const child of node.children ?? []) {
    if (!child.hidden) children.push(<NodeView key={child.id} node={child} />);
  }
  return scoped(createElement(tag, props, ...children));
});
