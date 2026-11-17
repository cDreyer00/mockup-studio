/**
 * Editor de linhas mínimo para a seção `[mcp_servers.mockup-studio]` do `~/.codex/config.toml`.
 * A leitura usa um parser TOML de verdade (`smol-toml`); a escrita troca só as linhas de uma chave,
 * preservando o resto do arquivo (comentários, outras seções, CRLF). Quem grava valida o texto
 * resultante com `tomlError` antes.
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

/** Erro de sintaxe do TOML (primeira linha da mensagem do parser, com linha:coluna), ou `null`. */
export function tomlError(text: string): string | null {
  try {
    parse(text);
    return null;
  } catch (e) {
    const err = e as { message?: string; line?: number; column?: number };
    const msg = (err.message ?? String(e)).split('\n')[0].replace(/^Invalid TOML document:\s*/, '');
    return err.line ? `linha ${err.line}, coluna ${err.column}: ${msg}` : msg;
  }
}

/** Tabela `mcp_servers.mockup-studio` do texto, ou `undefined`. Lança se o TOML é inválido. */
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
/** Chave simples ou pontilhada (`env.A`) e o resto da linha. */
const KEY_RE = new RegExp(String.raw`^\s*(${PART}(?:\s*\.\s*${PART})*)\s*=(.*)$`);
const PART_RE = new RegExp(PART, 'g');
/** Nome da chave sem aspas; as partes de uma chave pontilhada são unidas por `.`. */
const keyName = (text: string) =>
  (text.match(PART_RE) ?? []).map((p) => (/^["']/.test(p) ? p.slice(1, -1) : p)).join('.');

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

/**
 * Varre o valor de uma chave (pode ter várias linhas): `complete` quando colchetes/chaves fecharam e
 * nenhuma string `"""`/`'''` ficou aberta; `comment` é o comentário depois do valor (com o `#`).
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
          while (s[i] === q[0]) i++; // até duas aspas extras fazem parte do conteúdo
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

/** Seção principal ou uma subtabela dela (ex.: `env`). */
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

/** Troca (ou insere) `key = valor` na seção, mantendo o comentário do fim da linha. `false` se nada mudou. */
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

/** Remove a subtabela `[mcp_servers.mockup-studio.<sub>]` inteira (até o próximo cabeçalho). */
export function removeSubtable(doc: TomlDoc, sub: string): boolean {
  const sec = findSection(doc, sub);
  if (!sec) return false;
  let from = sec.start;
  if (from > 0 && doc.lines[from - 1].trim() === '') from--;
  let to = sec.end;
  // as linhas em branco do fim ficam (separam a próxima seção / quebra final); a de antes sai
  while (to > sec.start + 1 && doc.lines[to - 1].trim() === '') to--;
  doc.lines.splice(from, to - from);
  return true;
}

/** Remove a chave em linha e a subtabela; devolve os nomes removidos (`env`, `[...env]`). */
export function removeKeyOrTable(doc: TomlDoc, key: string): string[] {
  const out: string[] = [];
  if (removeKey(doc, key)) out.push(key);
  for (const e of findSection(doc)?.entries.filter((x) => x.key.startsWith(`${key}.`)) ?? [])
    if (removeKey(doc, e.key)) out.push(e.key);
  if (removeSubtable(doc, key)) out.push(subHeader(key));
  return out;
}

/**
 * Garante os pares na tabela `env`: se a seção tem `env = { ... }` em linha, reescreve a mesma chave
 * em linha (com os pares antigos e os novos); senão usa a subtabela `[mcp_servers.mockup-studio.env]`,
 * criando-a logo depois da seção principal. Lança se o `env` em linha não for legível.
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
    throw new Error('env definido com chaves pontilhadas (env.NOME = ...) na seção');
  const inline = main.entries.find((x) => x.key === 'env');
  if (inline) {
    let cur: unknown;
    try {
      cur = parse(`env = ${inline.raw}`).env;
    } catch {
      cur = undefined;
    }
    if (!cur || typeof cur !== 'object' || Array.isArray(cur))
      throw new Error('o valor de env na seção não é uma tabela legível');
    const merged = { ...(cur as Record<string, unknown>), ...env };
    if (pairs.every(([k, v]) => (cur as Record<string, unknown>)[k] === v)) return false;
    const body = Object.entries(merged)
      .map(([k, v]) => `${BARE_KEY.test(k) ? k : quote(k)} = ${quote(String(v))}`)
      .join(', ');
    return setKey(doc, 'env', `{ ${body} }`);
  }
  if (!findSection(doc, 'env')) {
    // no fim da seção (antes das linhas em branco), para não capturar linhas que o editor não reconhece
    let at = main.end;
    while (at > main.start + 1 && doc.lines[at - 1].trim() === '') at--;
    doc.lines.splice(at, 0, '', subHeader('env'));
  }
  let changed = false;
  for (const [k, v] of pairs) changed = setKey(doc, k, quote(v), 'env') || changed;
  return changed;
}
