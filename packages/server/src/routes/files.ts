/**
 * Rotas de organização e busca de arquivos: lista com filtros, metadados (pasta, tags, favorito),
 * pastas virtuais, registro/esquecimento, miniaturas e busca de nós nos documentos abertos.
 */
import type { Express } from 'express';
import { searchNodes } from '@mockup/core';
import { FileIndex, getFileIndex } from '../files.js';
import { renderUnavailableMessage } from '../render.js';
import { RouteError, wrap, type RouteContext } from './shared.js';

const flag = (v: unknown): boolean => v === '1' || v === 'true' || v === 'yes';
const optStr = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

function tagList(v: unknown, field: string): string[] | undefined {
  if (v === undefined) return undefined;
  if (!Array.isArray(v) || v.some((t) => typeof t !== 'string'))
    throw new RouteError(
      400,
      `${field} deve ser uma lista de textos. Ex.: ["cliente", "rascunho"].`,
    );
  return v as string[];
}

export function registerFilesRoutes(app: Express, ctx: RouteContext): void {
  const index = (): FileIndex => getFileIndex(ctx.store, ctx.dataDir);

  app.get(
    '/api/files',
    wrap(async (req, res) => {
      const q = req.query;
      res.json(
        await index().list({
          folder: optStr(q.folder),
          tag: optStr(q.tag),
          query: optStr(q.query),
          favorites: flag(q.favorites),
          recursive: flag(q.recursive),
        }),
      );
    }),
  );

  app.post(
    '/api/files/meta',
    wrap(async (req, res) => {
      const b = (req.body ?? {}) as Record<string, unknown>;
      if (b.folder !== undefined && b.folder !== null && typeof b.folder !== 'string')
        throw new RouteError(400, 'folder deve ser um texto ou null.');
      if (b.favorite !== undefined && typeof b.favorite !== 'boolean')
        throw new RouteError(400, 'favorite deve ser true ou false.');
      res.json(
        await index().setMeta(FileIndex.requireDocPath(b.path), {
          folder: b.folder as string | null | undefined,
          tags: tagList(b.tags, 'tags'),
          addTags: tagList(b.addTags, 'addTags'),
          removeTags: tagList(b.removeTags, 'removeTags'),
          favorite: b.favorite as boolean | undefined,
        }),
      );
    }),
  );

  app.post(
    '/api/files/folders',
    wrap(async (req, res) => {
      const b = (req.body ?? {}) as Record<string, unknown>;
      const p = optStr(b.path);
      if (!p) throw new RouteError(400, 'Campo obrigatório ausente: path (nome da pasta).');
      let folders: string[];
      switch (b.action) {
        case 'create':
          folders = await index().createFolder(p);
          break;
        case 'rename': {
          const to = optStr(b.to);
          if (!to) throw new RouteError(400, 'Para renomear, informe o novo caminho em "to".');
          folders = await index().renameFolder(p, to);
          break;
        }
        case 'delete':
          folders = await index().deleteFolder(p);
          break;
        default:
          throw new RouteError(400, 'action deve ser "create", "rename" ou "delete".');
      }
      res.json({ folders });
    }),
  );

  app.post(
    '/api/files/add',
    wrap(async (req, res) => {
      const p = optStr((req.body as Record<string, unknown> | undefined)?.path);
      if (!p) throw new RouteError(400, 'Campo obrigatório ausente: path.');
      res.json({ added: await index().add(p) });
    }),
  );

  app.post(
    '/api/files/forget',
    wrap(async (req, res) => {
      const p = optStr((req.body as Record<string, unknown> | undefined)?.path);
      if (!p) throw new RouteError(400, 'Campo obrigatório ausente: path.');
      await index().forget(p);
      res.json({ ok: true });
    }),
  );

  app.get(
    '/api/files/thumbnail',
    wrap(async (req, res) => {
      const p = FileIndex.requireDocPath(optStr(req.query.path));
      let w = 480;
      if (req.query.w !== undefined) {
        w = Number(req.query.w);
        if (!Number.isFinite(w) || w < 1)
          throw new RouteError(400, 'w deve ser a largura em pixels, de 1 a 1024. Ex.: w=480.');
        w = Math.min(1024, Math.round(w));
      }
      if (!ctx.render) {
        res
          .status(503)
          .json({ error: renderUnavailableMessage({ pid: process.pid, port: ctx.getPort?.() }) });
        return;
      }
      let png: Buffer;
      try {
        png = await index().thumbnail(p, w, ctx.render);
      } catch (e) {
        if (e instanceof Error && 'status' in e) throw e;
        throw new RouteError(
          500,
          `Falha ao gerar a miniatura: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
      res.set('Content-Type', 'image/png').set('Cache-Control', 'no-cache').send(png);
    }),
  );

  app.get(
    '/api/search/nodes',
    wrap((req, res) => {
      const query = optStr(req.query.query)?.trim();
      if (!query)
        throw new RouteError(
          400,
          'Informe a consulta em ?query=. Ex.: query=tag:button, query=text:"fale conosco".',
        );
      const docId = optStr(req.query.docId);
      const limit = req.query.limit === undefined ? 50 : Math.max(1, Number(req.query.limit) || 50);
      const infos = docId ? ctx.store.list().filter((d) => d.docId === docId) : ctx.store.list();
      if (docId && infos.length === 0)
        throw new RouteError(404, `Documento não encontrado: ${docId}`);
      const matches: ({ docId: string } & ReturnType<typeof searchNodes>[number])[] = [];
      for (const info of infos) {
        if (matches.length >= limit) break;
        const found = searchNodes(ctx.store.get(info.docId), query, {
          limit: limit - matches.length,
        });
        for (const m of found) matches.push({ docId: info.docId, ...m });
      }
      res.json({ matches });
    }),
  );
}
