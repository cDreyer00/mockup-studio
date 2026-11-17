/**
 * Service worker: injeta o seletor na aba, tira o screenshot de referência e envia o snapshot ao
 * daemon do Mockup Studio (POST /api/snapshot). Nenhum dado sai da máquina além disso.
 */
import type { SnapshotImportResult } from '@mockup/snapshot-core';

export type PickerMode = 'send' | 'copy';

export interface StartOptions {
  mode: PickerMode;
  port: number;
}

/** Injeta o content script na aba e inicia o seletor de seção. */
export async function startPicker(tabId: number, opts: StartOptions): Promise<void> {
  await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
  await chrome.tabs.sendMessage(tabId, { type: 'start', mode: opts.mode, port: opts.port });
}

// Exposto para o teste e2e (o Playwright não clica no ícone da barra).
(globalThis as unknown as { __mockupStartPicker: typeof startPicker }).__mockupStartPicker =
  startPicker;

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

function bytesToBase64(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}

/** Screenshot da aba recortado no retângulo (px CSS da viewport), limitado à parte visível. */
async function captureReference(
  windowId: number,
  rect: Rect,
  viewport: { width: number; height: number },
): Promise<{ dataUrl: string; width: number; height: number } | null> {
  const x0 = Math.max(0, rect.x);
  const y0 = Math.max(0, rect.y);
  const x1 = Math.min(viewport.width, rect.x + rect.width);
  const y1 = Math.min(viewport.height, rect.y + rect.height);
  if (x1 - x0 < 1 || y1 - y0 < 1) return null;

  const shot = await chrome.tabs.captureVisibleTab(windowId, { format: 'png' });
  const bitmap = await createImageBitmap(await (await fetch(shot)).blob());
  const scale = bitmap.width / viewport.width;
  const sw = Math.max(1, Math.round((x1 - x0) * scale));
  const sh = Math.max(1, Math.round((y1 - y0) * scale));
  const canvas = new OffscreenCanvas(sw, sh);
  const ctx = canvas.getContext('2d')!;
  ctx.drawImage(bitmap, Math.round(x0 * scale), Math.round(y0 * scale), sw, sh, 0, 0, sw, sh);
  bitmap.close();
  const blob = await canvas.convertToBlob({ type: 'image/png' });
  const b64 = bytesToBase64(new Uint8Array(await blob.arrayBuffer()));
  return { dataUrl: `data:image/png;base64,${b64}`, width: x1 - x0, height: y1 - y0 };
}

async function sendToApp(
  port: number,
  payload: unknown,
): Promise<{ ok: true; nodes: number } | { ok: false; error: string }> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/snapshot`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ payload }),
    });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    const result = (await res.json()) as SnapshotImportResult;
    return { ok: true, nodes: result.nodes };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const respond = (p: Promise<unknown>) => {
    p.then(sendResponse, (err) =>
      sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err) }),
    );
    return true; // resposta assíncrona
  };
  switch (message?.type) {
    case 'popup-start':
      return respond(
        startPicker(message.tabId, { mode: message.mode, port: message.port }).then(() => ({
          ok: true,
        })),
      );
    case 'screenshot':
      if (!sender.tab) return false;
      return respond(
        captureReference(sender.tab.windowId, message.rect, message.viewport).then((reference) => ({
          ok: true,
          reference,
        })),
      );
    case 'send':
      return respond(sendToApp(message.port, message.payload));
    default:
      return false;
  }
});
