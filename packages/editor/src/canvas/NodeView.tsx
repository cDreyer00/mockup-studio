import {
  createContext,
  createElement,
  memo,
  useContext,
  useLayoutEffect,
  useMemo,
  useRef,
} from 'react';
import type { CSSProperties, KeyboardEvent, ReactNode, RefObject } from 'react';
import {
  VOID_TAGS,
  baseNodeId,
  expandRepeaterChildren,
  inlineSvgVars,
  resolveStateStyle,
  textSplitOf,
} from '@mockup/core';
import type { Document, Node, Op, StateContext } from '@mockup/core';
import { daemon } from '../client/daemon';
import { EffectView } from '../fx/EffectView';
import { EmbedView } from '../fx/EmbedView';
import { VideoView } from '../fx/VideoView';
import { MotionFrameContext, MotionScopeContext, splitTextChildren } from '../motion/context';
import { useDoc } from '../state/docStore';
import { nodeScopeVars } from '../tokens/reportCache';
import { ui, useUi } from '../state/uiStore';
import type { NodePreview } from '../state/uiStore';
import { convertStyle, resolveSrc, resolveTag, safeAttrs, svgToDataUri } from './render-utils';
import { StateCtxContext, rootStateCtx, themedStateCtx, toCoreContext } from './stateContext';
import type { StateCtx } from './stateContext';

/** Document id (resolves the assets path). Stable across edits. */
export const DocIdContext = createContext('');

/**
 * Document of the render page (which does not use the store). On the canvas it is `null` and the SVG reads the
 * document from the store.
 */
export const RenderDocContext = createContext<Document | null>(null);

const px = (n: number): string => `${n}px`;

/**
 * Final CSS of the node: document style (with the active states from `states`, when there is a context) +
 * transient preview (drag/resize).
 */
export function buildNodeStyle(
  node: Node,
  preview: NodePreview | undefined,
  root: boolean,
  states?: StateContext,
): CSSProperties {
  const base = (states && node.states ? resolveStateStyle(node, states) : node.style) ?? {};
  const style: Record<string, unknown> = { ...convertStyle(base) };
  // Absolute children use `position` as left/top when not defined in the CSS.
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
  /** The node already defines `white-space` (so line breaks do not need `pre-wrap`). */
  hasWhiteSpace: boolean;
}

/** Text being edited inline: React does not manage the content (avoids overwriting what is typed). */
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
    // Without `pre-wrap` the normal render collapses the Shift+Enter break; it goes in the same call (one undo).
    if (value.includes('\n') && !hasWhiteSpace) {
      ops.push({ type: 'updateStyles', changes: [{ nodeId, set: { 'white-space': 'pre-wrap' } }] });
    }
    void daemon.applySafe(ops).then((ack) => {
      if (ack) {
        ui.editText(null);
        return;
      }
      // Failed (disconnected, locked node...): keeps the edit open so the text is not lost.
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

/** Markup with the `var()`s resolved in the node's scope (without the node in the document, it stays as is). */
function svgWithScope(doc: Document, node: Node, svg: string): string {
  try {
    return inlineSvgVars(svg, nodeScopeVars(doc, baseNodeId(node.id)));
  } catch {
    return svg;
  }
}

/**
 * SVG node. Never injects HTML: the markup is isolated in an `<img>` (no scripts; `currentColor` is not
 * inherited). Since the document's custom properties do not reach inside the image, the markup's `var()`s
 * are replaced with the values from the node's scope (tokens, effective theme and ancestor variables).
 */
function SvgView({
  node,
  style,
  domRef,
}: {
  node: Node;
  style: CSSProperties;
  domRef?: RefObject<HTMLElement | null>;
}) {
  const svg = node.svg ?? '';
  const renderDoc = useContext(RenderDocContext);
  const withVars = hasVar(svg);
  // On the canvas, the selector returns the final string: it only re-renders when the result changes.
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
    // repeater clones (`id~3`) respond to the template id
    'data-node-id': baseNodeId(node.id),
    ...(domRef && { ref: domRef }),
  });
}

