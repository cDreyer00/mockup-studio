/**
 * Lado do daemon da API de scripts: implementa os `method`s que o bootstrap do contexto chama
 * pela ponte (ver `worker-source.ts`). Tudo que entra aqui veio de código não confiável e já
 * atravessou como JSON: os argumentos são validados antes de tocar o documento.
 */
import {
  createNodeFromTag,
  findNode,
  normalizeTokenName,
  parseOp,
  type Document,
  type Node,
  type Op,
} from '@mockup/core';
import type { ScriptImage } from '@mockup/core';
import { renderTargetFor } from '../component-view.js';
import { renderUnavailableMessage, type RenderProvider } from '../render.js';
import type { DocumentStore } from '../store.js';
import { SelectorError, selectIds } from './selector.js';

const MAX_CALLS = 200_000;
const MAX_OPS_PER_APPLY = 20_000;
const MAX_IMAGES = 8;
const MAX_CREATE_NODES = 2000;
const MAX_CREATE_DEPTH = 24;
const MAX_SRC_IN_SNAPSHOT = 200;

/** Visão JSON de um nó entregue ao script (predicados e `toJSON`). */
export interface NodeSnapshot {
  id: string;
  type: Node['type'];
  tag: string;
  name: string;
  text?: string;
  attrs: Record<string, string>;
  style: Record<string, string>;
  classes?: string;
  position?: { x: number; y: number };
  hidden: boolean;
  locked: boolean;
  src?: string;
  componentId?: string;
  props?: Node['props'];
  parentId: string | null;
  childIds: string[];
  frameId: string;
  pageId: string;
}

function snapshotOf(
  n: Node,
  parentId: string | null,
  frameId: string,
  pageId: string,
): NodeSnapshot {
  return {
    id: n.id,
    type: n.type,
    tag: n.tag,
    name: n.name,
    ...(n.text !== undefined ? { text: n.text } : {}),
    attrs: n.attrs,
    style: n.style,
    ...(n.classes ? { classes: n.classes } : {}),
    ...(n.position ? { position: n.position } : {}),
    hidden: n.hidden,
    locked: n.locked,
    ...(n.src
      ? {
          src:
            n.src.length > MAX_SRC_IN_SNAPSHOT ? `${n.src.slice(0, MAX_SRC_IN_SNAPSHOT)}…` : n.src,
        }
      : {}),
    ...(n.componentId ? { componentId: n.componentId } : {}),
    ...(n.props ? { props: n.props } : {}),
    parentId,
    childIds: n.children.map((c) => c.id),
    frameId,
    pageId,
  };
}

/** Ids de nós tocados pelas ops (para o resumo da árvore no `run_script`). */
export function touchedNodeIds(ops: readonly Op[]): string[] {
  const ids = new Set<string>();
  for (const op of ops) {
    const o = op as unknown as Record<string, unknown>;
    if (Array.isArray(o['nodeIds'])) for (const id of o['nodeIds']) ids.add(String(id));
    if (typeof o['nodeId'] === 'string') ids.add(o['nodeId']);
    if (Array.isArray(o['changes'])) {
      for (const c of o['changes'] as { nodeId?: unknown }[]) {
        if (typeof c?.nodeId === 'string') ids.add(c.nodeId);
      }
    }
    const node = o['node'] as { id?: unknown } | undefined;
    if (op.type === 'createNode' && typeof node?.id === 'string') ids.add(node.id);
    if (op.type === 'duplicateNodes' && op.idMap)
      for (const id of Object.values(op.idMap)) ids.add(id);
  }
  return [...ids];
}

export interface ScriptHostOptions {
  store: DocumentStore;
  docId: string;
  /** Seleção vista por `doc.selection()` (padrão: a do daemon). */
  selection?: string[];
  group: string;
  source: 'editor' | 'mcp';
  render?: RenderProvider;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

export class ScriptHost {
  opsCount = 0;
  readonly images: ScriptImage[] = [];
  /** Verdadeiro depois do fim da execução: chamadas tardias (screenshot em andamento) são recusadas. */
  closed = false;
  private calls = 0;

  constructor(private readonly o: ScriptHostOptions) {}

  private get doc(): Document {
    return this.o.store.get(this.o.docId);
  }

