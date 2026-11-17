/** Atalhos globais do editor (estilo Figma). A tecla → comando está em `resolveShortcut`. */
import { useEffect } from 'react';
import { actions } from '../actions';
import { canvasApi } from '../canvas/canvasApi';
import { insertImageFile, pickImageFile } from '../canvas/imageTool';
import { saveDocumentAs } from '../desktop/fileFlows';
import { fxClock } from '../fx/clock';
import { useClipboard } from '../clipboard/useClipboard';
import { getNode, topLevel } from '../model/tree';
import { useDoc } from '../state/docStore';
import { ui, useUi } from '../state/uiStore';
import { isEditableTarget, isInteractionBlocked } from './guards';
import { resolveShortcut } from './resolveShortcut';
import type { ShortcutCommand } from './resolveShortcut';

/** Todos os nós de topo estão com a flag? (alterna: se todos estão, desliga; senão liga). */
function toggleFlag(flag: 'hidden' | 'locked'): void {
  const { doc } = useDoc.getState();
  if (!doc) return;
  const ids = topLevel(doc, useUi.getState().selection);
  if (!ids.length) return;
  const all = ids.every((id) => getNode(doc, id)?.[flag]);
  void (flag === 'hidden' ? actions.setHidden(ids, !all) : actions.setLocked(ids, !all));
}

export async function pickAndInsertImage(): Promise<void> {
  const file = await pickImageFile();
  if (file) await insertImageFile(file);
}

/** Executa um comando de atalho. */
export function runShortcut(cmd: ShortcutCommand): void {
  switch (cmd.type) {
    case 'tool':
      return ui.setTool(cmd.tool);
    case 'pickImage':
      return void pickAndInsertImage();
    case 'save':
      return void actions.save();
    case 'saveAs':
      return void saveDocumentAs();
    case 'delete':
      return void actions.deleteSelection();
    case 'duplicate':
      return void actions.duplicateSelection();
    case 'group':
      return void actions.group();
    case 'ungroup':
      return void actions.ungroup();
    case 'reorder':
      return void actions.reorder(cmd.kind);
    case 'toggleHidden':
      return toggleFlag('hidden');
    case 'toggleLocked':
      return toggleFlag('locked');
    case 'nudge':
      return void actions.nudge(cmd.dx, cmd.dy);
    case 'escape':
      if (useUi.getState().tool !== 'select') return ui.setTool('select');
      return actions.selectParent();
    case 'selectChildren': {
      const { doc } = useDoc.getState();
      if (!doc) return;
      const kids = useUi
        .getState()
        .selection.flatMap((id) => getNode(doc, id)?.children.map((c) => c.id) ?? []);
      if (kids.length) ui.select(kids);
      return;
    }
    case 'selectParent':
      return actions.selectParent();
    case 'selectAll':
      return actions.selectAll();
    case 'undo':
      return void actions.undo();
    case 'redo':
      return void actions.redo();
    case 'zoomIn':
      return canvasApi.zoomIn();
    case 'zoomOut':
      return canvasApi.zoomOut();
    case 'zoom100':
      return canvasApi.zoomTo(1);
    case 'zoomFit':
      return canvasApi.fitAll();
    case 'zoomSelection':
      return canvasApi.fitNodes();
  }
}

export function useShortcuts(): void {
  useClipboard();
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const cmd = resolveShortcut(e);
      // Ctrl+S / Ctrl+Shift+S sempre salvam, mesmo em campos de texto e modais.
      if (cmd?.type === 'save' || cmd?.type === 'saveAs') {
        e.preventDefault();
        runShortcut(cmd);
        return;
      }
      if (isEditableTarget(e.target) || isInteractionBlocked()) return;

      if (e.code === 'Space' || e.key === ' ') {
        e.preventDefault();
        // Shift+Espaço: play/pausa das animações (Espaço sozinho continua sendo o pan).
        if (e.shiftKey) {
          if (!e.repeat) fxClock.toggle();
          return;
        }
        if (!e.repeat && !useUi.getState().spaceDown) useUi.setState({ spaceDown: true });
        return;
      }
      if (e.key === 'Alt') {
        if (!useUi.getState().altDown) useUi.setState({ altDown: true });
        return;
      }
      if (!cmd) return;
      e.preventDefault();
      runShortcut(cmd);
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.code === 'Space' || e.key === ' ') useUi.setState({ spaceDown: false });
      else if (e.key === 'Alt') useUi.setState({ altDown: false });
    };
    const onBlur = () => useUi.setState({ spaceDown: false, altDown: false });
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', onBlur);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', onBlur);
    };
  }, []);
}
