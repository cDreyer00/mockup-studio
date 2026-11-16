/**
 * Ícones Lucide a partir de `lucide-static` (`icon-nodes.json` + `tags.json`), carregados sob
 * demanda. Só imports de JSON (sem ler arquivos do pacote por caminho), para funcionar também
 * empacotado num bundle.
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

/** Até `limit` nomes parecidos com `name` (substring ou pequena distância de edição). */
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

/** Resolve o nome (kebab ou PascalCase) para o nome canônico, ou `null`. */
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

/** Monta o `<svg>` do ícone com cor e traço literais (`currentColor` não herda dentro de `<img>`). */
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
