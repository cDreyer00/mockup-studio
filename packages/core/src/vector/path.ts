/** Path data SVG: parse para comandos absolutos, serialização, transformação, caixa e achatamento. */

/** Comandos absolutos normalizados. H/V viram L; S/T viram C/Q; A (arco) vira C. */
export type PathCommand =
  | { type: 'M'; x: number; y: number }
  | { type: 'L'; x: number; y: number }
  | { type: 'C'; x1: number; y1: number; x2: number; y2: number; x: number; y: number }
  | { type: 'Q'; x1: number; y1: number; x: number; y: number }
  | { type: 'Z' };

/** Matriz afim SVG `matrix(a b c d e f)`: x' = a·x + c·y + e, y' = b·x + d·y + f. */
export interface Matrix {
  a: number;
  b: number;
  c: number;
  d: number;
  e: number;
  f: number;
}

export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Uma poligonal achatada de um subpath. */
export interface FlatPolyline {
  points: [number, number][];
  closed: boolean;
}

/* ------------------------------------------------------------------------------- números */

/** Arredonda para `precision` casas e devolve o número como texto, sem zeros à toa nem `-0`. */
export function formatNumber(n: number, precision = 3): string {
  if (!Number.isFinite(n)) return '0';
  const f = 10 ** precision;
  const r = Math.round(n * f) / f;
  if (r === 0) return '0';
  const s = String(r);
  // números muito grandes/pequenos caem em notação científica; `toFixed` evita isso
  return s.includes('e') ? r.toFixed(precision).replace(/\.?0+$/, '') : s;
}

/* ------------------------------------------------------------------------------- parse */

const ARG_COUNT: Record<string, number> = {
  m: 2,
  l: 2,
  h: 1,
  v: 1,
  c: 6,
  s: 4,
  q: 4,
  t: 2,
  a: 7,
  z: 0,
};

const NUMBER_RE = /[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/y;

/** Leitor de tokens de path data (comandos, números e flags de arco compactadas). */
class Scanner {
  private i = 0;

  constructor(private readonly s: string) {}

  private skipSeparators(): void {
    while (this.i < this.s.length && /[\s,]/.test(this.s[this.i]!)) this.i++;
  }

  /** Há mais conteúdo (depois de espaços e vírgulas)? */
  more(): boolean {
    this.skipSeparators();
    return this.i < this.s.length;
  }

  /** Próximo caractere, se for uma letra de comando. */
  peekCommand(): string | null {
    this.skipSeparators();
    const ch = this.s[this.i];
    return ch !== undefined && /[A-Za-z]/.test(ch) ? ch : null;
  }

  takeCommand(): string {
    this.skipSeparators();
    return this.s[this.i++]!;
  }

  number(): number {
    this.skipSeparators();
    NUMBER_RE.lastIndex = this.i;
    const m = NUMBER_RE.exec(this.s);
    if (!m) throw new Error(`Path inválido: número esperado na posição ${this.i}`);
    this.i += m[0].length;
    return parseFloat(m[0]);
  }

  /** Flag de arco: um único `0` ou `1` (pode vir colado ao próximo número). */
  flag(): 0 | 1 {
    this.skipSeparators();
    const ch = this.s[this.i];
    if (ch !== '0' && ch !== '1') {
      throw new Error(`Path inválido: flag de arco (0 ou 1) esperada na posição ${this.i}`);
    }
    this.i++;
    return ch === '1' ? 1 : 0;
  }
}

/** Arco elíptico (endpoint) → cúbicas, segmentos de até 90°. */
function arcToCubics(
  x1: number,
  y1: number,
  rxIn: number,
  ryIn: number,
  phiDeg: number,
  fa: number,
  fs: number,
  x2: number,
  y2: number,
): PathCommand[] {
  let rx = Math.abs(rxIn);
  let ry = Math.abs(ryIn);
  if (rx === 0 || ry === 0) return [{ type: 'L', x: x2, y: y2 }];
  const phi = (phiDeg * Math.PI) / 180;
  const cos = Math.cos(phi);
  const sin = Math.sin(phi);
  const dx = (x1 - x2) / 2;
  const dy = (y1 - y2) / 2;
  const x1p = cos * dx + sin * dy;
  const y1p = -sin * dx + cos * dy;
  const lambda = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry);
  if (lambda > 1) {
    const s = Math.sqrt(lambda);
    rx *= s;
    ry *= s;
  }
  const rx2 = rx * rx;
  const ry2 = ry * ry;
  const den = rx2 * y1p * y1p + ry2 * x1p * x1p;
  const num = rx2 * ry2 - den;
  const coef = (fa === fs ? -1 : 1) * Math.sqrt(Math.max(0, num / den));
  const cxp = (coef * rx * y1p) / ry;
  const cyp = (-coef * ry * x1p) / rx;
  const cx = cos * cxp - sin * cyp + (x1 + x2) / 2;
  const cy = sin * cxp + cos * cyp + (y1 + y2) / 2;
  const angle = (ux: number, uy: number, vx: number, vy: number): number => {
    const a = Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy);
    return a;
  };
  const ux = (x1p - cxp) / rx;
  const uy = (y1p - cyp) / ry;
  const vx = (-x1p - cxp) / rx;
  const vy = (-y1p - cyp) / ry;
  const theta1 = angle(1, 0, ux, uy);
  let dtheta = angle(ux, uy, vx, vy);
  if (!fs && dtheta > 0) dtheta -= 2 * Math.PI;
  else if (fs && dtheta < 0) dtheta += 2 * Math.PI;
  const n = Math.max(1, Math.ceil(Math.abs(dtheta) / (Math.PI / 2) - 1e-9));
  const delta = dtheta / n;
  const t = (4 / 3) * Math.tan(delta / 4);
  const map = (px: number, py: number): [number, number] => [
    cx + cos * rx * px - sin * ry * py,
    cy + sin * rx * px + cos * ry * py,
  ];
  const out: PathCommand[] = [];
  for (let i = 0; i < n; i++) {
    const a1 = theta1 + i * delta;
    const a2 = a1 + delta;
    const [c1x, c1y] = map(Math.cos(a1) - t * Math.sin(a1), Math.sin(a1) + t * Math.cos(a1));
    const [c2x, c2y] = map(Math.cos(a2) + t * Math.sin(a2), Math.sin(a2) - t * Math.cos(a2));
    const [ex, ey] = i === n - 1 ? [x2, y2] : map(Math.cos(a2), Math.sin(a2));
    out.push({ type: 'C', x1: c1x, y1: c1y, x2: c2x, y2: c2y, x: ex, y: ey });
  }
  return out;
}

