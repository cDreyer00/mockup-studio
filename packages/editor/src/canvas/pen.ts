/**
 * Máquina da ferramenta Caneta (lógica pura, sem DOM): âncoras em coordenadas do mundo, alças
 * Bézier simétricas ao arrastar, fechamento, remoção da última âncora e montagem do nó svg.
 * O desenho ao vivo (`PenOverlay`) e os eventos de ponteiro (`penTool`) ficam em outros módulos.
 */
import { createVectorNode, fitVectorToContent, subpathsToPath } from '@mockup/core';
import type { Node, PathAnchor, Subpath, Vector } from '@mockup/core';
import type { Point } from './geometry';

export interface PenState {
  anchors: PathAnchor[];
  closed: boolean;
}

export const PEN_EMPTY: PenState = { anchors: [], closed: false };

/** Raio (px de tela) em volta da primeira âncora que fecha o caminho. */
export const PEN_CLOSE_RADIUS = 8;
/** Deslocamento mínimo (px de tela) para um clique virar arrasto de alças. */
export const PEN_DRAG_THRESHOLD = 3;
/** Distância mínima (px de tela) para aceitar uma âncora nova (ignora o 2º clique de um duplo clique). */
export const PEN_MIN_GAP = 2;

/** Tinta padrão do caminho: traço #111111 de 2 px; fechado ganha preenchimento #d9d9d9. */
export const PEN_STROKE = '#111111';
export const PEN_STROKE_WIDTH = 2;
export const PEN_FILL = '#d9d9d9';

const dist = (a: Point, b: Point): number => Math.hypot(a.x - b.x, a.y - b.y);

/** Leva `to` ao múltiplo de 45° mais próximo (em torno de `from`), preservando o comprimento. */
export function constrainAngle(from: Point, to: Point): Point {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const len = Math.hypot(dx, dy);
  if (len === 0) return { ...to };
  const step = Math.PI / 4;
  const a = Math.round(Math.atan2(dy, dx) / step) * step;
  return { x: from.x + Math.cos(a) * len, y: from.y + Math.sin(a) * len };
}

/**
 * Acrescenta uma âncora reta. Ignora o ponto se o caminho já está fechado ou se ele cai a menos de
 * `minGap` (mundo) da última âncora. Com `shift` o ponto é restrito a múltiplos de 45° da última.
 */
export function addAnchor(s: PenState, p: Point, opts: { minGap?: number; shift?: boolean } = {}): PenState {
  if (s.closed) return s;
  const last = s.anchors[s.anchors.length - 1];
  let at = p;
  if (last && opts.shift) at = constrainAngle(last, p);
  if (last && dist(last, at) < (opts.minGap ?? 0)) return s;
  return { ...s, anchors: [...s.anchors, { x: at.x, y: at.y }] };
}

/**
 * Arrasto logo após criar a última âncora: `out` vai para `p` e `in` para o ponto simétrico em torno
 * da âncora. Com `alt` a simetria quebra: só `out` muda (`in` fica como estava).
 */
export function dragLastHandles(s: PenState, p: Point, alt = false): PenState {
  const i = s.anchors.length - 1;
  const a = s.anchors[i];
  if (!a) return s;
  const next: PathAnchor = { x: a.x, y: a.y, out: { x: p.x, y: p.y } };
  if (a.in) next.in = a.in;
  if (!alt) next.in = { x: 2 * a.x - p.x, y: 2 * a.y - p.y };
  const anchors = s.anchors.slice();
  anchors[i] = next;
  return { ...s, anchors };
}

/** O ponto está sobre a primeira âncora (e há âncoras suficientes para fechar)? */
export function isNearFirst(s: PenState, p: Point, radius: number): boolean {
  const first = s.anchors[0];
  return !s.closed && s.anchors.length >= 2 && !!first && dist(first, p) <= radius;
}

export function closePen(s: PenState): PenState {
  return s.anchors.length >= 2 ? { ...s, closed: true } : s;
}

export function removeLastAnchor(s: PenState): PenState {
  if (s.anchors.length === 0) return s;
  return { anchors: s.anchors.slice(0, -1), closed: false };
}

/** Caminho aberto precisa de 2 âncoras; o fechado também (a máquina só fecha com 2 ou mais). */
export function canFinish(s: PenState): boolean {
  return s.anchors.length >= 2;
}

export function penSubpath(s: PenState): Subpath {
  return { anchors: s.anchors.map((a) => ({ ...a })), closed: s.closed };
}

/**
 * Path data (`M .. C/L ..`) do segmento de prévia da última âncora até `cursor`; com `closing` o
 * destino é a primeira âncora e usa a alça de entrada dela. Mesmo sistema de coordenadas das
 * âncoras de `s`. Vazio se não há âncoras ou o caminho já está fechado.
 */
export function previewSegmentD(s: PenState, cursor: Point, closing = false): string {
  const last = s.anchors[s.anchors.length - 1];
  if (!last || s.closed) return '';
  const first = s.anchors[0]!;
  const to = closing ? first : cursor;
  const c1 = last.out;
  const c2 = closing ? first.in : undefined;
  const f = (n: number): number => Math.round(n * 1000) / 1000;
  if (!c1 && !c2) return `M ${f(last.x)} ${f(last.y)} L ${f(to.x)} ${f(to.y)}`;
  const a = c1 ?? last;
  const b = c2 ?? to;
  return `M ${f(last.x)} ${f(last.y)} C ${f(a.x)} ${f(a.y)} ${f(b.x)} ${f(b.y)} ${f(to.x)} ${f(to.y)}`;
}

export function translateAnchors(anchors: PathAnchor[], dx: number, dy: number): PathAnchor[] {
  const mv = (p: Point): Point => ({ x: p.x + dx, y: p.y + dy });
  return anchors.map((a) => ({
    ...mv(a),
    ...(a.in ? { in: mv(a.in) } : {}),
    ...(a.out ? { out: mv(a.out) } : {}),
  }));
}

/**
 * Nó svg do caminho concluído. As âncoras vêm em coordenadas do mundo; `origin` é a origem do pai
 * (mundo) para convertê-las. `flow`: o nó entra no fluxo do pai (só width/height); senão fica
 * `position: absolute` em left/top. Devolve também a caixa final (no pai).
 */
export function buildPenNode(
  s: PenState,
  origin: Point,
  opts: { flow?: boolean; name?: string } = {},
): { node: Node; box: { x: number; y: number; width: number; height: number } } {
  const anchors = translateAnchors(s.anchors, -origin.x, -origin.y);
  const d = subpathsToPath([{ anchors, closed: s.closed }]);
  const draft: Vector = {
    // viewBox identidade com a caixa (escala 1): as coordenadas do caminho já são as do pai.
    viewBox: { x: 0, y: 0, width: 1, height: 1 },
    paths: [
      {
        id: 'p1',
        d,
        fill: s.closed ? PEN_FILL : 'none',
        stroke: PEN_STROKE,
        strokeWidth: PEN_STROKE_WIDTH,
      },
    ],
  };
  const fit = fitVectorToContent(draft, { x: 0, y: 0, width: 1, height: 1 });
  const num = (n: number): string => `${Math.round(n * 100) / 100}px`;
  const style: Record<string, string> = {
    width: num(fit.box.width),
    height: num(fit.box.height),
  };
  if (opts.flow) style.display = 'block';
  else {
    style.position = 'absolute';
    style.left = num(fit.box.x);
    style.top = num(fit.box.y);
  }
  const node = createVectorNode(fit.vector, { name: opts.name ?? 'Caminho', style });
  return { node, box: fit.box };
}
