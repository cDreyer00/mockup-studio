/**
 * Content script (IIFE): section picker with a hover overlay, capture via `captureElement` and
 * delivery (send to the app through the service worker or copy to the clipboard). Overlay and toasts live
 * in a closed shadow root so they do not inherit the page's CSS.
 */
import { captureElement } from '@mockup/snapshot-core/browser';
import { encodeClipboard, type SnapshotPayload } from '@mockup/snapshot-core';

type Mode = 'send' | 'copy';

const MiB = 1024 * 1024;
/** Sum of the data URLs embedded in the capture (characters); below the core's default limit. */
const MAX_INLINE_TOTAL = 32 * MiB;
/** Safe limit for the JSON sent to the service worker (Chrome rejects messages above ~64 MiB). */
const MAX_MESSAGE = 48 * MiB;

const TOO_BIG_TEXT =
  'The section is too large to send to Mockup Studio. Select a smaller section (↑/↓ adjust the element).';

/** Service worker response to `send` (see `SendResult` in background.ts). */
type SendResponse =
  | { ok: true; nodes: number }
  | { ok: false; kind: 'offline'; error: string }
  | { ok: false; kind: 'http'; status: number; error: string };

/**
 * Payload that fits in `MAX_MESSAGE` (measured by the message JSON, in characters): drops the
 * reference if it alone overflows and, if still over, removes the `dataUrl` of the largest assets (the
 * daemon tries to download them by URL). Returns `null` if it still does not fit. The original payload is not
 * modified (it serves the copy fallback).
 */
function fitMessage(payload: SnapshotPayload): SnapshotPayload | null {
  let size = JSON.stringify({ type: 'send', payload }).length;
  if (size <= MAX_MESSAGE) return payload;
  const out: SnapshotPayload = {
    ...payload,
    assets: payload.assets.map((a) => ({ ...a })),
    stats: { ...payload.stats, warnings: [...payload.stats.warnings] },
  };
  if (out.reference && out.reference.dataUrl.length > MAX_MESSAGE / 2) {
    size -= out.reference.dataUrl.length;
    delete out.reference;
    out.stats.warnings.push('The reference image was too large to send and was removed.');
  }
  const dropped: string[] = [];
  const bySize = out.assets
    .filter((a) => a.dataUrl)
    .sort((a, b) => b.dataUrl!.length - a.dataUrl!.length);
  for (const a of bySize) {
    if (size <= MAX_MESSAGE) break;
    size -= a.dataUrl!.length;
    delete a.dataUrl;
    dropped.push(a.url.slice(0, 120));
  }
  if (dropped.length) {
    out.stats.warnings.push(
      `${dropped.length} larger asset(s) were sent by URL only (the capture exceeded the send limit); the app tries to download them: ${dropped.slice(0, 5).join(', ')}`,
    );
  }
  return size <= MAX_MESSAGE ? out : null;
}

/** Does the `chrome.runtime.sendMessage` error indicate a message that is too large? */
const isTooLarge = (err: unknown): boolean =>
  /length|too large|exceed|size/i.test(err instanceof Error ? err.message : String(err));

const FLAG = '__mockupPickerInstalled';
const w = window as unknown as Record<string, unknown>;

if (!w[FLAG]) {
  w[FLAG] = true;
  install();
}

function install(): void {
  let active: { stop: () => void } | null = null;

  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type === 'start') {
      active?.stop();
      active = startPicker(
        message.mode === 'copy' ? 'copy' : 'send',
        Number(message.port) || 4747,
        () => {
          active = null;
        },
      );
    }
  });
}

