/**
 * Offline icon kits: Lucide (`lucide-static`: `icon-nodes.json` + `tags.json`) and Heroicons
 * (`@iconify-json/heroicons`: `icons.json` in Iconify format), loaded on demand. JSON imports only
 * (no reading package files by path), so it also works when packaged in a bundle.
 */

type IconNode = [tag: string, attrs: Record<string, string | number>];

interface IconData {
  nodes: Record<string, IconNode[]>;
  tags: Record<string, string[]>;
  names: string[];
}

let cache: Promise<IconData> | null = null;

export function loadIcons(): Promise<IconData> {
  cache ??= (async () => {
    const [nodes, tags] = await Promise.all([
      import('lucide-static/icon-nodes.json', { with: { type: 'json' } }),
      import('lucide-static/tags.json', { with: { type: 'json' } }),
    ]);
    const n = (nodes as unknown as { default: Record<string, IconNode[]> }).default;
    const t = (tags as unknown as { default: Record<string, string[]> }).default;
    return { nodes: n, tags: t, names: Object.keys(n).sort() };
  })();
  return cache;
}

/** `ArrowRight`, `arrow_right`, `Arrow Right` → `arrow-right`. */
export function toKebab(name: string): string {
  return name
    .trim()
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/[\s_]+/g, '-')
    .toLowerCase();
}

function editDistance(a: string, b: string): number {
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0]!;
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j]!;
      prev[j] = Math.min(prev[j]! + 1, prev[j - 1]! + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = tmp;
    }
  }
  return prev[b.length]!;
}

/** Up to `limit` names similar to `name` (substring or small edit distance). */
export function suggestIcons(data: IconData, name: string, limit = 5): string[] {
  const q = toKebab(name);
  const scored: { n: string; s: number }[] = [];
  for (const n of data.names) {
    let s: number;
    if (n.includes(q) || q.includes(n)) s = 0.5 + Math.abs(n.length - q.length) / 100;
    else {
      const d = editDistance(q, n);
      if (d > Math.max(2, Math.floor(q.length / 3))) continue;
      s = 1 + d;
    }
    scored.push({ n, s });
  }
  return scored
    .sort((a, b) => a.s - b.s || a.n.localeCompare(b.n))
    .slice(0, limit)
    .map((x) => x.n);
}

/** Resolves the name (kebab or PascalCase) to the canonical name, or `null`. */
export function resolveIconName(data: IconData, name: string): string | null {
  const k = toKebab(name);
  const candidates = [k, k.replace(/([a-z])(\d)/g, '$1-$2'), k.replace(/-(\d)/g, '$1')];
  return candidates.find((c) => data.nodes[c]) ?? null;
}

const esc = (v: string | number): string =>
  String(v).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

export interface IconSvgOptions {
  size: number;
  color: string;
  strokeWidth: number;
}

/** Builds the icon's `<svg>` with literal color and stroke (`currentColor` is not inherited inside `<img>`). */
export function buildIconSvg(nodes: IconNode[], o: IconSvgOptions): string {
  const body = nodes
    .map(([tag, attrs]) => {
      const a = Object.entries(attrs)
        .filter(([k]) => k !== 'key')
        .map(([k, v]) => ` ${k}="${esc(v)}"`)
        .join('');
      return `<${tag}${a}/>`;
    })
    .join('');
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${o.size}" height="${o.size}" viewBox="0 0 24 24" ` +
    `fill="none" stroke="${esc(o.color)}" stroke-width="${o.strokeWidth}" stroke-linecap="round" stroke-linejoin="round">` +
    `${body}</svg>`
  );
}

export interface IconHit {
  name: string;
  tags: string[];
}

export function searchIconNames(data: IconData, query: string, limit = 20): IconHit[] {
  const q = query.trim().toLowerCase();
  const kq = toKebab(query);
  if (!q) return [];
  const hits: { name: string; s: number }[] = [];
  for (const name of data.names) {
    const tags = data.tags[name] ?? [];
    let s = -1;
    if (name === kq) s = 0;
    else if (name.startsWith(kq)) s = 1;
    else if (name.includes(kq)) s = 2;
    else if (tags.some((t) => t.toLowerCase() === q)) s = 3;
    else if (tags.some((t) => t.toLowerCase().includes(q))) s = 4;
    if (s >= 0) hits.push({ name, s });
  }
  return hits
    .sort((a, b) => a.s - b.s || a.name.length - b.name.length || a.name.localeCompare(b.name))
    .slice(0, limit)
    .map((h) => ({ name: h.name, tags: data.tags[h.name] ?? [] }));
}

