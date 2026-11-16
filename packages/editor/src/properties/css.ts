/** Funções puras de CSS usadas pelo painel de propriedades (parse/serialização de valores). */

/**
 * Divide por qualquer um dos caracteres de `seps` fora de parênteses e aspas.
 * Partes vazias são mantidas (exceto quando `seps` é um espaço, onde são descartadas).
 */
export function splitTopLevel(value: string, seps: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let quote = '';
  let cur = '';
  for (let i = 0; i < value.length; i++) {
    const ch = value[i]!;
    if (quote) {
      cur += ch;
      if (ch === '\\' && i + 1 < value.length) cur += value[++i];
      else if (ch === quote) quote = '';
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      cur += ch;
    } else if (ch === '(') {
      depth++;
      cur += ch;
    } else if (ch === ')') {
      depth = Math.max(0, depth - 1);
      cur += ch;
    } else if (depth === 0 && seps.includes(ch)) {
      out.push(cur);
      cur = '';
    } else cur += ch;
  }
  out.push(cur);
  return seps.trim() === '' ? out.filter((p) => p.trim() !== '') : out;
}

const tokens = (v: string): string[] =>
  splitTopLevel(v.trim().replace(/\s+/g, ' '), ' ').map((t) => t.trim());

/* ------------------------------ rotação / filtros ------------------------------ */

/** Rotação em graus de um `transform` (0 se não houver `rotate()`). */
export function getRotation(transform: string | undefined | null): number {
  if (!transform) return 0;
  for (const p of splitTopLevel(transform.trim(), ' ')) {
    const m = /^rotate\((.*)\)$/i.exec(p.trim());
    if (!m) continue;
    const n = /^\s*(-?\d*\.?\d+)\s*(deg|rad|turn|grad)?\s*$/i.exec(m[1]!);
    if (!n) return 0;
    const v = Number(n[1]);
    const unit = (n[2] ?? 'deg').toLowerCase();
    const deg =
      unit === 'rad'
        ? (v * 180) / Math.PI
        : unit === 'turn'
          ? v * 360
          : unit === 'grad'
            ? v * 0.9
            : v;
    return Math.round(deg * 100) / 100;
  }
  return 0;
}

