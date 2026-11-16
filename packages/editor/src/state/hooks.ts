/** Hooks de leitura com seletores finos (evitam re-render global). */
import { useShallow } from 'zustand/react/shallow';
import type { Document, Node, Page } from '@mockup/core';
import { getEntry, getNode } from '../model/tree';
import { useDoc } from './docStore';
import { useUi } from './uiStore';

export function useActiveDoc(): Document | null {
  return useDoc((s) => s.doc);
}

/** Página exibida: a escolhida, se existir; senão a primeira. */
export function selectPage(doc: Document | null, pageId: string | null): Page | null {
  if (!doc) return null;
  return doc.pages.find((p) => p.id === pageId) ?? doc.pages[0] ?? null;
}

export function useActivePage(): Page | null {
  const doc = useDoc((s) => s.doc);
  const pageId = useUi((s) => s.pageId);
  return selectPage(doc, pageId);
}

/** Id da página exibida (estado local + fallback para a primeira). */
export function currentPageId(): string | null {
  return selectPage(useDoc.getState().doc, useUi.getState().pageId)?.id ?? null;
}

/** Nó pelo id (re-renderiza só quando o objeto do nó muda, graças ao compartilhamento estrutural). */
export function useNode(id: string | null | undefined): Node | undefined {
  return useDoc((s) => (s.doc && id ? getNode(s.doc, id) : undefined));
}

export function useSelection(): string[] {
  return useUi((s) => s.selection);
}

/** Nós selecionados que existem no documento ativo (reage à seleção e ao documento). */
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

/** Página do nó. */
export function pageOfNode(doc: Document, id: string): string | undefined {
  return getEntry(doc, id)?.pageId;
}
