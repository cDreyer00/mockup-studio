import type { Document, FontRef } from './types.js';

const FORMATS: Record<string, string> = {
  woff2: 'woff2',
  woff: 'woff',
  ttf: 'truetype',
  otf: 'opentype',
};

/** Extensões de arquivo de fonte aceitas em `assets/fonts/`. */
export const FONT_EXTS = Object.keys(FORMATS);

const cssString = (s: string): string => `"${s.replace(/["\\\n\r]/g, '')}"`;

function fontFaces(font: FontRef, urlOf: (file: string) => string): string[] {
  const files = font.files ?? [];
  if (files.length === 0) return [];
  const sameLength = (a?: unknown[]): boolean => !!a && a.length === files.length;
  return files.map((file, i) => {
    const ext = file.split('.').pop()?.toLowerCase() ?? '';
    const fmt = FORMATS[ext];
    const weight = sameLength(font.weights)
      ? String(font.weights![i])
      : font.weights && font.weights.length > 0
        ? `${Math.min(...font.weights)} ${Math.max(...font.weights)}`
        : '100 900';
    const style = sameLength(font.styles) ? font.styles![i] : 'normal';
    const src = `url(${cssString(urlOf(file))})${fmt ? ` format("${fmt}")` : ''}`;
    return `@font-face{font-family:${cssString(font.family)};src:${src};font-weight:${weight};font-style:${style};font-display:block}`;
  });
}

/**
 * Regras `@font-face` das fontes embutidas no documento (`source: 'file'`, arquivos relativos a
 * `assets/`). `urlOf` resolve o arquivo para a URL usada no contexto (ex.: `/assets/<docId>/<file>`
 * no editor e na página de render, `assets/<file>` no HTML exportado). Fontes locais não geram regra.
 *
 * Convenção de `FontRef`: `files[i]` tem peso `weights[i]` e estilo `styles[i]` quando as listas
 * têm o mesmo tamanho; senão todos os arquivos cobrem o intervalo de `weights` (padrão 100–900).
 */
export function fontFaceCss(doc: Pick<Document, 'fonts'>, urlOf: (file: string) => string): string {
  return doc.fonts
    .filter((f) => f.source !== 'local')
    .flatMap((f) => fontFaces(f, urlOf))
    .join('\n');
}