/** Faz o parse de `d` (todos os comandos SVG, relativos e absolutos). Lança em path inválido. */
export function parsePathData(d: string): PathCommand[] {
  const sc = new Scanner(d);
  const out: PathCommand[] = [];
  let cx = 0;
  let cy = 0;
  let sx = 0;
  let sy = 0;
  // último ponto de controle (para S/T) e se o comando anterior era cúbica/quadrática
  let lcx = 0;
  let lcy = 0;
  let prev: 'C' | 'Q' | null = null;
  let cmd = '';
  let first = true;
  // depois de Z, um comando de desenho começa novo subpath no ponto inicial: emite `M` explícito
  let afterClose = false;

  while (sc.more()) {
    const letter = sc.peekCommand();
    if (letter !== null) {
      sc.takeCommand();
      if (!(letter.toLowerCase() in ARG_COUNT)) {
        throw new Error(`Path inválido: comando desconhecido "${letter}"`);
      }
      cmd = letter;
    } else if (cmd === '' || cmd.toLowerCase() === 'z') {
      throw new Error('Path inválido: número sem comando');
    }
    if (first && cmd.toLowerCase() !== 'm') {
      throw new Error('Path inválido: deve começar com "M"');
    }
    first = false;
    const rel = cmd !== cmd.toUpperCase();
    const lower = cmd.toLowerCase();
    const ox = rel ? cx : 0;
    const oy = rel ? cy : 0;

    if (lower === 'z') {
      if (out.length > 0 && out[out.length - 1]!.type !== 'Z') out.push({ type: 'Z' });
      cx = sx;
      cy = sy;
      prev = null;
      afterClose = true;
      continue;
    }
    if (afterClose && lower !== 'm') {
      out.push({ type: 'M', x: sx, y: sy });
      afterClose = false;
    }

    switch (lower) {
      case 'm': {
        const x = sc.number() + ox;
        const y = sc.number() + oy;
        out.push({ type: 'M', x, y });
        cx = sx = x;
        cy = sy = y;
        prev = null;
        afterClose = false;
        // pares seguintes são L implícitos
        cmd = rel ? 'l' : 'L';
        break;
      }
      case 'l': {
        const x = sc.number() + ox;
        const y = sc.number() + oy;
        out.push({ type: 'L', x, y });
        cx = x;
        cy = y;
        prev = null;
        break;
      }
      case 'h': {
        const x = sc.number() + ox;
        out.push({ type: 'L', x, y: cy });
        cx = x;
        prev = null;
        break;
      }
      case 'v': {
        const y = sc.number() + oy;
        out.push({ type: 'L', x: cx, y });
        cy = y;
        prev = null;
        break;
      }
      case 'c': {
        const x1 = sc.number() + ox;
        const y1 = sc.number() + oy;
        const x2 = sc.number() + ox;
        const y2 = sc.number() + oy;
        const x = sc.number() + ox;
        const y = sc.number() + oy;
        out.push({ type: 'C', x1, y1, x2, y2, x, y });
        lcx = x2;
        lcy = y2;
        cx = x;
        cy = y;
        prev = 'C';
        break;
      }
      case 's': {
        const x1 = prev === 'C' ? 2 * cx - lcx : cx;
        const y1 = prev === 'C' ? 2 * cy - lcy : cy;
        const x2 = sc.number() + ox;
        const y2 = sc.number() + oy;
        const x = sc.number() + ox;
        const y = sc.number() + oy;
        out.push({ type: 'C', x1, y1, x2, y2, x, y });
        lcx = x2;
        lcy = y2;
        cx = x;
        cy = y;
        prev = 'C';
        break;
      }
      case 'q': {
        const x1 = sc.number() + ox;
        const y1 = sc.number() + oy;
        const x = sc.number() + ox;
        const y = sc.number() + oy;
        out.push({ type: 'Q', x1, y1, x, y });
        lcx = x1;
        lcy = y1;
        cx = x;
        cy = y;
        prev = 'Q';
        break;
      }
      case 't': {
        const x1 = prev === 'Q' ? 2 * cx - lcx : cx;
        const y1 = prev === 'Q' ? 2 * cy - lcy : cy;
        const x = sc.number() + ox;
        const y = sc.number() + oy;
        out.push({ type: 'Q', x1, y1, x, y });
        lcx = x1;
        lcy = y1;
        cx = x;
        cy = y;
        prev = 'Q';
        break;
      }
      case 'a': {
        const rx = sc.number();
        const ry = sc.number();
        const rot = sc.number();
        const fa = sc.flag();
        const fs = sc.flag();
        const x = sc.number() + ox;
        const y = sc.number() + oy;
        if (x !== cx || y !== cy) out.push(...arcToCubics(cx, cy, rx, ry, rot, fa, fs, x, y));
        cx = x;
        cy = y;
        prev = null;
        break;
      }
    }
  }
  return out;
}

