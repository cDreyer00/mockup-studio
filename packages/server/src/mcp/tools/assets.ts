import path from 'node:path';
import { z } from 'zod';
import { foldText } from '@mockup/core';
import { writeAsset } from '../../assets.js';
import {
  baseUrl,
  cdnUrlOf,
  linkDocAsset,
  listDocAssets,
  optimizeDocAssets,
  removeUnusedAssets,
  type AssetInfo,
  type AssetsServiceCtx,
} from '../../assetsService.js';
import { detectAsset, getLibrary, safeStem, type LibraryAsset } from '../../library.js';
import { RouteError } from '../../routes/shared.js';
import { READ, ToolError, WRITE, DESTRUCTIVE, docIdField, type ToolContext } from '../context.js';
import { loadSource } from './images.js';

const kb = (bytes: number): string => `${Math.max(1, Math.round(bytes / 1024))} KB`;

/** Converte os erros de status do serviço (compartilhado com o HTTP) em erros de ferramenta. */
async function guard<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof RouteError) throw new ToolError(e.message);
    throw e;
  }
}

function docLine(a: AssetInfo): string {
  const dims = a.width && a.height ? ` ${a.width}x${a.height}` : '';
  return `${a.path}${dims} ${a.ext.slice(1)} ${kb(a.size)} usos:${a.uses}${a.cdnUrl ? ` ${a.cdnUrl}` : ''}`;
}

function libLine(a: LibraryAsset, origin: string): string {
  const dims = a.width && a.height ? ` ${a.width}x${a.height}` : '';
  const tags = a.tags.length ? ` [${a.tags.join(', ')}]` : '';
  return `${a.name}${dims} ${a.ext} ${kb(a.size)} id:${a.hash}${tags} ${origin}${a.url}`;
}

