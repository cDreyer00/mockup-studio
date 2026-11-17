/**
 * Modelo de pontos âncora (caneta e edição de pontos): cada âncora tem posição e alças Bézier
 * absolutas opcionais (`in` = alça que chega, `out` = alça que sai).
 */
import { parsePathData, serializePathData } from './path.js';
import type { PathCommand } from './path.js';

export interface VectorPoint {
  x: number;
  y: number;
}

export interface PathAnchor {
  x: number;
  y: number;
  /** Alça de entrada (controle do segmento que chega nesta âncora). Ausente = canto. */
  in?: VectorPoint;
  /** Alça de saída (controle do segmento que sai desta âncora). Ausente = canto. */
  out?: VectorPoint;
}

export interface Subpath {
  anchors: PathAnchor[];
  closed: boolean;
}

const EPS = 1e-9;
const samePoint = (a: VectorPoint, b: VectorPoint): boolean =>
  Math.abs(a.x - b.x) < EPS && Math.abs(a.y - b.y) < EPS;

/**
 * Converte `d` em subpaths de âncoras. Segmentos retos viram âncoras sem alças; C vira alças;
 * Q é elevado a cúbica. Num subpath fechado, o último ponto igual ao primeiro é fundido.
 */
export function pathToSubpaths(d: string): Subpath[] {
  const subpaths: Subpath[] = [];
  let cur: Subpath | null = null;
  let last: PathAnchor | null = null;
  let px = 0;
  let py = 0;

  const addCurve = (c1: VectorPoint, c2: VectorPoint, x: number, y: number): void => {
    if (!cur || !last) return;
    if (!samePoint(c1, last)) last.out = { x: c1.x, y: c1.y };
    const a: PathAnchor = { x, y };
    if (!samePoint(c2, a)) a.in = { x: c2.x, y: c2.y };
    cur.anchors.push(a);
    last = a;
  };

  for (const c of parsePathData(d)) {
    switch (c.type) {
      case 'M':
        last = { x: c.x, y: c.y };
        cur = { anchors: [last], closed: false };
        subpaths.push(cur);
        px = c.x;
        py = c.y;
        break;
      case 'L': {
        if (!cur) break;
        const a: PathAnchor = { x: c.x, y: c.y };
        cur.anchors.push(a);
        last = a;
        px = c.x;
        py = c.y;
        break;
      }
      case 'C':
        addCurve({ x: c.x1, y: c.y1 }, { x: c.x2, y: c.y2 }, c.x, c.y);
        px = c.x;
        py = c.y;
        break;
      case 'Q':
        // quadrática elevada a cúbica
        addCurve(
          { x: px + (2 / 3) * (c.x1 - px), y: py + (2 / 3) * (c.y1 - py) },
          { x: c.x + (2 / 3) * (c.x1 - c.x), y: c.y + (2 / 3) * (c.y1 - c.y) },
          c.x,
          c.y,
        );
        px = c.x;
        py = c.y;
        break;
      case 'Z': {
        if (!cur) break;
        cur.closed = true;
        const first = cur.anchors[0]!;
        const end = cur.anchors[cur.anchors.length - 1]!;
        if (cur.anchors.length > 1 && samePoint(first, end)) {
          // o último ponto repete o primeiro: funde (a alça de entrada vira a do primeiro)
          if (end.in) first.in = end.in;
          cur.anchors.pop();
        }
        px = first.x;
        py = first.y;
        cur = null;
        last = null;
        break;
      }
    }
  }
  return subpaths;
}

/**
 * Converte subpaths em `d`: segmento sem alças (out da origem e in do destino ausentes) = L,
 * senão C (alça ausente = o próprio ponto). Fechado termina com o segmento de volta e Z.
 */
export function subpathsToPath(subpaths: Subpath[], precision = 3): string {
  const cmds: PathCommand[] = [];
  const segment = (a: PathAnchor, b: PathAnchor): PathCommand =>
    a.out || b.in
      ? {
          type: 'C',
          x1: (a.out ?? a).x,
          y1: (a.out ?? a).y,
          x2: (b.in ?? b).x,
          y2: (b.in ?? b).y,
          x: b.x,
          y: b.y,
        }
      : { type: 'L', x: b.x, y: b.y };

  for (const sp of subpaths) {
    const list = sp.anchors;
    if (list.length === 0) continue;
    cmds.push({ type: 'M', x: list[0]!.x, y: list[0]!.y });
    for (let i = 1; i < list.length; i++) cmds.push(segment(list[i - 1]!, list[i]!));
    if (sp.closed) {
      if (list.length > 1) cmds.push(segment(list[list.length - 1]!, list[0]!));
      cmds.push({ type: 'Z' });
    }
  }
  return serializePathData(cmds, precision);
}
