/**
 * Content script (IIFE): seletor de seção com overlay de hover, captura via `captureElement` e
 * entrega (enviar ao app pelo service worker ou copiar para o clipboard). Overlay e toasts vivem
 * num shadow root fechado para não herdar CSS da página.
 */
import { captureElement } from '@mockup/snapshot-core/browser';
import { encodeClipboard } from '@mockup/snapshot-core';

type Mode = 'send' | 'copy';

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
      active = startPicker(message.mode === 'copy' ? 'copy' : 'send', Number(message.port) || 4747, () => {
        active = null;
      });
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
  host.style.cssText =
    'all:initial;position:fixed;inset:0;z-index:2147483647;pointer-events:none;';
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
    /* cai no fallback */
  }
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0;pointer-events:none;';
  document.body.append(ta);
  ta.select();
  const ok = document.execCommand('copy');
  ta.remove();
  if (!ok) throw new Error('Não foi possível copiar para o clipboard.');
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
  /** Filhos já "subidos" com ↑, para ↓ voltar pelo mesmo caminho. */
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
      const payload = await captureElement(target);
      try {
        const res = await chrome.runtime.sendMessage({
          type: 'screenshot',
          rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
          viewport: { width: window.innerWidth, height: window.innerHeight },
        });
        if (res?.reference) payload.reference = res.reference;
      } catch {
        /* a referência é opcional */
      }

      if (mode === 'copy') {
        await writeClipboard(encodeClipboard(payload));
        toast('Copiado: cole no editor com Ctrl+V');
        return;
      }
      const res = await chrome.runtime.sendMessage({ type: 'send', port, payload });
      if (res?.ok) {
        toast(`Enviado ao Mockup Studio (${res.nodes} nós)`);
      } else {
        await writeClipboard(encodeClipboard(payload));
        toast('Mockup Studio não respondeu: copiado, cole no editor com Ctrl+V');
      }
    } catch (err) {
      toast(`Falha na captura: ${err instanceof Error ? err.message : String(err)}`, 'error');
    } finally {
      onDone();
    }
  }

  function detach(): void {
    window.removeEventListener('mousemove', onMove, true);
    window.removeEventListener('keydown', onKey, true);
    window.removeEventListener('click', onClick, true);
    for (const t of ['mousedown', 'mouseup', 'pointerdown', 'pointerup', 'auxclick', 'dblclick', 'contextmenu'] as const) {
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
  // Evita que a página reaja ao clique de seleção (navegação, menus, drag).
  for (const t of ['mousedown', 'mouseup', 'pointerdown', 'pointerup', 'auxclick', 'dblclick', 'contextmenu'] as const) {
    window.addEventListener(t, block, true);
  }
  window.addEventListener('scroll', paint, true);
  window.addEventListener('resize', paint, true);

  return { stop };
}
