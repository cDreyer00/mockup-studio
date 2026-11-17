/**
 * Node mini-selector for `doc.select("...")` (evaluated in the daemon, on the real document:
 * component instances are not expanded).
 *
 * Syntax (CSS subset):
 * - `*`, type (`frame`, `element`, `text`, `image`, `svg`, `instance`) or tag (`button`, `h1`...)
 * - `#id` and `.class` (Tailwind classes written on the node)
 * - attributes: `[name="x"]`, `[name=x]`, `[name^=x]`, `[name*=x]`, `[name$=x]`, `[text*=x]`,
 *   `[tag=x]`, `[type=x]`, `[style.color]`, `[style.color="red"]`, `[attrs.href^="http"]`, `[hidden]`
 * - combinators: descendant (space) and child (`>`); comma-separated list.
 * No user-supplied regular expressions (no ReDoS on the main thread).
 */
import type { Document, Node } from '@mockup/core';

export const NODE_TYPES = new Set(['frame', 'element', 'text', 'image', 'svg', 'instance']);

type AttrOp = '=' | '^=' | '*=' | '$=';

interface AttrTest {
  key: string;
  op?: AttrOp;
  value?: string;
}

interface Compound {
  /** `*`, a type or a tag (lowercase); absent = any. */
  kind?: string;
  ids: string[];
  classes: string[];
  attrs: AttrTest[];
}

interface Part {
  compound: Compound;
  /** Relation to the previous part: descendant (` `) or child (`>`). */
  combinator: ' ' | '>';
}

export class SelectorError extends Error {}

const IDENT = /[\w-]/;

function parseSelector(source: string): Part[][] {
  const s = source;
  let i = 0;
  const fail = (msg: string): never => {
    throw new SelectorError(`Invalid selector "${source}": ${msg} (position ${i}).`);
  };
  const skipSpaces = (): boolean => {
    const start = i;
    while (i < s.length && /\s/.test(s[i]!)) i++;
    return i > start;
  };
  const ident = (): string => {
    const start = i;
    while (i < s.length && IDENT.test(s[i]!)) i++;
    return s.slice(start, i);
  };

  const parseAttr = (): AttrTest => {
    i++; // [
    skipSpaces();
    const start = i;
    while (i < s.length && /[\w.-]/.test(s[i]!)) i++;
    const key = s.slice(start, i);
    if (!key) fail('expected the attribute name after "["');
    skipSpaces();
    if (s[i] === ']') {
      i++;
      return { key };
    }
    let op: AttrOp;
    if (s[i] === '=') {
      op = '=';
      i++;
    } else if ((s[i] === '^' || s[i] === '*' || s[i] === '$') && s[i + 1] === '=') {
      op = `${s[i]}=` as AttrOp;
      i += 2;
    } else {
      return fail('invalid attribute operator (use =, ^=, *= or $=)');
    }
    skipSpaces();
    let value: string;
    const q = s[i];
    if (q === '"' || q === "'") {
      i++;
      const from = i;
      while (i < s.length && s[i] !== q) i++;
      if (i >= s.length) fail('unclosed quote');
      value = s.slice(from, i);
      i++;
    } else {
      const from = i;
      while (i < s.length && s[i] !== ']') i++;
      value = s.slice(from, i).trim();
    }
    skipSpaces();
    if (s[i] !== ']') fail('expected "]"');
    i++;
    return { key, op, value };
  };

  const parseCompound = (): Compound => {
    const c: Compound = { ids: [], classes: [], attrs: [] };
    let any = false;
    if (s[i] === '*') {
      c.kind = '*';
      i++;
      any = true;
    } else if (i < s.length && IDENT.test(s[i]!)) {
      c.kind = ident().toLowerCase();
      any = true;
    }
    for (;;) {
      const ch = s[i];
      if (ch === '#') {
        i++;
        const v = ident();
        if (!v) fail('expected an id after "#"');
        c.ids.push(v);
      } else if (ch === '.') {
        i++;
        const v = ident();
        if (!v) fail('expected a class after "."');
        c.classes.push(v);
      } else if (ch === '[') {
        c.attrs.push(parseAttr());
      } else break;
      any = true;
    }
    if (!any) fail(s[i] === undefined ? 'incomplete selector' : `unexpected character "${s[i]}"`);
    return c;
  };

  const list: Part[][] = [];
  skipSpaces();
  if (i >= s.length) fail('empty selector');
  for (;;) {
    const parts: Part[] = [{ compound: parseCompound(), combinator: ' ' }];
    for (;;) {
      const spaced = skipSpaces();
      if (i >= s.length || s[i] === ',') break;
      let combinator: ' ' | '>' = ' ';
      if (s[i] === '>') {
        combinator = '>';
        i++;
        skipSpaces();
      } else if (!spaced) {
        fail(`unexpected character "${s[i]}"`);
      }
      parts.push({ compound: parseCompound(), combinator });
    }
    list.push(parts);
    if (i >= s.length) break;
    i++; // comma
    skipSpaces();
    if (i >= s.length) fail('empty selector after the comma');
  }
  return list;
}