/* ------------------------------------------------------------------------------- serialização */

/** Serializa comandos (`M 0 0 L 10 0 C ... Z`), números com até `precision` casas, sem zeros à toa. */
export function serializePathData(cmds: PathCommand[], precision = 3): string {
  const n = (v: number): string => formatNumber(v, precision);
  return cmds
    .map((c) => {
      switch (c.type) {
        case 'M':
          return `M ${n(c.x)} ${n(c.y)}`;
        case 'L':
          return `L ${n(c.x)} ${n(c.y)}`;
        case 'C':
          return `C ${n(c.x1)} ${n(c.y1)} ${n(c.x2)} ${n(c.y2)} ${n(c.x)} ${n(c.y)}`;
        case 'Q':
          return `Q ${n(c.x1)} ${n(c.y1)} ${n(c.x)} ${n(c.y)}`;
        case 'Z':
          return 'Z';
      }
    })
    .join(' ');
}

/** `serializePathData(parsePathData(d))`. */
export function normalizePathData(d: string, precision = 3): string {
  return serializePathData(parsePathData(d), precision);
}

/* ------------------------------------------------------------------------------- matrizes */

export const IDENTITY: Matrix = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };

/** Produto `m1 · m2` (aplica m2 primeiro). */
export function multiplyMatrix(m1: Matrix, m2: Matrix): Matrix {
  return {
    a: m1.a * m2.a + m1.c * m2.b,
    b: m1.b * m2.a + m1.d * m2.b,
    c: m1.a * m2.c + m1.c * m2.d,
    d: m1.b * m2.c + m1.d * m2.d,
    e: m1.a * m2.e + m1.c * m2.f + m1.e,
    f: m1.b * m2.e + m1.d * m2.f + m1.f,
  };
}