/**
 * States context of this node: the root frame uses its own width; nodes with data-theme switch the
 * subtree's dark. Returns the same object while nothing changes (the context does not re-render the tree).
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
  /** Root frame of the page (positioned on the canvas). */
  root?: boolean;
}

/**
 * Renders a node as a real HTML element, recursively. `memo` by `node` identity:
 * selection and hover do not go through here (they live in the overlay); only the node's own preview subscribes.
 */
/** Does the node have, at any level of the template, a descendant with this exact id? */
export function hasDescendant(node: Node, id: string): boolean {
  return node.children.some((c) => c.id === id || hasDescendant(c, id));
}

/**
 * Expanded children of the repeater. With a template text being edited, item 0 goes back to the raw node
 * (the expansion already resolved the bindings, but the editor needs the `{{field}}`).
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
  // Repeater clones (`id~3`) respond to the template id: click, hover, preview and overlay.
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
  // Only nodes with states reprocess the style when the context changes.
  const statesCtx = node.states ? ctx : null;
  const style = useMemo(
    () => buildNodeStyle(node, preview, root, statesCtx ? toCoreContext(statesCtx) : undefined),
    [node, preview, root, statesCtx],
  );
  /** The subtree sees the context of the root frame / of this node's theme. */
  const scoped = (el: ReactNode): ReactNode =>
    ctx === baseCtx ? el : <StateCtxContext.Provider value={ctx}>{el}</StateCtxContext.Provider>;
  // While inline-editing a template text, item 0 shows the raw text (`{{field}}`).
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

  // Motion: animated nodes register their element; the root frame registers the timeline.
  const motion = useContext(MotionScopeContext);
  const parentFrame = useContext(MotionFrameContext);
  const frameId = root ? node.id : parentFrame;
  const elRef = useRef<HTMLElement | null>(null);
  const animated = !!motion && !node.hidden && !!node.animations?.length;
  const media = node.type === 'effect' || node.type === 'video' || node.type === 'embed';
  useLayoutEffect(() => {
    if (!animated || !motion) return;
    return motion.attach(frameId, node, media ? null : elRef.current);
    // `editing` swaps the text element (inline editor), so the animations follow the new one
  }, [animated, motion, frameId, node, media, editing]);
  useLayoutEffect(() => {
    if (!motion || !root || node.hidden) return;
    return motion.setFrame(node.id, node, media ? null : elRef.current);
  }, [motion, root, node, media]);
  const withFrame = (el: ReactNode): ReactNode =>
    root && motion ? (
      <MotionFrameContext.Provider value={node.id}>{el}</MotionFrameContext.Provider>
    ) : (
      el
    );

  if (node.hidden) return null;

  const tag = resolveTag(node.tag);

  if (node.type === 'effect') return <EffectView node={node} style={style} docId={docId} />;
  if (node.type === 'video') return <VideoView node={node} style={style} docId={docId} />;
  if (node.type === 'embed') return <EmbedView node={node} style={style} docId={docId} />;

  const needsRef = !!motion && (root || animated);

  if (node.type === 'svg') {
    if (!node.svg)
      return createElement('div', {
        style,
        'data-node-id': realId,
        ...(needsRef && { ref: elRef }),
      });
    return <SvgView node={node} style={style} {...(needsRef && { domRef: elRef })} />;
  }

  const props: Record<string, unknown> = { ...attrs, style, 'data-node-id': realId };
  if (needsRef) props.ref = elRef;
  // Dark preview: the root frame takes the document's `dark` theme (DOM only).
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
  if (node.type === 'text' && node.text) {
    // word/character animations: one span per segment (also in the design state, same layout)
    const split = textSplitOf(node);
    if (split) children.push(...splitTextChildren(node.text, split));
    else children.push(node.text);
  }
  for (const child of repeated ?? node.children ?? []) {
    if (!child.hidden) children.push(<NodeView key={child.id} node={child} />);
  }
  return withFrame(scoped(createElement(tag, props, ...children)));
});
