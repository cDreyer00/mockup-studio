import { escapeCssText } from '../html.js';
import { fontFaceCss } from '../fonts.js';
import { themeRulesCss } from '../tokens.js';
import type { Document } from '../types.js';
import {
  BASE_CSS,
  ClassNamer,
  cssBody,
  escapeHtmlText,
  indentLines,
  renderHtmlTree,
  resolveRoots,
  rootTokensCss,
} from './common.js';

export interface HtmlExportOptions {
  /** Página cujos frames serão exportados (padrão: a primeira). */
  pageId?: string;
  /** Nós específicos a exportar (em vez dos frames da página). */
  nodeIds?: string[];
  title?: string;
  /** `classes` (padrão): classes por slug do nome da camada num `<style>`; `inline`: `style=""`. */
  mode?: 'inline' | 'classes';
  /** `true`: só `<style>` + markup, sem `<!doctype>`/`<head>`. Padrão `false`. */
  fragment?: boolean;
}

/**
 * Exporta HTML standalone (frames da página ou nós selecionados). Tokens em `:root`, `@font-face`
 * das fontes embutidas (`assets/<arquivo>`), frame raiz com `min-height` no lugar de `height`.
 */
export function exportHtml(doc: Document, options: HtmlExportOptions = {}): string {
  const mode = options.mode ?? 'classes';
  const roots = resolveRoots(doc, options);

  const namer = new ClassNamer();
  const rules: string[] = [];
  const markup = renderHtmlTree(roots, {
    styleOf: (node) => {
      if (Object.keys(node.style).length === 0) return {};
      if (mode === 'inline') {
        return {
          style: Object.entries(node.style)
            .map(([k, v]) => `${k}: ${v}`)
            .join('; '),
        };
      }
      const cls = namer.next(node.name);
      rules.push(`.${cls} {\n${cssBody(node.style)}\n}`);
      return { cls };
    },
  });

  const css: string[] = [];
  const tokens = rootTokensCss(doc.tokens);
  if (tokens) css.push(tokens);
  const themes = themeRulesCss(doc, { indent: '  ' });
  if (themes) css.push(themes);
  css.push(`  ${BASE_CSS}`);
  const faces = fontFaceCss(doc, (f) => `assets/${f}`, 'swap');
  if (faces) css.push(indentLines(faces, 1));
  if (rules.length > 0) css.push(indentLines(rules.join('\n'), 1));
  const style = escapeCssText(css.join('\n'));

  if (options.fragment) return `<style>\n${style}\n</style>\n${markup}\n`;

  return [
    '<!doctype html>',
    '<html lang="pt-BR">',
    '<head>',
    '  <meta charset="utf-8">',
    '  <meta name="viewport" content="width=device-width, initial-scale=1">',
    `  <title>${escapeHtmlText(options.title ?? doc.name)}</title>`,
    '  <style>',
    style,
    '  </style>',
    '</head>',
    '<body>',
    indentLines(markup, 1),
    '</body>',
    '</html>',
    '',
  ].join('\n');
}
