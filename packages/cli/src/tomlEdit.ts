/**
 * Editor de linhas mínimo para a seção `[mcp_servers.mockup-studio]` do `~/.codex/config.toml`.
 * Não é um parser TOML: localiza a seção, lê strings e arrays de strings de uma linha (ou várias) e troca
 * só as linhas de uma chave, preservando o resto do arquivo (comentários, outras seções, CRLF).
 */

export interface TomlDoc {
  lines: string[];
  eol: string;
}

export function parseDoc(text: string): TomlDoc {
  return { lines: text.split(/\r?\n/), eol: text.includes('\r\n') ? '\r\n' : '\n' };
}

export const renderDoc = (d: TomlDoc): string => d.lines.join(d.eol);

const HEADER_RE =
  /^\s*\[\s*mcp_servers\s*\.\s*(?:mockup-studio|"mockup-studio"|'mockup-studio')\s*\]\s*(?:#.*)?$/;
/** Subtabela `[mcp_servers.mockup-studio.env]`. */
export const ENV_HEADER_RE =
  /^\s*\[\s*mcp_servers\s*\.\s*(?:mockup-studio|"mockup-studio"|'mockup-studio')\s*\.\s*env\s*\]\s*(?:#.*)?$/;
export const ENV_HEADER = '[mcp_servers.mockup-studio.env]';
const ANY_HEADER_RE = /^\s*\[/;
const KEY_RE = /^\s*(?:"([^"]+)"|'([^']+)'|([A-Za-z0-9_-]+))\s*=(.*)$/;

export interface Entry {
  key: string;
  /** Primeira linha (índice) e fim exclusivo. */
  from: number;
  to: number;
  raw: string;
}

export interface Section {
  start: number;
  end: number;
  entries: Entry[];
}

/** Saldo de colchetes de um texto, ignorando strings e comentários. */
function bracketDepth(s: string): number {
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '"') {
      for (i++; i < s.length && s[i] !== '"'; i++) if (s[i] === '\\') i++;
    } else if (c === "'") {
      for (i++; i < s.length && s[i] !== "'"; i++);
    } else if (c === '#') break;
    else if (c === '[') depth++;
    else if (c === ']') depth--;
  }
  return depth;
}

/** Seção principal (padrão) ou outra pelo cabeçalho (ex.: `ENV_HEADER_RE`). */
export function findSection(doc: TomlDoc, header: RegExp = HEADER_RE): Section | null {
  const { lines } = doc;
  const start = lines.findIndex((l) => header.test(l));
  if (start < 0) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++)
    if (ANY_HEADER_RE.test(lines[i])) {
      end = i;
      break;
    }
  const entries: Entry[] = [];
  for (let i = start + 1; i < end; i++) {
    const m = KEY_RE.exec(lines[i]);
    if (!m) continue;
    let raw = m[4];
    let to = i + 1;
    while (bracketDepth(raw) > 0 && to < end) raw += `\n${lines[to++]}`;
    entries.push({ key: m[1] ?? m[2] ?? m[3], from: i, to, raw });
    i = to - 1;
  }
  return { start, end, entries };
}

const ESCAPES: Record<string, string> = {
  b: '\b',
  t: '\t',
  n: '\n',
  f: '\f',
  r: '\r',
  '"': '"',
  '\\': '\\',
};

