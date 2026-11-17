/**
 * Captura no navegador: serializa a subárvore de um elemento DOM em nós do core com os estilos
 * computados reduzidos. Roda na página (extensão, Electron headless via executeJavaScript, testes).
 */
import { createNodeFromTag, type Node } from '@mockup/core';
import { AssetRegistry, inlineAssets } from './capture/assets.js';
import { Defaults } from './capture/defaults.js';
import { collectFonts } from './capture/fonts.js';
import { PLACEHOLDER_NAMES, REPLACED_TAGS } from './capture/props.js';
import { type TreeCtx, visit } from './capture/tree.js';
import { isTransparent, px } from './capture/util.js';
import {
  SNAPSHOT_FORMAT,
  SNAPSHOT_LIMITS,
  SNAPSHOT_VERSION,
  type SnapshotPayload,
} from './format.js';

export interface CaptureOptions {
  /** Padrão `SNAPSHOT_LIMITS.maxNodes`. */
  maxNodes?: number;
  /** Padrão `SNAPSHOT_LIMITS.maxDepth`. */
  maxDepth?: number;
  /** Tenta ler os bytes das imagens/fontes (fetch na página) para embutir como data URL. Padrão true. */
  inlineAssets?: boolean;
  /** Limite por asset embutido (bytes). */
  maxInlineAssetBytes?: number;
  /** Soma máxima das data URLs embutidas (caracteres). Padrão `SNAPSHOT_LIMITS.maxInlineTotalBytes`. */
  maxInlineTotalBytes?: number;
  /** Seletor informado (vai em `source.selector`). */
  selector?: string;
}

/** Acima disso o teste de `height` automático é pulado (caminho barato). */
const CHEAP_NODE_THRESHOLD = 1500;

/** Primeira cor de fundo não transparente do elemento para cima (ou `#ffffff`). */
function backgroundBehind(el: Element): string {
  for (let e: Element | null = el; e; e = e.parentElement) {
    const c = getComputedStyle(e).backgroundColor;
    if (!isTransparent(c)) return c;
  }
  return '#ffffff';
}

/** Captura o elemento e a subárvore. */
export async function captureElement(
  el: Element,
  opts: CaptureOptions = {},
): Promise<SnapshotPayload> {
  const defaults = new Defaults();
  const assets = new AssetRegistry();
  const warnings: string[] = [];
  const ctx: TreeCtx = {
    root: el,
    defaults,
    assets,
    families: new Set(),
    maxNodes: opts.maxNodes ?? SNAPSHOT_LIMITS.maxNodes,
    maxDepth: opts.maxDepth ?? SNAPSHOT_LIMITS.maxDepth,
    count: 0,
    truncated: false,
    warnings,
    cheap: el.getElementsByTagName('*').length > CHEAP_NODE_THRESHOLD,
  };

  let root: Node;
  let width: number;
  let height: number;
  try {
    defaults.init();
    const he = el as HTMLElement;
    width = he.offsetWidth ?? el.getBoundingClientRect().width;
    height = he.offsetHeight ?? el.getBoundingClientRect().height;
    if (getComputedStyle(el).display === 'none') {
      throw new Error('O elemento está oculto (display: none); não há o que capturar.');
    }

    const tag = el.localName.toLowerCase();
    const needsWrap =
      REPLACED_TAGS.has(tag) || tag in PLACEHOLDER_NAMES || tag === 'br' || tag === 'picture';
    let built: Node | null;
    if (needsWrap) {
      // Raiz é um elemento sem filhos (img, svg, input...): um div relativo do mesmo tamanho a envolve.
      ctx.count++;
      const child = visit(el, defaults.body, 1, el, ctx, false);
      built = createNodeFromTag('div', {
        name: 'Captura',
        styles: { position: 'relative', width: px(width), height: px(height) },
        children: child ? [child] : [],
      });
    } else {
      built = visit(el, null, 0, el, ctx, true, true);
    }
    if (!built) throw new Error('O elemento não gerou nenhum nó (tag bloqueada ou oculta).');
    root = built;
    root.type = 'element';
    root.style['background-color'] = backgroundBehind(el);
  } finally {
    defaults.dispose();
  }

  const fonts = await collectFonts(ctx.families, assets, (m) => warnings.push(m));

  if (opts.inlineAssets !== false) {
    await inlineAssets(assets.list, {
      maxAssetBytes: opts.maxInlineAssetBytes ?? SNAPSHOT_LIMITS.maxInlineAssetBytes,
      maxTotalBytes: opts.maxInlineTotalBytes ?? SNAPSHOT_LIMITS.maxInlineTotalBytes,
      warn: (m) => warnings.push(m),
    });
  }

  return {
    format: SNAPSHOT_FORMAT,
    version: SNAPSHOT_VERSION,
    source: {
      url: location.href,
      title: document.title,
      capturedAt: new Date().toISOString(),
      viewport: { width: window.innerWidth, height: window.innerHeight },
      devicePixelRatio: window.devicePixelRatio,
      ...(opts.selector ? { selector: opts.selector } : {}),
    },
    root,
    width,
    height,
    assets: assets.list,
    fonts,
    stats: { nodes: ctx.count, truncated: ctx.truncated, warnings },
  };
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
