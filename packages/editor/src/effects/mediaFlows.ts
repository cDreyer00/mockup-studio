/** Inserção de vídeo e embeds: seletor de arquivo, upload ao daemon e criação do nó (como imagens). */
import {
  DEFAULT_THREE_CODE,
  EmbedSpecSchema,
  createEmbedNode,
  createVideoNode,
  detectEmbedProvider,
} from '@mockup/core';
import type { EmbedSpec, Node, Op } from '@mockup/core';
import { buildCreateOps, planPlacement } from '../canvas/placement';
import type { Placement } from '../canvas/placement';
import { canvasApi } from '../canvas/canvasApi';
import { daemon } from '../client/daemon';
import { makeFrame } from '../model/factory';
import { currentPageId } from '../state/hooks';
import { useDoc } from '../state/docStore';
import { ui } from '../state/uiStore';
import { specFromUrl } from './embedUrl';
import { mediaDialogs } from './mediaStore';

/** Mesmas extensões de vídeo que o MCP e o upload do daemon aceitam. */
export const VIDEO_ACCEPT = '.mp4,.m4v,.mov,.webm,.ogv';
export const LOTTIE_RIVE_ACCEPT = '.json,.lottie,.riv';
export const IMAGE_ACCEPT = 'image/*';

export const VIDEO_SIZE = { w: 640, h: 360 };
export const THREE_SIZE = { w: 480, h: 320 };
const EMBED_SIZES: Record<EmbedSpec['provider'], { w: number; h: number }> = {
  youtube: VIDEO_SIZE,
  iframe: VIDEO_SIZE,
  lottie: { w: 400, h: 400 },
  rive: { w: 400, h: 400 },
  three: THREE_SIZE,
};

/** Abre o seletor de arquivos com os tipos `accept`; `null` se cancelado. */
export function pickFile(accept: string): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.style.display = 'none';
    const done = (file: File | null): void => {
      input.remove();
      resolve(file);
    };
    input.addEventListener('change', () => done(input.files?.[0] ?? null));
    input.addEventListener('cancel', () => done(null));
    document.body.appendChild(input);
    input.click();
  });
}

/** Estilos de um nó de mídia `w`×`h` conforme o posicionamento (fluxo ou absoluto no pai). */
export function mediaStyles(
  w: number,
  h: number,
  plan: Pick<Placement, 'flow' | 'x' | 'y'> | null,
): Record<string, string> {
  const styles: Record<string, string> = {
    width: `${Math.round(w)}px`,
    height: `${Math.round(h)}px`,
    display: 'block',
  };
  if (plan && !plan.flow) {
    styles.position = 'absolute';
    styles.left = `${Math.round(plan.x)}px`;
    styles.top = `${Math.round(plan.y)}px`;
  }
  return styles;
}

/**
 * Cria um nó de mídia `w`×`h` no contêiner sob o centro da tela (ou frame raiz do tamanho do nó,
 * se não houver contêiner) e o seleciona.
 */
async function placeMedia(
  make: (styles: Record<string, string>) => Node,
  size: { w: number; h: number },
  frameName: string,
): Promise<string | null> {
  const doc = useDoc.getState().doc;
  const pageId = currentPageId();
  if (!doc || !pageId) throw new Error('Nenhum documento aberto');
  const { w, h } = size;
  const center = canvasApi.viewportCenter();
  const point = { x: center.x - w / 2, y: center.y - h / 2 };
  const plan = planPlacement(doc, point);
  let node: Node;
  let ops: Op[];
  if (!plan.parentId) {
    node = make(mediaStyles(w, h, null));
    const frame = makeFrame(point.x, point.y, w, h, frameName);
    frame.children.push(node);
    ops = buildCreateOps(pageId, plan, frame);
  } else {
    node = make(mediaStyles(w, h, plan));
    ops = buildCreateOps(pageId, plan, node);
  }
  const ack = await daemon.applySafe(ops);
  if (!ack) throw new Error('Não foi possível inserir o nó de mídia.');
  ui.select([node.id]);
  return node.id;
}

function report(e: unknown): null {
  ui.toast(e instanceof Error ? e.message : String(e), 'error');
  return null;
}