const OVERLAY_CSS = `
  :host { all: initial; }
  .box { position: fixed; box-sizing: border-box; border: 2px solid #4f46e5; background: rgba(79,70,229,.12); pointer-events: none; display: none; }
  .label { position: fixed; pointer-events: none; display: none; background: #4f46e5; color: #fff; font: 600 11px/1.3 ui-monospace, Menlo, Consolas, monospace; padding: 2px 6px; border-radius: 3px; white-space: nowrap; max-width: 80vw; overflow: hidden; text-overflow: ellipsis; }
  .toast { position: fixed; right: 16px; bottom: 16px; max-width: 360px; background: #1f2937; color: #fff; font: 13px/1.4 system-ui, sans-serif; padding: 10px 14px; border-radius: 8px; box-shadow: 0 6px 24px rgba(0,0,0,.3); pointer-events: none; }
  .toast[data-kind='error'] { background: #991b1b; }
`;

function makeHost(): { host: HTMLElement; root: ShadowRoot } {
  const host = document.createElement('div');
  host.style.cssText = 'all:initial;position:fixed;inset:0;z-index:2147483647;pointer-events:none;';
  const root = host.attachShadow({ mode: 'closed' });
  const style = document.createElement('style');
  style.textContent = OVERLAY_CSS;
  root.append(style);
  (document.documentElement || document.body).append(host);
  return { host, root };
}

function toast(text: string, kind: 'ok' | 'error' = 'ok'): void {
  const { host, root } = makeHost();
  const el = document.createElement('div');
  el.className = 'toast';
  el.dataset.kind = kind;
  el.textContent = text;
  root.append(el);
  setTimeout(() => host.remove(), 4000);
}

function describe(el: Element): string {
  const classes = Array.from(el.classList).slice(0, 3);
  const r = el.getBoundingClientRect();
  const cls = classes.length ? '.' + classes.join('.') : '';
  return `${el.tagName.toLowerCase()}${cls}  ${Math.round(r.width)}×${Math.round(r.height)}`;
}

async function writeClipboard(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    return;
  } catch {
    /* falls back */
  }
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0;pointer-events:none;';
  document.body.append(ta);
  ta.select();
  const ok = document.execCommand('copy');
  ta.remove();
  if (!ok) throw new Error('Could not copy to the clipboard.');
}

const nextFrame = () => new Promise<void>((r) => requestAnimationFrame(() => r()));

