/** Commands the daemon sends to this editor window on behalf of the MCP (presentation tools). */
import { NO_PRESENTATION } from '@mockup/core';
import type { EditorCommand, PresentationState } from '@mockup/core';
import { useDoc } from '../state/docStore';
import { presentation } from './presentationStore';

/** How long `presentation:start` waits for the requested document to become the active one. */
export const ACTIVE_DOC_WAIT_MS = 3000;

/** Waits until `docId` is the active document with its view loaded; rejects after `timeoutMs`. */
function waitForActiveDoc(docId: string, timeoutMs: number): Promise<void> {
  const ready = (s: ReturnType<typeof useDoc.getState>): boolean =>
    s.activeDocId === docId && s.doc?.id === docId;
  if (ready(useDoc.getState())) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      off();
      reject(new Error(`Document ${docId} is not the active document in the editor.`));
    }, timeoutMs);
    const off = useDoc.subscribe((s) => {
      if (!ready(s)) return;
      clearTimeout(timer);
      off();
      resolve();
    });
  });
}

/**
 * Runs an editor command and returns the presentation state afterwards. Rejects with a readable
 * message (the daemon forwards it to the MCP client).
 *
 * `presentation:stop` answers with the state as it was right before stopping (`active: true` plus the
 * slides) when a presentation was running, or `NO_PRESENTATION` when nothing was: that is how the
 * daemon tells "stopped" from "nothing was running".
 */
export async function runEditorCommand(command: EditorCommand): Promise<PresentationState> {
  switch (command.type) {
    case 'presentation:start': {
      await waitForActiveDoc(command.docId, ACTIVE_DOC_WAIT_MS);
      if (presentation.getState().active) presentation.stop();
      presentation.start({
        ...(command.pageId !== undefined && { pageId: command.pageId }),
        ...(command.frameId !== undefined && { frameId: command.frameId }),
      });
      await presentation.settled();
      return presentation.getState();
    }
    case 'presentation:goto': {
      const { index, frameId, step } = command;
      return presentation.goto({
        ...(index !== undefined && { index }),
        ...(frameId !== undefined && { frameId }),
        ...(step !== undefined && { step }),
      });
    }
    case 'presentation:stop': {
      const before = presentation.getState();
      if (!before.active) return NO_PRESENTATION;
      presentation.stop();
      return before;
    }
  }
}