// ---------------------------------------------------------------------------------------------
// Kit registry
// ---------------------------------------------------------------------------------------------

export type IconKit = 'lucide' | 'heroicons';

export interface IconKitInfo {
  kit: IconKit;
  label: string;
  license: string;
  count: number;
  /** How the kit draws: stroke or fill. */
  note: string;
}

interface IconifyIcon {
  body: string;
  width?: number;
  height?: number;
}

interface IconifySet {
  icons: Record<string, IconifyIcon>;
  aliases?: Record<string, { parent: string }>;
  width?: number;
  height?: number;
}

interface HeroData {
  set: IconifySet;
  names: string[];
  /** Alias to the canonical name. */
  aliases: Record<string, string>;
}

let heroCache: Promise<HeroData> | null = null;

export function loadHeroicons(): Promise<HeroData> {
  heroCache ??= (async () => {
    const mod = await import('@iconify-json/heroicons/icons.json', { with: { type: 'json' } });
    const set = (mod as unknown as { default: IconifySet }).default;
    const aliases: Record<string, string> = {};
    for (const [a, v] of Object.entries(set.aliases ?? {})) aliases[a] = v.parent;
    return { set, names: Object.keys(set.icons).sort(), aliases };
  })();
  return heroCache;
}

/** Style of a Heroicon from its suffix: `outline` (24, no suffix), `solid`, `20-solid`, `16-solid`. */
export function heroiconStyle(name: string): 'outline' | 'solid' | '20-solid' | '16-solid' {
  const m = /-(20-solid|16-solid|solid)$/.exec(name);
  return m ? (m[1] as 'solid' | '20-solid' | '16-solid') : 'outline';
}

export interface IconRef {
  kit: IconKit;
  name: string;
}

export interface KitIconHit extends IconRef {
  tags: string[];
}

const KITS: IconKit[] = ['lucide', 'heroicons'];

export async function listIconKits(): Promise<IconKitInfo[]> {
  const [l, h] = await Promise.all([loadIcons(), loadHeroicons()]);
  return [
    {
      kit: 'lucide',
      label: 'Lucide',
      license: 'ISC',
      count: l.names.length,
      note: 'stroke, 24x24',
    },
    {
      kit: 'heroicons',
      label: 'Heroicons',
      license: 'MIT',
      count: h.names.length,
      note: 'outline 24 (no suffix, stroke); -solid (24), -20-solid and -16-solid (fill)',
    },
  ];
}

/** Candidates for the same name: `bars3` also tries `bars-3`. */
function nameCandidates(name: string): string[] {
  const k = toKebab(name);
  return [k, k.replace(/([a-z])(\d)/g, '$1-$2'), k.replace(/-(\d)/g, '$1')];
}

/** Splits `kit/name` or `kit:name`; without a known kit prefix returns just the name. */
export function parseIconRef(input: string): { kit?: IconKit; name: string } {
  const m = /^\s*(lucide|heroicons)\s*[/:]\s*(.+)$/i.exec(input);
  if (m) return { kit: m[1]!.toLowerCase() as IconKit, name: m[2]!.trim() };
  return { name: input.trim() };
}

/**
 * Resolves `lucide/arrow-right`, `heroicons/arrow-right`, `heroicons:arrow-right` or a name without
 * a kit (Lucide first, then Heroicons). `kit` forces the kit when the name has no prefix.
 */
export async function resolveIcon(nameOrKitName: string, kit?: IconKit): Promise<IconRef | null> {
  const p = parseIconRef(nameOrKitName);
  const only = p.kit ?? kit;
  for (const k of only ? [only] : KITS) {
    if (k === 'lucide') {
      const c = resolveIconName(await loadIcons(), p.name);
      if (c) return { kit: 'lucide', name: c };
    } else {
      const h = await loadHeroicons();
      for (const c of nameCandidates(p.name)) {
        const real = h.set.icons[c] ? c : h.aliases[c];
        if (real && h.set.icons[real]) return { kit: 'heroicons', name: real };
      }
    }
  }
  return null;
}

function interleave<T>(lists: T[][]): T[] {
  const out: T[] = [];
  for (let i = 0; lists.some((l) => i < l.length); i++) {
    for (const l of lists) if (i < l.length) out.push(l[i]!);
  }
  return out;
}

