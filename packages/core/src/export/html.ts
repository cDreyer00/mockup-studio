import { documentBaseCssFor } from '../base.js';
import { expandDocument } from '../components/expand.js';
import { escapeCssText } from '../html.js';
import { fontFaceCss } from '../fonts.js';
import { breakpointsOf } from '../states.js';
import { themeRulesCss } from '../tokens.js';
import type { Document } from '../types.js';
import { mediaScripts, newMediaCollector } from './media.js';
import {
  ClassNamer,
  cssBody,
  escapeHtmlText,
  indentLines,
  renderHtmlTree,
  resolveRoots,
  rootTokensCss,
  stateRulesCss,
} from './common.js';

export interface HtmlExportOptions {
  /** Page whose frames will be exported (default: the first). */
  pageId?: string;
  /** Specific nodes to export (instead of the page's frames). */
  nodeIds?: string[];
  title?: string;
  /** `classes` (default): classes from the layer-name slug in a `<style>`; `inline`: `style=""`. */
  mode?: 'inline' | 'classes';
  /** `true`: only `<style>` + markup, without `<!doctype>`/`<head>`. Default `false`. */
  fragment?: boolean;
  /**
   * Reads a file from `assets/` (relative path). With it, Lottie `.json` animations up to 512 KB
   * are embedded in the HTML and open via `file://`; without it (or above that size) the HTML fetches the file.
   */
  readAsset?: (ref: string) => string | Uint8Array | undefined;
}

/**
 * Exports standalone HTML (the page's frames or selected nodes). Tokens in `:root`, `@font-face`
 * for embedded fonts (`assets/<file>`), root frame with `min-height` instead of `height`.
 * The base follows `doc.cssBase` (with the Tailwind preflight when `'tailwind'`).
 *
 * States (`node.states`) become rules in the `<style>`: `.slug:hover`, `@media (min-width: 768px)` for
 * breakpoints and `.slug:where([data-theme="dark"], ...)` for `dark`. In `inline` mode the base style
 * stays in `style=""`; nodes with states get a class only for the state rules, which
 * are emitted with `!important` (inline `style` would otherwise win the cascade).
 *
 * Media nodes: effects become `<canvas data-mockup-effect='{json}'>` with the catalog's fallback
 * background (visible without JS) and ONE `<script>` at the end of the body with the runtime and auto-mount;
 * video becomes `<video>`, YouTube/iframe become `<iframe>`, Lottie/Rive/Three.js load the
 * library from a CDN. Scripts only exist if there are media nodes and are also emitted with
 * `fragment: true` (right after the markup).
 */
export function exportHtml(source: Document, options: HtmlExportOptions = {}): string {
  // component instances become the concrete tree (same as the canvas); accepts virtual ids
  const doc = expandDocument(source);
  const mode = options.mode ?? 'classes';
  const roots = resolveRoots(doc, options);

  const namer = new ClassNamer();
  const breakpoints = breakpointsOf(doc);
  const rules: string[] = [];
  const media = newMediaCollector();
  const markup = renderHtmlTree(roots, {
    media,
    readAsset: options.readAsset,
    styleOf: (node) => {
      const hasStyle = Object.keys(node.style).length > 0;
      const hasStates = node.states !== undefined && Object.keys(node.states).length > 0;
      if (!hasStyle && !hasStates) return {};
      if (mode === 'inline') {
        const style = Object.entries(node.style)
          .map(([k, v]) => `${k}: ${v}`)
          .join('; ');
        if (!hasStates) return { style };
        const cls = namer.next(node.name);
        rules.push(...stateRulesCss(`.${cls}`, node.states, { important: true, breakpoints }));
        return hasStyle ? { cls, style } : { cls };
      }
      const cls = namer.next(node.name);
      if (hasStyle) rules.push(`.${cls} {\n${cssBody(node.style)}\n}`);
      rules.push(...stateRulesCss(`.${cls}`, node.states, { breakpoints }));
      return { cls };
    },
  });

  const css: string[] = [];
  const tokens = rootTokensCss(doc.tokens);
  if (tokens) css.push(tokens);
  const themes = themeRulesCss(doc, { indent: '  ' });
  if (themes) css.push(themes);
  css.push(`  ${documentBaseCssFor(doc)}`);
  const faces = fontFaceCss(doc, (f) => `assets/${f}`, 'swap');
  if (faces) css.push(indentLines(faces, 1));
  if (rules.length > 0) css.push(indentLines(rules.join('\n'), 1));
  const style = escapeCssText(css.join('\n'));
  const scripts = mediaScripts(media);

  if (options.fragment) {
    return `<style>\n${style}\n</style>\n${markup}\n${scripts ? scripts + '\n' : ''}`;
  }

  return [
    '<!doctype html>',
    '<html lang="en">',
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
    ...(scripts ? [scripts] : []),
    '</body>',
    '</html>',
    '',
  ].join('\n');
}
