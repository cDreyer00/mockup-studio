/**
 * Dados de repetidores: leitura de arquivo local, URL, texto colado ou lista direta, e as ops que
 * ligam os dados a um nó (convertendo um contêiner em repetidor quando preciso). Compartilhado pelas
 * ferramentas MCP (`bind_data`, `refresh_data`) e pelas rotas HTTP do editor.
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  MAX_DATA_BYTES,
  MAX_DATA_ITEMS,
  createRepeaterFrom,
  dataColumns,
  findNode,
  guessDataFormat,
  parseCsv,
  selectDataList,
  templateFields,
  type DataSource,
  type Document,
  type Node,
  type Op,
} from '@mockup/core';
import { fetchBytes } from './assets.js';

/** Erro de uso dos dados (mensagem em português dizendo o que fazer). */
export class DataSourceError extends Error {}

/** Limite de leitura de um arquivo ou URL de dados. */
export const MAX_DATA_FILE_BYTES = 5 * 1024 * 1024;

export interface DataInput {
  data?: unknown[];
  text?: string;
  format?: 'json' | 'csv';
  path?: string;
  url?: string;
  select?: string;
  mapping?: Record<string, string>;
  limit?: number;
}

export interface LoadedData {
  data: unknown[];
  source: DataSource;
}

/** Lista de itens de um texto JSON/CSV, sem cortar em `MAX_DATA_ITEMS` (o corte é de quem chama). */
function listFromText(text: string, format: 'json' | 'csv', select?: string): unknown[] {
  if (format === 'csv') return parseCsv(text);
  let json: unknown;
  try {
    json = JSON.parse(text.replace(/^\uFEFF/, ''));
  } catch (e) {
    throw new DataSourceError(
      `JSON inválido: ${e instanceof Error ? e.message : String(e)}. Confira o conteúdo ou informe format "csv".`,
    );
  }
  try {
    return selectDataList(json, select);
  } catch (e) {
    throw new DataSourceError(
      `${e instanceof Error ? e.message : String(e)}. Informe select com o caminho da lista (ex.: "data.items").`,
    );
  }
}

/** Aplica `limit` e valida os limites de itens e de tamanho. */
function finalizeList(list: unknown[], limit?: number): unknown[] {
  const out = limit && limit > 0 ? list.slice(0, limit) : list;
  if (out.length > MAX_DATA_ITEMS) {
    throw new DataSourceError(
      `A origem tem ${out.length} itens e o máximo é ${MAX_DATA_ITEMS}. Use limit (até ${MAX_DATA_ITEMS}) para ler só os primeiros.`,
    );
  }
  if (out.length === 0) {
    throw new DataSourceError(
      'A origem não tem itens. Confira o conteúdo (CSV precisa de cabeçalho e ao menos uma linha) e o select.',
    );
  }
  if (JSON.stringify(out).length > MAX_DATA_BYTES) {
    throw new DataSourceError(
      `Os dados passam de ${MAX_DATA_BYTES / 1024 / 1024} MB. Use limit para ler menos itens.`,
    );
  }
  return out;
}

/** Extensões aceitas em `path` (o conteúdo volta por `get_data` e pela API do documento). */
const DATA_EXTS = ['.json', '.csv', '.tsv'];

export interface LoadOptions {
  /**
   * Pastas onde `path` pode estar (comparadas depois de resolver symlinks). Ausente = qualquer
   * pasta não oculta. A rota HTTP do editor limita à pasta do documento e ao home.
   */
  roots?: string[];
}

const hasHiddenSegment = (p: string): boolean =>
  p.split(/[\\/]+/).some((seg) => seg.startsWith('.'));

const isInside = (root: string, p: string): boolean => {
  const rel = path.relative(root, p);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
};

/**
 * Valida e resolve o caminho de um arquivo de dados: absoluto, .json/.csv/.tsv, sem nenhuma pasta
 * ou arquivo oculto (segmento iniciado por ".", ex.: `~/.ssh`, `~/.claude`), inclusive depois de
 * seguir symlinks, e dentro de `roots` quando informado. Devolve o caminho real.
 */
