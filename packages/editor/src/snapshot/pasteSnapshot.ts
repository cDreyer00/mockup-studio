/** Paste snapshot: the clipboard text becomes a frame in the active document via `POST /api/snapshot`. */
import { decodeClipboard } from '@mockup/snapshot-core';
import { canvasApi } from '../canvas/canvasApi';
import { useDoc } from '../state/docStore';
import { currentPageId } from '../state/hooks';
import { ui } from '../state/uiStore';
import { postSnapshot, selectImported } from './importApi';

/** Success toast text (with a warning when the capture brought `warnings`). */
export function importToastText(r: { nodes: number; warnings: string[] }): string {
  const base = `Section imported (${r.nodes} nodes)`;
  if (!r.warnings.length) return base;
  const extra = r.warnings.length > 1 ? ` (+${r.warnings.length - 1})` : '';
  return `${base}. Warning: ${r.warnings[0]}${extra}`;
}

/** Imports the pasted snapshot. Errors become a toast (they never propagate). */
export async function pasteSnapshot(text: string): Promise<void> {
  const payload = decodeClipboard(text);
  if (!payload) {
    ui.toast('Invalid snapshot or unsupported version', 'error');
    return;
  }
  const docId = useDoc.getState().activeDocId;
  if (!docId) {
    ui.toast('No document open', 'error');
    return;
  }
  const c = canvasApi.viewportCenter();
  try {
    const result = await postSnapshot({
      payload,
      docId,
      ...(currentPageId() ? { pageId: currentPageId()! } : {}),
      x: Math.round(c.x - (payload.width || 0) / 2),
      y: Math.round(c.y - (payload.height || 0) / 2),
    });
    await selectImported(result.frameId);
    ui.toast(importToastText(result));
  } catch (e) {
    ui.toast(e instanceof Error ? e.message : String(e), 'error');
  }
}
