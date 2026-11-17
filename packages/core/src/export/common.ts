/** Peças compartilhadas pelos exportadores (html, tailwind, react, svg). */
import { deepClone } from '../clone.js';
import { expandRepeaters } from '../data.js';
import { findNode, findPage } from '../document.js';
import { isUnsafeUrl, slugify } from '../html.js';
import { cssValueProblem, dropUnsafeStyles, isValidCssPropertyName } from '../styles.js';
import { sanitizeSvg, scopeSvgIds } from '../svg.js';
import { ATTR_NAME_RE, TOKEN_NAME_RE, VOID_TAGS } from '../tags.js';
import type { Document, Node } from '../types.js';
import { DOCUMENT_ROOT_DECLARATIONS, documentBaseCss, documentRootDeclarations } from '../base.js';
import { BREAKPOINT_PX, parseStateKey, sortStateKeys } from '../states.js';
import type { Breakpoint } from '../states.js';
import {
  mediaElement,
  mediaStyleDefaults,
  renderMediaAttrs,
  type MediaCollector,
} from './media.js';

/** Base do documento (a mesma do canvas e do render): ver `documentBaseCss`. */
export const BASE_CSS = documentBaseCss();

/** Tipografia da raiz do documento para o Tailwind (o preflight já cobre box-sizing, margin e controles). */
export const TAILWIND_BASE_CSS = `@layer base {
  body { ${DOCUMENT_ROOT_DECLARATIONS.split(';').join('; ')}; }
}`;

/** Tipografia da raiz para o Tailwind conforme `doc.cssBase` (o `body` da camada base). */
export function tailwindBaseCssFor(doc: { cssBase?: 'tailwind' }): string {
  return `@layer base {\n  body { ${documentRootDeclarations(doc).split(';').join('; ')}; }\n}`;
}

/** Seleção de nós a exportar: `nodeIds` ou os frames da página (`pageId` ou a primeira). */
export interface RootSelection {
  pageId?: string;
  nodeIds?: string[];
}

export interface PrepareOptions {
  /** Mantém `height` dos frames raiz (padrão: vira `min-height`, o conteúdo pode crescer). */
  keepHeight?: boolean;
}

/**
 * Prepara uma árvore para exportar: remove nós ocultos, descarta declarações CSS inseguras,
 * converte `position` do canvas em left/top nos filhos absolutos e, no frame raiz, troca
 * `height` por `min-height`. Um filho direto com `height:100%` (o wrapper típico da tela) também vira
 * `min-height` com a altura do frame; sem isso o % não tem referência e o conteúdo colapsa, diferente
 * do que se vê no canvas. Trabalha numa cópia; o documento original não é alterado.
 */
function prepareNode(node: Node, isRoot: boolean, opts: PrepareOptions): void {
  node.style = dropUnsafeStyles(node.style);
  if (node.states) {
    const states: Record<string, Record<string, string>> = {};
    for (const [key, style] of Object.entries(node.states)) {
      if (!parseStateKey(key)) continue;
      const safe = dropUnsafeStyles(style);
      if (Object.keys(safe).length > 0) states[key] = safe;
    }
    if (Object.keys(states).length > 0) node.states = states;
    else delete node.states;
  }
  if (node.type === 'effect' || node.type === 'embed') {
    // fundo de fallback do efeito (visível sem JS) e `border:0` em iframes; o estilo do nó vence
    node.style = { ...mediaStyleDefaults(node), ...node.style };
  }
  if (!isRoot && node.style.position === 'absolute' && node.position) {
    if (!node.style.left) node.style.left = `${node.position.x}px`;
    if (!node.style.top) node.style.top = `${node.position.y}px`;
  }
  if (isRoot && node.type === 'frame' && !opts.keepHeight && node.style.height) {
    if (!node.style['min-height']) node.style['min-height'] = node.style.height;
    const frameHeight = node.style.height;
    delete node.style.height;
    if (!node.style.padding && !node.style['padding-top'] && !node.style['padding-bottom']) {
      for (const c of node.children) {
        if (c.style.height === '100%' && !c.style['min-height']) {
          c.style['min-height'] = frameHeight;
          delete c.style.height;
        }
      }
    }
  }
  node.children = node.children.filter((c) => !c.hidden);
  for (const c of node.children) prepareNode(c, false, opts);
}

