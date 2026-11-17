/**
 * Minimal line editor for the `[mcp_servers.mockup-studio]` section of `~/.codex/config.toml`.
 * Reading uses a real TOML parser (`smol-toml`); writing only replaces the lines of a key,
 * preserving the rest of the file (comments, other sections, CRLF). Whoever writes validates the
 * resulting text with `tomlError` first.
 */
import { parse } from 'smol-toml';

export interface TomlDoc {
  lines: string[];
  eol: string;
}

export function parseDoc(text: string): TomlDoc {
  return { lines: text.split(/\r?\n/), eol: text.includes('\r\n') ? '\r\n' : '\n' };
}

export const renderDoc = (d: TomlDoc): string => d.lines.join(d.eol);

/** TOML syntax error (first line of the parser message, with line:column), or `null`. */
export function tomlError(text: string): string | null {
  try {
    parse(text);
    return null;
  } catch (e) {
    const err = e as { message?: string; line?: number; column?: number };
    const msg = (err.message ?? String(e)).split('\n')[0].replace(/^Invalid TOML document:\s*/, '');
    return err.line ? `line ${err.line}, column ${err.column}: ${msg}` : msg;
  }
}

/** `mcp_servers.mockup-studio` table of the text, or `undefined`. Throws if the TOML is invalid. */
export function readServerTable(text: string, name: string): Record<string, unknown> | undefined {
  const servers = parse(text).mcp_servers as Record<string, unknown> | undefined;
  const t = servers && typeof servers === 'object' ? servers[name] : undefined;
  return t && typeof t === 'object' && !Array.isArray(t)
    ? (t as Record<string, unknown>)
    : undefined;
}

const NAME = String.raw`(?:mockup-studio|"mockup-studio"|'mockup-studio')`;
const headerRe = (sub?: string) =>
  new RegExp(
    String.raw`^\s*\[\s*mcp_servers\s*\.\s*${NAME}${sub ? String.raw`\s*\.\s*(?:${sub}|"${sub}"|'${sub}')` : ''}\s*\]\s*(?:#.*)?$`,
  );