/** Up to `limit` similar icons (`kit/name`), from all kits or just one. */
export async function suggestSimilarIcons(
  name: string,
  opts: { kit?: IconKit; limit?: number } = {},
): Promise<string[]> {
  const limit = opts.limit ?? 5;
  const p = parseIconRef(name);
  const only = p.kit ?? opts.kit;
  const kits = only ? [only] : KITS;
  const per = Math.max(1, Math.ceil(limit / kits.length));
  const lists: string[][] = [];
  for (const k of kits) {
    if (k === 'lucide') {
      lists.push(suggestIcons(await loadIcons(), p.name, per).map((n) => `lucide/${n}`));
    } else {
      const h = await loadHeroicons();
      // Without an explicit style, suggest only the outline ones (the rest are size/fill variations).
      const base = /solid/.test(p.name)
        ? h.names
        : h.names.filter((n) => heroiconStyle(n) === 'outline');
      const data = { nodes: {}, tags: {}, names: base };
      lists.push(suggestIcons(data, p.name, per).map((n) => `heroicons/${n}`));
    }
  }
  return interleave(lists).slice(0, limit);
}

function searchHeroicons(h: HeroData, query: string, limit: number): KitIconHit[] {
  const q = query.trim().toLowerCase();
  const kq = toKebab(query);
  if (!q) return [];
  const hits: { name: string; s: number }[] = [];
  for (const name of h.names) {
    let s = -1;
    if (name === kq) s = 0;
    else if (name.startsWith(kq)) s = 1;
    else if (name.includes(kq)) s = 2;
    else if (heroiconStyle(name) === q) s = 3;
    if (s >= 0) hits.push({ name, s });
  }
  return hits
    .sort((a, b) => a.s - b.s || a.name.length - b.name.length || a.name.localeCompare(b.name))
    .slice(0, limit)
    .map((x) => ({ kit: 'heroicons' as const, name: x.name, tags: [heroiconStyle(x.name)] }));
}

/**
 * Searches by name (and tags, in Lucide) in one kit or in all. For "all" it interleaves the kits so
 * one does not hide the other. Heroicons tags: the style (`outline`, `solid`, `20-solid`, `16-solid`).
 */
export async function searchIcons(
  query: string,
  opts: { kit?: IconKit | 'all'; limit?: number } = {},
): Promise<KitIconHit[]> {
  const limit = opts.limit ?? 20;
  const kits = !opts.kit || opts.kit === 'all' ? KITS : [opts.kit];
  const lists: KitIconHit[][] = [];
  for (const k of kits) {
    if (k === 'lucide') {
      const hits = searchIconNames(await loadIcons(), query, limit);
      lists.push(hits.map((h) => ({ kit: 'lucide' as const, ...h })));
    } else {
      lists.push(searchHeroicons(await loadHeroicons(), query, limit));
    }
  }
  return interleave(lists).slice(0, limit);
}

export interface KitIconSvgOptions {
  size: number;
  color: string;
  /** Only applies to stroke kits (Lucide and outline Heroicons); when unset, uses the icon's own. */
  strokeWidth?: number;
}

/** Does the icon use a stroke (and therefore accept `stroke_width`)? Lucide and outline Heroicons. */
export function isStrokeIcon(ref: IconRef): boolean {
  return ref.kit === 'lucide' || heroiconStyle(ref.name) === 'outline';
}

/**
 * The icon's `<svg>` with a literal color (`currentColor` is not inherited inside `<img>`), keeping
 * the icon's `viewBox` (24, 20 or 16) and the requested size.
 */
export async function buildKitIconSvg(ref: IconRef, o: KitIconSvgOptions): Promise<string> {
  if (ref.kit === 'lucide') {
    const data = await loadIcons();
    return buildIconSvg(data.nodes[ref.name]!, {
      size: o.size,
      color: o.color,
      strokeWidth: o.strokeWidth ?? 2,
    });
  }
  const h = await loadHeroicons();
  const icon = h.set.icons[ref.name]!;
  const w = icon.width ?? h.set.width ?? 24;
  const ht = icon.height ?? h.set.height ?? 24;
  let body = icon.body.replace(/currentColor/g, () => esc(o.color));
  if (o.strokeWidth !== undefined && heroiconStyle(ref.name) === 'outline') {
    body = body.replace(/stroke-width="[^"]*"/g, `stroke-width="${esc(o.strokeWidth)}"`);
  }
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${o.size}" height="${o.size}" viewBox="0 0 ${w} ${ht}">` +
    `${body}</svg>`
  );
}
