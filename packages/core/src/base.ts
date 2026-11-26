/**
 * Base CSS of the DOCUMENT (not the editor UI): the same on the canvas, on the render page
 * (screenshot) and in the exported code, so all three stay identical.
 *
 * - `box-sizing: border-box` e `margin: 0` on everything (nodes control spacing with padding/gap);
 * - form controls inherit font and color (like Tailwind's preflight);
 * - default document typography: system font, 16px, `line-height: normal`, black text.
 */
export const DOCUMENT_FONT_STACK = "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif";

/** Declarations for the document root (the `body` in exported code). */
export const DOCUMENT_ROOT_DECLARATIONS =
  `font-family:${DOCUMENT_FONT_STACK};font-size:16px;line-height:normal;color:#000;` +
  'font-weight:400;font-style:normal;letter-spacing:normal;text-align:left;' +
  '-webkit-font-smoothing:auto;color-scheme:light';

/** Tailwind v4 default font (`--default-font-family` = `--font-sans`). */
export const TAILWIND_FONT_STACK =
  "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', 'Noto Sans', Arial, sans-serif, 'Apple Color Emoji', 'Segoe UI Emoji', 'Segoe UI Symbol', 'Noto Color Emoji'";

/** Document root with the Tailwind base: like Mockup Studio's, but with the preflight's font and `line-height: 1.5`. */
export const TAILWIND_ROOT_DECLARATIONS =
  `font-family:${TAILWIND_FONT_STACK};font-size:16px;line-height:1.5;color:#000;` +
  'font-weight:400;font-style:normal;letter-spacing:normal;text-align:left;' +
  '-webkit-font-smoothing:auto;color-scheme:light;tab-size:4;-webkit-text-size-adjust:100%';

/**
 * Tailwind v4 preflight (`tailwindcss/preflight.css`, MIT), without the `html`/`:host` rule
 * (it goes to the document root) and without the browser fixes that don't affect layout.
 * Each item is `[selectors, declarations]`; selectors get the scope in `documentBaseCss`.
 */
export const TAILWIND_PREFLIGHT: [string[], string][] = [
  [
    ['*', '::after', '::before', '::backdrop', '::file-selector-button'],
    'box-sizing:border-box;margin:0;padding:0;border:0 solid',
  ],
  [['hr'], 'height:0;color:inherit;border-top-width:1px'],
  [['abbr:where([title])'], 'text-decoration:underline dotted'],
  [['h1', 'h2', 'h3', 'h4', 'h5', 'h6'], 'font-size:inherit;font-weight:inherit'],
  [['a'], 'color:inherit;text-decoration:inherit'],
  [['b', 'strong'], 'font-weight:bolder'],
  [
    ['code', 'kbd', 'samp', 'pre'],
    "font-family:ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace;font-size:1em",
  ],
  [['small'], 'font-size:80%'],
  [['sub', 'sup'], 'font-size:75%;line-height:0;position:relative;vertical-align:baseline'],
  [['sub'], 'bottom:-0.25em'],
  [['sup'], 'top:-0.5em'],
  [['table'], 'text-indent:0;border-color:inherit;border-collapse:collapse'],
  [['progress'], 'vertical-align:baseline'],
  [['summary'], 'display:list-item'],
  [['ol', 'ul', 'menu'], 'list-style:none'],
  [
    ['img', 'svg', 'video', 'canvas', 'audio', 'iframe', 'embed', 'object'],
    'display:block;vertical-align:middle',
  ],
  [['img', 'video'], 'max-width:100%;height:auto'],
  [
    ['button', 'input', 'select', 'optgroup', 'textarea', '::file-selector-button'],
    'font:inherit;font-feature-settings:inherit;font-variation-settings:inherit;letter-spacing:inherit;color:inherit;border-radius:0;background-color:transparent;opacity:1',
  ],
  [['::placeholder'], 'opacity:1;color:color-mix(in oklab, currentcolor 50%, transparent)'],
  [['textarea'], 'resize:vertical'],
  [
    [
      'button',
      'input:where([type="button"], [type="reset"], [type="submit"])',
      '::file-selector-button',
    ],
    'appearance:button',
  ],
  [['::-webkit-inner-spin-button', '::-webkit-outer-spin-button'], 'height:auto'],
  [['[hidden]:where(:not([hidden="until-found"]))'], 'display:none !important'],
];

