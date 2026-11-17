import type { Document, FontRef } from './types.js';

const FORMATS: Record<string, string> = {
  woff2: 'woff2',
  woff: 'woff',
  ttf: 'truetype',
  otf: 'opentype',
};

/** Extensões de arquivo de fonte aceitas em `assets/fonts/`. */
export const FONT_EXTS = Object.keys(FORMATS);
// eslint-disable-next-line no-control-regex
const SAFE_TEXT = /^[^<>{};"\\\x60\u0000-\u001f\u007f]+$/;
const cssString = (s: string): string =>
  // eslint-disable-next-line no-control-regex
  '"' + s.replace(/[<>{};"'\\\x60\u0000-\u001f\u007f]/g, '') + '"';

/** URL dentro de url("..."): ';' e ',' são válidos (data URL), o resto que escapa do CSS/HTML é removido. */
const cssUrl = (s: string): string =>
  // eslint-disable-next-line no-control-regex
  '"' + s.replace(/[<>"'\\\x60\u0000-\u001f\u007f]/g, '') + '"';

const STYLES = new Set(['normal', 'italic', 'oblique']);

/** Arquivo relativo, sem ".." nem esquema, e sem caracteres que escapem do CSS/HTML. */
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

/** `block` deixa o render determinístico (sem texto trocando de fonte); `swap` é o do código entregue. */
export type FontDisplay = 'block' | 'swap';

/**
 * Regras `@font-face` das fontes embutidas no documento (`source: 'file'`, arquivos relativos a
 * `assets/`). `urlOf` resolve o arquivo para a URL usada no contexto (ex.: `/assets/<docId>/<file>`
 * no editor e na página de render, `assets/<file>` no HTML exportado). Fontes locais não geram regra.
 *
 * Convenção de `FontRef`: `files[i]` tem peso `weights[i]` e estilo `styles[i]` quando as listas
 * têm o mesmo tamanho; senão todos os arquivos cobrem o intervalo de `weights` (padrão 100–900).
 *
 * `display` (padrão `block`, usado no render e no editor) vira o `font-display`; os formatos de
 * exportação passam `swap`.
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
