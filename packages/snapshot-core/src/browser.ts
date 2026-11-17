/**
 * Captura no navegador: serializa a subárvore de um elemento DOM em nós do core com os estilos
 * computados reduzidos. Roda na página (extensão, Electron headless via executeJavaScript, testes).
 */
import type { SnapshotPayload } from './format.js';

export interface CaptureOptions {
  /** Padrão `SNAPSHOT_LIMITS.maxNodes`. */
  maxNodes?: number;
  /** Padrão `SNAPSHOT_LIMITS.maxDepth`. */
  maxDepth?: number;
  /** Tenta ler os bytes das imagens/fontes (fetch na página) para embutir como data URL. Padrão true. */
  inlineAssets?: boolean;
  /** Limite por asset embutido (bytes). */
  maxInlineAssetBytes?: number;
  /** Seletor informado (vai em `source.selector`). */
  selector?: string;
}

/** Captura o elemento e a subárvore. */
export async function captureElement(
  el: Element,
  opts: CaptureOptions = {},
): Promise<SnapshotPayload> {
  void el;
  void opts;
  throw new Error('captureElement: não implementado');
}

/** Captura o primeiro elemento que casa com o seletor (erro claro se nenhum casar). */
export async function captureSelector(
  selector: string,
  opts: CaptureOptions = {},
): Promise<SnapshotPayload> {
  const el = document.querySelector(selector);
  if (!el) throw new Error(`Nenhum elemento corresponde ao seletor "${selector}".`);
  return captureElement(el, { ...opts, selector });
}