  async call(method: string, rawArgs: unknown): Promise<unknown> {
    if (this.closed) throw new Error('A execução do script já terminou.');
    if (++this.calls > MAX_CALLS) {
      throw new Error(`O script fez chamadas demais à API do documento (limite ${MAX_CALLS}).`);
    }
    const args = isRecord(rawArgs) ? rawArgs : {};
    switch (method) {
      case 'docInfo':
        return { id: this.o.docId, name: this.doc.name };
      case 'pages':
        return this.doc.pages.map((p) => ({
          id: p.id,
          name: p.name,
          frameIds: p.frames.map((f) => f.id),
        }));
      case 'frames':
        return this.frames(args['pageId']);
      case 'node':
        return this.node(this.str(args, 'id'));
      case 'nodes':
        return this.nodes(args['within']);
      case 'select':
        return this.select(args['selector'], args['within']);
      case 'selection':
        return this.selection();
      case 'apply':
        return this.applyOps(args['ops']);
      case 'create':
        return this.create(args['parentId'], args['spec']);
      case 'screenshot':
        return this.screenshot(args);
      case 'tokens':
        return { ...this.doc.tokens };
      case 'setTokens':
        return this.setTokens(args['tokens']);
      default:
        throw new Error(`Método desconhecido da API do documento: "${method}".`);
    }
  }

  private str(args: Record<string, unknown>, key: string): string {
    const v = args[key];
    if (typeof v !== 'string' || !v)
      throw new Error(`Argumento "${key}" inválido (esperava uma string).`);
    return v;
  }

  private frames(pageId: unknown): string[] {
    const doc = this.doc;
    if (typeof pageId === 'string') {
      const page = doc.pages.find((p) => p.id === pageId);
      if (!page) throw new Error(`Página não encontrada: "${pageId}".`);
      return page.frames.map((f) => f.id);
    }
    return doc.pages.flatMap((p) => p.frames.map((f) => f.id));
  }

  private node(id: string): NodeSnapshot | null {
    const p = findNode(this.doc, id);
    if (!p) return null;
    return snapshotOf(p.node, p.parent?.id ?? null, (p.ancestors[0] ?? p.node).id, p.page.id);
  }

  private nodes(within: unknown): NodeSnapshot[] {
    const doc = this.doc;
    const scope = typeof within === 'string' && within ? within : null;
    if (scope && !findNode(doc, scope)) throw new Error(`Nó de escopo não encontrado: "${scope}".`);
    const out: NodeSnapshot[] = [];
    const visit = (
      n: Node,
      parentId: string | null,
      frameId: string,
      pageId: string,
      scoped: boolean,
    ) => {
      if (scoped) out.push(snapshotOf(n, parentId, frameId, pageId));
      const childScoped = scoped || n.id === scope;
      for (const c of n.children) visit(c, n.id, frameId, pageId, childScoped);
    };
    for (const page of doc.pages) {
      for (const f of page.frames) visit(f, null, f.id, page.id, !scope);
    }
    return out;
  }

  private select(selector: unknown, within: unknown): string[] {
    if (typeof selector !== 'string') throw new Error('Seletor inválido: esperava uma string.');
    try {
      return selectIds(this.doc, selector, typeof within === 'string' ? within : null);
    } catch (e) {
      if (e instanceof SelectorError) throw new Error(e.message);
      throw e;
    }
  }

  private selection(): string[] {
    const doc = this.doc;
    const ids = this.o.selection ?? this.o.store.getSelection(this.o.docId);
    return ids.filter((id) => findNode(doc, id));
  }

  private apply(ops: Op[]) {
    const r = this.o.store.applyOps(this.o.docId, ops, {
      source: this.o.source,
      label: 'script',
      group: this.o.group,
    });
    this.opsCount += r.appliedOps.length;
    return r;
  }

  private applyOps(raw: unknown): unknown[] {
    if (!Array.isArray(raw)) throw new Error('doc.apply espera uma op ou um array de ops.');
    if (raw.length > MAX_OPS_PER_APPLY) {
      throw new Error(`Ops demais numa só chamada (${raw.length}; limite ${MAX_OPS_PER_APPLY}).`);
    }
    if (raw.length === 0) return [];
    const ops = raw.map((o) => parseOp(o));
    const r = this.apply(ops);
    return r.results.map((x) => {
      if (!x) return null;
      const { op: _op, ...rest } = x as Record<string, unknown>;
      return rest;
    });
  }

