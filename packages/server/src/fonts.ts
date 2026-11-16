/**
 * Fontes: listagem das instaladas no sistema (sem dependência nativa), parser do CSS do Google
 * Fonts e utilitários para `add_font`.
 */
import { execFile } from 'node:child_process';
import path from 'node:path';

export interface SystemFont {
  family: string;
  styles: string[];
  files: string[];
}

const run = (cmd: string, args: string[], maxBuffer = 64 * 1024 * 1024): Promise<string> =>
  new Promise((resolve, reject) => {
    execFile(cmd, args, { maxBuffer, windowsHide: true }, (err, stdout) =>
      err ? reject(err) : resolve(stdout),
    );
  });

const STYLE_WORDS = [
  'Thin',
  'Hairline',
  'ExtraLight',
  'Extra Light',
  'UltraLight',
  'Ultra Light',
  'Light',
  'SemiLight',
  'Semilight',
  'Semi Light',
  'Regular',
  'Normal',
  'Book',
  'Medium',
  'SemiBold',
  'Semibold',
  'Semi Bold',
  'DemiBold',
  'Demi Bold',
  'Demi',
  'ExtraBold',
  'Extra Bold',
  'UltraBold',
  'Ultra Bold',
  'Bold',
  'Heavy',
  'Black',
  'Italic',
  'Oblique',
  'Slanted',
];
const STYLE_RE = new RegExp(
  `\\s+(?:${STYLE_WORDS.map((w) => w.replace(/ /g, '\\s')).join('|')})$`,
  'i',
);

/** Separa "Arial Bold Italic" em família "Arial" e estilo "Bold Italic". */
export function splitFamilyStyle(full: string): { family: string; style: string } {
  let family = full.trim();
  const styles: string[] = [];
  for (;;) {
    const m = STYLE_RE.exec(family);
    if (!m || family.length === m[0].length) break;
    styles.unshift(m[0].trim());
    family = family.slice(0, family.length - m[0].length).trim();
  }
  return { family, style: styles.join(' ') || 'Regular' };
}

function addFont(map: Map<string, SystemFont>, family: string, style: string, file: string): void {
  if (!family) return;
  const key = family.toLowerCase();
  let f = map.get(key);
  if (!f) {
    f = { family, styles: [], files: [] };
    map.set(key, f);
  }
  if (style && !f.styles.includes(style)) f.styles.push(style);
  if (file && !f.files.includes(file)) f.files.push(file);
}

/** Saída de `reg query ...\Fonts` (Windows). */
export function parseRegFonts(text: string): SystemFont[] {
  const map = new Map<string, SystemFont>();
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s+(.+?)\s+REG_\w+\s+(.+?)\s*$/.exec(line);
    if (!m) continue;
    const display = m[1]!.replace(/\s*\((?:TrueType|OpenType|All res|VGA res)\)\s*$/i, '');
    for (const part of display.split(/\s+&\s+/)) {
      const { family, style } = splitFamilyStyle(part);
      addFont(map, family, style, m[2]!);
    }
  }
  return sortFonts(map);
}

/** Saída de `fc-list --format '%{family}\t%{style}\t%{file}\n'` (Linux). */
export function parseFcList(text: string): SystemFont[] {
  const map = new Map<string, SystemFont>();
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const [fam, style, file] = line.split('\t');
    const family = (fam ?? '').split(',')[0]!.trim();
    addFont(map, family, (style ?? '').split(',')[0]!.trim(), file?.trim() ?? '');
  }
  return sortFonts(map);
}

/** Saída de `system_profiler SPFontsDataType -json` (macOS). */
export function parseSystemProfiler(json: string): SystemFont[] {
  const map = new Map<string, SystemFont>();
  const data = JSON.parse(json) as {
    SPFontsDataType?: { path?: string; typefaces?: { family?: string; style?: string }[] }[];
  };
  for (const f of data.SPFontsDataType ?? []) {
    for (const t of f.typefaces ?? []) addFont(map, t.family ?? '', t.style ?? '', f.path ?? '');
  }
  return sortFonts(map);
}

