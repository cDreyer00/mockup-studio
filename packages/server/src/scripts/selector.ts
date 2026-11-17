/**
 * Mini-seletor de nós para `doc.select("...")` (avaliado no daemon, sobre o documento real:
 * instâncias de componente não são expandidas).
 *
 * Sintaxe (subconjunto de CSS):
 * - `*`, tipo (`frame`, `element`, `text`, `image`, `svg`, `instance`) ou tag (`button`, `h1`...)
 * - `#id` e `.classe` (classes Tailwind escritas no nó)
 * - atributos: `[name="x"]`, `[name=x]`, `[name^=x]`, `[name*=x]`, `[name$=x]`, `[text*=x]`,
 *   `[tag=x]`, `[type=x]`, `[style.color]`, `[style.color="red"]`, `[attrs.href^="http"]`, `[hidden]`
 * - combinadores: descendente (espaço) e filho (`>`); lista separada por vírgula.
 * Sem expressões regulares fornecidas pelo usuário (nada de ReDoS no thread principal).
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
  /** `*`, um tipo ou uma tag (minúsculos); ausente = qualquer. */
  kind?: string;
  ids: string[];
  classes: string[];
  attrs: AttrTest[];
}

interface Part {
  compound: Compound;
  /** Relação com a parte anterior: descendente (` `) ou filho (`>`). */
  combinator: ' ' | '>';
}

export class SelectorError extends Error {}

const IDENT = /[\w-]/;

function parseSelector(source: string): Part[][] {
  const s = source;
  let i = 0;
  const fail = (msg: string): never => {
    throw new SelectorError(`Seletor inválido "${source}": ${msg} (posição ${i}).`);
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
    if (!key) fail('esperava o nome do atributo depois de "["');
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
      return fail('operador de atributo inválido (use =, ^=, *= ou $=)');
    }
    skipSpaces();
    let value: string;
    const q = s[i];
    if (q === '"' || q === "'") {
      i++;
      const from = i;
      while (i < s.length && s[i] !== q) i++;
      if (i >= s.length) fail('aspas sem fechar');
      value = s.slice(from, i);
      i++;
    } else {
      const from = i;
      while (i < s.length && s[i] !== ']') i++;
      value = s.slice(from, i).trim();
    }
    skipSpaces();
    if (s[i] !== ']') fail('esperava "]"');
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
        if (!v) fail('esperava um id depois de "#"');
        c.ids.push(v);
      } else if (ch === '.') {
        i++;
        const v = ident();
        if (!v) fail('esperava uma classe depois de "."');
        c.classes.push(v);
      } else if (ch === '[') {
        c.attrs.push(parseAttr());
      } else break;
      any = true;
    }
    if (!any) fail(s[i] === undefined ? 'seletor incompleto' : `caractere inesperado "${s[i]}"`);
    return c;
  };

  const list: Part[][] = [];
  skipSpaces();
  if (i >= s.length) fail('seletor vazio');
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
        fail(`caractere inesperado "${s[i]}"`);
      }
      parts.push({ compound: parseCompound(), combinator });
    }
    list.push(parts);
    if (i >= s.length) break;
    i++; // vírgula
    skipSpaces();
    if (i >= s.length) fail('seletor vazio depois da vírgula');
  }
  return list;
}

const ATTR_KEYS =
  'id, name, tag, type, text, src, classes (ou class), component, hidden, locked, style.<prop>, attrs.<nome>';

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
  throw new SelectorError(`Atributo desconhecido "${key}" no seletor. Use: ${ATTR_KEYS}.`);
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
  /** Dentro do escopo (`within`), sem contar o próprio nó de escopo. */
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

/** Ids dos nós que casam com o seletor, em ordem de documento (opcionalmente só descendentes de `within`). */
export function selectIds(doc: Document, selector: string, within?: string | null): string[] {
  const list = parseSelector(selector);
  const entries = buildEntries(doc, within);
  if (within && !entries.some((e) => e.node.id === within)) {
    throw new SelectorError(`Nó de escopo não encontrado: "${within}".`);
  }
  const ids: string[] = [];
  for (const e of entries) {
    if (!e.inScope) continue;
    if (list.some((parts) => matchFrom(e, parts, parts.length - 1))) ids.push(e.node.id);
  }
  return ids;
}