export function registerAssetsTools(ctx: ToolContext): void {
  const { tool, store, apply } = ctx;
  const svcFor = (): AssetsServiceCtx => ({
    store,
    dataDir: ctx.opts.dataDir,
    getPort: ctx.opts.getPort,
  });
  const lib = () => getLibrary(ctx.opts.dataDir);

  tool(
    'list_assets',
    {
      title: 'Listar assets',
      description:
        'Lista os arquivos de assets/ do documento (imagens e fontes, com tamanho, dimensões, usos e link direto /cdn) ou a biblioteca global (scope "library"). unused filtra os sem uso.',
      example: { scope: 'document', query: 'capa', unused: false },
      inputSchema: {
        docId: docIdField,
        scope: z
          .enum(['document', 'library'])
          .optional()
          .describe('"document" (padrão): assets/ do documento; "library": biblioteca global.'),
        query: z
          .string()
          .optional()
          .describe('Filtro por nome, caminho ou tag, sem acento nem caixa, ex.: "capa".'),
        unused: z
          .boolean()
          .optional()
          .describe('true lista só os arquivos sem uso (candidatos a remove_unused_assets).'),
      },
      annotations: READ,
    },
    async ({ docId, scope, query, unused }) => {
      const origin = baseUrl(ctx.opts);
      if (scope === 'library') {
        const items = lib().list(query);
        if (!items.length) {
          return query
            ? `Nenhum asset da biblioteca para "${query}".`
            : 'A biblioteca está vazia. Use upload_asset (library: true) para adicionar.';
        }
        return `${items.length} asset(s) na biblioteca:\n${items.map((a) => libLine(a, origin)).join('\n')}`;
      }
      const id = store.resolveDocId(docId);
      if (!store.assetsDir(id)) {
        return 'O documento ainda não tem caminho em disco, então não há pasta assets/. Salve-o ou use scope "library".';
      }
      let items = await guard(() => listDocAssets(svcFor(), id));
      const q = foldText(query ?? '').trim();
      if (q) items = items.filter((a) => foldText(a.path).includes(q));
      if (unused) items = items.filter((a) => a.uses === 0 && a.kind !== 'other');
      if (!items.length) return unused ? 'Nenhum asset sem uso.' : 'Nenhum asset encontrado.';
      const total = items.reduce((s, a) => s + a.size, 0);
      return `${items.length} asset(s), ${kb(total)} no total:\n${items.map(docLine).join('\n')}`;
    },
  );

  tool(
    'upload_asset',
    {
      title: 'Enviar asset',
      description:
        'Adiciona uma imagem ou fonte (woff2, woff, ttf, otf) de caminho absoluto, URL http(s) ou data URL: grava em assets/ do documento e registra no CDN local. Devolve o src para usar nos nós e o link direto /cdn. library: true guarda só na biblioteca.',
      example: { source: 'C:/fotos/capa.png', name: 'capa', library: false },
      inputSchema: {
        source: z
          .string()
          .describe('Caminho absoluto, URL http(s) ou data URL, ex.: "C:/fotos/capa.png".'),
        name: z
          .string()
          .optional()
          .describe('Nome do arquivo (a extensão vem dos bytes), ex.: "capa".'),
        docId: docIdField,
        library: z
          .boolean()
          .optional()
          .describe(
            'true: só na biblioteca global, sem copiar para o documento (padrão false; sem caminho em disco, vale true).',
          ),
      },
      annotations: WRITE,
    },
    async ({ source, name, docId, library }) => {
      const { bytes, hint } = await loadSource(source);
      const info = detectAsset(bytes);
      if (!info) {
        throw new ToolError(
          'O conteúdo não é uma imagem (PNG, JPEG, GIF, WebP, SVG, AVIF) nem uma fonte (woff2, woff, ttf, otf) reconhecida. Confira o arquivo ou a URL.',
        );
      }
      const file = `${safeStem(name ?? hint, info.kind === 'font' ? 'fonte' : 'imagem')}${info.ext}`;
      const asset = lib().add(bytes, { name: file, info });
      const link = cdnUrlOf(ctx.opts, asset.hash, asset.ext);
      const dims = info.width ? ` ${info.width}x${info.height}` : '';
      const head = `${info.mime}${dims}, ${kb(bytes.length)}`;
      const dir = library ? null : store.assetsDir(store.resolveDocId(docId));
      if (!dir) {
        const why = library
          ? 'guardado só na biblioteca'
          : 'o documento ainda não tem caminho em disco, então ficou só na biblioteca (salve-o para copiar para assets/)';
        return `Asset ${why}: id ${asset.hash} (${head}).\nLink direto: ${link}`;
      }
      const sub = info.kind === 'font' ? 'fonts' : '';
      const finalName = await writeAsset(sub ? path.join(dir, sub) : dir, file, bytes);
      const src = sub ? `${sub}/${finalName}` : finalName;
      return `Asset enviado: id ${asset.hash} (${head}).\nsrc (use em nós img/setSrc): ${src}\nLink direto: ${link}\nArquivo: ${path.join(dir, src)}`;
    },
  );

  tool(
    'get_asset_url',
    {
      title: 'Link direto de um asset',
      description:
        'Devolve o link direto (/cdn, estável e imutável), o src relativo e o caminho no disco de um asset. id = hash do CDN, caminho relativo em assets/ (com docId) ou URL /cdn/...',
      example: { id: 'fotos/capa.jpg' },
      inputSchema: {
        id: z
          .string()
          .describe(
            'Hash (32 hex), caminho em assets/ ("fotos/capa.jpg") ou URL "/cdn/<hash>.png".',
          ),
        docId: docIdField,
      },
      annotations: WRITE,
    },
    async ({ id, docId }) => {
      const key = id.trim();
      const m = /(?:^|\/cdn\/)([0-9a-f]{32})(?:\.[a-z0-9]+)?(?:[?#].*)?$/i.exec(key);
      const hash = m?.[1]?.toLowerCase();
      if (hash) {
        const r = lib().resolve(hash);
        if (!r) {
          throw new ToolError(
            `Asset "${hash}" não está na biblioteca. Use list_assets (scope "library") ou upload_asset.`,
          );
        }
        const url = cdnUrlOf(ctx.opts, hash, r.asset.ext);
        let src = '';
        try {
          const docAssets = await listDocAssets(svcFor(), store.resolveDocId(docId));
          src = docAssets.find((a) => a.hash === hash)?.path ?? '';
        } catch {
          // sem documento: só a biblioteca
        }
        return `Link direto: ${url}\nsrc: ${src || '(não está em assets/ do documento; use upload_asset com o caminho abaixo como source para copiar)'}\nArquivo: ${r.file}`;
      }
      const docKey = store.resolveDocId(docId);
      const link = await guard(() => linkDocAsset(svcFor(), docKey, key));
      const rel = key.replace(/\\/g, '/').replace(/^(\.\/)?assets\//, '');
      const dir = store.assetsDir(docKey)!;
      return `Link direto: ${link.url}\nid: ${link.hash}\nsrc: ${rel}\nArquivo: ${path.join(dir, rel)}`;
    },
  );

  tool(
    'optimize_assets',
    {
      title: 'Otimizar imagens',
      description:
        'Reduz imagens de assets/ com sharp: limita a largura (maxWidth, sem ampliar) e converte para WebP (ou mantém o formato). Só troca se ficar menor; reescreve as referências (um undo) e mantém os originais (use remove_unused_assets depois). Ignora SVG, GIF e fontes.',
      example: { maxWidth: 1600, format: 'webp', quality: 82 },
      inputSchema: {
        paths: z
          .array(z.string())
          .optional()
          .describe(
            'Caminhos em assets/, ex.: ["fotos/capa.png"] (padrão: todas as imagens em uso).',
          ),
        maxWidth: z
          .number()
          .int()
          .positive()
          .optional()
          .describe('Largura máxima em px, ex.: 1600 (imagens menores não são ampliadas).'),
        format: z
          .enum(['webp', 'keep'])
          .optional()
          .describe('"webp" (padrão) converte; "keep" mantém png/jpg/webp/avif.'),
        quality: z
          .number()
          .int()
          .min(1)
          .max(100)
          .optional()
          .describe('Qualidade de 1 a 100, ex.: 82 (padrão 82).'),
        docId: docIdField,
      },
      annotations: WRITE,
    },
    async ({ paths, maxWidth, format, quality, docId }) => {
      const id = store.resolveDocId(docId);
      const r = await guard(() =>
        optimizeDocAssets(svcFor(), id, { paths, maxWidth, format, quality }, (ops) => {
          apply(id, ops, 'optimize_assets');
        }),
      );
      const lines = r.results.map((x) => {
        const pct = Math.round((1 - x.after / x.before) * 100);
        return `${x.path} -> ${x.newPath}: ${kb(x.before)} -> ${kb(x.after)} (-${pct}%)`;
      });
      const before = r.results.reduce((s, x) => s + x.before, 0);
      const after = r.results.reduce((s, x) => s + x.after, 0);
      const head = r.results.length
        ? `${r.results.length} imagem(ns) otimizada(s): ${kb(before)} -> ${kb(after)}; ${r.rewritten} referência(s) reescrita(s). Os originais continuam em assets/ (remove_unused_assets apaga os sem uso).`
        : 'Nenhuma imagem foi substituída.';
      const skipped = r.skipped.map((s) => `${s.path}: ${s.reason}`);
      return [head, ...lines, ...(skipped.length ? ['Ignoradas:', ...skipped] : [])].join('\n');
    },
  );

  tool(
    'remove_unused_assets',
    {
      title: 'Remover assets sem uso',
      description:
        'Apaga de assets/ as imagens e fontes que nenhum nó, estilo, dado de repetidor ou fonte do documento referencia. dryRun: true só lista, sem apagar.',
      example: { dryRun: true },
      inputSchema: {
        dryRun: z.boolean().optional().describe('true: só lista o que seria removido.'),
        docId: docIdField,
      },
      annotations: DESTRUCTIVE,
    },
    async ({ dryRun, docId }) => {
      const id = store.resolveDocId(docId);
      const r = await guard(() => removeUnusedAssets(svcFor(), id, dryRun === true));
      if (!r.removed.length) return `Nenhum asset sem uso (${r.kept} arquivo(s) mantido(s)).`;
      return `${dryRun ? 'Seriam removidos' : 'Removidos'} ${r.removed.length} arquivo(s) (${r.kept} mantido(s)):\n${r.removed.join('\n')}`;
    },
  );
}
