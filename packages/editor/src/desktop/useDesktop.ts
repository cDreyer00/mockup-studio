/** Connects the native menu and the window state of the desktop app to the editor actions. */
import { useEffect } from 'react';
import { actions } from '../actions';
import { canvasApi } from '../canvas/canvasApi';
import { isEditableTarget } from '../shortcuts/guards';
import { selectActiveInfo, useDoc } from '../state/docStore';
import { getDesktop } from './bridge';
import type { DesktopMenuAction } from './bridge';
import { closeActiveDocument, newDocument, openDocument, saveDocumentAs } from './fileFlows';

/** Undo/redo of the focused field when it is editable; otherwise of the document history. */
function undoRedo(kind: 'undo' | 'redo'): void {
  if (isEditableTarget(document.activeElement)) {
    document.execCommand(kind);
    return;
  }
  void (kind === 'undo' ? actions.undo() : actions.redo());
}

/** Runs a native menu action. Exported for testing. */
export function runDesktopMenu(action: DesktopMenuAction, arg?: string): void {
  switch (action) {
    case 'new':
      return void newDocument();
    case 'open':
      return void openDocument();
    case 'openRecent':
      return void (arg && openDocument(arg));
    case 'save':
      return void actions.save();
    case 'saveAs':
      return void saveDocumentAs();
    case 'close':
      return void closeActiveDocument();
    case 'undo':
    case 'redo':
      return undoRedo(action);
    case 'zoomIn':
      return canvasApi.zoomIn();
    case 'zoomOut':
      return canvasApi.zoomOut();
    case 'zoomReset':
      return canvasApi.zoomTo(1);
    case 'zoomFit':
      return canvasApi.fitAll();
  }
}

/** Window state derived from the active document. */
export function windowStateOf(info: ReturnType<typeof selectActiveInfo>): {
  title: string;
  path: string | null;
  dirty: boolean;
} {
  return info
    ? { title: info.name, path: info.path, dirty: info.dirty }
    : { title: '', path: null, dirty: false };
}

/** Syncs the active document state with the native window. Outside React, for testing. */
export function syncDocumentState(): () => void {
  const desktop = getDesktop();
  if (!desktop) return () => undefined;
  const push = (): void =>
    desktop.setDocumentState(windowStateOf(selectActiveInfo(useDoc.getState())));
  push();
  return useDoc.subscribe((s, p) => {
    const a = selectActiveInfo(s);
    const b = selectActiveInfo(p);
    if (
      a?.name !== b?.name ||
      a?.path !== b?.path ||
      a?.dirty !== b?.dirty ||
      a?.docId !== b?.docId
    )
      push();
  });
}

export function useDesktop(): void {
  useEffect(() => {
    const desktop = getDesktop();
    if (!desktop) return;
    const off = desktop.onMenu(runDesktopMenu);
    const stop = syncDocumentState();
    return () => {
      off();
      stop();
    };
  }, []);
}
