/**
 * Aba "Componentes" do painel esquerdo: biblioteca do documento (clique = editar o principal;
 * arrastar ou "+" = inserir instância) e os kits do daemon (clique ou arrastar = inserir; o kit é
 * importado no mesmo passo se preciso). Busca por nome.
 */
import { useEffect, useMemo, useState } from 'react';
import type { DragEvent } from 'react';
import { Component, Package, Plus } from 'lucide-react';
import type { ComponentDef, Document, Node } from '@mockup/core';
import { useDoc } from '../state/docStore';
import { useUi } from '../state/uiStore';
import { insertInstance } from './componentActions';
import { writeComponentDrag } from './drag';
import { enterComponent } from './editing';
import { fetchKits } from './kits';
import type { KitComponentInfo, KitInfo } from './kits';
import './components.css';

/**
 * Nº de instâncias por componente nas páginas, numa passada (as aninhadas em outros principais,
 * como os Buttons dentro do Dialog do kit, não contam).
 */
export function countInstances(doc: Document): Map<string, number> {
  const out = new Map<string, number>();
  const visit = (n: Node): void => {
    if (n.type === 'instance' && n.componentId) {
      out.set(n.componentId, (out.get(n.componentId) ?? 0) + 1);
    }
    for (const c of n.children) visit(c);
  };
  for (const p of doc.pages) for (const f of p.frames) visit(f);
  return out;
}

const plural = (n: number): string => (n === 1 ? '1 instância' : `${n} instâncias`);

function matches(q: string, name: string, extra?: string): boolean {
  if (!q) return true;
  return name.toLowerCase().includes(q) || !!extra?.toLowerCase().includes(q);
}

function DocItem({ c, count, active }: { c: ComponentDef; count: number; active: boolean }) {
  return (
    <div
      className={`cmp-item${active ? ' active' : ''}`}
      data-testid={`component-item-${c.id}`}
      role="option"
      aria-selected={active}
      title={c.description ?? 'Clique para editar o principal; arraste para inserir'}
      draggable
      onDragStart={(e: DragEvent) => writeComponentDrag(e.dataTransfer, { componentId: c.id })}
      onClick={() => enterComponent(c.id)}
    >
      <Component size={13} />
      <span className="cmp-item-main">
        <span className="cmp-item-name">{c.name}</span>
        <span className="cmp-item-meta">
          {c.kit ? `${c.kit} · ` : ''}
          {plural(count)}
        </span>
      </span>
      <button
        type="button"
        className="layer-btn"
        data-testid={`component-insert-${c.id}`}
        title="Inserir instância"
        onClick={(e) => {
          e.stopPropagation();
          void insertInstance(c.id);
        }}
      >
        <Plus size={13} />
      </button>
    </div>
  );
}

function KitItem({ kit, c }: { kit: string; c: KitComponentInfo }) {
  return (
    <div
      className="cmp-item"
      data-testid={`kit-item-${kit}-${c.name}`}
      role="option"
      aria-selected={false}
      title={c.description ?? 'Clique ou arraste para inserir'}
      draggable
      onDragStart={(e: DragEvent) => writeComponentDrag(e.dataTransfer, { componentId: c.id, kit })}
      onClick={() => void insertInstance(c.id, { kit })}
    >
      <Package size={13} />
      <span className="cmp-item-main">
        <span className="cmp-item-name">{c.name}</span>
        {c.description && <span className="cmp-item-meta">{c.description}</span>}
      </span>
    </div>
  );
}

export function ComponentsPanel() {
  const raw = useDoc((s) => s.rawDoc ?? s.doc);
  const editing = useUi((s) => s.editingComponentId);
  const [query, setQuery] = useState('');
  const [kits, setKits] = useState<KitInfo[] | null>(null);
  const [kitError, setKitError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    fetchKits()
      .then((k) => alive && setKits(k))
      .catch((e: unknown) => alive && setKitError(e instanceof Error ? e.message : String(e)));
    return () => {
      alive = false;
    };
  }, []);

  const counts = useMemo(() => (raw ? countInstances(raw) : new Map<string, number>()), [raw]);
  const q = query.trim().toLowerCase();
  const library = (raw?.components ?? []).filter((c) => matches(q, c.name, c.kit));

  return (
    <aside className="panel panel-left cmp-panel" data-testid="components-panel">
      <div className="cmp-search">
        <input
          className="text-input"
          data-testid="components-search"
          placeholder="Buscar componentes"
          value={query}
          spellCheck={false}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === 'Escape') setQuery('');
          }}
        />
      </div>
      <div className="cmp-body">
        <div className="cmp-heading">
          <span>Neste documento</span>
        </div>
        <div role="listbox" data-testid="components-library">
          {library.length === 0 ? (
            <div className="cmp-empty">
              {q
                ? 'Nenhum componente com esse nome.'
                : 'Nenhum componente. Selecione um nó e use Ctrl+Alt+K, ou insira um do kit abaixo.'}
            </div>
          ) : (
            library.map((c) => (
              <DocItem key={c.id} c={c} count={counts.get(c.id) ?? 0} active={c.id === editing} />
            ))
          )}
        </div>
        {kitError && <div className="cmp-empty">Kits indisponíveis: {kitError}</div>}
        {kits?.map((kit) => {
          const list = kit.components.filter((c) => matches(q, c.name, c.description));
          return (
            <div key={kit.name} data-testid={`kit-${kit.name}`}>
              <div className="cmp-heading">
                <span>Kit {kit.name}</span>
              </div>
              <div role="listbox">
                {list.length === 0 ? (
                  <div className="cmp-empty">Nenhum componente com esse nome.</div>
                ) : (
                  list.map((c) => <KitItem key={c.id} kit={kit.name} c={c} />)
                )}
              </div>
            </div>
          );
        })}
      </div>
    </aside>
  );
}
