/**
 * Edição de pontos de um vetor (lógica pura): modelo de âncoras por subpath, mover âncoras e
 * alças, apagar, alternar canto/suave, inserir âncora num segmento e montar as ops de gravação.
 * Âncoras são endereçadas por `AnchorRef { s, i }`: `s` = índice do subpath em todos os paths do
 * vetor (em ordem) e `i` = índice da âncora no subpath. As coordenadas são as do viewBox.
 */
import {
  buildSetVectorOps,
  editVector,
  fitVectorToContent,
  nodeBoxInParent,
  pathToSubpaths,
  subpathsToPath,
} from '@mockup/core';
import type { Node, Op, PathAnchor, Subpath, Vector } from '@mockup/core';
import type { Point } from './geometry';

export interface EditPath {
  id: string;
  subpaths: Subpath[];
}
export interface EditModel {
  paths: EditPath[];
}
export interface AnchorRef {
  s: number;
  i: number;
}
export type HandleKind = 'in' | 'out';

export const refKey = (r: AnchorRef): string => `${r.s}-${r.i}`;
export const sameRef = (a: AnchorRef, b: AnchorRef): boolean => a.s === b.s && a.i === b.i;

/** Modelo editável do vetor (todos os paths; o `d` de cada um vira subpaths de âncoras). */
export function loadModel(v: Vector): EditModel {
  return { paths: v.paths.map((p) => ({ id: p.id, subpaths: pathToSubpaths(p.d) })) };
}

/** Todos os subpaths do modelo, em ordem (o índice é o `s` do `AnchorRef`). */
export function flatSubpaths(m: EditModel): Subpath[] {
  return m.paths.flatMap((p) => p.subpaths);
}

/** Aplica `fn` ao subpath de índice global `s`, devolvendo um modelo novo. */
function mapSubpath(m: EditModel, s: number, fn: (sp: Subpath) => Subpath | null): EditModel {
  let k = 0;
  return {
    paths: m.paths.map((p) => ({
      ...p,
      subpaths: p.subpaths.flatMap((sp) => {
        const out = k++ === s ? fn(sp) : sp;
        return out ? [out] : [];
      }),
    })),
  };
}

const shift = (p: Point, dx: number, dy: number): Point => ({ x: p.x + dx, y: p.y + dy });

/** Move as âncoras (e as alças delas) por (dx, dy), em unidades do viewBox. */
export function moveAnchors(
  m: EditModel,
  refs: readonly AnchorRef[],
  dx: number,
  dy: number,
): EditModel {
  const keys = new Set(refs.map(refKey));
  let k = 0;
  return {
    paths: m.paths.map((p) => ({
      ...p,
      subpaths: p.subpaths.map((sp) => {
        const s = k++;
        if (!sp.anchors.some((_, i) => keys.has(`${s}-${i}`))) return sp;
        return {
          ...sp,
          anchors: sp.anchors.map((a, i) =>
            keys.has(`${s}-${i}`)
              ? {
                  ...shift(a, dx, dy),
                  ...(a.in ? { in: shift(a.in, dx, dy) } : {}),
                  ...(a.out ? { out: shift(a.out, dx, dy) } : {}),
                }
              : a,
          ),
        };
      }),
    })),
  };
}

/**
 * Leva a alça `kind` da âncora até `to`. Sem `alt` a alça oposta acompanha, simétrica em torno da
 * âncora; com `alt` a simetria quebra e só a alça movida muda.
 */
export function moveHandle(
  m: EditModel,
  ref: AnchorRef,
  kind: HandleKind,
  to: Point,
  alt = false,
): EditModel {
  return mapSubpath(m, ref.s, (sp) => ({
    ...sp,
    anchors: sp.anchors.map((a, i) => {
      if (i !== ref.i) return a;
      const next: PathAnchor = { ...a, [kind]: { x: to.x, y: to.y } };
      if (!alt) {
        const other: HandleKind = kind === 'in' ? 'out' : 'in';
        next[other] = { x: 2 * a.x - to.x, y: 2 * a.y - to.y };
      }
      return next;
    }),
  }));
}