/** Lê string, ou array de strings; `undefined` se não conseguir interpretar. */
export function parseValue(raw: string): string | string[] | undefined {
  let pos = 0;
  const skip = () => {
    for (;;) {
      while (pos < raw.length && /\s/.test(raw[pos])) pos++;
      if (raw[pos] === '#') while (pos < raw.length && raw[pos] !== '\n') pos++;
      else return;
    }
  };
  const str = (): string | undefined => {
    const q = raw[pos++];
    let out = '';
    while (pos < raw.length) {
      const c = raw[pos++];
      if (c === q) return out;
      if (q === "'" || c !== '\\') {
        if (c === '\n') return undefined;
        out += c;
        continue;
      }
      const e = raw[pos++];
      if (e === 'u' || e === 'U') {
        const n = e === 'u' ? 4 : 8;
        const hex = raw.slice(pos, pos + n);
        if (!new RegExp(`^[0-9a-fA-F]{${n}}$`).test(hex)) return undefined;
        const cp = parseInt(hex, 16);
        if (cp > 0x10ffff) return undefined;
        out += String.fromCodePoint(cp);
        pos += n;
      } else if (e !== undefined && e in ESCAPES) out += ESCAPES[e];
      else return undefined;
    }
    return undefined;
  };
  skip();
  let result: string | string[] | undefined;
  if (raw[pos] === '"' || raw[pos] === "'") {
    if (raw.startsWith('"""', pos) || raw.startsWith("'''", pos)) return undefined;
    result = str();
  } else if (raw[pos] === '[') {
    pos++;
    const arr: string[] = [];
    for (;;) {
      skip();
      if (raw[pos] === ']') {
        pos++;
        break;
      }
      if (raw[pos] === ',') {
        pos++;
        continue;
      }
      if (raw[pos] !== '"' && raw[pos] !== "'") return undefined;
      const s = str();
      if (s === undefined) return undefined;
      arr.push(s);
    }
    result = arr;
  }
  if (result === undefined) return undefined;
  skip();
  return pos >= raw.length ? result : undefined;
}

/** Valor atual de uma chave da seção (`undefined` se ausente ou ilegível). */
export function getValue(
  doc: TomlDoc,
  key: string,
  header: RegExp = HEADER_RE,
): string | string[] | undefined {
  const e = findSection(doc, header)?.entries.find((x) => x.key === key);
  return e ? parseValue(e.raw) : undefined;
}

/** Troca (ou insere) `key = valor` na seção. `false` se não há seção ou nada mudou. */
export function setKey(
  doc: TomlDoc,
  key: string,
  valueText: string,
  header: RegExp = HEADER_RE,
): boolean {
  const sec = findSection(doc, header);
  if (!sec) return false;
  const line = `${key} = ${valueText}`;
  const e = sec.entries.find((x) => x.key === key);
  if (e) {
    if (e.to - e.from === 1 && doc.lines[e.from].trim() === line) return false;
    doc.lines.splice(e.from, e.to - e.from, line);
  } else {
    const last = sec.entries[sec.entries.length - 1];
    doc.lines.splice(last ? last.to : sec.start + 1, 0, line);
  }
  return true;
}

export function removeKey(doc: TomlDoc, key: string): boolean {
  const e = findSection(doc)?.entries.find((x) => x.key === key);
  if (!e) return false;
  doc.lines.splice(e.from, e.to - e.from);
  return true;
}

/** Pares string da subtabela `env` da seção. */
export function readEnv(doc: TomlDoc): Record<string, string> {
  const out: Record<string, string> = {};
  for (const e of findSection(doc, ENV_HEADER_RE)?.entries ?? []) {
    const v = parseValue(e.raw);
    if (typeof v === 'string') out[e.key] = v;
  }
  return out;
}

/** Grava os pares na subtabela `env`, criando-a logo depois da seção principal se preciso. */
export function setEnv(
  doc: TomlDoc,
  env: Record<string, string>,
  quote: (s: string) => string,
): boolean {
  const pairs = Object.entries(env);
  if (!pairs.length) return false;
  if (!findSection(doc, ENV_HEADER_RE)) {
    const main = findSection(doc);
    if (!main) return false;
    const last = main.entries[main.entries.length - 1];
    doc.lines.splice(last ? last.to : main.start + 1, 0, '', ENV_HEADER);
  }
  let changed = false;
  for (const [k, v] of pairs) changed = setKey(doc, k, quote(v), ENV_HEADER_RE) || changed;
  return changed;
}