/** Cópia preparada (ver `prepareNode`) de uma árvore que não é raiz do export: principais e instâncias expandidas. */
export function prepareTree(node: Node, opts: PrepareOptions = {}): Node {
  const copy = deepClone(node);
  prepareNode(copy, false, opts);
  return copy;
}

export function resolveRoots(
  doc: Document,
  selection: RootSelection = {},
  opts: PrepareOptions = {},
): Node[] {
  let nodes: Node[];
  if (selection.nodeIds && selection.nodeIds.length > 0) {
    nodes = selection.nodeIds.map((id) => {
      const path = findNode(doc, id);
      if (!path) throw new Error(`Nó "${id}" não encontrado`);
      return path.node;
    });
  } else {
    const page = selection.pageId ? findPage(doc, selection.pageId) : doc.pages[0];
    if (!page) throw new Error(`Página "${selection.pageId ?? ''}" não encontrada`);
    nodes = page.frames;
  }
  // Repetidores viram contêineres com os itens expandidos (dados reais no código exportado).
  const copies = deepClone(nodes).map((n) => expandRepeaters(n));
  for (const n of copies) prepareNode(n, true, opts);
  return copies;
}

/** Tokens com nome e valor válidos (descarta o que quebraria o CSS exportado). */
export function cleanTokens(tokens: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(tokens)) {
    if (TOKEN_NAME_RE.test(k) && cssValueProblem(v) === null) out[k] = v;
  }
  return out;
}

