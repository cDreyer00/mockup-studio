/**
 * API da página de render (`window.__mockupRender`), usada pelo processo principal do app desktop
 * para screenshots fiéis e para `get_layout`. Não conecta ao daemon: recebe o documento pronto.
 */
import { createElement } from 'react';
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import type {
  Document,
  LayoutGrid,
  LayoutNode,
  LayoutRect,
  LayoutStyle,
  LayoutTextLine,
  Node,
  RenderBox,
} from '@mockup/core';
import { fxClock } from '../fx/clock';
import { fxRenderInfo, fxSettled } from '../fx/ready';
import { RenderApp, renderFrameOf } from './RenderApp';
import {
  LAYOUT_STYLE_PROPS,
  fitLineBox,
  groupLines,
  measureGridTracks,
  pickFrame,
} from './measure';
import type { CharBox } from './measure';

export interface RenderPayload {
  doc: Document;
  docId: string;
  nodeId: string;
  transparent?: boolean;
  /** Instante da animação (s). Sem isso: tempo 0 (e vídeo com poster mostra o poster). */
  time?: number;
}

export interface MockupRenderApi {
  render(payload: RenderPayload): Promise<RenderBox>;
  measure(nodeId: string): LayoutNode;
  /** Muda o tempo do frame já renderizado e espera as animações desenharem (captura de N quadros). */
  setTime(t: number): Promise<void>;
}

declare global {
  interface Window {
    __mockupRenderReady?: boolean;
    __mockupRender?: MockupRenderApi;
  }
}

const ASSET_TIMEOUT_MS = 5000;
const DEFAULT_PAGE_BG = '#0f1115';

const raf = (): Promise<void> => new Promise((r) => requestAnimationFrame(() => r()));
const FX_TIMEOUT_MS = 10000;
const timeout = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const esc = (id: string): string => `[data-node-id="${id.replace(/["\\]/g, '\\$&')}"]`;

/** Espera a imagem carregar e decodificar (com limite de tempo; erro não trava). */
async function imageReady(img: HTMLImageElement): Promise<void> {
  const work = (async () => {
    if (!img.complete) {
      await new Promise<void>((resolve) => {
        img.addEventListener('load', () => resolve(), { once: true });
        img.addEventListener('error', () => resolve(), { once: true });
      });
    }
    try {
      await img.decode();
    } catch {
      /* imagem quebrada: segue */
    }
  })();
  await Promise.race([work, timeout(ASSET_TIMEOUT_MS)]);
}

function rectIn(el: Element, origin: DOMRect) {
  const r = el.getBoundingClientRect();
  return { x: r.left - origin.left, y: r.top - origin.top, width: r.width, height: r.height };
}

let ctx2d: CanvasRenderingContext2D | null | undefined;
/** Ascent/descent da fonte do elemento (métrica da fonte, não do texto). */
function fontMetrics(cs: CSSStyleDeclaration): { ascent: number; descent: number } {
  const size = parseFloat(cs.fontSize) || 16;
  try {
    if (ctx2d === undefined) ctx2d = document.createElement('canvas').getContext('2d');
    if (ctx2d) {
      ctx2d.font = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
      const m = ctx2d.measureText('Hg');
      if (m.fontBoundingBoxAscent !== undefined && m.fontBoundingBoxDescent !== undefined)
        return { ascent: m.fontBoundingBoxAscent, descent: m.fontBoundingBoxDescent };
    }
  } catch {
    /* sem canvas: aproxima */
  }
  return { ascent: size * 0.8, descent: size * 0.2 };
}

function textLines(el: HTMLElement, origin: DOMRect): LayoutTextLine[] {
  const cs = getComputedStyle(el);
  const chars: CharBox[] = [];
  const range = document.createRange();
  for (const child of Array.from(el.childNodes)) {
    if (child.nodeType !== 3) continue;
    const text = child.textContent ?? '';
    for (let i = 0; i < text.length; i++) {
      range.setStart(child, i);
      range.setEnd(child, i + 1);
      const rect = range.getClientRects()[0];
      if (!rect) continue;
      chars.push({
        ch: text[i]!,
        x: rect.left - origin.left,
        y: rect.top - origin.top,
        width: rect.width,
        height: rect.height,
      });
    }
  }
  const metrics = fontMetrics(cs);
  const lhRaw = parseFloat(cs.lineHeight);
  const lineHeight = Number.isFinite(lhRaw) ? lhRaw : null;
  return groupLines(chars).map((l) => {
    const fit = fitLineBox(l, metrics, lineHeight);
    return {
      text: l.text,
      x: l.x,
      y: fit.y,
      width: l.width,
      height: fit.height,
      baseline: fit.baseline,
    };
  });
}

function readStyle(el: Element): LayoutStyle {
  const cs = getComputedStyle(el);
  const out: LayoutStyle = {};
  for (const p of LAYOUT_STYLE_PROPS) out[p] = cs.getPropertyValue(p);
  return out;
}

/** Trilhas do nó quando ele é um contêiner grid (valores resolvidos do navegador, em px). */
function gridOf(el: Element, rect: LayoutRect): LayoutGrid | undefined {
  const cs = getComputedStyle(el);
  return measureGridTracks(
    {
      display: cs.display,
      gridTemplateColumns: cs.gridTemplateColumns,
      gridTemplateRows: cs.gridTemplateRows,
      columnGap: cs.columnGap,
      rowGap: cs.rowGap,
      borderLeftWidth: cs.borderLeftWidth,
      borderTopWidth: cs.borderTopWidth,
      paddingLeft: cs.paddingLeft,
      paddingTop: cs.paddingTop,
    },
    rect,
  );
}

