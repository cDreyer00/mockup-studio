/** Painel de camadas: páginas no topo e árvore de camadas da página ativa. */
import { memo, useEffect, useMemo, useRef, useState } from 'react';
import type { DragEvent, KeyboardEvent, MouseEvent } from 'react';
import {
  ChevronDown,
  ChevronRight,
  Eye,
  EyeOff,
  Frame,
  Image as ImageIcon,
  LayoutPanelTop,
  Link,
  List,
  Lock,
  LockOpen,
  Plus,
  RectangleHorizontal,
  Repeat,
  Shapes,
  Square,
  TextCursorInput,
  Type,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { newPageId } from '@mockup/core';
import type { Node, Page } from '@mockup/core';
import { actions } from '../actions';
import { canvasApi } from '../canvas/canvasApi';
import { daemon } from '../client/daemon';
import { getChain, topLevel } from '../model/tree';
import { useDoc } from '../state/docStore';
import { selectPage, useActivePage, useIsSelected, useNode } from '../state/hooks';
import { ui, useUi } from '../state/uiStore';
import { openContextMenu } from '../ui/overlays';
import { computeDropOps, flattenTree, nextPageName, rangeBetween, zoneFor } from './layersLogic';
import type { DropTarget } from './layersLogic';
import { layers, useLayers } from './layersStore';
import { buildNodeMenu } from './nodeMenu';
import { NodeSearch } from './NodeSearch';
import './layers.css';

const TAG_ICONS: Record<string, LucideIcon> = {
  button: RectangleHorizontal,
  a: Link,
  section: LayoutPanelTop,
  header: LayoutPanelTop,
  footer: LayoutPanelTop,
  nav: LayoutPanelTop,
  main: LayoutPanelTop,
  ul: List,
  ol: List,
  input: TextCursorInput,
};

function iconFor(node: Node): LucideIcon {
  if (node.type === 'frame') return Frame;
  if (node.type === 'text') return Type;
  if (node.type === 'image') return ImageIcon;
  if (node.type === 'svg') return Shapes;
  if (node.type === 'repeater') return Repeat;
  return TAG_ICONS[node.tag] ?? Square;
}

/** Lê a lista visível atual (para Shift+clique), sempre do estado mais recente. */
function currentVisibleIds(): string[] {
  const page = selectPage(useDoc.getState().doc, useUi.getState().pageId);
  return page ? flattenTree(page, useLayers.getState().collapsed).map((r) => r.id) : [];
}

/* ---------------- campo de renomear inline ---------------- */

function InlineInput({
  initial,
  testId,
  onCommit,
  onCancel,
}: {
  initial: string;
  testId: string;
  onCommit: (v: string) => void;
  onCancel: () => void;
}) {
  const done = useRef(false);
  const finish = (commit: boolean, value: string) => {
    if (done.current) return;
    done.current = true;
    if (commit) onCommit(value);
    else onCancel();
  };
  return (
    <input
      className="layer-input"
      data-testid={testId}
      defaultValue={initial}
      autoFocus
      onFocus={(e) => e.currentTarget.select()}
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onKeyDown={(e: KeyboardEvent<HTMLInputElement>) => {
        e.stopPropagation();
        if (e.key === 'Enter') finish(true, e.currentTarget.value);
        else if (e.key === 'Escape') finish(false, '');
      }}
      onBlur={(e) => finish(true, e.currentTarget.value)}
    />
  );
}

/* ---------------- páginas ---------------- */

function PageItem({ page, active, only }: { page: Page; active: boolean; only: boolean }) {
  const [editing, setEditing] = useState(false);
  const rename = (name: string) => {
    setEditing(false);
    const n = name.trim();
    if (n && n !== page.name) {
      void daemon.applySafe([{ type: 'renamePage', pageId: page.id, name: n }]);
    }
  };
  const remove = async () => {
    const wasActive = active;
    const ok = await daemon.applySafe([{ type: 'deletePage', pageId: page.id }]);
    if (ok && wasActive) ui.setPage(null);
  };
  return (
    <div
      className={`page-item${active ? ' active' : ''}`}
      data-testid={`page-item-${page.id}`}
      role="option"
      aria-selected={active}
      onClick={() => ui.setPage(page.id)}
      onContextMenu={(e) => {
        e.preventDefault();
        openContextMenu(e.clientX, e.clientY, [
          { label: 'Renomear', onSelect: () => setEditing(true) },
          { label: 'Excluir', danger: true, disabled: only, onSelect: () => void remove() },
        ]);
      }}
    >
      {editing ? (
        <InlineInput
          initial={page.name}
          testId="page-rename-input"
          onCommit={rename}
          onCancel={() => setEditing(false)}
        />
      ) : (
        <span
          className="page-name"
          onDoubleClick={(e) => {
            e.stopPropagation();
            setEditing(true);
          }}
        >
          {page.name}
        </span>
      )}
    </div>
  );
}

function PagesList() {
  const doc = useDoc((s) => s.doc);
  const active = useActivePage();
  if (!doc) return null;
  const add = async () => {
    const pageId = newPageId();
    const ok = await daemon.applySafe([
      { type: 'createPage', pageId, name: nextPageName(doc.pages) },
    ]);
    if (ok) ui.setPage(pageId);
  };
  return (
    <div className="layers-pages">
      <div className="layers-heading">
        <span>Páginas</span>
        <button
          type="button"
          className="layer-btn"
          data-testid="add-page"
          title="Nova página"
          onClick={() => void add()}
        >
          <Plus size={14} />
        </button>
      </div>
      <div className="pages-list" data-testid="pages-list" role="listbox">
        {doc.pages.map((p) => (
          <PageItem key={p.id} page={p} active={p.id === active?.id} only={doc.pages.length <= 1} />
        ))}
      </div>
    </div>
  );
}

/* ---------------- drag and drop ---------------- */

let dragIds: string[] = [];

function dropOps(target: DropTarget) {
  const doc = useDoc.getState().doc;
  if (!doc) return null;
  return computeDropOps(doc, dragIds, target, (id) => canvasApi.nodeRect(id));
}

function performDrop(target: DropTarget): void {
  const ops = dropOps(target);
  layers.setDrop(null);
  dragIds = [];
  if (ops?.length) void daemon.applySafe(ops);
}

/* ---------------- linha ---------------- */

interface RowProps {
  id: string;
  depth: number;
  hasChildren: boolean;
  expanded: boolean;
}

const LayerRow = memo(function LayerRow({ id, depth, hasChildren, expanded }: RowProps) {
  const node = useNode(id);
  const selected = useIsSelected(id);
  const dropZone = useLayers((s) => (s.drop?.id === id ? s.drop.zone : null));
  const [editing, setEditing] = useState(false);
  if (!node) return null;
  const Icon = iconFor(node);

  const onClick = (e: MouseEvent) => {
    if (e.shiftKey) {
      ui.select(rangeBetween(currentVisibleIds(), useLayers.getState().anchor, id));
      return;
    }
    layers.setAnchor(id);
    if (e.ctrlKey || e.metaKey) ui.toggle(id);
    else ui.select([id]);
  };

  const onDragStart = (e: DragEvent) => {
    let sel = useUi.getState().selection;
    if (!sel.includes(id)) {
      sel = [id];
      ui.select(sel);
    }
    dragIds = sel;
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', id);
  };

  const onDragOver = (e: DragEvent<HTMLDivElement>) => {
    if (!dragIds.length) return;
    const r = e.currentTarget.getBoundingClientRect();
    const zone = zoneFor(node, (e.clientY - r.top) / Math.max(1, r.height));
    if (dropOps({ id, zone })) {
      e.preventDefault();
      e.stopPropagation();
      e.dataTransfer.dropEffect = 'move';
      layers.setDrop({ id, zone });
    } else {
      layers.setDrop(null);
    }
  };

  const onDrop = (e: DragEvent<HTMLDivElement>) => {
    const d = useLayers.getState().drop;
    if (!d || d.id !== id) return;
    e.preventDefault();
    e.stopPropagation();
    performDrop({ id, zone: d.zone });
  };

  return (
    <div
      className={`layer-row${selected ? ' selected' : ''}${node.hidden ? ' hidden-node' : ''}${
        dropZone ? ` drop-${dropZone}` : ''
      }`}
      data-testid={`layer-row-${id}`}
      data-layer-id={id}
      role="treeitem"
      aria-selected={selected}
      aria-expanded={hasChildren ? expanded : undefined}
      aria-level={depth + 1}
      draggable={!editing}
      style={{ paddingLeft: 6 + depth * 14 }}
      onClick={onClick}
      onMouseEnter={() => ui.hover(id)}
      onMouseLeave={() => ui.hover(null)}
      onContextMenu={(e) => {
        e.preventDefault();
        if (!useUi.getState().selection.includes(id)) {
          layers.setAnchor(id);
          ui.select([id]);
        }
        openContextMenu(e.clientX, e.clientY, buildNodeMenu());
      }}
      onDragStart={onDragStart}
      onDragOver={onDragOver}
      onDrop={onDrop}
      onDragEnd={() => {
        dragIds = [];
        layers.setDrop(null);
      }}
    >
      <span
        className={`layer-chevron${hasChildren ? '' : ' empty'}`}
        data-testid={`layer-chevron-${id}`}
        onClick={(e) => {
          e.stopPropagation();
          if (hasChildren) layers.toggleCollapsed(id);
        }}
      >
        {hasChildren ? expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} /> : null}
      </span>
      <Icon size={13} className="layer-icon" />
      {editing ? (
        <InlineInput
          initial={node.name}
          testId="layer-rename-input"
          onCommit={(v) => {
            setEditing(false);
            if (v.trim() && v.trim() !== node.name) void actions.rename(id, v);
          }}
          onCancel={() => setEditing(false)}
        />
      ) : (
        <span
          className="layer-name"
          onDoubleClick={(e) => {
            e.stopPropagation();
            setEditing(true);
          }}
        >
          {node.name}
          <span className="layer-tag">{`<${node.tag}>`}</span>
        </span>
      )}
      <span className="layer-actions">
        <button
          type="button"
          className={`layer-btn${node.hidden ? ' on' : ''}`}
          data-testid={`layer-toggle-hidden-${id}`}
          title={node.hidden ? 'Mostrar' : 'Ocultar'}
          onClick={(e) => {
            e.stopPropagation();
            void actions.setHidden([id], !node.hidden);
          }}
        >
          {node.hidden ? <EyeOff size={13} /> : <Eye size={13} />}
        </button>
        <button
          type="button"
          className={`layer-btn${node.locked ? ' on' : ''}`}
          data-testid={`layer-toggle-locked-${id}`}
          title={node.locked ? 'Destravar' : 'Travar'}
          onClick={(e) => {
            e.stopPropagation();
            void actions.setLocked([id], !node.locked);
          }}
        >
          {node.locked ? <Lock size={13} /> : <LockOpen size={13} />}
        </button>
      </span>
    </div>
  );
});

