import type { SnapshotFont } from '../format.js';
import type { AssetRegistry } from './assets.js';
import { splitTop } from './util.js';

interface FaceDecl {
  family: string;
  weight: string;
  style: string;
  src: string;
  unicodeRange?: string;
  /** URL base para resolver os `url()` do `src`. */
  base: string;
}

const unquote = (s: string): string =>
  s
    .trim()
    .replace(/^["']|["']$/g, '')
    .trim();

/** Rank de preferência de formato (menor = melhor): woff2 > woff > ttf > otf > resto. */
function formatRank(url: string, format: string): number {
  const f = (format || /\.(\w+)(?:[?#]|$)/.exec(url)?.[1] || '').toLowerCase();
  if (f.includes('woff2')) return 0;
  if (f.includes('woff')) return 1;
  if (f.includes('truetype') || f === 'ttf') return 2;
  if (f.includes('opentype') || f === 'otf') return 3;
  return 4;
}

function parseSrc(src: string, base: string): string[] {
  const found: { url: string; rank: number; order: number }[] = [];
  const re = /url\(\s*(["']?)(.*?)\1\s*\)(?:\s*format\(\s*(["']?)([^"')]+)\3\s*\))?/gi;
  let m: RegExpExecArray | null;
  let order = 0;
  while ((m = re.exec(src))) {
    const raw = m[2]!;
    if (!raw) continue;
    try {
      const url = new URL(raw, base).href;
      found.push({ url, rank: formatRank(url, m[4] ?? ''), order: order++ });
    } catch {
      /* URL inválida: ignora */
    }
  }
  found.sort((a, b) => a.rank - b.rank || a.order - b.order);
  // Com woff2 disponível, os formatos legados só aumentariam o snapshot.
  const urls = found.map((f) => f.url);
  return found[0]?.rank === 0 ? urls.slice(0, 1) : urls;
}

function declsFromText(body: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const d of splitTop(body.replace(/\/\*[\s\S]*?\*\//g, ''), ';')) {
    const i = d.indexOf(':');
    if (i > 0) out[d.slice(0, i).trim().toLowerCase()] = d.slice(i + 1).trim();
  }
  return out;
}

function faceFromDecls(d: Record<string, string>, base: string): FaceDecl | null {
  const family = unquote(d['font-family'] ?? '');
  const src = d['src'] ?? '';
  if (!family || !src) return null;
  return {
    family,
    weight: d['font-weight'] || '400',
    style: d['font-style'] || 'normal',
    src,
    unicodeRange: d['unicode-range'] || undefined,
    base,
  };
}

async function fetchSheetFaces(href: string, warn: (m: string) => void): Promise<FaceDecl[]> {
  try {
    const res = await fetch(href, { credentials: 'same-origin' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();
    const faces: FaceDecl[] = [];
    const re = /@font-face\s*\{([^}]*)\}/gi;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
      const face = faceFromDecls(declsFromText(m[1]!), href);
      if (face) faces.push(face);
    }
    return faces;
  } catch (err) {
    warn(
      `Não foi possível ler a folha de estilo "${href}" para coletar fontes: ${err instanceof Error ? err.message : String(err)}`,
    );
    return [];
  }
}

async function walkRules(
  rules: CSSRuleList,
  base: string,
  faces: FaceDecl[],
  seen: Set<CSSStyleSheet>,
  warn: (m: string) => void,
  depth: number,
): Promise<void> {
  for (const rule of Array.from(rules)) {
    if (rule.type === 5) {
      const s = (rule as CSSFontFaceRule).style;
      const face = faceFromDecls(
        {
          'font-family': s.getPropertyValue('font-family'),
          src: s.getPropertyValue('src'),
          'font-weight': s.getPropertyValue('font-weight'),
          'font-style': s.getPropertyValue('font-style'),
          'unicode-range': s.getPropertyValue('unicode-range'),
        },
        base,
      );
      if (face) faces.push(face);
    } else if (rule.type === 3) {
      const sheet = (rule as CSSImportRule).styleSheet;
      if (sheet) await walkSheet(sheet, faces, seen, warn, depth + 1);
    } else {
      const nested = (rule as CSSGroupingRule).cssRules;
      if (nested) await walkRules(nested, base, faces, seen, warn, depth);
    }
  }
}

async function walkSheet(
  sheet: CSSStyleSheet,
  faces: FaceDecl[],
  seen: Set<CSSStyleSheet>,
  warn: (m: string) => void,
  depth: number,
): Promise<void> {
  if (seen.has(sheet) || depth > 6) return;
  seen.add(sheet);
  let rules: CSSRuleList;
  try {
    rules = sheet.cssRules;
  } catch {
    // Folha de outra origem sem CORS: tenta ler o texto e extrair os @font-face por regex.
    if (sheet.href) faces.push(...(await fetchSheetFaces(sheet.href, warn)));
    return;
  }
  await walkRules(rules, sheet.href ?? document.baseURI, faces, seen, warn, depth);
}

/**
 * Fontes `@font-face` cujas famílias são usadas pelos nós capturados (`used`: famílias em minúsculas,
 * sem aspas). Os arquivos viram assets `kind: 'font'`.
 */
export async function collectFonts(
  used: Set<string>,
  assets: AssetRegistry,
  warn: (message: string) => void,
): Promise<SnapshotFont[]> {
  if (used.size === 0) return [];
  const faces: FaceDecl[] = [];
  const seen = new Set<CSSStyleSheet>();
  const sheets: CSSStyleSheet[] = [
    ...Array.from(document.styleSheets),
    ...((document as Document & { adoptedStyleSheets?: CSSStyleSheet[] }).adoptedStyleSheets ?? []),
  ];
  for (const sheet of sheets) await walkSheet(sheet, faces, seen, warn, 0);

  const fonts: SnapshotFont[] = [];
  const dedupe = new Set<string>();
  for (const face of faces) {
    if (!used.has(face.family.toLowerCase())) continue;
    const urls = parseSrc(face.src, face.base);
    if (urls.length === 0) continue;
    const key = `${face.family.toLowerCase()}|${face.weight}|${face.style}|${face.unicodeRange ?? ''}|${urls.join(',')}`;
    if (dedupe.has(key)) continue;
    dedupe.add(key);
    const font: SnapshotFont = {
      family: face.family,
      weight: face.weight,
      style: face.style,
      assetIds: urls.map((u) => assets.add(u, 'font').id),
    };
    if (face.unicodeRange) font.unicodeRange = face.unicodeRange;
    fonts.push(font);
  }
  return fonts;
}