/** Define a rotação preservando as demais funções do transform; 0 remove o `rotate()`. */
export function setRotation(transform: string | undefined | null, deg: number): string {
  const parts = splitTopLevel((transform ?? '').trim(), ' ').filter(
    (p) => !/^rotate\(/i.test(p.trim()),
  );
  if (deg) parts.push(`rotate(${Math.round(deg * 100) / 100}deg)`);
  return parts.map((p) => p.trim()).join(' ');
}

/** Argumento de uma função de filtro (`blur(4px)` → `'4px'`), ou `null`. */
export function getFilterFn(value: string | undefined | null, name: string): string | null {
  if (!value) return null;
  const re = new RegExp(`^${name}\\((.*)\\)$`, 'i');
  for (const p of splitTopLevel(value.trim(), ' ')) {
    const m = re.exec(p.trim());
    if (m) return m[1]!.trim();
  }
  return null;
}

/** Define/remove (arg vazio ou null) uma função de filtro preservando as outras. */
export function setFilterFn(
  value: string | undefined | null,
  name: string,
  arg: string | null,
): string {
  const re = new RegExp(`^${name}\\(`, 'i');
  const parts = splitTopLevel((value ?? '').trim(), ' ')
    .map((p) => p.trim())
    .filter((p) => p && !re.test(p) && p !== 'none');
  if (arg !== null && arg.trim() !== '') parts.push(`${name}(${arg.trim()})`);
  return parts.join(' ');
}

/* ------------------------------ shorthand de caixa ------------------------------ */

export interface Box {
  top: string;
  right: string;
  bottom: string;
  left: string;
}

/** `padding`/`margin`/`border-radius` com 1–4 valores → 4 lados; `null` se inválido/com `/`. */
export function parseBox(value: string | undefined | null): Box | null {
  if (!value || !value.trim() || value.includes('/')) return null;
  const t = tokens(value);
  if (t.length < 1 || t.length > 4) return null;
  const a = t[0]!;
  const b = t[1] ?? a;
  const c = t[2] ?? a;
  const d = t[3] ?? b;
  return { top: a, right: b, bottom: c, left: d };
}

/** Serializa para o menor shorthand equivalente. */
export function serializeBox(box: Box): string {
  const { top, right, bottom, left } = box;
  if (top === right && right === bottom && bottom === left) return top;
  if (top === bottom && right === left) return `${top} ${right}`;
  if (right === left) return `${top} ${right} ${bottom}`;
  return `${top} ${right} ${bottom} ${left}`;
}

export const parsePadding = parseBox;
export const serializePadding = serializeBox;

/* --------------------------------- border --------------------------------- */

export interface Border {
  width: string;
  style: string;
  color: string;
}

const BORDER_STYLES = new Set([
  'none',
  'hidden',
  'solid',
  'dashed',
  'dotted',
  'double',
  'groove',
  'ridge',
  'inset',
  'outset',
]);
const isLength = (t: string) => /^-?\d*\.?\d+[a-z%]*$/i.test(t) || /^(thin|medium|thick)$/i.test(t);

export function parseBorder(value: string | undefined | null): Border {
  const out: Border = { width: '', style: '', color: '' };
  if (!value) return out;
  for (const t of tokens(value)) {
    if (BORDER_STYLES.has(t.toLowerCase())) out.style = t;
    else if (isLength(t) || /^calc\(/i.test(t)) out.width = t;
    else out.color = out.color ? `${out.color} ${t}` : t;
  }
  return out;
}

export function serializeBorder(b: Border): string {
  return [b.width, b.style, b.color].filter((p) => p.trim() !== '').join(' ');
}

/* -------------------------------- box-shadow -------------------------------- */

export interface Shadow {
  x: string;
  y: string;
  blur: string;
  spread: string;
  color: string;
  inset: boolean;
}

export function parseShadow(value: string): Shadow | null {
  const s: Shadow = { x: '0px', y: '0px', blur: '', spread: '', color: '', inset: false };
  const lengths: string[] = [];
  for (const t of tokens(value)) {
    if (t.toLowerCase() === 'inset') s.inset = true;
    else if (/^-?\d*\.?\d+[a-z%]*$/i.test(t) || /^calc\(/i.test(t)) lengths.push(t);
    else s.color = s.color ? `${s.color} ${t}` : t;
  }
  if (lengths.length < 2 || lengths.length > 4) return null;
  s.x = lengths[0]!;
  s.y = lengths[1]!;
  s.blur = lengths[2] ?? '';
  s.spread = lengths[3] ?? '';
  return s;
}

/** Lista de sombras de um valor `box-shadow` (vírgulas dentro de `rgb()`/`var()` são respeitadas). */
export function parseShadows(value: string | undefined | null): Shadow[] {
  if (!value || value.trim() === '' || value.trim() === 'none') return [];
  return splitTopLevel(value, ',')
    .map((p) => parseShadow(p))
    .filter((s): s is Shadow => !!s);
}

export function serializeShadow(s: Shadow): string {
  const hasSpread = s.spread.trim() !== '';
  const blur = s.blur.trim() !== '' ? s.blur : hasSpread ? '0px' : '';
  return [s.inset ? 'inset' : '', s.x, s.y, blur, s.spread, s.color]
    .filter((p) => p.trim() !== '')
    .join(' ');
}

export function serializeShadows(list: Shadow[]): string {
  return list.map(serializeShadow).join(', ');
}

/* --------------------------------- CSS bruto --------------------------------- */

export function stylesToCssText(style: Record<string, string>): string {
  return Object.entries(style)
    .map(([k, v]) => `${k}: ${v};`)
    .join('\n');
}

function stripComments(text: string): string {
  let out = '';
  let quote = '';
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quote) {
      out += ch;
      if (ch === '\\' && i + 1 < text.length) out += text[++i];
      else if (ch === quote) quote = '';
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      out += ch;
    } else if (ch === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      i = end < 0 ? text.length : end + 1;
      out += ' ';
    } else out += ch;
  }
  return out;
}

export interface ParsedCss {
  style: Record<string, string>;
  /** Mensagem do primeiro erro; quando presente, nada deve ser aplicado. */
  error?: string;
}

/** Interpreta `prop: valor;` (uma por linha ou separadas por `;`), ignorando comentários. */
export function parseCssText(text: string): ParsedCss {
  const style: Record<string, string> = {};
  for (const raw of splitTopLevel(stripComments(text), ';\n')) {
    const decl = raw.trim();
    if (!decl) continue;
    const i = decl.indexOf(':');
    const prop = i < 0 ? '' : decl.slice(0, i).trim();
    const value = i < 0 ? '' : decl.slice(i + 1).trim();
    if (!/^(--[\w-]+|-?[a-zA-Z][\w-]*)$/.test(prop) || value === '') {
      return { style, error: `Linha inválida: "${decl}"` };
    }
    style[prop.startsWith('--') ? prop : prop.toLowerCase()] = value;
  }
  return { style };
}

export function diffStyles(
  prev: Record<string, string>,
  next: Record<string, string>,
): { set: Record<string, string>; unset: string[] } {
  const set: Record<string, string> = {};
  for (const [k, v] of Object.entries(next)) if (prev[k] !== v) set[k] = v;
  const unset = Object.keys(prev).filter((k) => !(k in next));
  return { set, unset };
}
