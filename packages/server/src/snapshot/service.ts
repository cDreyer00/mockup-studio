/**
 * Serviço de importação compartilhado pelas rotas HTTP e pelas ferramentas MCP: captura (motor de
 * render) ou conversão (core) e depois `importSnapshot`.
 */
import { createNodeFromTag, htmlToNodes, type Node, type OpSource } from '@mockup/core';
import {
  SNAPSHOT_FORMAT,
  SNAPSHOT_VERSION,
  type ImportHtmlRequest,
  type ImportPlacement,
  type ImportUrlRequest,
  type SnapshotImportRequest,
  type SnapshotImportResult,
  type SnapshotPayload,
} from '@mockup/snapshot-core';
import type { RenderProvider } from '../render.js';
import type { DocumentStore } from '../store.js';
import { importSnapshot } from './import.js';
import {
  SnapshotImportError,
  parseCaptureParams,
  parseHttpUrl,
  parsePlacement,
} from './validate.js';

export interface SnapshotServiceCtx {
  store: DocumentStore;
  render?: RenderProvider;
  /** Origem do evento no histórico (`'mcp'` nas ferramentas MCP, `'editor'` nas rotas HTTP). */
  source: OpSource;
}

/** 503 de `import_url` sem motor de render. */
export const IMPORT_URL_NEEDS_RENDER =
  'Importar de uma URL precisa do motor de render, que não está disponível neste daemon. ' +
  'Abra o app desktop do Mockup Studio ou rode `mockup serve --render`.';

const MAX_HTML_CHARS = 20_000_000;
const MAX_CSS_CHARS = 5_000_000;

const FALLBACK_WARNING =
  'Importado sem motor de render: conversão simples do HTML/CSS (sem estilos computados, fontes da página nem JavaScript), com fidelidade menor. Confira o resultado e ajuste; o app desktop (ou `mockup serve --render`) captura com estilos computados.';

async function capture(
  render: RenderProvider,
  req: Parameters<NonNullable<RenderProvider['snapshot']>>[0],
  what: string,
): Promise<SnapshotPayload> {
  try {
    return await render.snapshot!(req);
  } catch (e) {
    throw new SnapshotImportError(
      502,
      `Falha ao capturar ${what}: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
}

/** Importa um payload pronto (extensão, colar no editor). */
export function importFromPayload(
  ctx: SnapshotServiceCtx,
  req: SnapshotImportRequest,
): Promise<SnapshotImportResult> {
  const { payload, ...placement } = req;
  return importSnapshot(ctx.store, payload, placement, { source: ctx.source });
}

/** Captura a URL no motor de render e importa. 503 sem render. */
export async function importFromUrl(
  ctx: SnapshotServiceCtx,
  req: ImportUrlRequest,
): Promise<SnapshotImportResult> {
  const url = parseHttpUrl(req.url);
  const params = parseCaptureParams(req);
  const placement = parsePlacement(req);
  if (!ctx.render?.snapshot) throw new SnapshotImportError(503, IMPORT_URL_NEEDS_RENDER);
  const payload = await capture(
    ctx.render,
    {
      kind: 'url',
      url,
      selector: params.selector,
      viewport: params.viewport,
      timeoutMs: params.timeoutMs,
    },
    url,
  );
  return importSnapshot(ctx.store, payload, placement, { source: ctx.source, method: 'snapshot' });
}

/** Resolve `src` relativos de imagens contra a base (a conversão do core mantém o texto original). */
function absolutizeImages(nodes: Node[], base: string): void {
  const walk = (n: Node): void => {
    if (n.type === 'image' && n.src && !/^(data:|https?:|asset:)/i.test(n.src)) {
      try {
        n.src = new URL(n.src, base).href;
      } catch {
        // mantém o valor original
      }
    }
    n.children.forEach(walk);
  };
  nodes.forEach(walk);
}

/**
 * Captura o HTML no motor de render (estilos computados) quando ele tem `snapshot`; senão converte
 * com o core (`htmlToNodes`) num frame com a largura do viewport. O canvas mostra frames com altura
 * fixa em px (`frameSize`: 600 se não houver) e sem medir o conteúdo; sem layout não dá para saber
 * a altura real, então o frame leva a altura do viewport com `overflow: visible` (nada some) e o
 * aviso manda ajustá-la.
 */
export async function importFromHtml(
  ctx: SnapshotServiceCtx,
  req: ImportHtmlRequest,
): Promise<SnapshotImportResult> {
  if (typeof req.html !== 'string')
    throw new SnapshotImportError(400, 'Campo obrigatório ausente: html.');
  if (!req.html.trim())
    throw new SnapshotImportError(400, 'HTML vazio: informe em html o conteúdo a importar.');
  if (req.html.length > MAX_HTML_CHARS)
    throw new SnapshotImportError(400, 'O HTML passa do limite de 20 milhões de caracteres.');
  if (req.css !== undefined && (typeof req.css !== 'string' || req.css.length > MAX_CSS_CHARS))
    throw new SnapshotImportError(400, 'css inválido (texto de até 5 milhões de caracteres).');
  const baseUrl =
    req.assetsBaseUrl === undefined || req.assetsBaseUrl === ''
      ? undefined
      : parseHttpUrl(req.assetsBaseUrl, 'assetsBaseUrl');
  const params = parseCaptureParams(req);
  const placement: ImportPlacement = parsePlacement(req);

  if (ctx.render?.snapshot) {
    const payload = await capture(
      ctx.render,
      {
        kind: 'html',
        html: req.html,
        css: req.css,
        baseUrl,
        selector: params.selector,
        viewport: params.viewport,
        timeoutMs: params.timeoutMs,
      },
      'o HTML',
    );
    return importSnapshot(ctx.store, payload, placement, {
      source: ctx.source,
      method: 'snapshot',
    });
  }

  const warnings = [FALLBACK_WARNING];
  if (params.selector)
    warnings.push(
      `O seletor "${params.selector}" foi ignorado: sem render o HTML inteiro é convertido.`,
    );
  let children: Node[];
  try {
    children = htmlToNodes(req.html, { css: req.css });
  } catch (e) {
    throw new SnapshotImportError(
      400,
      `Não foi possível converter o HTML: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  if (children.length === 0)
    throw new SnapshotImportError(400, 'O HTML não tem conteúdo para importar.');
  if (baseUrl) absolutizeImages(children, baseUrl);
  const { width, height } = params.viewport;
  warnings.push(
    `O frame usa a altura do viewport (${height}px) sem cortar o conteúdo; ajuste a altura do frame ao conteúdo.`,
  );
  const root = createNodeFromTag('div', {
    name: 'HTML importado',
    styles: { width: `${width}px`, height: `${height}px`, overflow: 'visible' },
    children,
  });
  const payload: SnapshotPayload = {
    format: SNAPSHOT_FORMAT,
    version: SNAPSHOT_VERSION,
    source: {
      url: baseUrl ?? 'about:blank',
      title: '',
      capturedAt: new Date().toISOString(),
      viewport: params.viewport,
      devicePixelRatio: 1,
    },
    root,
    width,
    height,
    assets: [],
    fonts: [],
    stats: { nodes: 0, truncated: false, warnings: [] },
  };
  return importSnapshot(ctx.store, payload, placement, {
    source: ctx.source,
    method: 'html',
    warnings,
  });
}
