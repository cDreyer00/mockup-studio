/** Text and CSS utilities for the capture (stateless). */

export const NAME_TEXT_MAX = 32;

export const capitalize = (s: string): string => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);
export const truncate = (s: string, n: number): string => (s.length > n ? s.slice(0, n) + '…' : s);

/**
 * Same whitespace rule as the core's `htmlToNodes`: whitespace only → discarded; sequences become a
 * single space, and leading/trailing whitespace is removed if it contains a line break.
 */
export function cleanText(raw: string): string {
  const m = /^([ \t\r\n\f]*)([\s\S]*?)([ \t\r\n\f]*)$/.exec(raw);
  if (!m || m[2] === '') return '';
  const lead = m[1] && !m[1].includes('\n') ? ' ' : '';
  const trail = m[3] && !m[3].includes('\n') ? ' ' : '';
  return lead + m[2].replace(/[ \t\r\n\f]+/g, ' ') + trail;
}

/** Decodes CSS escapes (`\201C`, `\"`, `\A`) of a string already without the outer quotes. */
export function decodeCssString(s: string): string {
  return s.replace(
    /\\(?:([0-9a-fA-F]{1,6})[ \t\n\r\f]?|([\s\S]))/g,
    (_m, hex?: string, ch?: string) => {
      if (hex) {
        const cp = parseInt(hex, 16);
        return cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : '�';
      }
      return ch === '\n' ? '' : (ch ?? '');
    },
  );
}

export interface ParsedContent {
  /** Resulting text (strings, attr(), quotes). */
  text: string;
  /** First `url(...)` of the content. */
  url?: string;
  /** Plain `content: ""`: decorative box. */
  box: boolean;
  /** There was counter()/counters() (not evaluated). */
  skippedCounter: boolean;
}

const CONTENT_TOKEN_RE =
  /\s*(?:"((?:[^"\\]|\\[\s\S])*)"|'((?:[^'\\]|\\[\s\S])*)'|url\(\s*(["']?)(.*?)\3\s*\)|attr\(\s*([\w-]+)[^)]*\)|(open-quote|close-quote|no-open-quote|no-close-quote)|(counters?\([^)]*\))|\/[\s\S]*$|(\S+))/gy;

/** Interprets the computed `content` value of a pseudo-element. */
export function parseContent(raw: string, el: Element): ParsedContent | null {
  const value = raw.trim();
  if (!value || value === 'none' || value === 'normal') return null;
  const out: ParsedContent = { text: '', box: false, skippedCounter: false };
  let strings = 0;
  let onlyEmpty = true;
  CONTENT_TOKEN_RE.lastIndex = 0;
  for (;;) {
    if (CONTENT_TOKEN_RE.lastIndex >= value.length) break;
    const m = CONTENT_TOKEN_RE.exec(value);
    if (!m || m[0] === '') break;
    const [, dq, sq, , url, attr, quote, counter] = m;
    if (dq !== undefined || sq !== undefined) {
      const text = decodeCssString(dq ?? sq ?? '');
      strings++;
      if (text !== '') onlyEmpty = false;
      out.text += text;
    } else if (url !== undefined) {
      out.url ??= url;
      onlyEmpty = false;
    } else if (attr) {
      const v = el.getAttribute(attr) ?? '';
      if (v) onlyEmpty = false;
      out.text += v;
    } else if (quote) {
      onlyEmpty = false;
      if (quote === 'open-quote') out.text += '“';
      else if (quote === 'close-quote') out.text += '”';
    } else if (counter) {
      out.skippedCounter = true;
    }
  }
  out.box = strings === 1 && onlyEmpty && !out.url && !out.skippedCounter;
  return out;
}

/** `rgba(0, 0, 0, 0)` / `transparent`. */
export function isTransparent(color: string): boolean {
  const c = color.trim().toLowerCase();
  if (!c || c === 'transparent') return true;
  const m = /^rgba?\(([^)]*)\)$/.exec(c);
  if (!m) return false;
  const parts = m[1]!.split(/[\s,/]+/).filter(Boolean);
  return parts.length >= 4 && parseFloat(parts[3]!) === 0;
}

/** Splits a CSS list by top-level commas. */
export function splitTop(value: string, sep = ','): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quote = '';
  let buf = '';
  for (const ch of value) {
    if (quote) {
      if (ch === quote) quote = '';
    } else if (ch === '"' || ch === "'") quote = ch;
    else if (ch === '(') depth++;
    else if (ch === ')') depth = Math.max(0, depth - 1);
    else if (ch === sep && depth === 0) {
      parts.push(buf.trim());
      buf = '';
      continue;
    }
    buf += ch;
  }
  if (buf.trim()) parts.push(buf.trim());
  return parts;
}

/** Family names of a `font-family` value (no quotes, lowercase). */
export function fontFamilies(value: string): string[] {
  return splitTop(value).map((f) =>
    f
      .replace(/^["']|["']$/g, '')
      .trim()
      .toLowerCase(),
  );
}

export const px = (n: number): string => `${Math.round(n * 100) / 100}px`;
