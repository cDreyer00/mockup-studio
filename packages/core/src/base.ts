/**
 * CSS base do DOCUMENTO (não da interface do editor): o mesmo no canvas, na página de render
 * (screenshot) e no código exportado, para que os três fiquem idênticos.
 *
 * - `box-sizing: border-box` e `margin: 0` em tudo (os nós controlam o espaçamento com padding/gap);
 * - controles de formulário herdam fonte e cor (como o preflight do Tailwind);
 * - tipografia padrão do documento: fonte do sistema, 16px, `line-height: normal`, texto preto.
 */
export const DOCUMENT_FONT_STACK = "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif";

/** Declarações da raiz do documento (o `body` no código exportado). */
export const DOCUMENT_ROOT_DECLARATIONS =
  `font-family:${DOCUMENT_FONT_STACK};font-size:16px;line-height:normal;color:#000;` +
  'font-weight:400;font-style:normal;letter-spacing:normal;text-align:left;' +
  '-webkit-font-smoothing:auto;color-scheme:light';

/** Fonte padrão do Tailwind v4 (`--default-font-family` = `--font-sans`). */
export const TAILWIND_FONT_STACK =
  "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', 'Noto Sans', Arial, sans-serif, 'Apple Color Emoji', 'Segoe UI Emoji', 'Segoe UI Symbol', 'Noto Color Emoji'";

/** Raiz do documento com a base Tailwind: como a do Mockup Studio, mas com a fonte e o `line-height: 1.5` do preflight. */
export const TAILWIND_ROOT_DECLARATIONS =
  `font-family:${TAILWIND_FONT_STACK};font-size:16px;line-height:1.5;color:#000;` +
  'font-weight:400;font-style:normal;letter-spacing:normal;text-align:left;' +
  '-webkit-font-smoothing:auto;color-scheme:light;tab-size:4;-webkit-text-size-adjust:100%';

/**
 * Preflight do Tailwind v4 (`tailwindcss/preflight.css`, MIT), sem a regra de `html`/`:host`
 * (vai para a raiz do documento) e sem os ajustes de navegador que não afetam o layout.
 * Cada item é `[seletores, declarações]`; os seletores recebem o escopo em `documentBaseCss`.
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

export interface DocumentBaseOptions {
  /** Inclui o preflight do Tailwind (documentos com `cssBase: 'tailwind'`). */
  preflight?: boolean;
}

/**
 * CSS base. Sem `scope`: regras globais com a tipografia no `body` (HTML exportado). Com `scope`
 * (ex.: `.cv-world`): regras restritas ao contêiner; a tipografia vai em `rootSelector` (padrão: o
 * próprio contêiner; no canvas, só os frames, para não atingir rótulos e selos da interface).
 * Com `preflight`, acrescenta o preflight do Tailwind v4 (escopado do mesmo jeito) e usa a raiz
 * tipográfica do Tailwind.
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
    ].join('\n');
  }
  return [
    `${s}*,${s}*::before,${s}*::after{box-sizing:border-box;margin:0}`,
    `${s}button,${s}input,${s}select,${s}textarea{font:inherit;color:inherit;letter-spacing:inherit}`,
    `${root}{${DOCUMENT_ROOT_DECLARATIONS}}`,
  ].join('\n');
}

/** CSS base do documento `doc` (com o preflight quando `doc.cssBase === 'tailwind'`). */
export function documentBaseCssFor(
  doc: { cssBase?: 'tailwind' },
  scope?: string,
  rootSelector?: string,
): string {
  return documentBaseCss(scope, rootSelector, { preflight: doc.cssBase === 'tailwind' });
}

/** Declarações da raiz do documento conforme a base (`body` no código exportado). */
export function documentRootDeclarations(doc: { cssBase?: 'tailwind' }): string {
  return doc.cssBase === 'tailwind' ? TAILWIND_ROOT_DECLARATIONS : DOCUMENT_ROOT_DECLARATIONS;
}