function startPicker(mode: Mode, port: number, onDone: () => void): { stop: () => void } {
  const { host, root } = makeHost();
  const box = document.createElement('div');
  box.className = 'box';
  const label = document.createElement('div');
  label.className = 'label';
  root.append(box, label);

  let current: Element | null = null;
  /** Children already "climbed" with ↑, so ↓ goes back along the same path. */
  let trail: Element[] = [];
  let busy = false;

  const isOurs = (el: Element | null) => !el || el === host;

  function paint(): void {
    if (!current || !current.isConnected) {
      box.style.display = label.style.display = 'none';
      return;
    }
    const r = current.getBoundingClientRect();
    box.style.cssText = `display:block;left:${r.left}px;top:${r.top}px;width:${r.width}px;height:${r.height}px;`;
    label.textContent = describe(current);
    label.style.display = 'block';
    const top = r.top >= 22 ? r.top - 22 : r.top + 2;
    label.style.top = `${top}px`;
    label.style.left = `${Math.max(0, Math.min(r.left, window.innerWidth - 120))}px`;
  }

  function setCurrent(el: Element | null, resetTrail: boolean): void {
    current = el;
    if (resetTrail) trail = [];
    paint();
  }

  const onMove = (e: MouseEvent) => {
    if (busy) return;
    const el = document.elementFromPoint(e.clientX, e.clientY);
    if (isOurs(el) || el === current) return;
    setCurrent(el, true);
  };

  const block = (e: Event) => {
    if (busy) return;
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();
  };

  const onKey = (e: KeyboardEvent) => {
    if (busy) return;
    if (e.key === 'Escape') {
      block(e);
      stop();
    } else if (e.key === 'ArrowUp' && current) {
      block(e);
      const parent = current.parentElement;
      if (parent && parent !== document.documentElement) {
        trail.push(current);
        setCurrent(parent, false);
      }
    } else if (e.key === 'ArrowDown' && current) {
      block(e);
      const child = trail.pop();
      if (child) setCurrent(child, false);
    }
  };

  const onClick = (e: MouseEvent) => {
    if (busy) return;
    block(e);
    const target = current ?? document.elementFromPoint(e.clientX, e.clientY);
    if (!target || isOurs(target)) return;
    void capture(target);
  };

  async function capture(target: Element): Promise<void> {
    busy = true;
    detach();
    host.remove();
    try {
      await nextFrame();
      await nextFrame();
      const rect = target.getBoundingClientRect();
      const payload = await captureElement(target, { maxInlineTotalBytes: MAX_INLINE_TOTAL });
      try {
        const res = await chrome.runtime.sendMessage({
          type: 'screenshot',
          rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
          viewport: { width: window.innerWidth, height: window.innerHeight },
        });
        if (res?.reference) payload.reference = res.reference;
        if (res?.clipped) {
          const ref = res.reference as { width: number; height: number } | null | undefined;
          const full = `${Math.round(res.full.width)}x${Math.round(res.full.height)}`;
          payload.stats.warnings.push(
            ref
              ? `The reference image covers only the visible part of the section (${Math.round(ref.width)}x${Math.round(ref.height)} of ${full} px); scroll the page or use import_url to capture it entirely.`
              : `The section (${full} px) is outside the visible part of the page: no reference image; scroll the page or use import_url to capture it entirely.`,
          );
        }
      } catch {
        /* the reference is optional */
      }

      if (mode === 'copy') {
        await writeClipboard(encodeClipboard(payload));
        toast('Copied: paste into the editor with Ctrl+V');
        return;
      }

      const toSend = fitMessage(payload);
      if (!toSend) {
        toast(TOO_BIG_TEXT, 'error');
        return;
      }
      let res: SendResponse | undefined;
      try {
        res = await chrome.runtime.sendMessage({ type: 'send', port, payload: toSend });
      } catch (err) {
        if (isTooLarge(err)) {
          toast(TOO_BIG_TEXT, 'error');
          return;
        }
        res = undefined; // no response from the service worker: treat as the app being down
      }
      if (res?.ok) {
        const trimmed = toSend.stats.warnings.length > payload.stats.warnings.length;
        toast(`Sent to Mockup Studio (${res.nodes} nodes)${trimmed ? ': see the warnings' : ''}`);
      } else if (res && res.kind === 'http') {
        const detail = res.error ? `: ${res.error}` : '';
        toast(`Mockup Studio rejected the upload (HTTP ${res.status})${detail}`, 'error');
      } else {
        await writeClipboard(encodeClipboard(payload));
        toast('Mockup Studio did not respond: copied, paste into the editor with Ctrl+V');
      }
    } catch (err) {
      toast(`Capture failed: ${err instanceof Error ? err.message : String(err)}`, 'error');
    } finally {
      onDone();
    }
  }

  function detach(): void {
    window.removeEventListener('mousemove', onMove, true);
    window.removeEventListener('keydown', onKey, true);
    window.removeEventListener('click', onClick, true);
    for (const t of [
      'mousedown',
      'mouseup',
      'pointerdown',
      'pointerup',
      'auxclick',
      'dblclick',
      'contextmenu',
    ] as const) {
      window.removeEventListener(t, block, true);
    }
    window.removeEventListener('scroll', paint, true);
    window.removeEventListener('resize', paint, true);
  }

  function stop(): void {
    detach();
    host.remove();
    onDone();
  }

  window.addEventListener('mousemove', onMove, true);
  window.addEventListener('keydown', onKey, true);
  window.addEventListener('click', onClick, true);
  // Prevents the page from reacting to the selection click (navigation, menus, drag).
  for (const t of [
    'mousedown',
    'mouseup',
    'pointerdown',
    'pointerup',
    'auxclick',
    'dblclick',
    'contextmenu',
  ] as const) {
    window.addEventListener(t, block, true);
  }
  window.addEventListener('scroll', paint, true);
  window.addEventListener('resize', paint, true);

  return { stop };
}
