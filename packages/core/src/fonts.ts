import type { Document, FontRef } from './types.js';

const FORMATS: Record<string, string> = {
  woff2: 'woff2',
  woff: 'woff',
  ttf: 'truetype',
  otf: 'opentype',
};

/** Font file extensions accepted in `assets/fonts/`. */
export const FONT_EXTS = Object.keys(FORMATS);
// eslint-disable-next-line no-control-regex
const SAFE_TEXT = /^[^<>{};"\\\x60\u0000-\u001f\u007f]+$/;
const cssString = (s: string): string =>
  // eslint-disable-next-line no-control-regex
  '"' + s.replace(/[<>{};"'\\\x60\u0000-\u001f\u007f]/g, '') + '"';

/** URL inside url("..."): ';' and ',' are valid (data URL); anything else that escapes CSS/HTML is removed. */
const cssUrl = (s: string): string =>
  // eslint-disable-next-line no-control-regex
  '"' + s.replace(/[<>"'\\\x60\u0000-\u001f\u007f]/g, '') + '"';

const STYLES = new Set(['normal', 'italic', 'oblique']);

/** Relative file, with no ".." or scheme, and no characters that escape CSS/HTML. */
function safeFile(file: unknown): file is string {
  return (
    typeof file === 'string' &&
    SAFE_TEXT.test(file) &&
    !file.startsWith('/') &&
    !/^[a-z][a-z0-9+.-]*:/i.test(file) &&
    !file.includes('\\') &&
    !file.split('/').some((seg) => seg === '..' || seg === '')
  );
}

const safeWeight = (w: unknown): w is number =>
  typeof w === 'number' && Number.isInteger(w) && w >= 1 && w <= 1000;

function fontFaces(font: FontRef, urlOf: (file: string) => string, display: FontDisplay): string[] {
  if (typeof font.family !== 'string' || !SAFE_TEXT.test(font.family)) return [];
  const files = font.files ?? [];
  if (files.length === 0) return [];
  const weights = font.weights?.every(safeWeight) ? font.weights : undefined;
  const sameLength = (a?: unknown[]): boolean => !!a && a.length === files.length;
  return files.flatMap((file, i) => {
    if (!safeFile(file)) return [];
    const ext = file.split('.').pop()?.toLowerCase() ?? '';
    const fmt = FORMATS[ext];
    const weight = sameLength(weights)
      ? String(weights![i])
      : weights && weights.length > 0
        ? `${Math.min(...weights)} ${Math.max(...weights)}`
        : '100 900';
    const rawStyle = sameLength(font.styles) ? font.styles![i] : 'normal';
    const style = rawStyle && STYLES.has(rawStyle) ? rawStyle : 'normal';
    const src = `url(${cssUrl(urlOf(file))})${fmt ? ` format("${fmt}")` : ''}`;
    return [
      `@font-face{font-family:${cssString(font.family)};src:${src};font-weight:${weight};font-style:${style};font-display:${display}}`,
    ];
  });
}

/** `block` keeps rendering deterministic (no text swapping fonts); `swap` is used for the delivered code. */
export type FontDisplay = 'block' | 'swap';

/**
 * `@font-face` rules for the fonts embedded in the document (`source: 'file'`, files relative to
 * `assets/`). `urlOf` resolves the file to the URL used in the context (e.g. `/assets/<docId>/<file>`
 * in the editor and the render page, `assets/<file>` in the exported HTML). Local fonts generate no rule.
 *
 * `FontRef` convention: `files[i]` has weight `weights[i]` and style `styles[i]` when the lists
 * have the same length; otherwise all files cover the `weights` range (default 100–900).
 *
 * `display` (default `block`, used in the render and the editor) becomes the `font-display`; the
 * export formats pass `swap`.
 */
export function fontFaceCss(
  doc: Pick<Document, 'fonts'>,
  urlOf: (file: string) => string,
  display: FontDisplay = 'block',
): string {
  return doc.fonts
    .filter((f) => f.source !== 'local')
    .flatMap((f) => fontFaces(f, urlOf, display))
    .join('\n');
}