/**
 * Remove as âncoras. Subpaths que ficam com menos de 2 âncoras somem; paths sem subpaths também.
 */
export function deleteAnchors(m: EditModel, refs: readonly AnchorRef[]): EditModel {
  const keys = new Set(refs.map(refKey));
  let k = 0;
  return {
    paths: m.paths
      .map((p) => ({
        ...p,
        subpaths: p.subpaths.flatMap((sp) => {
          const s = k++;
          const anchors = sp.anchors.filter((_, i) => !keys.has(`${s}-${i}`));
          if (anchors.length === sp.anchors.length) return [sp];
          return anchors.length < 2 ? [] : [{ ...sp, anchors }];
        }),
      }))
      .filter((p) => p.subpaths.length > 0),
  };
}

/** A âncora tem alça (é suave)? */
export function isSmooth(a: PathAnchor): boolean {
  return !!(a.in || a.out);
}

const dist = (a: Point, b: Point): number => Math.hypot(a.x - b.x, a.y - b.y);

/**
 * Alterna canto/suave: com alças remove-as (canto); sem alças cria alças alinhadas com a direção
 * dos vizinhos (um terço da distância até cada um).
 */
export function toggleSmooth(m: EditModel, ref: AnchorRef): EditModel {
  return mapSubpath(m, ref.s, (sp) => {
    const n = sp.anchors.length;
    const a = sp.anchors[ref.i];
    if (!a) return sp;
    const prev = ref.i > 0 ? sp.anchors[ref.i - 1] : sp.closed ? sp.anchors[n - 1] : undefined;
    const next = ref.i < n - 1 ? sp.anchors[ref.i + 1] : sp.closed ? sp.anchors[0] : undefined;
    let upd: PathAnchor;
    if (isSmooth(a)) {
      upd = { x: a.x, y: a.y };
    } else {
      const from = prev ?? a;
      const to = next ?? a;
      const len = Math.hypot(to.x - from.x, to.y - from.y);
      if (len === 0) return sp;
      const ux = (to.x - from.x) / len;
      const uy = (to.y - from.y) / len;
      const lenOut = (next ? dist(a, next) : prev ? dist(a, prev) : 0) / 3;
      const lenIn = (prev ? dist(a, prev) : next ? dist(a, next) : 0) / 3;
      upd = {
        x: a.x,
        y: a.y,
        in: { x: a.x - ux * lenIn, y: a.y - uy * lenIn },
        out: { x: a.x + ux * lenOut, y: a.y + uy * lenOut },
      };
    }
    return { ...sp, anchors: sp.anchors.map((x, i) => (i === ref.i ? upd : x)) };
  });
}

/* ------------------------------ segmentos ------------------------------ */

export interface SegmentHit {
  /** Índice global do subpath e do segmento (o segmento `i` vai da âncora `i` à `i + 1`). */
  s: number;
  seg: number;
  t: number;
  dist: number;
}

function cubicAt(p0: Point, p1: Point, p2: Point, p3: Point, t: number): Point {
  const u = 1 - t;
  const a = u * u * u;
  const b = 3 * u * u * t;
  const c = 3 * u * t * t;
  const d = t * t * t;
  return {
    x: a * p0.x + b * p1.x + c * p2.x + d * p3.x,
    y: a * p0.y + b * p1.y + c * p2.y + d * p3.y,
  };
}

function segmentPoints(sp: Subpath, seg: number): [Point, Point, Point, Point] {
  const a = sp.anchors[seg]!;
  const b = sp.anchors[(seg + 1) % sp.anchors.length]!;
  return [a, a.out ?? a, b.in ?? b, b];
}

function segmentCount(sp: Subpath): number {
  return sp.closed ? sp.anchors.length : sp.anchors.length - 1;
}

