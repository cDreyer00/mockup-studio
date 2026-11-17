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
import {
  VOID_TAGS,
  baseNodeId,
  expandRepeaterChildren,
  inlineSvgVars,
  resolveStateStyle,
} from '@mockup/core';
import type { Document, Node, Op, StateContext } from '@mockup/core';
import { daemon } from '../client/daemon';
import { EffectView } from '../fx/EffectView';
import { EmbedView } from '../fx/EmbedView';
import { VideoView } from '../fx/VideoView';
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
    return inlineSvgVars(svg, nodeScopeVars(doc, baseNodeId(node.id)));
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
    // clones de repetidor (`id~3`) respondem ao id do template
    'data-node-id': baseNodeId(node.id),
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
    a.preview === next.preview &&
    a.bpWidth === next.bpWidth &&
    a.dark === next.dark &&
    a.breakpoints === next.breakpoints &&
    a.darkTheme === next.darkTheme;
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
  const attrs = useMemo(() => safeAttrs(node, docId), [node, docId]);
  if (node.hidden) return null;

  const tag = resolveTag(node.tag);

  if (node.type === 'effect') return <EffectView node={node} style={style} docId={docId} />;
  if (node.type === 'video') return <VideoView node={node} style={style} docId={docId} />;
  if (node.type === 'embed') return <EmbedView node={node} style={style} docId={docId} />;

  if (node.type === 'svg') {
    if (!node.svg) return createElement('div', { style, 'data-node-id': realId });
    return <SvgView node={node} style={style} />;
  }

  const props: Record<string, unknown> = { ...attrs, style, 'data-node-id': realId };
  // Prévia dark: o frame raiz assume o tema `dark` do documento (só no DOM).
  if (root && baseCtx.preview === 'dark' && baseCtx.darkTheme) props['data-theme'] = 'dark';
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
  for (const child of repeated ?? node.children ?? []) {
    if (!child.hidden) children.push(<NodeView key={child.id} node={child} />);
  }
  return scoped(createElement(tag, props, ...children));
});
