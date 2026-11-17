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

interface ReferenceResult {
  reference: { dataUrl: string; width: number; height: number } | null;
  /** O retângulo passa da viewport (algum lado): a imagem cobre só a parte visível. */
  clipped: boolean;
  /** Tamanho do retângulo inteiro da seção (px CSS). */
  full: { width: number; height: number };
}

/** Screenshot da aba recortado no retângulo (px CSS da viewport), limitado à parte visível. */
async function captureReference(
  windowId: number,
  rect: Rect,
  viewport: { width: number; height: number },
): Promise<ReferenceResult> {
  const x0 = Math.max(0, rect.x);
  const y0 = Math.max(0, rect.y);
  const x1 = Math.min(viewport.width, rect.x + rect.width);
  const y1 = Math.min(viewport.height, rect.y + rect.height);
  const full = { width: rect.width, height: rect.height };
  // Meio pixel de folga: arredondamento de layout não conta como recorte.
  const clipped =
    rect.x < -0.5 ||
    rect.y < -0.5 ||
    rect.x + rect.width > viewport.width + 0.5 ||
    rect.y + rect.height > viewport.height + 0.5;
  if (x1 - x0 < 1 || y1 - y0 < 1) return { reference: null, clipped, full };

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
  // width/height da referência são o recorte visível (px CSS), coerentes com a imagem.
  const reference = { dataUrl: `data:image/png;base64,${b64}`, width: x1 - x0, height: y1 - y0 };
  return { reference, clipped, full };
}

/**
 * Resultado do envio ao daemon. `offline`: nada respondeu (fetch falhou); `http`: o daemon
 * respondeu com erro (`error` = mensagem do corpo `{ error }`, se houver).
 */
export type SendResult =
  | { ok: true; nodes: number }
  | { ok: false; kind: 'offline'; error: string }
  | { ok: false; kind: 'http'; status: number; error: string };

async function sendToApp(port: number, payload: unknown): Promise<SendResult> {
  let res: Response;
  try {
    res = await fetch(`http://127.0.0.1:${port}/api/snapshot`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ payload }),
    });
  } catch (err) {
    return { ok: false, kind: 'offline', error: err instanceof Error ? err.message : String(err) };
  }
  if (!res.ok) {
    let error = '';
    try {
      const body = (await res.json()) as { error?: unknown };
      if (typeof body.error === 'string') error = body.error;
    } catch {
      /* corpo sem JSON */
    }
    return { ok: false, kind: 'http', status: res.status, error };
  }
  try {
    const result = (await res.json()) as SnapshotImportResult;
    return { ok: true, nodes: result.nodes };
  } catch {
    return { ok: false, kind: 'http', status: res.status, error: 'resposta inválida do app' };
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
        captureReference(sender.tab.windowId, message.rect, message.viewport).then((r) => ({
          ok: true,
          ...r,
        })),
      );
    case 'send':
      return respond(sendToApp(message.port, message.payload));
    default:
      return false;
  }
});