/** Segmento mais próximo de `p` (a até `tol` de distância, em unidades do viewBox), ou `null`. */
export function hitSegment(m: EditModel, p: Point, tol: number): SegmentHit | null {
  let best: SegmentHit | null = null;
  const STEPS = 32;
  flatSubpaths(m).forEach((sp, s) => {
    for (let seg = 0; seg < segmentCount(sp); seg++) {
      const [p0, p1, p2, p3] = segmentPoints(sp, seg);
      let prev = p0;
      for (let k = 1; k <= STEPS; k++) {
        const cur = cubicAt(p0, p1, p2, p3, k / STEPS);
        const vx = cur.x - prev.x;
        const vy = cur.y - prev.y;
        const len2 = vx * vx + vy * vy;
        const u =
          len2 === 0
            ? 0
            : Math.max(0, Math.min(1, ((p.x - prev.x) * vx + (p.y - prev.y) * vy) / len2));
        const d = dist(p, { x: prev.x + vx * u, y: prev.y + vy * u });
        if (d <= tol && (!best || d < best.dist)) {
          best = { s, seg, t: (k - 1 + u) / STEPS, dist: d };
        }
        prev = cur;
      }
    }
  });
  return best;
}

const mid = (a: Point, b: Point, t: number): Point => ({
  x: a.x + (b.x - a.x) * t,
  y: a.y + (b.y - a.y) * t,
});

/** Insere uma âncora no segmento `seg` do subpath `s` em `t` (De Casteljau, mantém a forma). */
export function insertAnchor(m: EditModel, s: number, seg: number, t: number): EditModel {
  return mapSubpath(m, s, (sp) => {
    const n = sp.anchors.length;
    if (seg < 0 || seg >= segmentCount(sp)) return sp;
    const [p0, p1, p2, p3] = segmentPoints(sp, seg);
    const a = sp.anchors[seg]!;
    const bi = (seg + 1) % n;
    const b = sp.anchors[bi]!;
    const curved = !!(a.out || b.in);
    const p01 = mid(p0, p1, t);
    const p12 = mid(p1, p2, t);
    const p23 = mid(p2, p3, t);
    const p012 = mid(p01, p12, t);
    const p123 = mid(p12, p23, t);
    const at = mid(p012, p123, t);
    const created: PathAnchor = curved
      ? { x: at.x, y: at.y, in: p012, out: p123 }
      : { x: at.x, y: at.y };
    const anchors = sp.anchors.map((x, i) => {
      if (!curved) return x;
      // Sem alça original o ponto de controle coincide com a âncora: continua sem alça.
      if (i === seg && x.out) return { ...x, out: p01 };
      if (i === bi && x.in) return { ...x, in: p23 };
      return x;
    });
    anchors.splice(seg + 1, 0, created);
    return { ...sp, anchors };
  });
}

/* ------------------------------ gravação ------------------------------ */

/** Vetor com os paths do modelo (cada `d` regenerado); paths que sumiram do modelo são removidos. */
export function modelToVector(v: Vector, m: EditModel): Vector {
  const byId = new Map(m.paths.map((p) => [p.id, p]));
  const paths = v.paths.flatMap((p) => {
    const mp = byId.get(p.id);
    return mp ? [{ ...p, d: subpathsToPath(mp.subpaths) }] : [];
  });
  return editVector(v, { paths });
}

const px = (n: number): string => `${Math.round(n * 100) / 100}px`;

/**
 * Ops de uma edição de pontos (uma entrada de undo): `setVector` com o vetor ajustado ao conteúdo
 * (`fitVectorToContent`, o desenho fica parado na tela) e `updateStyles` com a caixa nova do nó
 * (`left`/`top`/`width`/`height`; nó em fluxo: só `width`/`height`). Sem caixa em px, só `setVector`.
 */
export function buildVectorEditOps(node: Node, next: Vector, opts: { absolute: boolean }): Op[] {
  const box = nodeBoxInParent(node);
  if (!box) return buildSetVectorOps(node.id, next);
  const fit = fitVectorToContent(next, box);
  const set: Record<string, string> = {
    width: px(fit.box.width),
    height: px(fit.box.height),
  };
  if (opts.absolute) {
    set.left = px(fit.box.x);
    set.top = px(fit.box.y);
  }
  const changed = Object.fromEntries(Object.entries(set).filter(([k, v]) => node.style[k] !== v));
  const ops = buildSetVectorOps(node.id, fit.vector);
  if (Object.keys(changed).length) {
    ops.push({ type: 'updateStyles', changes: [{ nodeId: node.id, set: changed }] });
  }
  return ops;
}
