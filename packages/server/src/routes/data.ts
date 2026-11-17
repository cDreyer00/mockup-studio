import os from 'node:os';
import path from 'node:path';
import type { Express } from 'express';
import { MAX_DATA_ITEMS, PLACEHOLDER_KINDS, type PlaceholderKind } from '@mockup/core';
import {
  DataSourceError,
  bindOps,
  dataReport,
  loadData,
  reloadSource,
  type DataInput,
} from '../datasource.js';
import { PlaceholderError, buildPlaceholder } from '../placeholder.js';
import { RouteError, requireDoc, wrap, type RouteContext } from './shared.js';
import { docWithNodes } from '../component-view.js';

/** Converte os erros de uso em 400 (os demais seguem para o middleware de erro). */
async function guard<T>(fn: () => Promise<T> | T): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof DataSourceError || e instanceof PlaceholderError) {
      throw new RouteError(400, e.message);
    }
    throw e;
  }
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);

function inputOf(body: Record<string, unknown>): DataInput {
  const input: DataInput = {};
  if (body['data'] !== undefined) {
    if (!Array.isArray(body['data'])) throw new RouteError(400, 'data deve ser uma lista.');
    input.data = body['data'];
  }
  const text = str(body['text']);
  if (text !== undefined) input.text = text;
  const p = str(body['path']);
  if (p) input.path = p;
  const url = str(body['url']);
  if (url) input.url = url;
  const format = body['format'];
  if (format !== undefined) {
    if (format !== 'json' && format !== 'csv')
      throw new RouteError(400, 'format deve ser "json" ou "csv".');
    input.format = format;
  }
  const select = str(body['select']);
  if (select) input.select = select;
  const mapping = body['mapping'];
  if (mapping !== undefined && mapping !== null) {
    if (typeof mapping !== 'object' || Array.isArray(mapping))
      throw new RouteError(400, 'mapping deve ser um objeto campo -> caminho.');
    input.mapping = mapping as Record<string, string>;
  }
  const limit = body['limit'];
  if (limit !== undefined && limit !== null) {
    if (
      typeof limit !== 'number' ||
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > MAX_DATA_ITEMS
    )
      throw new RouteError(400, `limit deve ser um inteiro de 1 a ${MAX_DATA_ITEMS}.`);
    input.limit = limit;
  }
  return input;
}

/** Rotas de dados de repetidores e de placeholders (o editor consome). */
export function registerDataRoutes(app: Express, ctx: RouteContext): void {
  const { store } = ctx;

  app.post(
    '/api/data/:docId/:nodeId/bind',
    wrap((req, res) =>
      guard(async () => {
        const docId = String(req.params['docId']);
        requireDoc(ctx, docId);
        const body = (req.body ?? {}) as Record<string, unknown>;
        // Pelo editor, `path` só lê da pasta do documento ou do home (pastas ocultas são recusadas
        // em qualquer caso); o conteúdo colado vai em `text`.
        const docPath = store.getInfo(docId).path;
        const roots = [os.homedir(), ...(docPath ? [path.dirname(docPath)] : [])];
        const loaded = await loadData(inputOf(body), { roots });
        const target = String(req.params['nodeId']);
        const r = bindOps(docWithNodes(store.get(docId), [target]), target, loaded);
        const out = store.applyOps(docId, r.ops, { source: 'editor', label: 'bind_data' });
        const rep = dataReport(docWithNodes(out.doc, [r.nodeId]), r.nodeId);
        res.json({
          nodeId: rep.nodeId,
          count: rep.count,
          columns: rep.columns,
          source: rep.source,
        });
      }),
    ),
  );

  app.post(
    '/api/data/:docId/:nodeId/refresh',
    wrap((req, res) =>
      guard(async () => {
        const docId = String(req.params['docId']);
        requireDoc(ctx, docId);
        const nodeId = String(req.params['nodeId']);
        const rep0 = dataReport(docWithNodes(store.get(docId), [nodeId]), nodeId);
        const loaded = await reloadSource(rep0.source);
        const r = bindOps(docWithNodes(store.get(docId), [nodeId]), nodeId, loaded);
        const out = store.applyOps(docId, r.ops, { source: 'editor', label: 'refresh_data' });
        const rep = dataReport(docWithNodes(out.doc, [r.nodeId]), r.nodeId);
        res.json({
          nodeId: rep.nodeId,
          count: rep.count,
          columns: rep.columns,
          source: rep.source,
        });
      }),
    ),
  );

  app.post(
    '/api/placeholder/:docId',
    wrap((req, res) =>
      guard(async () => {
        const docId = String(req.params['docId']);
        requireDoc(ctx, docId);
        const b = (req.body ?? {}) as Record<string, unknown>;
        const nodeId = str(b['nodeId']);
        if (!nodeId) throw new RouteError(400, 'Informe nodeId.');
        const kind = b['kind'];
        if (typeof kind !== 'string' || !PLACEHOLDER_KINDS.includes(kind as PlaceholderKind))
          throw new RouteError(400, `kind deve ser ${PLACEHOLDER_KINDS.join(', ')}.`);
        const num = (v: unknown, name: string): number | undefined => {
          if (v === undefined || v === null) return undefined;
          if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0)
            throw new RouteError(400, `${name} deve ser um número positivo.`);
          return v;
        };
        const seed = b['seed'];
        const r = await buildPlaceholder(
          docWithNodes(store.get(docId), [nodeId]),
          store.assetsDir(docId),
          {
            nodeId,
            kind: kind as PlaceholderKind,
            ...(typeof seed === 'string' || typeof seed === 'number' ? { seed } : {}),
            ...(num(b['width'], 'width') ? { width: num(b['width'], 'width')! } : {}),
            ...(num(b['height'], 'height') ? { height: num(b['height'], 'height')! } : {}),
            ...(str(b['label']) ? { label: str(b['label'])! } : {}),
          },
        );
        store.applyOps(docId, r.ops, { source: 'editor', label: 'generate_placeholder' });
        res.json({ src: r.src, nodeId: r.nodeId });
      }),
    ),
  );
}
