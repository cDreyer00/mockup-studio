/** Read hooks with fine-grained selectors (avoid global re-renders). */
import { useShallow } from 'zustand/react/shallow';
import type { Document, Node, Page } from '@mockup/core';
import { getEntry, getNode } from '../model/tree';
import { useDoc } from './docStore';
import { useUi } from './uiStore';

export function useActiveDoc(): Document | null {
  return useDoc((s) => s.doc);
}

/** Displayed page: the chosen one, if it exists; otherwise the first. */
export function selectPage(doc: Document | null, pageId: string | null): Page | null {
  if (!doc) return null;
  return doc.pages.find((p) => p.id === pageId) ?? doc.pages[0] ?? null;
}

export function useActivePage(): Page | null {
  const doc = useDoc((s) => s.doc);
  const pageId = useUi((s) => s.pageId);
  return selectPage(doc, pageId);
}

/** Id of the displayed page (local state + fallback to the first). */
export function currentPageId(): string | null {
  return selectPage(useDoc.getState().doc, useUi.getState().pageId)?.id ?? null;
}

/** Node by id (re-renders only when the node object changes, thanks to structural sharing). */
export function useNode(id: string | null | undefined): Node | undefined {
  return useDoc((s) => (s.doc && id ? getNode(s.doc, id) : undefined));
}

export function useSelection(): string[] {
  return useUi((s) => s.selection);
}

/** Selected nodes that exist in the active document (reacts to the selection and the document). */
export function useSelectedNodes(): Node[] {
  const sel = useUi((s) => s.selection);
  return useDoc(
    useShallow((s) =>
      s.doc ? sel.map((id) => getNode(s.doc!, id)).filter((n): n is Node => !!n) : [],
    ),
  );
}

export function useIsSelected(id: string): boolean {
  return useUi((s) => s.selection.includes(id));
}

/** Page of the node. */
export function pageOfNode(doc: Document, id: string): string | undefined {
  return getEntry(doc, id)?.pageId;
}