const ATTR_KEYS =
  'id, name, tag, type, text, src, classes (or class), component, hidden, locked, style.<prop>, attrs.<name>';

function kebab(p: string): string {
  return p.startsWith('-') ? p : p.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`);
}

function attrValue(n: Node, key: string): string | undefined {
  switch (key) {
    case 'id':
      return n.id;
    case 'name':
      return n.name;
    case 'tag':
      return n.tag;
    case 'type':
      return n.type;
    case 'text':
      return n.text;
    case 'src':
      return n.src;
    case 'class':
    case 'classes':
      return n.classes;
    case 'component':
      return n.componentId;
    case 'hidden':
      return n.hidden ? 'true' : undefined;
    case 'locked':
      return n.locked ? 'true' : undefined;
    default:
  }
  if (key.startsWith('style.')) return n.style[kebab(key.slice(6))];
  if (key.startsWith('attrs.')) return n.attrs[key.slice(6)];
  throw new SelectorError(`Unknown attribute "${key}" in the selector. Use: ${ATTR_KEYS}.`);
}

function matchAttr(n: Node, t: AttrTest): boolean {
  const v = attrValue(n, t.key);
  if (v === undefined) return false;
  if (!t.op) return true;
  const want = t.value ?? '';
  switch (t.op) {
    case '=':
      return v === want;
    case '^=':
      return v.startsWith(want);
    case '*=':
      return v.includes(want);
    case '$=':
      return v.endsWith(want);
  }
}

function matchCompound(n: Node, c: Compound): boolean {
  if (c.kind && c.kind !== '*') {
    if (NODE_TYPES.has(c.kind)) {
      if (n.type !== c.kind && !(c.kind === 'svg' && n.tag === 'svg')) return false;
    } else if (n.tag.toLowerCase() !== c.kind) return false;
  }
  for (const id of c.ids) if (n.id !== id) return false;
  if (c.classes.length) {
    const have = new Set((n.classes ?? '').split(/\s+/).filter(Boolean));
    for (const cl of c.classes) if (!have.has(cl)) return false;
  }
  for (const a of c.attrs) if (!matchAttr(n, a)) return false;
  return true;
}

interface Entry {
  node: Node;
  parent: Entry | null;
  /** Inside the scope (`within`), not counting the scope node itself. */
  inScope: boolean;
}

function buildEntries(doc: Document, within?: string | null): Entry[] {
  const out: Entry[] = [];
  const visit = (node: Node, parent: Entry | null, scoped: boolean): void => {
    const entry: Entry = { node, parent, inScope: !within || scoped };
    out.push(entry);
    const childScoped = scoped || (!!within && node.id === within);
    for (const c of node.children) visit(c, entry, childScoped);
  };
  for (const page of doc.pages) for (const f of page.frames) visit(f, null, false);
  return out;
}

function matchFrom(e: Entry, parts: Part[], i: number): boolean {
  const part = parts[i]!;
  if (!matchCompound(e.node, part.compound)) return false;
  if (i === 0) return true;
  if (part.combinator === '>') return e.parent ? matchFrom(e.parent, parts, i - 1) : false;
  for (let p = e.parent; p; p = p.parent) if (matchFrom(p, parts, i - 1)) return true;
  return false;
}

/** Ids of the nodes matching the selector, in document order (optionally only descendants of `within`). */
export function selectIds(doc: Document, selector: string, within?: string | null): string[] {
  const list = parseSelector(selector);
  const entries = buildEntries(doc, within);
  if (within && !entries.some((e) => e.node.id === within)) {
    throw new SelectorError(`Scope node not found: "${within}".`);
  }
  const ids: string[] = [];
  for (const e of entries) {
    if (!e.inScope) continue;
    if (list.some((parts) => matchFrom(e, parts, parts.length - 1))) ids.push(e.node.id);
  }
  return ids;
}