export function escapeHtmlText(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function escapeHtmlAttr(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Bloco `:root { --token: valor }` (vazio se não há tokens). */
export function rootTokensCss(tokens: Record<string, string>, indent = '  '): string {
  const entries = Object.entries(cleanTokens(tokens));
  if (entries.length === 0) return '';
  return `${indent}:root {\n${entries.map(([k, v]) => `${indent}  ${k}: ${v};`).join('\n')}\n${indent}}`;
}

/** Corpo de uma regra CSS (`prop: valor;` por linha). */
export function cssBody(style: Record<string, string>, indent = '  '): string {
  return Object.entries(style)
    .map(([k, v]) => `${indent}${k}: ${v};`)
    .join('\n');
}

/** Aloca nomes de classe a partir do nome da camada (slug; repetidos ganham `-2`, `-3`...). */
export class ClassNamer {
  private used = new Set<string>();
  private counts = new Map<string, number>();

  next(name: string): string {
    let base = slugify(name);
    if (/^[0-9]/.test(base)) base = `n-${base}`;
    let n = this.counts.get(base) ?? 0;
    let candidate: string;
    do {
      n++;
      candidate = n === 1 ? base : `${base}-${n}`;
    } while (this.used.has(candidate));
    this.counts.set(base, n);
    this.used.add(candidate);
    return candidate;
  }
}

/** `src` de imagem relativo a `assets/` → URL exportada; data URLs e URLs absolutas passam. */
export function assetUrl(src: string, base = 'assets/'): string {
  if (/^(data:|https?:|\/\/|\/|#|blob:)/i.test(src)) return src;
  if (src.startsWith(base)) return src;
  return base + src.replace(/^\.?\//, '');
}

/** O valor de `white-space` preserva quebras de linha? */
export function preservesNewlines(whiteSpace: string | undefined): boolean {
  return !!whiteSpace && /^(pre|pre-wrap|pre-line|break-spaces)$/.test(whiteSpace.trim());
}

const URL_ATTRS = new Set(['href', 'src', 'action', 'formaction', 'xlink:href']);

/** Atributos HTML seguros do nó (sem `on*`, `style`, `class`, `srcdoc` nem URLs perigosas). */
export function safeAttrs(node: Node): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(node.attrs)) {
    const lower = k.toLowerCase();
    if (!ATTR_NAME_RE.test(k) || /^on/i.test(k)) continue;
    if (lower === 'style' || lower === 'class' || lower === 'srcdoc') continue;
    if (URL_ATTRS.has(lower) && isUnsafeUrl(v)) continue;
    out[k] = v;
  }
  return out;
}

/** Atributos que, presentes com valor vazio (ou igual ao nome), são booleanos. */
export const BOOLEAN_ATTRS = new Set([
  'allowfullscreen',
  'async',
  'autofocus',
  'autoplay',
  'checked',
  'controls',
  'default',
  'defer',
  'disabled',
  'formnovalidate',
  'hidden',
  'inert',
  'ismap',
  'loop',
  'multiple',
  'muted',
  'nomodule',
  'novalidate',
  'open',
  'playsinline',
  'readonly',
  'required',
  'reversed',
  'selected',
]);

export interface HtmlStyleAttrs {
  /** Valor do atributo `class`. */
  cls?: string;
  /** Valor do atributo `style` (declarações `a: b; c: d`). */
  style?: string;
}

export interface HtmlRenderOptions {
  /** Classe/estilo de cada nó (chamado em ordem de documento; `isRoot` para os nós raiz). */
  styleOf: (node: Node, isRoot: boolean) => HtmlStyleAttrs;
  /** Prefixo de imagens relativas (padrão `assets/`). */
  assetsBase?: string;
  /** Troca o `src` de imagens (ex.: data URL). `undefined` mantém o padrão. */
  resolveSrc?: (src: string) => string | undefined;
  /** Saída compatível com XHTML (void tags `<br />`, `xmlns` no svg). */
  xhtml?: boolean;
  /** Recuo inicial em níveis (padrão 0). */
  depth?: number;
  /**
   * Nós de mídia: `live` (padrão) gera canvas/iframe/video prontos para os scripts de
   * `mediaScripts(media)`; `static` gera markup inerte (`data-mockup-*`), sem scripts.
   */
  mediaMode?: 'live' | 'static';
  /** Recebe o que os nós de mídia `live` precisam carregar (scripts, fragments). */
  media?: MediaCollector;
  /** Lê arquivos de `assets/` para embutir o JSON de animações Lottie pequenas no HTML. */
  readAsset?: (ref: string) => string | Uint8Array | undefined;
}

/** Texto do nó: `\n` fica literal (o CSS decide se vira quebra); apenas escapa. */
function renderText(text: string): string {
  return escapeHtmlText(text);
}

function injectIntoSvg(markup: string, attrs: HtmlStyleAttrs, xhtml: boolean): string {
  let out = markup;
  const extra: string[] = [];
  if (xhtml && !/^\s*<svg[^>]*\sxmlns=/i.test(out)) {
    extra.push('xmlns="http://www.w3.org/2000/svg"');
  }
  if (attrs.cls) extra.push(`class="${escapeHtmlAttr(attrs.cls)}"`);
  if (attrs.style) extra.push(`style="${escapeHtmlAttr(attrs.style)}"`);
  if (extra.length > 0) out = out.replace(/^(\s*<svg)/i, `$1 ${extra.join(' ')}`);
  return out;
}

/** Renderiza as árvores como HTML (uma linha por tag; texto na linha do elemento). */
export function renderHtmlTree(roots: Node[], opts: HtmlRenderOptions): string {
  const lines: string[] = [];
  const pad = (d: number): string => '  '.repeat(d);
  const xhtml = opts.xhtml === true;

  const render = (node: Node, depth: number, isRoot: boolean): void => {
    const sa = opts.styleOf(node, isRoot);

    if (node.type === 'svg') {
      const markup = scopeSvgIds(sanitizeSvg(node.svg ?? '') || '<svg></svg>', node.id);
      lines.push(pad(depth) + injectIntoSvg(markup, sa, xhtml));
      return;
    }

    const parts: string[] = [];
    if (sa.cls) parts.push(`class="${escapeHtmlAttr(sa.cls)}"`);
    if (node.type === 'effect' || node.type === 'video' || node.type === 'embed') {
      const m = mediaElement(node, {
        mode: opts.mediaMode ?? 'live',
        collector: opts.media,
        readAsset: opts.readAsset,
        url: (ref, kind) => {
          const url =
            (kind === 'poster' ? opts.resolveSrc?.(ref) : undefined) ??
            assetUrl(ref, opts.assetsBase);
          return isUnsafeUrl(url) ? null : url;
        },
      });
      if (m) {
        parts.push(...renderMediaAttrs(m.attrs, xhtml));
        if (sa.style) parts.push(`style="${escapeHtmlAttr(sa.style)}"`);
        lines.push(`${pad(depth)}<${m.tag} ${parts.join(' ')}></${m.tag}>`);
        return;
      }
    }
    const isImg = node.type === 'image' || node.tag === 'img';
    if (isImg && node.src !== undefined) {
      const url = opts.resolveSrc?.(node.src) ?? assetUrl(node.src, opts.assetsBase);
      if (!isUnsafeUrl(url)) parts.push(`src="${escapeHtmlAttr(url)}"`);
    }
    for (const [k, v] of Object.entries(safeAttrs(node))) {
      if (isImg && k.toLowerCase() === 'src') continue;
      if (v === '' && BOOLEAN_ATTRS.has(k.toLowerCase()) && !xhtml) parts.push(k);
      else parts.push(`${k}="${escapeHtmlAttr(v)}"`);
    }
    if (sa.style) parts.push(`style="${escapeHtmlAttr(sa.style)}"`);
    const open = `<${node.tag}${parts.length > 0 ? ' ' + parts.join(' ') : ''}`;

    if (VOID_TAGS.has(node.tag)) {
      lines.push(`${pad(depth)}${open}${xhtml ? ' />' : '>'}`);
      return;
    }
    const text = node.text ?? '';
    if (node.children.length === 0) {
      lines.push(`${pad(depth)}${open}>${renderText(text)}</${node.tag}>`);
      return;
    }
    lines.push(`${pad(depth)}${open}>`);
    if (text !== '') lines.push(pad(depth + 1) + renderText(text));
    for (const c of node.children) render(c, depth + 1, false);
    lines.push(`${pad(depth)}</${node.tag}>`);
  };

  for (const r of roots) render(r, opts.depth ?? 0, true);
  return lines.join('\n');
}

/** Propriedade CSS válida e valor seguro (para uso direto em `style=`/regras). */
export function isSafeDeclaration(key: string, value: string): boolean {
  return isValidCssPropertyName(key) && cssValueProblem(value) === null;
}

/** Recua cada linha não vazia de `text` por `n` níveis de 2 espaços. */
export function indentLines(text: string, n: number): string {
  const p = '  '.repeat(n);
  return text
    .split('\n')
    .map((l) => (l === '' ? l : p + l))
    .join('\n');
}

/** O nó tem algum estado com a variante `dark`? */
export function usesDarkState(node: Node): boolean {
  if (node.states && Object.keys(node.states).some((k) => parseStateKey(k)?.dark)) return true;
  return node.children.some(usesDarkState);
}

/**
 * Regras CSS dos estados de um nó para o seletor `.cls`: pseudo-classes (`.cls:hover`), `dark`
 * (`.cls:where([data-theme="dark"], [data-theme="dark"] *)`, o mesmo seletor do `@custom-variant`) e
 * breakpoints (`@media (min-width: 768px)`, mobile first). `important` acrescenta `!important` às
 * declarações (necessário quando o estilo base está inline).
 */
export function stateRulesCss(
  selector: string,
  states: Record<string, Record<string, string>> | undefined,
  opts: { important?: boolean; breakpoints?: Partial<Record<Breakpoint, number>> } = {},
): string[] {
  if (!states) return [];
  const out: string[] = [];
  for (const key of sortStateKeys(Object.keys(states))) {
    const parts = parseStateKey(key);
    const style = states[key];
    if (!parts || Object.keys(style).length === 0) continue;
    let sel = selector;
    if (parts.dark) sel += ':where([data-theme="dark"], [data-theme="dark"] *)';
    if (parts.pseudo) sel += `:${parts.pseudo}`;
    const decls = opts.important
      ? Object.fromEntries(
          Object.entries(style).map(([k, v]) => [
            k,
            /!important\s*$/.test(v) ? v : `${v} !important`,
          ]),
        )
      : style;
    if (parts.breakpoint) {
      const min = opts.breakpoints?.[parts.breakpoint] ?? BREAKPOINT_PX[parts.breakpoint];
      out.push(`@media (min-width: ${min}px) {\n  ${sel} {\n${cssBody(decls, '    ')}\n  }\n}`);
    } else out.push(`${sel} {\n${cssBody(decls)}\n}`);
  }
  return out;
}