/* ---------------- árvore ---------------- */

function LayerTree() {
  const page = useActivePage();
  const collapsed = useLayers((s) => s.collapsed);
  const selection = useUi((s) => s.selection);
  const treeRef = useRef<HTMLDivElement>(null);
  const rows = useMemo(() => (page ? flattenTree(page, collapsed) : []), [page, collapsed]);

  // Seleção externa: expande ancestrais e rola até a primeira linha selecionada.
  useEffect(() => {
    const doc = useDoc.getState().doc;
    if (!doc || !selection.length || !topLevel(doc, selection).length) return;
    const ancestors = selection.flatMap((id) =>
      getChain(doc, id)
        .slice(0, -1)
        .map((n) => n.id),
    );
    layers.expand(ancestors);
    const first = selection[0]!;
    const t = setTimeout(() => {
      const el = treeRef.current?.querySelector(`[data-layer-id="${CSS.escape(first)}"]`);
      el?.scrollIntoView?.({ block: 'nearest' });
    }, 0);
    return () => clearTimeout(t);
  }, [selection]);

  if (!page) return null;
  return (
    <div
      className="layers-tree"
      data-testid="layers-tree"
      role="tree"
      aria-multiselectable="true"
      ref={treeRef}
      onDragOver={(e) => {
        if (!dragIds.length) return;
        if (dropOps({ rootOfPage: page.id })) {
          e.preventDefault();
          layers.setDrop({ id: null, zone: 'root' });
        }
      }}
      onDrop={(e) => {
        if (useLayers.getState().drop?.zone !== 'root') return;
        e.preventDefault();
        performDrop({ rootOfPage: page.id });
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) ui.select([]);
      }}
    >
      {rows.length === 0 ? (
        <div className="layers-empty" data-testid="layers-empty">
          Sem frames nesta página. Use F para criar um frame.
        </div>
      ) : (
        rows.map((r) => (
          <LayerRow
            key={r.id}
            id={r.id}
            depth={r.depth}
            hasChildren={r.hasChildren}
            expanded={r.expanded}
          />
        ))
      )}
    </div>
  );
}

export function LayersPanel() {
  return (
    <aside className="panel panel-left layers-panel" data-testid="layers-panel">
      <NodeSearch />
      <PagesList />
      <div className="layers-heading">
        <span>Camadas</span>
      </div>
      <LayerTree />
    </aside>
  );
}