/**
 * Tailwind v4 default `@keyframes` (`spin`, `ping`, `pulse`, `bounce`, exact definitions from
 * `tailwindcss/theme.css`). Tailwind's `animate-*` utilities store `animation: spin 1s linear infinite`
 * and the like in the node style; without these rules the canvas, the render page and the HTML/React
 * `inline` exports would not animate. They are part of the base when `cssBase === 'tailwind'`
 * (keyframe names are global, so they are not scoped). The Tailwind export itself does not need
 * them: Tailwind generates the `@keyframes` for the `animate-*` classes it finds.
 */
export const TAILWIND_KEYFRAMES = [
  '@keyframes spin{to{transform:rotate(360deg)}}',
  '@keyframes ping{75%,100%{transform:scale(2);opacity:0}}',
  '@keyframes pulse{50%{opacity:.5}}',
  '@keyframes bounce{0%,100%{transform:translateY(-25%);animation-timing-function:cubic-bezier(0.8,0,1,1)}50%{transform:none;animation-timing-function:cubic-bezier(0,0,0.2,1)}}',
].join('\n');

export interface DocumentBaseOptions {
  /** Includes the Tailwind preflight (documents with `cssBase: 'tailwind'`). */
  preflight?: boolean;
}

/**
 * Base CSS. Without `scope`: global rules with the typography on `body` (exported HTML). With `scope`
 * (e.g. `.cv-world`): rules restricted to the container; the typography goes on `rootSelector` (default: the
 * container itself; on the canvas, only the frames, so it doesn't reach UI labels and badges).
 * With `preflight`, adds the Tailwind v4 preflight (scoped the same way) and uses the Tailwind
 * typographic root.
 */
export function documentBaseCss(
  scope?: string,
  rootSelector?: string,
  opts: DocumentBaseOptions = {},
): string {
  const s = scope ? `${scope} ` : '';
  const root = rootSelector ?? scope ?? 'body';
  if (opts.preflight) {
    const scoped = (sel: string): string => (sel.startsWith('::') ? `${s}*${sel}` : `${s}${sel}`);
    return [
      ...TAILWIND_PREFLIGHT.map(([sels, decls]) => `${sels.map(scoped).join(',')}{${decls}}`),
      `${root}{${TAILWIND_ROOT_DECLARATIONS}}`,
      TAILWIND_KEYFRAMES,
    ].join('\n');
  }
  return [
    `${s}*,${s}*::before,${s}*::after{box-sizing:border-box;margin:0}`,
    `${s}button,${s}input,${s}select,${s}textarea{font:inherit;color:inherit;letter-spacing:inherit}`,
    `${root}{${DOCUMENT_ROOT_DECLARATIONS}}`,
  ].join('\n');
}

/** Base CSS for document `doc` (with the preflight when `doc.cssBase === 'tailwind'`). */
export function documentBaseCssFor(
  doc: { cssBase?: 'tailwind' },
  scope?: string,
  rootSelector?: string,
): string {
  return documentBaseCss(scope, rootSelector, { preflight: doc.cssBase === 'tailwind' });
}

/** Document root declarations for the given base (`body` in exported code). */
export function documentRootDeclarations(doc: { cssBase?: 'tailwind' }): string {
  return doc.cssBase === 'tailwind' ? TAILWIND_ROOT_DECLARATIONS : DOCUMENT_ROOT_DECLARATIONS;
}