const TRANSFORM_FN_RE = /\s*,?\s*([a-zA-Z]+)\s*\(([^)]*)\)/y;

/** Faz o parse de um atributo `transform` SVG (matrix, translate, scale, rotate, skewX, skewY). */
export function parseTransform(value: string): Matrix {
  let m: Matrix = IDENTITY;
  const s = value.trim();
  let pos = 0;
  while (pos < s.length) {
    TRANSFORM_FN_RE.lastIndex = pos;
    const match = TRANSFORM_FN_RE.exec(s);
    if (!match) throw new Error(`Transform inválido: "${value}"`);
    pos += match[0].length;
    const name = match[1]!;
    const args = (match[2]!.match(/[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/g) ?? []).map(Number);
    const bad = (): never => {
      throw new Error(`Transform inválido: "${name}" com argumentos incorretos`);
    };
    let t: Matrix;
    switch (name) {
      case 'matrix':
        if (args.length !== 6) return bad();
        t = { a: args[0]!, b: args[1]!, c: args[2]!, d: args[3]!, e: args[4]!, f: args[5]! };
        break;
      case 'translate':
        if (args.length < 1 || args.length > 2) return bad();
        t = { ...IDENTITY, e: args[0]!, f: args[1] ?? 0 };
        break;
      case 'scale':
        if (args.length < 1 || args.length > 2) return bad();
        t = { ...IDENTITY, a: args[0]!, d: args[1] ?? args[0]! };
        break;
      case 'rotate': {
        if (args.length !== 1 && args.length !== 3) return bad();
        const r = (args[0]! * Math.PI) / 180;
        const cos = Math.cos(r);
        const sin = Math.sin(r);
        t = { a: cos, b: sin, c: -sin, d: cos, e: 0, f: 0 };
        if (args.length === 3) {
          const px = args[1]!;
          const py = args[2]!;
          t = multiplyMatrix(multiplyMatrix({ ...IDENTITY, e: px, f: py }, t), {
            ...IDENTITY,
            e: -px,
            f: -py,
          });
        }
        break;
      }
      case 'skewX':
        if (args.length !== 1) return bad();
        t = { ...IDENTITY, c: Math.tan((args[0]! * Math.PI) / 180) };
        break;
      case 'skewY':
        if (args.length !== 1) return bad();
        t = { ...IDENTITY, b: Math.tan((args[0]! * Math.PI) / 180) };
        break;
      default:
        throw new Error(`Transform inválido: função desconhecida "${name}"`);
    }
    m = multiplyMatrix(m, t);
  }
  return m;
}

function applyMatrix(m: Matrix, x: number, y: number): [number, number] {
  return [m.a * x + m.c * y + m.e, m.b * x + m.d * y + m.f];
}

/** Aplica a matriz a todos os pontos dos comandos. */
export function transformCommands(cmds: PathCommand[], m: Matrix): PathCommand[] {
  return cmds.map((c): PathCommand => {
    switch (c.type) {
      case 'M':
      case 'L': {
        const [x, y] = applyMatrix(m, c.x, c.y);
        return { type: c.type, x, y };
      }
      case 'C': {
        const [x1, y1] = applyMatrix(m, c.x1, c.y1);
        const [x2, y2] = applyMatrix(m, c.x2, c.y2);
        const [x, y] = applyMatrix(m, c.x, c.y);
        return { type: 'C', x1, y1, x2, y2, x, y };
      }
      case 'Q': {
        const [x1, y1] = applyMatrix(m, c.x1, c.y1);
        const [x, y] = applyMatrix(m, c.x, c.y);
        return { type: 'Q', x1, y1, x, y };
      }
      case 'Z':
        return c;
    }
  });
}

/** Aplica a matriz a todos os pontos do path. */
export function transformPathData(d: string, m: Matrix, precision = 3): string {
  return serializePathData(transformCommands(parsePathData(d), m), precision);
}

/* ------------------------------------------------------------------------------- caixa */

/** Raízes em (0,1) da derivada de uma cúbica 1D com pontos p0..p3. */
function cubicExtrema(p0: number, p1: number, p2: number, p3: number): number[] {
  const a = -p0 + 3 * p1 - 3 * p2 + p3;
  const b = 2 * (p0 - 2 * p1 + p2);
  const c = p1 - p0;
  const ts: number[] = [];
  if (Math.abs(a) < 1e-12) {
    if (Math.abs(b) > 1e-12) ts.push(-c / b);
  } else {
    const disc = b * b - 4 * a * c;
    if (disc >= 0) {
      const sq = Math.sqrt(disc);
      ts.push((-b + sq) / (2 * a), (-b - sq) / (2 * a));
    }
  }
  return ts.filter((t) => t > 0 && t < 1);
}

function cubicAt(p0: number, p1: number, p2: number, p3: number, t: number): number {
  const u = 1 - t;
  return u * u * u * p0 + 3 * u * u * t * p1 + 3 * u * t * t * p2 + t * t * t * p3;
}

function quadAt(p0: number, p1: number, p2: number, t: number): number {
  const u = 1 - t;
  return u * u * p0 + 2 * u * t * p1 + t * t * p2;
}

/** Caixa exata dos comandos (extremos das curvas), sem traço. Sem pontos: caixa 0. */
export function commandsBounds(cmds: PathCommand[]): Box {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const add = (x: number, y: number): void => {
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  };
  let cx = 0;
  let cy = 0;
  let sx = 0;
  let sy = 0;
  for (const c of cmds) {
    switch (c.type) {
      case 'M':
        add(c.x, c.y);
        cx = sx = c.x;
        cy = sy = c.y;
        break;
      case 'L':
        add(c.x, c.y);
        cx = c.x;
        cy = c.y;
        break;
      case 'C':
        add(c.x, c.y);
        for (const t of cubicExtrema(cx, c.x1, c.x2, c.x)) {
          add(cubicAt(cx, c.x1, c.x2, c.x, t), cubicAt(cy, c.y1, c.y2, c.y, t));
        }
        for (const t of cubicExtrema(cy, c.y1, c.y2, c.y)) {
          add(cubicAt(cx, c.x1, c.x2, c.x, t), cubicAt(cy, c.y1, c.y2, c.y, t));
        }
        cx = c.x;
        cy = c.y;
        break;
      case 'Q': {
        add(c.x, c.y);
        const tx = cx - 2 * c.x1 + c.x;
        const ty = cy - 2 * c.y1 + c.y;
        const ts: number[] = [];
        if (Math.abs(tx) > 1e-12) ts.push((cx - c.x1) / tx);
        if (Math.abs(ty) > 1e-12) ts.push((cy - c.y1) / ty);
        for (const t of ts) {
          if (t > 0 && t < 1) add(quadAt(cx, c.x1, c.x, t), quadAt(cy, c.y1, c.y, t));
        }
        cx = c.x;
        cy = c.y;
        break;
      }
      case 'Z':
        cx = sx;
        cy = sy;
        break;
    }
  }
  if (minX === Infinity) return { x: 0, y: 0, width: 0, height: 0 };
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

/** Caixa exata do path (extremos das curvas), sem traço. Path vazio: caixa 0. */
export function pathBounds(d: string): Box {
  return commandsBounds(parsePathData(d));
}

/* ------------------------------------------------------------------------------- achatamento */

const MAX_SEGMENTS = 400;

/** Achata as curvas em poligonais (`tolerance` = erro máximo em unidades do path). */
export function flattenPath(d: string, tolerance = 0.25): FlatPolyline[] {
  const tol = Math.max(tolerance, 1e-6);
  const out: FlatPolyline[] = [];
  let cur: FlatPolyline | null = null;
  let cx = 0;
  let cy = 0;
  let sx = 0;
  let sy = 0;
  const finish = (): void => {
    if (cur && cur.points.length >= 2) out.push(cur);
    cur = null;
  };
  for (const c of parsePathData(d)) {
    switch (c.type) {
      case 'M':
        finish();
        cur = { points: [[c.x, c.y]], closed: false };
        cx = sx = c.x;
        cy = sy = c.y;
        break;
      case 'L':
        cur?.points.push([c.x, c.y]);
        cx = c.x;
        cy = c.y;
        break;
      case 'C': {
        // erro de uma poligonal uniforme de n segmentos ≤ 0.75·|B''| / n² (|B''|/6 ≈ dd)
        const dd = Math.max(
          Math.hypot(cx - 2 * c.x1 + c.x2, cy - 2 * c.y1 + c.y2),
          Math.hypot(c.x1 - 2 * c.x2 + c.x, c.y1 - 2 * c.y2 + c.y),
        );
        const n = Math.min(MAX_SEGMENTS, Math.max(1, Math.ceil(Math.sqrt((0.75 * dd) / tol))));
        for (let i = 1; i <= n; i++) {
          const t = i / n;
          cur?.points.push(
            i === n
              ? [c.x, c.y]
              : [cubicAt(cx, c.x1, c.x2, c.x, t), cubicAt(cy, c.y1, c.y2, c.y, t)],
          );
        }
        cx = c.x;
        cy = c.y;
        break;
      }
      case 'Q': {
        const dd = Math.hypot(cx - 2 * c.x1 + c.x, cy - 2 * c.y1 + c.y);
        const n = Math.min(MAX_SEGMENTS, Math.max(1, Math.ceil(Math.sqrt(dd / (4 * tol)))));
        for (let i = 1; i <= n; i++) {
          const t = i / n;
          cur?.points.push(
            i === n ? [c.x, c.y] : [quadAt(cx, c.x1, c.x, t), quadAt(cy, c.y1, c.y, t)],
          );
        }
        cx = c.x;
        cy = c.y;
        break;
      }
      case 'Z':
        if (cur) cur.closed = true;
        finish();
        cx = sx;
        cy = sy;
        break;
    }
  }
  finish();
  return out;
}

/* ------------------------------------------------------------------------------- formas */

/** Path de um retângulo (`rx`/`ry` > 0 arredondam os cantos com arcos, já convertidos em cúbicas). */
export function rectPathData(
  x: number,
  y: number,
  w: number,
  h: number,
  rx = 0,
  ry = rx,
  precision = 3,
): string {
  const r = Math.min(Math.max(rx, 0), w / 2);
  const s = Math.min(Math.max(ry, 0), h / 2);
  if (r <= 0 || s <= 0) {
    return serializePathData(
      [
        { type: 'M', x, y },
        { type: 'L', x: x + w, y },
        { type: 'L', x: x + w, y: y + h },
        { type: 'L', x, y: y + h },
        { type: 'Z' },
      ],
      precision,
    );
  }
  const d = [
    `M ${x + r} ${y}`,
    `L ${x + w - r} ${y}`,
    `A ${r} ${s} 0 0 1 ${x + w} ${y + s}`,
    `L ${x + w} ${y + h - s}`,
    `A ${r} ${s} 0 0 1 ${x + w - r} ${y + h}`,
    `L ${x + r} ${y + h}`,
    `A ${r} ${s} 0 0 1 ${x} ${y + h - s}`,
    `L ${x} ${y + s}`,
    `A ${r} ${s} 0 0 1 ${x + r} ${y}`,
    'Z',
  ].join(' ');
  return normalizePathData(d, precision);
}

const KAPPA = 0.5522847498307936;

/** Path de uma elipse com 4 cúbicas, começando à direita e seguindo no sentido horário da tela. */
export function ellipsePathData(
  cx: number,
  cy: number,
  rx: number,
  ry: number,
  precision = 3,
): string {
  const kx = rx * KAPPA;
  const ky = ry * KAPPA;
  return serializePathData(
    [
      { type: 'M', x: cx + rx, y: cy },
      { type: 'C', x1: cx + rx, y1: cy + ky, x2: cx + kx, y2: cy + ry, x: cx, y: cy + ry },
      { type: 'C', x1: cx - kx, y1: cy + ry, x2: cx - rx, y2: cy + ky, x: cx - rx, y: cy },
      { type: 'C', x1: cx - rx, y1: cy - ky, x2: cx - kx, y2: cy - ry, x: cx, y: cy - ry },
      { type: 'C', x1: cx + kx, y1: cy - ry, x2: cx + rx, y2: cy - ky, x: cx + rx, y: cy },
      { type: 'Z' },
    ],
    precision,
  );
}