/** Vídeo a partir de `src` (caminho em assets/ ou URL). */
export async function insertVideoSrc(src: string, name?: string): Promise<string | null> {
  try {
    return await placeMedia(
      (styles) =>
        createVideoNode(
          { src, muted: true, loop: true, autoplay: true },
          { styles, ...(name ? { name } : {}) },
        ),
      VIDEO_SIZE,
      'Vídeo',
    );
  } catch (e) {
    return report(e);
  }
}

/** Envia o arquivo ao daemon (confere os bytes e grava em assets/videos|lottie|rive/); devolve o src salvo. */
async function uploadChecked(file: File): Promise<string> {
  try {
    return await daemon.uploadAsset(file, file.name);
  } catch (e) {
    throw new Error(`Arquivo recusado: ${e instanceof Error ? e.message : String(e)}`);
  }
}

export async function insertVideoFile(file: File): Promise<string | null> {
  try {
    const src = await uploadChecked(file);
    return await insertVideoSrc(src, file.name.replace(/\.[^.]+$/, ''));
  } catch (e) {
    return report(e);
  }
}

/** Embed a partir de uma especificação já montada (valida com o esquema do core). */
export async function insertEmbed(spec: EmbedSpec, name?: string): Promise<string | null> {
  try {
    const parsed = EmbedSpecSchema.safeParse(spec);
    if (!parsed.success) throw new Error(parsed.error.issues[0]?.message ?? 'Embed inválido');
    return await placeMedia(
      (styles) => createEmbedNode(spec, { styles, ...(name ? { name } : {}) }),
      EMBED_SIZES[spec.provider],
      name ?? 'Embed',
    );
  } catch (e) {
    return report(e);
  }
}

/** Lottie (`.json`/`.lottie`) ou Rive (`.riv`) de arquivo local. */
export async function insertLottieRiveFile(file: File): Promise<string | null> {
  const provider = detectEmbedProvider(file.name);
  if (provider !== 'lottie' && provider !== 'rive') {
    return report(new Error('Use um arquivo .json, .lottie ou .riv'));
  }
  try {
    const src = await uploadChecked(file);
    return await insertEmbed({ provider, src }, file.name.replace(/\.[^.]+$/, ''));
  } catch (e) {
    return report(e);
  }
}

/**
 * Lottie/Rive por URL: copia para assets/lottie|rive/ (offline-first) e usa o src relativo. Se o
 * download falhar (rede, documento sem caminho, arquivo inválido), mantém a URL e avisa: o embed
 * ainda funciona com rede, e o usuário vê o motivo em vez de perder a inserção.
 */
export async function localizeAnimation(spec: EmbedSpec): Promise<EmbedSpec> {
  const src = spec.src;
  if ((spec.provider !== 'lottie' && spec.provider !== 'rive') || !src || !/^https?:/i.test(src))
    return spec;
  try {
    return { ...spec, src: await daemon.fetchAsset(src, spec.provider) };
  } catch (e) {
    ui.toast(
      `Não consegui copiar o arquivo para assets/ (${e instanceof Error ? e.message : String(e)}). Usando a URL: só funciona com rede.`,
      'info',
    );
    return spec;
  }
}

/** Insere o que a URL representa (vídeo, YouTube, Lottie, Rive ou iframe). */
export async function insertFromUrl(url: string): Promise<string | null> {
  const spec = specFromUrl(url);
  if (!spec) return report(new Error('Informe uma URL http(s) válida.'));
  if (spec.kind === 'video') return insertVideoSrc(spec.src);
  return insertEmbed(await localizeAnimation(spec.spec));
}

/** Cria uma ilha Three.js com o código padrão e abre o editor de código. */
export async function insertThreeIsland(): Promise<string | null> {
  const id = await insertEmbed({ provider: 'three', code: DEFAULT_THREE_CODE });
  if (id) mediaDialogs.openThree(id);
  return id;
}

export async function pickAndInsertVideo(): Promise<void> {
  const file = await pickFile(VIDEO_ACCEPT);
  if (file) await insertVideoFile(file);
}

export async function pickAndInsertLottieRive(): Promise<void> {
  const file = await pickFile(LOTTIE_RIVE_ACCEPT);
  if (file) await insertLottieRiveFile(file);
}