function findNode(n: Node, id: string): Node | null {
  if (n.id === id) return n;
  for (const c of n.children ?? []) {
    const r = findNode(c, id);
    if (r) return r;
  }
  return null;
}

/** Primeiro nó oculto no caminho do frame (exclusive) até `id` (inclusive), ou null. */
function hiddenOnPath(root: Node, id: string): Node | null {
  const walk = (n: Node, hiddenAbove: Node | null): Node | null | undefined => {
    const h = hiddenAbove ?? (n !== root && n.hidden ? n : null);
    if (n.id === id) return h;
    for (const c of n.children ?? []) {
      const r = walk(c, h);
      if (r !== undefined) return r;
    }
    return undefined;
  };
  return walk(root, null) ?? null;
}

function assertVisible(frame: Node, id: string): void {
  const h = hiddenOnPath(frame, id);
  if (!h) return;
  const quem =
    h.id === id
      ? `O nó "${id}" está oculto (hidden)`
      : `O nó "${id}" está dentro de "${h.id}", que está oculto (hidden)`;
  throw new Error(`${quem}; mostre-o com set_node_flags ou capture outro nó.`);
}

interface Last {
  world: HTMLElement;
  frameEl: HTMLElement;
  frame: Node;
}

/** Instala `window.__mockupRender` montando o React em `container`. */
export function installRenderApi(container: HTMLElement): MockupRenderApi {
  let root: Root | null = null;
  let last: Last | null = null;

  const api: MockupRenderApi = {
    async render({ doc, docId, nodeId, transparent, time }) {
      const picked = pickFrame(doc, nodeId);
      if (!picked) throw new Error(`Nó não encontrado no documento: ${nodeId}`);
      const frame = renderFrameOf(picked.frame);
      assertVisible(frame, nodeId);

      const bg = transparent ? 'transparent' : picked.background || DEFAULT_PAGE_BG;
      for (const el of [document.documentElement, document.body]) {
        el.style.background = bg;
        el.style.margin = '0';
        el.style.overflow = 'hidden';
      }
      // Sem fundo: evita que o `color-scheme: dark` do tema pinte a tela por baixo do frame.
      document.documentElement.style.colorScheme = transparent ? 'normal' : '';

      // Animações em tempo manual (determinístico); `time` explícito é lembrado (regra do poster).
      fxRenderInfo.explicitTime = time !== undefined;
      fxClock.setManual(time ?? 0);

      root ??= createRoot(container);
      flushSync(() => root!.render(createElement(RenderApp, { doc, docId, frame })));

      const world = container.firstElementChild as HTMLElement | null;
      const frameEl = world?.querySelector<HTMLElement>(esc(frame.id));
      if (!world || !frameEl) throw new Error(`Falha ao renderizar o frame ${frame.id}`);
      last = { world, frameEl, frame };

      void frameEl.getBoundingClientRect(); // força o layout, que dispara o carregamento das fontes
      await document.fonts?.ready;
      await Promise.all(Array.from(world.querySelectorAll('img')).map(imageReady));
      await document.fonts?.ready;
      await fxSettled(FX_TIMEOUT_MS);
      await raf();
      await raf();

      const fr = frameEl.getBoundingClientRect();
      const target = world.querySelector(esc(nodeId));
      const box = target ? rectIn(target, fr) : { x: 0, y: 0, width: fr.width, height: fr.height };
      return {
        frameId: frame.id,
        frameWidth: Math.ceil(fr.width),
        frameHeight: Math.ceil(fr.height),
        ...box,
      };
    },

    async setTime(t) {
      if (!last) throw new Error('Nada foi renderizado ainda: chame render() antes de setTime().');
      fxRenderInfo.explicitTime = true;
      fxClock.setManual(t);
      await raf(); // deixa as views reagirem ao novo tempo e registrarem pendências
      await fxSettled(FX_TIMEOUT_MS);
      await raf();
      await raf();
    },

    measure(nodeId) {
      if (!last) throw new Error('Nada foi renderizado ainda: chame render() antes de measure().');
      const { world, frameEl, frame } = last;
      const node = findNode(frame, nodeId);
      if (!node) throw new Error(`O nó ${nodeId} não está no último render (frame ${frame.id}).`);
      assertVisible(frame, nodeId);
      const origin = frameEl.getBoundingClientRect();

      const build = (n: Node): LayoutNode | null => {
        const el = world.querySelector<HTMLElement>(esc(n.id));
        if (!el) return null;
        const out: LayoutNode = {
          id: n.id,
          name: n.name,
          type: n.type,
          tag: n.tag,
          ...rectIn(el, origin),
          style: readStyle(el),
          children: [],
        };
        if (n.type === 'text') out.lines = textLines(el, origin);
        const grid = gridOf(el, out);
        if (grid) out.grid = grid;
        if (n.type === 'image' && n.src) out.src = n.src;
        // effect/video/embed são caixas: sem linhas de texto.
        for (const c of n.children ?? []) {
          if (c.hidden) continue;
          const m = build(c);
          if (m) out.children.push(m);
        }
        return out;
      };
      const result = build(node);
      if (!result) throw new Error(`O nó ${nodeId} não foi renderizado (oculto?).`);
      return result;
    },
  };
  window.__mockupRender = api;
  window.__mockupRenderReady = true;
  return api;
}
