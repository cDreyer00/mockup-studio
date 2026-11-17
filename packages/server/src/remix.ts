/**
 * Remix: variações de um nó lado a lado. Os tipos locais (`color-scale`, `font-pairs`, `spacing`,
 * `layout`) são planejados pelo core (`planRemix`) e aplicados numa única entrada de undo; o `ai`
 * pede ao assistente que crie as variações num turno (todas as ops do turno viram um grupo).
 */
import { randomUUID } from 'node:crypto';
import {
  findNode,
  planRemix,
  type ClientMessage,
  type Document,
  type RemixKind,
  type RemixResult,
} from '@mockup/core';
import { listSystemFonts } from './fonts.js';
import type { AssistantServiceApi, RemixOptions, RemixServiceApi } from './services.js';
import type { DocumentStore } from './store.js';

export interface RemixServiceOptions {
  assistant?: AssistantServiceApi;
  /** Fontes instaladas no sistema (padrão: `listSystemFonts`, com cache). Injetável nos testes. */
  systemFonts?: () => Promise<{ family: string }[]>;
}

export const REMIX_MAX_COUNT = 10;
/** Quantidade de variações do `ai` quando `count` não é informado. */
export const AI_REMIX_DEFAULT_COUNT = 3;

const KIND_LABEL: Record<RemixKind, string> = {
  'color-scale': 'escala de cor',
  'font-pairs': 'pares de fontes',
  spacing: 'espaçamento',
  layout: 'layout',
  ai: 'com IA',
};

const KINDS = Object.keys(KIND_LABEL);

function checkCount(count: number | undefined): number | undefined {
  if (count === undefined) return undefined;
  if (!Number.isInteger(count) || count < 1 || count > REMIX_MAX_COUNT)
    throw new Error(`count inválido (${String(count)}): use um inteiro de 1 a ${REMIX_MAX_COUNT}.`);
  return count;
}

export class RemixService implements RemixServiceApi {
  constructor(
    readonly store: DocumentStore,
    readonly opts: RemixServiceOptions = {},
  ) {}

  /** Mensagem WS `remix` (origem: editor). */
  async handle(msg: ClientMessage): Promise<unknown> {
    if (msg.type !== 'remix') throw new Error(`Mensagem não tratada pelo remix: "${msg.type}".`);
    return this.run(msg.docId, msg.nodeId, msg.kind, {
      count: msg.count,
      prompt: msg.prompt,
      source: 'editor',
    });
  }

  async run(
    docId: string,
    nodeId: string,
    kind: RemixKind,
    opts: RemixOptions = {},
  ): Promise<RemixResult> {
    if (!KINDS.includes(kind))
      throw new Error(`Tipo de remix inválido: "${String(kind)}". Use ${KINDS.join(', ')}.`);
    const count = checkCount(opts.count);
    const source = opts.source ?? 'editor';
    if (kind === 'ai') return this.runAi(docId, nodeId, count, opts, source);

    const doc = this.store.get(docId);
    const plan = planRemix(doc, nodeId, kind, {
      ...(count !== undefined ? { count } : {}),
      ...(kind === 'font-pairs' ? { fonts: await this.localFonts(doc) } : {}),
    });
    this.store.applyOps(docId, plan.ops, {
      source,
      label: `Remix: ${KIND_LABEL[kind]}`,
      group: opts.group,
    });
    this.store.setSelection(docId, plan.frameIds, source);
    return { frameIds: plan.frameIds, labels: plan.labels };
  }

  /**
   * Famílias disponíveis localmente: as do documento (embutidas ou registradas) e as instaladas no
   * sistema. `undefined` (sem filtro) quando não há como saber.
   */
  private async localFonts(doc: Document): Promise<string[] | undefined> {
    let system: { family: string }[] = [];
    try {
      system = await (this.opts.systemFonts ?? listSystemFonts)();
    } catch {
      // listagem indisponível: usa só as do documento
    }
    const families = new Set([...doc.fonts, ...system].map((f) => f.family));
    return families.size > 0 ? [...families] : undefined;
  }

  private async runAi(
    docId: string,
    nodeId: string,
    count: number | undefined,
    opts: RemixOptions,
    source: 'editor' | 'mcp',
  ): Promise<RemixResult> {
    const assistant = this.opts.assistant;
    if (!assistant)
      throw new Error(
        'O assistente de IA não está disponível neste daemon: o remix com IA precisa dele.',
      );
    const prompt = opts.prompt?.trim();
    if (!prompt)
      throw new Error(
        'O remix com IA exige "prompt": descreva como as variações devem diferir. Ex.: "versões mais ousadas, com mais contraste".',
      );
    if (nodeId.includes('/'))
      throw new Error(
        `O nó "${nodeId}" está dentro de uma instância de componente e não pode ser remixado. Escolha um nó real.`,
      );
    const path = findNode(this.store.get(docId), nodeId);
    if (!path)
      throw new Error(
        `Nó não encontrado: "${nodeId}". Use get_basic_info ou get_tree_summary para ver os ids.`,
      );
    const frame = path.ancestors[0] ?? path.node;
    const pageId = path.page.id;
    const before = new Set(path.page.frames.map((f) => f.id));
    const n = count ?? AI_REMIX_DEFAULT_COUNT;

    const instructions = [
      `REMIX COM IA: crie ${n} variação(ões) do frame raiz que contém o nó ${nodeId} (frame ${frame.id} "${frame.name}"), lado a lado à direita dele, conforme o pedido do usuário.`,
      'Para cada variação i (de 1 a ' + n + '):',
      `1. Duplique o frame ${frame.id} com duplicate_nodes (a cópia traz todos os descendentes).`,
      '2. Posicione a cópia com set_position, na mesma linha (mesmo y) do frame original, à direita de TODOS os frames da página que se sobrepõem a essa linha (use get_basic_info para ver posições e tamanhos), com 80 px entre as cópias.',
      `3. Renomeie a cópia para "${frame.name} — variação i" (rename_nodes).`,
      '4. Altere a cópia conforme o pedido; cada variação deve ser claramente diferente das outras.',
      '5. Confira com get_screenshot e corrija se preciso.',
      'Não altere nem mova o frame original nem os outros frames. Termine com uma frase curta por variação.',
    ].join('\n');

    // Grupo próprio (ou o de quem chamou): as variações são os frames criados pelas ops DESTE
    // grupo, não qualquer frame novo da página (o usuário pode criar frames durante o turno).
    const ownGroup = !opts.group;
    const group = opts.group ?? `remix:${randomUUID()}`;
    let message;
    try {
      message = await assistant.runTurn(docId, prompt, {
        selection: [nodeId],
        instructions,
        group,
      });
    } finally {
      if (ownGroup) {
        this.store.closeGroup(docId, group);
        this.store.finishWorking(docId, []);
      }
    }

    const createdIds = this.store.groupCreatedIds(docId, group);
    const page = this.store.get(docId).pages.find((p) => p.id === pageId);
    const created = (page?.frames ?? []).filter((f) => !before.has(f.id) && createdIds.has(f.id));
    const frameIds = created.map((f) => f.id);
    if (frameIds.length === 0 && (message.status === 'error' || message.status === 'cancelled'))
      throw new Error(
        message.error ??
          (message.status === 'cancelled'
            ? 'O turno do assistente foi cancelado antes de criar as variações.'
            : 'O turno do assistente falhou antes de criar as variações.'),
      );
    if (frameIds.length > 0) this.store.setSelection(docId, frameIds, source);
    return { frameIds, labels: created.map((f) => f.name), turnId: message.turnId };
  }
}