function sortFonts(map: Map<string, SystemFont>): SystemFont[] {
  return [...map.values()].sort((a, b) => a.family.localeCompare(b.family));
}

let cache: Promise<SystemFont[]> | null = null;

async function readSystemFonts(): Promise<SystemFont[]> {
  if (process.platform === 'win32') {
    const keys = [
      'HKLM\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Fonts',
      'HKCU\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Fonts',
    ];
    const outs = await Promise.all(keys.map((k) => run('reg', ['query', k]).catch(() => '')));
    return parseRegFonts(outs.join('\n'));
  }
  if (process.platform === 'darwin') {
    return parseSystemProfiler(await run('system_profiler', ['SPFontsDataType', '-json']));
  }
  return parseFcList(await run('fc-list', ['--format', '%{family}\t%{style}\t%{file}\n']));
}

/** Fontes instaladas (cache em memória; falha de comando = lista vazia). */
export function listSystemFonts(): Promise<SystemFont[]> {
  cache ??= readSystemFonts().catch(() => []);
  return cache;
}

/* ---------- Google Fonts ---------- */

export interface GoogleFace {
  subset: string;
  style: string;
  weight: number;
  url: string;
}

// Blocos `@font-face` do CSS2 do Google, com o subconjunto (comentário "latin", "latin-ext"...).
export function parseGoogleCss(css: string): GoogleFace[] {
  const out: GoogleFace[] = [];
  const re = /\/\*\s*([\w-]+)\s*\*\/\s*@font-face\s*\{([^}]*)\}/g;
  for (const m of css.matchAll(re)) {
    const body = m[2]!;
    const url = /url\(\s*['"]?([^'")\s]+)['"]?\s*\)/.exec(body)?.[1];
    const weight = /font-weight:\s*(\d+)/.exec(body)?.[1];
    const style = /font-style:\s*(\w+)/.exec(body)?.[1] ?? 'normal';
    if (url && weight) out.push({ subset: m[1]!, style, weight: Number(weight), url });
  }
  return out;
}

export function googleCssUrl(family: string, weights: number[]): string {
  const fam = encodeURIComponent(family).replace(/%20/g, '+');
  return `https://fonts.googleapis.com/css2?family=${fam}:wght@${[...weights].sort((a, b) => a - b).join(';')}&display=swap`;
}

/** User-Agent de navegador moderno: faz o Google devolver woff2. */
export const MODERN_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

/* ---------- arquivos de fonte locais ---------- */

const WEIGHT_NAMES: [RegExp, number][] = [
  [/thin|hairline/i, 100],
  [/extra[-_ ]?light|ultra[-_ ]?light/i, 200],
  [/semi[-_ ]?light/i, 350],
  [/light/i, 300],
  [/semi[-_ ]?bold|demi[-_ ]?bold/i, 600],
  [/extra[-_ ]?bold|ultra[-_ ]?bold/i, 800],
  [/black|heavy/i, 900],
  [/medium/i, 500],
  [/bold/i, 700],
  [/regular|normal|book/i, 400],
];

/** Peso e estilo prováveis a partir do nome do arquivo (padrão 400/normal). */
export function guessFontStyle(file: string): { weight: number; style: 'normal' | 'italic' } {
  const base = path.basename(file, path.extname(file));
  const weight = WEIGHT_NAMES.find(([re]) => re.test(base))?.[1] ?? 400;
  return { weight, style: /italic|oblique/i.test(base) ? 'italic' : 'normal' };
}

export function fontSlug(family: string): string {
  const s = family
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return s || 'fonte';
}

/** `font-family` com fallback genérico adequado ao nome. */
export function fontFamilyCss(family: string): string {
  const f = family.toLowerCase();
  const generic = /mono|code|courier|consolas|menlo/.test(f)
    ? 'monospace'
    : /serif(?!.*sans)|times|georgia|garamond|palatino|merriweather|playfair|lora|cambria/.test(
          f,
        ) && !/sans/.test(f)
      ? 'serif'
      : 'sans-serif';
  return `font-family: "${family}", ${generic};`;
}