  private buildNode(spec: unknown, depth: number, budget: { left: number }, root: boolean): Node {
    if (!isRecord(spec))
      throw new Error(
        'A descrição do nó deve ser um objeto { tag, name, text, style, attrs, children }.',
      );
    if (depth > MAX_CREATE_DEPTH) throw new Error('Árvore profunda demais em doc.create.');
    if (--budget.left < 0)
      throw new Error(`Nós demais em doc.create (limite ${MAX_CREATE_NODES}).`);
    const tag = spec['tag'] === undefined ? 'div' : spec['tag'];
    if (typeof tag !== 'string') throw new Error('"tag" deve ser uma string.');
    const strMap = (v: unknown, what: string): Record<string, string> | undefined => {
      if (v === undefined || v === null) return undefined;
      if (!isRecord(v)) throw new Error(`"${what}" deve ser um objeto { nome: valor }.`);
      return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, String(x)]));
    };
    const optStr = (v: unknown, what: string): string | undefined => {
      if (v === undefined || v === null) return undefined;
      if (typeof v !== 'string') throw new Error(`"${what}" deve ser uma string.`);
      return v;
    };
    const children = Array.isArray(spec['children'])
      ? spec['children'].map((c) => this.buildNode(c, depth + 1, budget, false))
      : undefined;
    const pos = spec['position'];
    const position =
      isRecord(pos) && Number.isFinite(Number(pos['x'])) && Number.isFinite(Number(pos['y']))
        ? { x: Number(pos['x']), y: Number(pos['y']) }
        : undefined;
    return createNodeFromTag(tag, {
      name: optStr(spec['name'], 'name'),
      text: optStr(spec['text'], 'text'),
      styles: strMap(spec['style'], 'style'),
      attrs: strMap(spec['attrs'], 'attrs'),
      src: optStr(spec['src'], 'src'),
      svg: optStr(spec['svg'], 'svg'),
      children,
      isRoot: root,
      position,
    });
  }

  private create(parentId: unknown, spec: unknown): string {
    const doc = this.doc;
    const budget = { left: MAX_CREATE_NODES };
    if (parentId === null || parentId === undefined) {
      const node = this.buildNode(spec, 0, budget, true);
      const page = doc.pages[0];
      if (!page) throw new Error('O documento não tem páginas.');
      if (!node.position) {
        const last = page.frames[page.frames.length - 1];
        const w = last ? parseFloat(last.style['width'] ?? '') : NaN;
        node.position = {
          x: last ? (last.position?.x ?? 0) + (Number.isFinite(w) ? w : 0) + 100 : 0,
          y: last?.position?.y ?? 0,
        };
      }
      this.apply([{ type: 'createNode', parentId: null, pageId: page.id, node }]);
      return node.id;
    }
    if (typeof parentId !== 'string' || !findNode(doc, parentId)) {
      throw new Error(`Nó pai não encontrado: "${String(parentId)}".`);
    }
    const node = this.buildNode(spec, 0, budget, false);
    const index =
      isRecord(spec) && Number.isInteger(spec['index']) ? (spec['index'] as number) : undefined;
    this.apply([{ type: 'createNode', parentId, node, index }]);
    return node.id;
  }

  private setTokens(raw: unknown): Record<string, string> {
    if (!isRecord(raw))
      throw new Error('doc.setTokens espera um objeto { "--nome": "valor" } (null remove).');
    const set: Record<string, string> = {};
    const unset: string[] = [];
    for (const [k, v] of Object.entries(raw)) {
      const name = normalizeTokenName(k);
      if (v === null) unset.push(name);
      else set[name] = String(v);
    }
    if (Object.keys(set).length || unset.length) {
      this.apply([
        {
          type: 'setTokens',
          ...(Object.keys(set).length ? { set } : {}),
          ...(unset.length ? { unset } : {}),
        },
      ]);
    }
    return { ...this.doc.tokens };
  }

  private async screenshot(args: Record<string, unknown>) {
    const { render, store, docId } = this.o;
    if (!render) throw new Error(renderUnavailableMessage({ pid: process.pid }));
    if (this.images.length >= MAX_IMAGES) {
      throw new Error(`Screenshots demais numa execução (limite ${MAX_IMAGES}).`);
    }
    const scale = args['scale'] ?? 1;
    if (scale !== 1 && scale !== 2 && scale !== 3) throw new Error('scale deve ser 1, 2 ou 3.');
    const format = args['format'] ?? 'png';
    if (format !== 'png' && format !== 'jpg') throw new Error('format deve ser "png" ou "jpg".');
    const doc = this.doc;
    let target = typeof args['nodeId'] === 'string' ? args['nodeId'] : undefined;
    if (!target) {
      target = this.selection()[0] ?? doc.pages.flatMap((p) => p.frames)[0]?.id;
      if (!target) throw new Error('O documento não tem frames para capturar.');
    }
    const rt = renderTargetFor(doc, target);
    if (!rt) throw new Error(`Nó não encontrado: "${target}".`);
    let r;
    try {
      r = await render.capture({
        doc: rt.doc,
        docId,
        nodeId: rt.nodeId,
        assetsDir: store.assetsDir(docId),
        scale,
        format,
      });
    } catch (e) {
      throw new Error(
        `Falha ao renderizar ${target}: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
    if (this.closed) throw new Error('A execução do script já terminou.');
    const width = Math.round(r.width);
    const height = Math.round(r.height);
    this.images.push({
      nodeId: target,
      mime: r.mime,
      data: r.data.toString('base64'),
      width,
      height,
    });
    return { nodeId: target, width, height, mime: r.mime };
  }
}
