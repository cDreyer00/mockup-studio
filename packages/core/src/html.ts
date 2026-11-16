import { DomUtils, parseDocument as parseHtml } from 'htmlparser2';
import type { AnyNode, Element } from 'domhandler';
import { createNodeFromTag } from './document.js';
import { cssValueProblem, isValidCssPropertyName, normalizeStyles, toKebabCase } from './styles.js';
import { sanitizeSvg } from './svg.js';
import { ATTR_NAME_RE, BLOCKED_TAGS, TAG_RE, VOID_TAGS } from './tags.js';
import type { Node } from './types.js';

/* ====================================================================== */
/* CSS: parser mínimo de regras + resolvedor de seletores simples          */
/* ====================================================================== */

type Decl = [string, string];

/** Divide declarações `a: b; c: d` respeitando parênteses e aspas. */
function splitDeclarations(body: string): Decl[] {
  const decls: Decl[] = [];
  let buf = '';
  let paren = 0;
  let quote = '';
  const flush = (): void => {
    const idx = buf.indexOf(':');
    if (idx > 0) {
      const k = buf.slice(0, idx).trim();
      const v = buf.slice(idx + 1).trim();
      if (k && v) decls.push([k, v]);
    }
    buf = '';
  };
  for (const ch of body) {
    if (quote) {
      if (ch === quote) quote = '';
    } else if (ch === '"' || ch === "'") quote = ch;
    else if (ch === '(') paren++;
    else if (ch === ')') paren = Math.max(0, paren - 1);
    else if (ch === ';' && paren === 0) {
      flush();
      continue;
    }
    buf += ch;
  }
  flush();
  return decls;
}

interface Compound {
  tag?: string;
  classes: string[];
  id?: string;
}
interface Complex {
  parts: Compound[];
  /** combs[i] relaciona parts[i-1] e parts[i]: ' ' (descendente) ou '>' (filho direto). */
  combs: (' ' | '>')[];
}
interface Rule {
  selector: Complex;
  decls: Decl[];
}

