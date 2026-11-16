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

/**
 * CSS base. Sem `scope`: regras globais com a tipografia no `body` (HTML exportado). Com `scope`
 * (ex.: `.cv-world`): regras restritas ao contêiner; a tipografia vai em `rootSelector` (padrão: o
 * próprio contêiner; no canvas, só os frames, para não atingir rótulos e selos da interface).
 */
export function documentBaseCss(scope?: string, rootSelector?: string): string {
  const s = scope ? `${scope} ` : '';
  const root = rootSelector ?? scope ?? 'body';
  return [
    `${s}*,${s}*::before,${s}*::after{box-sizing:border-box;margin:0}`,
    `${s}button,${s}input,${s}select,${s}textarea{font:inherit;color:inherit;letter-spacing:inherit}`,
    `${root}{${DOCUMENT_ROOT_DECLARATIONS}}`,
  ].join('\n');
}
