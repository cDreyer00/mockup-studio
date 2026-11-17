/**
 * Placeholders SVG gerados localmente (offline), determinísticos pela semente: a mesma
 * `kind` + `seed` + tamanho produz sempre o mesmo SVG, byte a byte.
 */

export const PLACEHOLDER_KINDS = ['avatar', 'product', 'landscape', 'logo'] as const;
export type PlaceholderKind = (typeof PLACEHOLDER_KINDS)[number];

export interface PlaceholderOptions {
  /** Semente (texto ou número). Padrão: `"1"`. */
  seed?: string | number;
  width?: number;
  height?: number;
  /** Texto do logo (padrão: gerado pela semente). Avatar usa as iniciais quando informado. */
  label?: string;
}

/** Tamanho padrão por tipo (largura × altura). */
export const PLACEHOLDER_SIZES: Record<PlaceholderKind, [number, number]> = {
  avatar: [256, 256],
  product: [600, 600],
  landscape: [1200, 800],
  logo: [480, 160],
};

/** Hash FNV-1a de 32 bits. */
export function hashSeed(seed: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** PRNG mulberry32 (determinístico). */
export function seededRandom(seed: string | number): () => number {
  let a = hashSeed(String(seed));
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const r1 = (n: number): string => String(Math.round(n * 10) / 10);

function hsl(h: number, s: number, l: number): string {
  return `hsl(${Math.round(((h % 360) + 360) % 360)} ${Math.round(s)}% ${Math.round(l)}%)`;
}

function escapeXml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

const SYLLABLES = [
  'no',
  'va',
  'lu',
  'mi',
  'ra',
  'ze',
  'to',
  'ka',
  'sol',
  've',
  'ri',
  'on',
  'ta',
  'ly',
  'ex',
  'qu',
];

function brandName(rand: () => number): string {
  const n = 2 + Math.floor(rand() * 2);
  let s = '';
  for (let i = 0; i < n; i++) s += SYLLABLES[Math.floor(rand() * SYLLABLES.length)]!;
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function wrap(w: number, h: number, body: string, title: string): string {
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" role="img">` +
    `<title>${escapeXml(title)}</title>${body}</svg>`
  );
}

function avatar(rand: () => number, w: number, h: number, label?: string): string {
  const hue = rand() * 360;
  const bg = hsl(hue, 55, 82);
  const skin = hsl(20 + rand() * 25, 45 + rand() * 20, 45 + rand() * 30);
  const shirt = hsl(hue + 150 + rand() * 60, 50, 42);
  const hair = hsl(rand() * 40, 30 + rand() * 30, 12 + rand() * 30);
  const cx = w / 2;
  const s = Math.min(w, h);
  const headR = s * 0.2;
  const headY = h * 0.42;
  let body =
    `<rect width="${w}" height="${h}" fill="${bg}"/>` +
    `<ellipse cx="${r1(cx)}" cy="${r1(h * 1.02)}" rx="${r1(s * 0.38)}" ry="${r1(s * 0.32)}" fill="${shirt}"/>` +
    `<rect x="${r1(cx - s * 0.07)}" y="${r1(headY + headR * 0.6)}" width="${r1(s * 0.14)}" height="${r1(s * 0.16)}" fill="${skin}"/>` +
    `<circle cx="${r1(cx)}" cy="${r1(headY)}" r="${r1(headR)}" fill="${skin}"/>`;
  const style = Math.floor(rand() * 3);
  if (style === 0) {
    body += `<path d="M${r1(cx - headR)} ${r1(headY)} a${r1(headR)} ${r1(headR)} 0 0 1 ${r1(headR * 2)} 0 q${r1(-headR)} ${r1(-headR * 0.5)} ${r1(-headR * 2)} 0z" fill="${hair}"/>`;
  } else if (style === 1) {
    body += `<ellipse cx="${r1(cx)}" cy="${r1(headY - headR * 0.55)}" rx="${r1(headR * 1.05)}" ry="${r1(headR * 0.6)}" fill="${hair}"/>`;
  } else {
    body += `<path d="M${r1(cx - headR * 1.1)} ${r1(headY + headR * 0.9)} V${r1(headY - headR * 0.2)} a${r1(headR * 1.1)} ${r1(headR * 1.1)} 0 0 1 ${r1(headR * 2.2)} 0 V${r1(headY + headR * 0.9)} h${r1(-headR * 0.35)} V${r1(headY - headR * 0.1)} h${r1(-headR * 1.5)} V${r1(headY + headR * 0.9)}z" fill="${hair}"/>`;
  }
  if (label) {
    const initials = label
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((p) => p.charAt(0).toUpperCase())
      .join('');
    body =
      `<rect width="${w}" height="${h}" fill="${hsl(hue, 50, 45)}"/>` +
      `<text x="50%" y="50%" dy=".35em" text-anchor="middle" font-family="system-ui, sans-serif" font-weight="600" font-size="${r1(s * 0.4)}" fill="#fff">${escapeXml(initials)}</text>`;
  }
  return wrap(w, h, body, label ? `Avatar ${label}` : 'Avatar');
}

function product(rand: () => number, w: number, h: number): string {
  const hue = rand() * 360;
  const bg = hsl(hue, 30, 94);
  const main = hsl(hue + 180 + rand() * 40, 55, 50);
  const dark = hsl(hue + 180, 45, 32);
  const cx = w / 2;
  const s = Math.min(w, h);
  const floorY = h * 0.8;
  let body =
    `<rect width="${w}" height="${h}" fill="${bg}"/>` +
    `<ellipse cx="${r1(cx)}" cy="${r1(floorY)}" rx="${r1(s * 0.3)}" ry="${r1(s * 0.04)}" fill="rgba(0,0,0,.12)"/>`;
  const kind = Math.floor(rand() * 3);
  if (kind === 0) {
    // garrafa
    const bw = s * 0.22;
    body +=
      `<rect x="${r1(cx - bw / 2)}" y="${r1(h * 0.35)}" width="${r1(bw)}" height="${r1(floorY - h * 0.35)}" rx="${r1(bw * 0.25)}" fill="${main}"/>` +
      `<rect x="${r1(cx - bw * 0.18)}" y="${r1(h * 0.2)}" width="${r1(bw * 0.36)}" height="${r1(h * 0.17)}" fill="${main}"/>` +
      `<rect x="${r1(cx - bw * 0.22)}" y="${r1(h * 0.16)}" width="${r1(bw * 0.44)}" height="${r1(h * 0.05)}" rx="3" fill="${dark}"/>` +
      `<rect x="${r1(cx - bw / 2)}" y="${r1(h * 0.5)}" width="${r1(bw)}" height="${r1(h * 0.14)}" fill="rgba(255,255,255,.75)"/>`;
  } else if (kind === 1) {
    // caixa
    const bw = s * 0.42;
    const top = floorY - bw * 0.8;
    body +=
      `<polygon points="${r1(cx - bw / 2)},${r1(top + bw * 0.15)} ${r1(cx)},${r1(top)} ${r1(cx + bw / 2)},${r1(top + bw * 0.15)} ${r1(cx)},${r1(top + bw * 0.3)}" fill="${hsl(hue + 180, 55, 62)}"/>` +
      `<polygon points="${r1(cx - bw / 2)},${r1(top + bw * 0.15)} ${r1(cx)},${r1(top + bw * 0.3)} ${r1(cx)},${r1(floorY)} ${r1(cx - bw / 2)},${r1(floorY - bw * 0.15)}" fill="${main}"/>` +
      `<polygon points="${r1(cx + bw / 2)},${r1(top + bw * 0.15)} ${r1(cx)},${r1(top + bw * 0.3)} ${r1(cx)},${r1(floorY)} ${r1(cx + bw / 2)},${r1(floorY - bw * 0.15)}" fill="${dark}"/>`;
  } else {
    // tênis/sacola: sacola
    const bw = s * 0.4;
    const top = floorY - bw;
    body +=
      `<path d="M${r1(cx - bw * 0.2)} ${r1(top)} a${r1(bw * 0.2)} ${r1(bw * 0.2)} 0 0 1 ${r1(bw * 0.4)} 0" fill="none" stroke="${dark}" stroke-width="${r1(s * 0.02)}"/>` +
      `<rect x="${r1(cx - bw / 2)}" y="${r1(top)}" width="${r1(bw)}" height="${r1(bw)}" rx="${r1(bw * 0.06)}" fill="${main}"/>` +
      `<circle cx="${r1(cx)}" cy="${r1(top + bw * 0.5)}" r="${r1(bw * 0.14)}" fill="rgba(255,255,255,.8)"/>`;
  }
  return wrap(w, h, body, 'Produto');
}

function landscape(rand: () => number, w: number, h: number): string {
  const hue = 180 + rand() * 60;
  const night = rand() < 0.2;
  const sky1 = night ? hsl(hue + 20, 45, 14) : hsl(hue, 70, 72);
  const sky2 = night ? hsl(hue, 40, 28) : hsl(hue + 25, 75, 88);
  const sunX = w * (0.2 + rand() * 0.6);
  const sunY = h * (0.2 + rand() * 0.2);
  let body =
    `<defs><linearGradient id="sky" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${sky1}"/><stop offset="1" stop-color="${sky2}"/></linearGradient></defs>` +
    `<rect width="${w}" height="${h}" fill="url(#sky)"/>` +
    `<circle cx="${r1(sunX)}" cy="${r1(sunY)}" r="${r1(Math.min(w, h) * 0.08)}" fill="${night ? '#f1f5f9' : '#fff7d6'}"/>`;
  const layers = 3;
  for (let l = 0; l < layers; l++) {
    const base = h * (0.55 + l * 0.14);
    const amp = h * (0.18 - l * 0.04);
    const pts: string[] = [`0,${r1(h)}`];
    const steps = 6 + Math.floor(rand() * 4);
    for (let i = 0; i <= steps; i++) {
      const x = (w * i) / steps;
      const y = base - rand() * amp;
      pts.push(`${r1(x)},${r1(y)}`);
    }
    pts.push(`${r1(w)},${r1(h)}`);
    const light = night ? 18 + l * 6 : 58 - l * 14;
    body += `<polygon points="${pts.join(' ')}" fill="${hsl(140 + rand() * 40 - l * 10, 30 + l * 8, light)}"/>`;
  }
  return wrap(w, h, body, 'Paisagem');
}

function logo(rand: () => number, w: number, h: number, label?: string): string {
  const hue = rand() * 360;
  const c1 = hsl(hue, 70, 50);
  const c2 = hsl(hue + 40, 75, 60);
  const name = label ?? brandName(rand);
  const s = h * 0.62;
  const x = h * 0.2;
  const y = (h - s) / 2;
  const mark = Math.floor(rand() * 4);
  let m: string;
  if (mark === 0)
    m = `<circle cx="${r1(x + s / 2)}" cy="${r1(h / 2)}" r="${r1(s / 2)}" fill="${c1}"/><circle cx="${r1(x + s * 0.65)}" cy="${r1(h / 2 - s * 0.12)}" r="${r1(s * 0.22)}" fill="${c2}"/>`;
  else if (mark === 1)
    m = `<rect x="${r1(x)}" y="${r1(y)}" width="${r1(s)}" height="${r1(s)}" rx="${r1(s * 0.22)}" fill="${c1}"/><rect x="${r1(x + s * 0.28)}" y="${r1(y + s * 0.28)}" width="${r1(s * 0.44)}" height="${r1(s * 0.44)}" rx="${r1(s * 0.1)}" fill="${c2}"/>`;
  else if (mark === 2)
    m = `<polygon points="${r1(x + s / 2)},${r1(y)} ${r1(x + s)},${r1(y + s)} ${r1(x)},${r1(y + s)}" fill="${c1}"/><polygon points="${r1(x + s / 2)},${r1(y + s * 0.4)} ${r1(x + s * 0.75)},${r1(y + s)} ${r1(x + s * 0.25)},${r1(y + s)}" fill="${c2}"/>`;
  else
    m = `<path d="M${r1(x)} ${r1(y + s)} L${r1(x + s * 0.35)} ${r1(y)} L${r1(x + s * 0.65)} ${r1(y + s * 0.6)} L${r1(x + s)} ${r1(y)} L${r1(x + s)} ${r1(y + s)}z" fill="${c1}"/>`;
  const body =
    m +
    `<text x="${r1(x + s + h * 0.18)}" y="50%" dy=".35em" font-family="system-ui, sans-serif" font-weight="700" font-size="${r1(h * 0.36)}" fill="#111827">${escapeXml(name)}</text>`;
  return wrap(w, h, body, `Logo ${name}`);
}

/** SVG do placeholder. Tamanho padrão em `PLACEHOLDER_SIZES`; dimensões limitadas a 4096 px. */
export function placeholderSvg(kind: PlaceholderKind, opts: PlaceholderOptions = {}): string {
  if (!PLACEHOLDER_KINDS.includes(kind)) {
    throw new Error(
      `Tipo de placeholder inválido: "${String(kind)}" (use ${PLACEHOLDER_KINDS.join(', ')})`,
    );
  }
  const [dw, dh] = PLACEHOLDER_SIZES[kind];
  const size = (v: number | undefined, d: number): number =>
    v && Number.isFinite(v) && v > 0 ? Math.min(4096, Math.max(8, Math.round(v))) : d;
  const w = size(opts.width, dw);
  const h = size(opts.height, dh);
  const seed = `${kind}:${opts.seed ?? '1'}`;
  const rand = seededRandom(seed);
  switch (kind) {
    case 'avatar':
      return avatar(rand, w, h, opts.label);
    case 'product':
      return product(rand, w, h);
    case 'landscape':
      return landscape(rand, w, h);
    case 'logo':
      return logo(rand, w, h, opts.label);
  }
}

/** Nome de arquivo estável do placeholder: `avatar-<seed>-256x256.svg` (seed sanitizada). */
export function placeholderFileName(kind: PlaceholderKind, opts: PlaceholderOptions = {}): string {
  const [dw, dh] = PLACEHOLDER_SIZES[kind];
  const seed =
    String(opts.seed ?? '1')
      .normalize('NFD')
      .replace(/[\u0300-\u036F]/g, '')
      .replace(/[^a-zA-Z0-9_-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || `h${hashSeed(String(opts.seed)).toString(36)}`;
  const w = opts.width ? Math.round(opts.width) : dw;
  const h = opts.height ? Math.round(opts.height) : dh;
  const label = opts.label ? `-${hashSeed(opts.label).toString(36)}` : '';
  return `${kind}-${seed}${label}-${w}x${h}.svg`;
}

/** Data URL do SVG (para documentos sem caminho e para a interface). */
export function svgDataUrl(svg: string): string {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}