const COMPOUND_RE = /^(\*|[a-zA-Z][\w-]*)?((?:[.#][\w-]+)*)$/;

function parseCompound(token: string): Compound | null {
  const m = COMPOUND_RE.exec(token);
  if (!m) return null;
  const compound: Compound = { classes: [] };
  if (m[1] && m[1] !== '*') compound.tag = m[1].toLowerCase();
  for (const part of m[2].match(/[.#][\w-]+/g) ?? []) {
    if (part[0] === '.') compound.classes.push(part.slice(1));
    else compound.id = part.slice(1);
  }
  return compound;
}

/** Retorna `null` para seletores não suportados (pseudo-classes, atributos, irmãos...). */
function parseSelector(sel: string): Complex | null {
  const s = sel.trim();
  if (!s || /[:[\]+~|@()]/.test(s)) return null;
  const tokens = s.replace(/>/g, ' > ').split(/\s+/).filter(Boolean);
  const parts: Compound[] = [];
  const combs: (' ' | '>')[] = [];
  let pending: ' ' | '>' = ' ';
  let lastWasComb = true;
  for (const t of tokens) {
    if (t === '>') {
      if (lastWasComb) return null;
      pending = '>';
      lastWasComb = true;
      continue;
    }
    const c = parseCompound(t);
    if (!c) return null;
    parts.push(c);
    combs.push(pending);
    pending = ' ';
    lastWasComb = false;
  }
  if (lastWasComb || parts.length === 0) return null;
  return { parts, combs };
}

function parseCss(css: string): Rule[] {
  const src = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const rules: Rule[] = [];
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf('{', i);
    const semi = src.indexOf(';', i);
    if (open === -1) break;
    const prelude = src.slice(i, open).trim();
    if (prelude.startsWith('@') && semi !== -1 && semi < open) {
      i = semi + 1; // at-rule sem bloco (@import, @charset)
      continue;
    }
    if (prelude.startsWith('@')) {
      // at-rule com bloco aninhado (@media, @keyframes...): ignora inteiro.
      let depth = 0;
      let j = open;
      for (; j < src.length; j++) {
        if (src[j] === '{') depth++;
        else if (src[j] === '}' && --depth === 0) break;
      }
      i = j + 1;
      continue;
    }
    const close = src.indexOf('}', open);
    if (close === -1) break;
    const decls = splitDeclarations(src.slice(open + 1, close));
    for (const sel of prelude.split(',')) {
      const selector = parseSelector(sel);
      if (selector) rules.push({ selector, decls });
    }
    i = close + 1;
  }
  return rules;
}

function classesOf(el: Element): string[] {
  return (el.attribs.class ?? '').split(/\s+/).filter(Boolean);
}

function compoundMatches(el: Element, c: Compound): boolean {
  if (c.tag && el.name.toLowerCase() !== c.tag) return false;
  if (c.id && el.attribs.id !== c.id) return false;
  if (c.classes.length > 0) {
    const have = classesOf(el);
    if (!c.classes.every((k) => have.includes(k))) return false;
  }
  return true;
}

function parentElement(el: Element): Element | null {
  const p = el.parent;
  return p && DomUtils.isTag(p) ? p : null;
}

function matches(el: Element, sel: Complex, i: number): boolean {
  if (!compoundMatches(el, sel.parts[i])) return false;
  if (i === 0) return true;
  if (sel.combs[i] === '>') {
    const p = parentElement(el);
    return p !== null && matches(p, sel, i - 1);
  }
  for (let p = parentElement(el); p; p = parentElement(p)) {
    if (matches(p, sel, i - 1)) return true;
  }
  return false;
}

/** Normaliza declarações ignorando silenciosamente nomes inválidos. */
function safeNormalize(decls: Decl[]): Record<string, string> {
  const merged: Record<string, string> = {};
  for (const [k, v] of decls) {
    const key = toKebabCase(k.trim());
    if (isValidCssPropertyName(key) && cssValueProblem(v.trim()) === null) merged[key] = v;
  }
  return normalizeStyles(merged);
}

/* ====================================================================== */
/* HTML → Nodes                                                            */
/* ====================================================================== */

const SKIP_TAGS = new Set([
  'script',
  'style',
  'head',
  'meta',
  'link',
  'title',
  'noscript',
  'iframe',
  'object',
  'embed',
  'base',
]);
const UNWRAP_TAGS = new Set(['html', 'body']);
const NAME_TEXT_MAX = 32;

/**
 * Regra de espaços em runs de texto: só whitespace → descartado; senão sequências de whitespace
 * viram um único espaço, e o whitespace inicial (ou final) é removido se contiver quebra de linha.
 * Quebras de linha/indentação de HTML "bonito" são formatação e somem; espaços simples inline
 * ("Olá <b>mundo</b>") são conteúdo e viram um espaço.
 */
function cleanText(raw: string): string {
  const m = /^([ \t\r\n\f]*)([\s\S]*?)([ \t\r\n\f]*)$/.exec(raw);
  if (!m || m[2] === '') return '';
  const lead = m[1] && !m[1].includes('\n') ? ' ' : '';
  const trail = m[3] && !m[3].includes('\n') ? ' ' : '';
  return lead + m[2].replace(/[ \t\r\n\f]+/g, ' ') + trail;
}
const capitalize = (s: string): string => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);
const truncate = (s: string, n: number): string => (s.length > n ? s.slice(0, n) + '…' : s);

interface Ctx {
  rules: Rule[];
}

function elementStyle(el: Element, ctx: Ctx): Record<string, string> {
  const decls: Decl[] = [];
  for (const rule of ctx.rules) {
    if (matches(el, rule.selector, rule.selector.parts.length - 1)) decls.push(...rule.decls);
  }
  if (el.attribs.style) decls.push(...splitDeclarations(el.attribs.style));
  return safeNormalize(decls);
}

/** Atributos que carregam URL e podem executar código (`javascript:`, `data:text/html`). */
const URL_ATTRS = new Set(['href', 'src', 'action', 'formaction', 'xlink:href', 'srcdoc']);

/** `javascript:` ou `data:` que não seja imagem, ignorando espaços e controles. */
export function isUnsafeUrl(value: string): boolean {
  // eslint-disable-next-line no-control-regex
  const v = value.replace(/[\s\u0000-\u001f]+/g, '').toLowerCase();
  return v.startsWith('javascript:') || (v.startsWith('data:') && !v.startsWith('data:image/'));
}

function elementAttrs(el: Element, omit: string[] = []): Record<string, string> {
  const attrs: Record<string, string> = {};
  for (const [k, v] of Object.entries(el.attribs)) {
    if (k === 'class' || k === 'style' || k === 'id' || k === 'data-name') continue;
    if (/^on/i.test(k) || !ATTR_NAME_RE.test(k)) continue;
    if (omit.includes(k)) continue;
    const lower = k.toLowerCase();
    if (lower === 'srcdoc') continue;
    if (URL_ATTRS.has(lower) && isUnsafeUrl(v)) continue;
    attrs[k] = v;
  }
  return attrs;
}

function elementName(el: Element, text?: string): string {
  const dataName = el.attribs['data-name']?.trim();
  if (dataName) return dataName;
  const first = classesOf(el)[0];
  if (first) return capitalize(first);
  if (text) return truncate(text, NAME_TEXT_MAX);
  return capitalize(el.name);
}

function convertChildren(children: AnyNode[], ctx: Ctx): Node[] {
  const out: Node[] = [];
  for (const c of children) {
    if (DomUtils.isTag(c)) {
      const name = c.name.toLowerCase();
      if (SKIP_TAGS.has(name) || BLOCKED_TAGS.has(name) || !TAG_RE.test(name)) continue;
      if (UNWRAP_TAGS.has(name)) out.push(...convertChildren(c.children, ctx));
      else out.push(convertElement(c, ctx));
    } else if (DomUtils.isText(c)) {
      const text = cleanText(c.data);
      if (text) {
        out.push(createNodeFromTag('span', { text, name: truncate(text.trim(), NAME_TEXT_MAX) }));
      }
    }
  }
  return out;
}

function convertElement(el: Element, ctx: Ctx): Node {
  const tag = el.name.toLowerCase();
  const styles = elementStyle(el, ctx);

  if (tag === 'img') {
    return createNodeFromTag('img', {
      name: elementName(el),
      styles,
      src: isUnsafeUrl(el.attribs.src ?? '') ? '' : (el.attribs.src ?? ''),
      attrs: elementAttrs(el, ['src']),
    });
  }

  if (tag === 'svg') {
    const saved = { style: el.attribs.style, class: el.attribs.class };
    delete el.attribs.style;
    delete el.attribs.class;
    const svg = sanitizeSvg(DomUtils.getOuterHTML(el));
    if (saved.style !== undefined) el.attribs.style = saved.style;
    if (saved.class !== undefined) el.attribs.class = saved.class;
    return createNodeFromTag('svg', { name: elementName(el), styles, svg });
  }

  const meaningful = el.children.filter((c) => DomUtils.isTag(c) || DomUtils.isText(c));
  const hasTags = meaningful.some((c) => DomUtils.isTag(c));
  const textContent = cleanText(
    meaningful
      .filter((c) => DomUtils.isText(c))
      .map((c) => (c as { data: string }).data)
      .join(''),
  );

  if (!hasTags && textContent) {
    return createNodeFromTag(tag, {
      name: elementName(el, textContent.trim()),
      styles,
      text: textContent,
      attrs: elementAttrs(el),
    });
  }
  return createNodeFromTag(tag, {
    name: elementName(el),
    styles,
    attrs: elementAttrs(el),
    children: convertChildren(el.children, ctx),
  });
}

export function htmlToNodes(html: string, options: { css?: string } = {}): Node[] {
  const dom = parseHtml(html);
  const rules: Rule[] = [];
  for (const styleEl of DomUtils.findAll((e) => e.name === 'style', dom.children)) {
    rules.push(...parseCss(DomUtils.textContent(styleEl)));
  }
  if (options.css) rules.push(...parseCss(options.css));
  return convertChildren(dom.children, { rules });
}

/* ====================================================================== */
/* Nodes → HTML                                                            */
/* ====================================================================== */

export function slugify(name: string): string {
  const slug = name
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || 'node';
}

const escapeText = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const escapeAttr = (s: string): string => escapeText(s).replace(/'/g, '&#39;');

/** Impede que um valor CSS feche o <style> que o contém ("</" vira "<\/"). */
export function escapeCssText(s: string): string {
  return s.replace(/<\//g, '<\\/');
}

/** Nome de classe único: slug do nome + últimos 4 chars do id. */
export function classNameFor(node: Node): string {
  return `${slugify(node.name)}-${node.id.slice(-4)}`;
}

export function nodesToHtml(
  nodes: Node | Node[],
  options: { mode?: 'inline' | 'classes'; indent?: boolean } = {},
): { html: string; css: string } {
  const mode = options.mode ?? 'inline';
  const indent = options.indent ?? true;
  const list = Array.isArray(nodes) ? nodes : [nodes];
  const lines: string[] = [];
  const cssRules: string[] = [];
  const pad = (depth: number): string => (indent ? '  '.repeat(depth) : '');

  const styleAttr = (node: Node): string => {
    const entries = Object.entries(node.style);
    if (entries.length === 0) return '';
    if (mode === 'inline') {
      const value = entries.map(([k, v]) => `${k}: ${v}`).join('; ');
      return `style="${escapeAttr(value)}"`;
    }
    const cls = classNameFor(node);
    const body = entries.map(([k, v]) => `  ${k}: ${escapeCssText(v)};`).join('\n');
    cssRules.push(`.${cls} {\n${body}\n}`);
    return `class="${cls}"`;
  };

  const attrString = (node: Node, extra: string): string => {
    const parts: string[] = [];
    if (node.type === 'image' || node.tag === 'img') {
      if (node.src !== undefined) parts.push(`src="${escapeAttr(node.src)}"`);
    }
    for (const [k, v] of Object.entries(node.attrs)) {
      if (!ATTR_NAME_RE.test(k)) {
        throw new Error(`Nome de atributo inválido no nó "${node.id}": "${k}"`);
      }
      parts.push(`${k}="${escapeAttr(v)}"`);
    }
    if (extra) parts.push(extra);
    return parts.length > 0 ? ' ' + parts.join(' ') : '';
  };

  const render = (node: Node, depth: number): void => {
    if (node.hidden) return;
    const extra = styleAttr(node);

    if (node.type === 'svg') {
      const markup = node.svg ?? '<svg></svg>';
      lines.push(pad(depth) + (extra ? markup.replace(/^(\s*<svg)/i, `$1 ${extra}`) : markup));
      return;
    }

    const open = `<${node.tag}${attrString(node, extra)}>`;
    if (VOID_TAGS.has(node.tag)) {
      if (node.children.length > 0) {
        throw new Error(
          `O nó "${node.id}" (${node.tag}) é uma tag void e não pode ter filhos; remova-os ou troque a tag`,
        );
      }
      lines.push(pad(depth) + open);
      return;
    }
    const hasText = node.text !== undefined && node.text !== '';
    const children = node.children.filter((c) => !c.hidden);
    if (children.length === 0) {
      lines.push(`${pad(depth)}${open}${hasText ? escapeText(node.text ?? '') : ''}</${node.tag}>`);
      return;
    }
    lines.push(pad(depth) + open);
    if (hasText) lines.push(pad(depth + 1) + escapeText(node.text ?? ''));
    for (const child of children) render(child, depth + 1);
    lines.push(`${pad(depth)}</${node.tag}>`);
  };

  for (const n of list) render(n, 0);
  return { html: lines.join(indent ? '\n' : ''), css: cssRules.join('\n') };
}
