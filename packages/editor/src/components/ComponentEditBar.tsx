/** Badge for main-component edit mode, at the top of the canvas: "Editing component X — Done". */
import { useEffect, useRef } from 'react';
import { Component } from 'lucide-react';
import { getComponent, listInstances } from '@mockup/core';
import { useDoc } from '../state/docStore';
import { useUi } from '../state/uiStore';
import { exitComponent } from './editing';
import './components.css';

export function ComponentEditBar() {
  const editing = useUi((s) => s.editingComponentId);
  const name = useDoc((s) => {
    const raw = s.rawDoc ?? s.doc;
    return editing && raw ? (getComponent(raw, editing)?.name ?? null) : null;
  });
  const count = useDoc((s) => {
    const raw = s.rawDoc ?? s.doc;
    return editing && raw ? listInstances(raw, editing).filter((r) => r.pageId).length : 0;
  });
  const ref = useRef<HTMLDivElement>(null);

  // The canvas listens to the pointer on the root element (native): the badge does not start gestures.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const stop = (e: Event): void => e.stopPropagation();
    const events = ['pointerdown', 'dblclick', 'contextmenu', 'wheel'] as const;
    for (const ev of events) el.addEventListener(ev, stop);
    return () => {
      for (const ev of events) el.removeEventListener(ev, stop);
    };
  }, [editing, name]);

  if (!editing || !name) return null;
  return (
    <div className="cmp-edit-bar" data-testid="component-edit-bar" ref={ref}>
      <Component size={13} />
      <span>
        Editing component <strong data-testid="component-edit-name">{name}</strong>
      </span>
      <span className="cmp-edit-count">{count === 1 ? '1 instance' : `${count} instances`}</span>
      <button
        type="button"
        className="cmp-edit-done"
        data-testid="component-edit-done"
        title="Back to page (Esc)"
        onClick={() => exitComponent()}
      >
        Done
      </button>
    </div>
  );
}