export async function resolveDataPath(p: string, opts: LoadOptions = {}): Promise<string> {
  // Caminho de rede (\\host\share, //host/share) ou de dispositivo (\\?\, \\.\): recusado antes de
  // qualquer acesso ao disco, porque abrir um compartilhamento SMB pode enviar credenciais NTLM.
  if (/^[\\/]{2}/.test(p)) {
    throw new DataSourceError(
      `Caminho recusado: "${p}" é um caminho de rede ou de dispositivo. Use um arquivo local ou url http(s).`,
    );
  }
  if (!path.isAbsolute(p)) {
    throw new DataSourceError(`path deve ser um caminho absoluto, recebido "${p}".`);
  }
  const resolved = path.resolve(p);
  const hidden = (): DataSourceError =>
    new DataSourceError(
      `Caminho recusado: "${p}" passa por pasta ou arquivo oculto (nome iniciado por "."). Copie os dados para uma pasta comum ou cole o conteúdo em text.`,
    );
  if (hasHiddenSegment(resolved)) throw hidden();
  const badExt = (q: string): boolean => !DATA_EXTS.includes(path.extname(q).toLowerCase());
  if (badExt(resolved)) {
    throw new DataSourceError(
      `Extensão "${path.extname(resolved).toLowerCase()}" não suportada. Use .json, .csv ou .tsv.`,
    );
  }
  let real: string;
  try {
    real = await fs.promises.realpath(resolved);
  } catch {
    throw new DataSourceError(`Arquivo não encontrado: ${p}`);
  }
  if (hasHiddenSegment(real)) throw hidden();
  if (badExt(real)) {
    throw new DataSourceError(
      `"${p}" aponta para um arquivo sem extensão .json, .csv ou .tsv; recusado.`,
    );
  }
  if (opts.roots) {
    const roots: string[] = [];
    for (const r of opts.roots) {
      try {
        roots.push(await fs.promises.realpath(r));
      } catch {
        // pasta inexistente não autoriza nada
      }
    }
    if (!roots.some((r) => isInside(r, real))) {
      throw new DataSourceError(
        `Caminho recusado: pelo editor, o arquivo de dados precisa estar na pasta do documento ou na sua pasta pessoal (${opts.roots.join(', ')}). Cole o conteúdo ou mova o arquivo.`,
      );
    }
  }
  return real;
}

async function readFileData(
  p: string,
  opts: LoadOptions = {},
): Promise<{ text: string; format: 'json' | 'csv' }> {
  const real = await resolveDataPath(p, opts);
  let st: fs.Stats;
  try {
    st = await fs.promises.stat(real);
  } catch {
    throw new DataSourceError(`Arquivo não encontrado: ${p}`);
  }
  if (!st.isFile()) throw new DataSourceError(`"${p}" não é um arquivo.`);
  if (st.size > MAX_DATA_FILE_BYTES) {
    throw new DataSourceError(
      `O arquivo passa do limite de ${MAX_DATA_FILE_BYTES / 1024 / 1024} MB.`,
    );
  }
  return { text: await fs.promises.readFile(real, 'utf8'), format: guessDataFormat(real) };
}

async function readUrlData(url: string): Promise<{ text: string; contentType: string }> {
  if (!/^https?:\/\//i.test(url)) {
    throw new DataSourceError(`url deve começar com http:// ou https://, recebido "${url}".`);
  }
  try {
    const r = await fetchBytes(url, { maxBytes: MAX_DATA_FILE_BYTES, timeoutMs: 20_000 });
    return { text: r.bytes.toString('utf8'), contentType: r.contentType };
  } catch (e) {
    throw new DataSourceError(e instanceof Error ? e.message : String(e));
  }
}

/** Lê os dados da origem informada (exatamente uma entre `data`, `text`, `path`, `url`). */
export async function loadData(input: DataInput, opts: LoadOptions = {}): Promise<LoadedData> {
  const given = [input.data, input.text, input.path, input.url].filter((v) => v !== undefined);
  if (given.length !== 1) {
    throw new DataSourceError(
      'Informe exatamente uma origem: data (lista), text (JSON/CSV colado, com format), path (arquivo .json/.csv/.tsv) ou url (http/https).',
    );
  }
  const base: DataSource = { kind: 'inline' };
  if (input.select) base.select = input.select;
  if (input.mapping && Object.keys(input.mapping).length) base.mapping = input.mapping;
  if (input.limit) base.limit = input.limit;
  const now = new Date().toISOString();

  if (input.data !== undefined) {
    if (!Array.isArray(input.data)) {
      throw new DataSourceError('data deve ser uma lista, ex.: [{ "nome": "Ana" }].');
    }
    return { data: finalizeList(input.data, input.limit), source: { ...base, fetchedAt: now } };
  }
  if (input.text !== undefined) {
    const format =
      input.format ??
      (input.text.trim().startsWith('[') || input.text.trim().startsWith('{') ? 'json' : 'csv');
    const list = listFromText(input.text, format, input.select);
    return { data: finalizeList(list, input.limit), source: { ...base, fetchedAt: now } };
  }
  if (input.path !== undefined) {
    const f = await readFileData(input.path, opts);
    const format = input.format ?? f.format;
    const list = listFromText(f.text, format, input.select);
    return {
      data: finalizeList(list, input.limit),
      source: { ...base, kind: format, path: input.path, fetchedAt: now },
    };
  }
  const url = input.url!;
  const r = await readUrlData(url);
  const format = input.format ?? guessDataFormat(`${r.contentType} ${url}`);
  const list = listFromText(r.text, format, input.select);
  return {
    data: finalizeList(list, input.limit),
    source: { ...base, kind: 'url', url, fetchedAt: now },
  };
}

