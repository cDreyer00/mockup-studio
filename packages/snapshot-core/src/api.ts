/**
 * Contrato HTTP de importação do daemon (usado pela extensão e pelo editor) e do motor de captura
 * em página (`RenderProvider.snapshot`, implementado pelo app desktop). Só tipos e constantes.
 */
import type { SnapshotPayload, SnapshotViewport } from './format.js';

/** Rotas do daemon. */
export const SNAPSHOT_ROUTES = {
  /** Corpo `SnapshotImportRequest`; aceita Origin local e `chrome-extension://`. */
  snapshot: '/api/snapshot',
  /** Corpo `ImportUrlRequest` (precisa do motor de render: 503 sem ele). */
  importUrl: '/api/import/url',
  /** Corpo `ImportHtmlRequest` (sem render, cai na conversão HTML → nós do core). */
  importHtml: '/api/import/html',
} as const;

export const DEFAULT_IMPORT_VIEWPORT: SnapshotViewport = { width: 1440, height: 900 };
/** Limites do viewport de import_url/import_html (px CSS), iguais no daemon, no MCP e no editor. */
export const IMPORT_VIEWPORT_LIMITS = {
  minWidth: 320,
  maxWidth: 3840,
  minHeight: 200,
  maxHeight: 4000,
} as const;

/**
 * Id fixo da extensão "Capturar seção" (`packages/extension`), derivado da `key` do manifest.json:
 * a cópia descompactada tem sempre este id, e o daemon só aceita a Origin
 * `chrome-extension://<este id>` (mais os ids extras de `MOCKUP_EXTENSION_IDS`).
 */
export const MOCKUP_EXTENSION_ID = 'agjagmcpikghnfnnapjbicplkmommmkn';
/** Tempo máximo padrão de um import_url/import_html no motor de render (ms). */
export const DEFAULT_IMPORT_TIMEOUT_MS = 20_000;
export const MAX_IMPORT_TIMEOUT_MS = 60_000;

/** Onde colocar o frame importado (todos opcionais). */
export interface ImportPlacement {
  /** Documento (padrão: ativo). */
  docId?: string;
  /** Página (padrão: a primeira, ou a do editor quando vem do editor). */
  pageId?: string;
  /** Posição do frame no canvas (padrão: à direita do último frame da página). */
  x?: number;
  y?: number;
  /** Anexar a captura de referência como imagem oculta ao lado do frame (padrão true). */
  reference?: boolean;
  /** Nome do frame (padrão: título da página ou tag/classe do elemento). */
  name?: string;
}

export interface SnapshotImportRequest extends ImportPlacement {
  payload: SnapshotPayload;
}

export interface ImportUrlRequest extends ImportPlacement {
  url: string;
  /** Seletor CSS do elemento; padrão `body`. */
  selector?: string;
  viewport?: Partial<SnapshotViewport>;
  timeoutMs?: number;
}

export interface ImportHtmlRequest extends ImportPlacement {
  /** HTML completo ou fragmento. */
  html: string;
  /** CSS extra aplicado à página. */
  css?: string;
  /** Base para resolver URLs relativas (`<link>`, `<img>`, `url()`); http(s). */
  assetsBaseUrl?: string;
  selector?: string;
  viewport?: Partial<SnapshotViewport>;
  timeoutMs?: number;
}

/** Resposta das três rotas (e base do texto das ferramentas MCP). */
export interface SnapshotImportResult {
  docId: string;
  pageId: string;
  frameId: string;
  /** Frame oculto com a imagem de referência, quando houve. */
  referenceId?: string;
  /** Nós criados no frame (inclui o frame). */
  nodes: number;
  /** Imagens gravadas em `assets/` ou embutidas. */
  images: number;
  /** Famílias de fonte registradas no documento. */
  fonts: string[];
  warnings: string[];
  /** `snapshot` (estilos computados no navegador) ou `html` (conversão sem render). */
  method: 'snapshot' | 'html';
}

/** Pedido ao motor de captura em página (app desktop). */
export type PageSnapshotRequest =
  | {
      kind: 'url';
      url: string;
      selector?: string;
      viewport: SnapshotViewport;
      timeoutMs: number;
    }
  | {
      kind: 'html';
      html: string;
      css?: string;
      baseUrl?: string;
      selector?: string;
      viewport: SnapshotViewport;
      timeoutMs: number;
    };

export type PageSnapshotResult = SnapshotPayload;