const subHeader = (sub: string) => `[mcp_servers.mockup-studio.${sub}]`;
const ANY_HEADER_RE = /^\s*\[/;
const BARE_KEY = /^[A-Za-z0-9_-]+$/;
const PART = String.raw`(?:"(?:[^"\\]|\\.)*"|'[^']*'|[A-Za-z0-9_-]+)`;
/** Simple or dotted key (`env.A`) and the rest of the line. */
const KEY_RE = new RegExp(String.raw`^\s*(${PART}(?:\s*\.\s*${PART})*)\s*=(.*)$`);
const PART_RE = new RegExp(PART, 'g');
/** Key name without quotes; the parts of a dotted key are joined by `.`. */
const keyName = (text: string) =>
  (text.match(PART_RE) ?? []).map((p) => (/^["']/.test(p) ? p.slice(1, -1) : p)).join('.');

export interface Entry {
  key: string;
  /** First line (index) and exclusive end. */
  from: number;
  to: number;
  raw: string;
}

export interface Section {
  start: number;
  end: number;
  entries: Entry[];
}

/**
 * Scans the value of a key (may span several lines): `complete` when brackets/braces closed and
 * no `"""`/`'''` string was left open; `comment` is the comment after the value (with the `#`).
 */
export function scanValue(s: string): { complete: boolean; comment?: string } {
  let depth = 0;
  let comment: string | undefined;
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (s.startsWith('"""', i) || s.startsWith("'''", i)) {
      const q = s.slice(i, i + 3);
      i += 3;
      for (;;) {
        if (i >= s.length) return { complete: false };
        if (q === '"""' && s[i] === '\\') i += 2;
        else if (s.startsWith(q, i)) {
          i += 3;
          while (s[i] === q[0]) i++; // up to two extra quotes are part of the content
          break;
        } else i++;
      }
      continue;
    }
    if (c === '"' || c === "'") {
      for (i++; i < s.length && s[i] !== c && s[i] !== '\n'; i++)
        if (c === '"' && s[i] === '\\') i++;
      i++;
      continue;
    }
    if (c === '#') {
      const nl = s.indexOf('\n', i);
      const end = nl < 0 ? s.length : nl;
      comment = depth === 0 ? s.slice(i, end) : undefined;
      i = end;
      continue;
    }
    if (c === '[' || c === '{') depth++;
    else if (c === ']' || c === '}') depth--;
    else if (depth === 0 && !/\s/.test(c)) comment = undefined;
    i++;
  }
  return { complete: depth <= 0, comment };
}

/** Main section or one of its subtables (e.g. `env`). */
export function findSection(doc: TomlDoc, sub?: string): Section | null {
  const { lines } = doc;
  const header = headerRe(sub);
  const start = lines.findIndex((l) => header.test(l));
  if (start < 0) return null;
  const entries: Entry[] = [];
  let i = start + 1;
  while (i < lines.length && !ANY_HEADER_RE.test(lines[i])) {
    const m = KEY_RE.exec(lines[i]);
    if (!m) {
      i++;
      continue;
    }
    let raw = m[2];
    let to = i + 1;
    while (!scanValue(raw).complete && to < lines.length) raw += `\n${lines[to++]}`;
    entries.push({ key: keyName(m[1]), from: i, to, raw });
    i = to;
  }
  return { start, end: i, entries };
}

/** Replaces (or inserts) `key = value` in the section, keeping the end-of-line comment. `false` if nothing changed. */
export function setKey(doc: TomlDoc, key: string, valueText: string, sub?: string): boolean {
  const sec = findSection(doc, sub);
  if (!sec) return false;
  const e = sec.entries.find((x) => x.key === key);
  const keyText = BARE_KEY.test(key) ? key : JSON.stringify(key);
  if (e) {
    const comment = scanValue(e.raw).comment;
    const line = `${keyText} = ${valueText}${comment ? ` ${comment}` : ''}`;
    if (e.to - e.from === 1 && doc.lines[e.from].trim() === line) return false;
    doc.lines.splice(e.from, e.to - e.from, line);
  } else {
    const last = sec.entries[sec.entries.length - 1];
    doc.lines.splice(last ? last.to : sec.start + 1, 0, `${keyText} = ${valueText}`);
  }
  return true;
}

export function removeKey(doc: TomlDoc, key: string): boolean {
  const e = findSection(doc)?.entries.find((x) => x.key === key);
  if (!e) return false;
  doc.lines.splice(e.from, e.to - e.from);
  return true;
}

/** Removes the whole `[mcp_servers.mockup-studio.<sub>]` subtable (up to the next header). */
export function removeSubtable(doc: TomlDoc, sub: string): boolean {
  const sec = findSection(doc, sub);
  if (!sec) return false;
  let from = sec.start;
  if (from > 0 && doc.lines[from - 1].trim() === '') from--;
  let to = sec.end;
  // trailing blank lines stay (they separate the next section / final break); the one before goes
  while (to > sec.start + 1 && doc.lines[to - 1].trim() === '') to--;
  doc.lines.splice(from, to - from);
  return true;
}

/** Removes the inline key and the subtable; returns the removed names (`env`, `[...env]`). */
export function removeKeyOrTable(doc: TomlDoc, key: string): string[] {
  const out: string[] = [];
  if (removeKey(doc, key)) out.push(key);
  for (const e of findSection(doc)?.entries.filter((x) => x.key.startsWith(`${key}.`)) ?? [])
    if (removeKey(doc, e.key)) out.push(e.key);
  if (removeSubtable(doc, key)) out.push(subHeader(key));
  return out;
}

/**
 * Ensures the pairs in the `env` table: if the section has an inline `env = { ... }`, rewrites the same key
 * inline (with the old and new pairs); otherwise uses the `[mcp_servers.mockup-studio.env]` subtable,
 * creating it right after the main section. Throws if the inline `env` is not readable.
 */
export function setEnv(
  doc: TomlDoc,
  env: Record<string, string>,
  quote: (s: string) => string,
): boolean {
  const pairs = Object.entries(env);
  if (!pairs.length) return false;
  const main = findSection(doc);
  if (!main) return false;
  if (main.entries.some((x) => x.key.startsWith('env.')))
    throw new Error('env defined with dotted keys (env.NAME = ...) in the section');
  const inline = main.entries.find((x) => x.key === 'env');
  if (inline) {
    let cur: unknown;
    try {
      cur = parse(`env = ${inline.raw}`).env;
    } catch {
      cur = undefined;
    }
    if (!cur || typeof cur !== 'object' || Array.isArray(cur))
      throw new Error('the env value in the section is not a readable table');
    const merged = { ...(cur as Record<string, unknown>), ...env };
    if (pairs.every(([k, v]) => (cur as Record<string, unknown>)[k] === v)) return false;
    const body = Object.entries(merged)
      .map(([k, v]) => `${BARE_KEY.test(k) ? k : quote(k)} = ${quote(String(v))}`)
      .join(', ');
    return setKey(doc, 'env', `{ ${body} }`);
  }
  if (!findSection(doc, 'env')) {
    // at the end of the section (before the blank lines), so it does not capture lines the editor does not recognize
    let at = main.end;
    while (at > main.start + 1 && doc.lines[at - 1].trim() === '') at--;
    doc.lines.splice(at, 0, '', subHeader('env'));
  }
  let changed = false;
  for (const [k, v] of pairs) changed = setKey(doc, k, quote(v), 'env') || changed;
  return changed;
}