/** Relê a origem guardada de um repetidor. */
export async function reloadSource(
  source: DataSource | undefined,
  opts: LoadOptions = {},
): Promise<LoadedData> {
  if (!source || source.kind === 'inline') {
    throw new DataSourceError(
      'Este repetidor tem dados colados/editados, sem arquivo ou URL de origem para atualizar. Use bind_data com path ou url.',
    );
  }
  const input: DataInput = {
    ...(source.select ? { select: source.select } : {}),
    ...(source.mapping ? { mapping: source.mapping } : {}),
    ...(source.limit ? { limit: source.limit } : {}),
  };
  if (source.kind === 'url') {
    if (!source.url)
      throw new DataSourceError('A origem URL perdeu o endereço; use bind_data de novo.');
    input.url = source.url;
  } else {
    if (!source.path)
      throw new DataSourceError('A origem de arquivo perdeu o caminho; use bind_data de novo.');
    input.path = source.path;
    input.format = source.kind;
  }
  return loadData(input, opts);
}

export interface BindResult {
  ops: Op[];
  /** Id do repetidor depois das ops (muda quando o contêiner é convertido). */
  nodeId: string;
  converted: boolean;
}

/** Ops que ligam `loaded` ao nó: `setData` num repetidor ou conversão do contêiner em repetidor. */
export function bindOps(doc: Document, nodeId: string, loaded: LoadedData): BindResult {
  const p = findNode(doc, nodeId);
  if (!p) {
    throw new DataSourceError(
      `Nó não encontrado: "${nodeId}". Use get_tree_summary para listar ids válidos.`,
    );
  }
  const node = p.node;
  if (node.type === 'repeater') {
    return {
      ops: [{ type: 'setData', changes: [{ nodeId, data: loaded.data, source: loaded.source }] }],
      nodeId,
      converted: false,
    };
  }
  if (node.type === 'text' || node.type === 'image' || node.type === 'svg') {
    throw new DataSourceError(
      `O nó ${nodeId} é ${node.type}; dados ligam a um contêiner com o template dentro. Passe o id do contêiner pai.`,
    );
  }
  if (!p.parent) {
    throw new DataSourceError(
      `O nó ${nodeId} é um frame raiz; não vira repetidor. Coloque o template dentro de um contêiner (ex.: write_html com uma div com os cards) e passe o id dele.`,
    );
  }
  if (node.children.length === 0) {
    throw new DataSourceError(
      `O contêiner ${nodeId} não tem filhos. Crie primeiro o template, ex.: write_html com um card usando {{nome}}, e chame bind_data de novo.`,
    );
  }
  const rep = createRepeaterFrom(node, loaded.data, loaded.source);
  return {
    ops: [
      { type: 'deleteNodes', nodeIds: [nodeId] },
      { type: 'createNode', parentId: p.parent.id, node: rep, index: p.index },
    ],
    nodeId: rep.id,
    converted: true,
  };
}

export interface DataReport {
  nodeId: string;
  count: number;
  columns: string[];
  source: DataSource;
  templateFields: string[];
  warnings: string[];
}

function rootOf(field: string): string {
  return field.split('.')[0]!;
}

/** Campos do template sem coluna correspondente (considera `mapping`). */
export function missingFields(node: Node, data: unknown[], source?: DataSource): string[] {
  const columns = dataColumns(data, 200);
  if (columns.includes('$item')) return [];
  const out: string[] = [];
  for (const f of templateFields(node.children)) {
    if (f.startsWith('$')) continue;
    const target = source?.mapping?.[f] ?? f;
    if (!columns.includes(rootOf(target))) out.push(f);
  }
  return out;
}

/** Relatório do repetidor `nodeId` no documento atual. */
export function dataReport(doc: Document, nodeId: string): DataReport {
  const p = findNode(doc, nodeId);
  if (!p || p.node.type !== 'repeater') {
    throw new DataSourceError(
      `O nó ${nodeId} não é um repetidor. Use bind_data para ligar dados a um contêiner.`,
    );
  }
  const data = Array.isArray(p.node.data) ? p.node.data : [];
  const fields = templateFields(p.node.children);
  const warnings = missingFields(p.node, data, p.node.dataSource).map(
    (f) =>
      `O campo {{${f}}} do template não tem coluna correspondente${p.node.dataSource?.mapping?.[f] ? ` (mapeado para "${p.node.dataSource.mapping[f]}")` : ''}; ajuste o template ou use mapping.`,
  );
  return {
    nodeId,
    count: data.length,
    columns: dataColumns(data),
    source: p.node.dataSource ?? { kind: 'inline' },
    templateFields: fields,
    warnings,
  };
}
