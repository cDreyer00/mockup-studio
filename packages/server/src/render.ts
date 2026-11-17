/**
 * Contrato do motor de render. O daemon não depende de Electron: o app desktop (`@mockup/desktop`)
 * injeta uma implementação em `startDaemon({ render })`. Sem ela, screenshot, `get_layout` e SVG
 * medido ficam indisponíveis (as ferramentas explicam como habilitar).
 */
import type { Document, LayoutNode, PreviewState } from '@mockup/core';

export type RenderScale = 1 | 2 | 3;
export type RenderFormat = 'png' | 'jpg';

export interface RenderTarget {
  /** Documento completo (o render usa tokens, fontes e o frame que contém o nó). */
  doc: Document;
  docId: string;
  /** Nó a capturar; o frame raiz que o contém é renderizado inteiro e recortado no nó. */
  nodeId: string;
  /**
   * Pasta `assets/` do documento (ou null se não salvo). O motor usa o tamanho e a data dos
   * arquivos referenciados (imagens e fontes) na chave do cache, para não devolver render obsoleto.
   */
  assetsDir?: string | null;
}

export interface CaptureRequest extends RenderTarget {
  scale?: RenderScale;
  format?: RenderFormat;
  /** Qualidade JPG (0–100, padrão 90). */
  quality?: number;
  /** Largura máxima da imagem final em px (reduz mantendo a proporção). */
  maxWidth?: number;
  /** Fundo transparente fora do conteúdo (PNG). Padrão `false`. */
  transparent?: boolean;
  /** Estado de prévia (hover, focus, dark...): aplica os `states` do nó como a prévia do editor. */
  state?: PreviewState;
}

export interface CaptureResult {
  data: Buffer;
  mime: 'image/png' | 'image/jpeg';
  /** Tamanho do nó em px CSS. */
  width: number;
  height: number;
  /** Tamanho da imagem gerada em px. */
  pixelWidth: number;
  pixelHeight: number;
}

export interface RenderProvider {
  capture(req: CaptureRequest): Promise<CaptureResult>;
  /** Geometria da subárvore do nó, relativa ao frame raiz (ver `LayoutNode`). */
  measure(target: RenderTarget): Promise<LayoutNode>;
  close?(): Promise<void>;
}

/** Mensagem de render indisponível com o pid e a porta do daemon sem render e como resolver. */
export function renderUnavailableMessage(info: { pid?: number; port?: number } = {}): string {
  const who =
    info.pid !== undefined
      ? ` Este é um daemon Node sem render (pid ${info.pid}${info.port !== undefined ? `, porta ${info.port}` : ''}).`
      : '';
  return (
    RENDER_UNAVAILABLE +
    who +
    ' Para trocar por um com screenshot: encerre-o com `mockup stop` (ou finalize o processo pelo pid) ' +
    'e chame a ferramenta de novo, ou abra o app desktop, que assume a porta sozinho.'
  );
}

export const RENDER_UNAVAILABLE =
  'O motor de render não está disponível neste daemon (daemon Node puro, sem Electron). ' +
  'Abra o app desktop do Mockup Studio ou rode `mockup serve --render` (o `mockup mcp` sobe o ' +
  'Electron headless automaticamente quando ele está instalado).';
