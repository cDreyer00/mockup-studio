/** Colar snapshot: o texto do clipboard vira um frame no documento ativo via `POST /api/snapshot`. */
import { decodeClipboard } from '@mockup/snapshot-core';
import { canvasApi } from '../canvas/canvasApi';
import { useDoc } from '../state/docStore';
import { currentPageId } from '../state/hooks';
import { ui } from '../state/uiStore';
import { postSnapshot, selectImported } from './importApi';

/** Texto do toast de sucesso (com aviso quando a captura trouxe `warnings`). */
export function importToastText(r: { nodes: number; warnings: string[] }): string {
  const base = `Seção importada (${r.nodes} nós)`;
  if (!r.warnings.length) return base;
  const extra = r.warnings.length > 1 ? ` (+${r.warnings.length - 1})` : '';
  return `${base}. Aviso: ${r.warnings[0]}${extra}`;
}

/** Importa o snapshot colado. Erros viram toast (nunca propagam). */
export async function pasteSnapshot(text: string): Promise<void> {
  const payload = decodeClipboard(text);
  if (!payload) {
    ui.toast('Snapshot inválido ou de versão não suportada', 'error');
    return;
  }
  const docId = useDoc.getState().activeDocId;
  if (!docId) {
    ui.toast('Nenhum documento aberto', 'error');
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
