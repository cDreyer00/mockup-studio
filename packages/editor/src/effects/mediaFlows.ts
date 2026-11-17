/** Video and embed insertion: file picker, upload to the daemon and node creation (like images). */
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

/** Same video extensions that the MCP and the daemon upload accept. */
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

/** Opens the file picker with the `accept` types; `null` if cancelled. */
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

/** Styles of a `w`×`h` media node according to placement (flow or absolute in the parent). */
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
 * Creates a `w`×`h` media node in the container under the screen center (or a root frame the size
 * of the node, if there is no container) and selects it.
 */
async function placeMedia(
  make: (styles: Record<string, string>) => Node,
  size: { w: number; h: number },
  frameName: string,
): Promise<string | null> {
  const doc = useDoc.getState().doc;
  const pageId = currentPageId();
  if (!doc || !pageId) throw new Error('No document open');
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
  if (!ack) throw new Error('Could not insert the media node.');
  ui.select([node.id]);
  return node.id;
}

function report(e: unknown): null {
  ui.toast(e instanceof Error ? e.message : String(e), 'error');
  return null;
}

/** Video from `src` (path in assets/ or URL). */
export async function insertVideoSrc(src: string, name?: string): Promise<string | null> {
  try {
    return await placeMedia(
      (styles) =>
        createVideoNode(
          { src, muted: true, loop: true, autoplay: true },
          { styles, ...(name ? { name } : {}) },
        ),
      VIDEO_SIZE,
      'Video',
    );
  } catch (e) {
    return report(e);
  }
}

/** Sends the file to the daemon (checks the bytes and writes to assets/videos|lottie|rive/); returns the saved src. */
async function uploadChecked(file: File): Promise<string> {
  try {
    return await daemon.uploadAsset(file, file.name);
  } catch (e) {
    throw new Error(`File rejected: ${e instanceof Error ? e.message : String(e)}`);
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

/** Embed from an already built spec (validated with the core schema). */
export async function insertEmbed(spec: EmbedSpec, name?: string): Promise<string | null> {
  try {
    const parsed = EmbedSpecSchema.safeParse(spec);
    if (!parsed.success) throw new Error(parsed.error.issues[0]?.message ?? 'Invalid embed');
    return await placeMedia(
      (styles) => createEmbedNode(spec, { styles, ...(name ? { name } : {}) }),
      EMBED_SIZES[spec.provider],
      name ?? 'Embed',
    );
  } catch (e) {
    return report(e);
  }
}

/** Lottie (`.json`/`.lottie`) or Rive (`.riv`) from a local file. */
export async function insertLottieRiveFile(file: File): Promise<string | null> {
  const provider = detectEmbedProvider(file.name);
  if (provider !== 'lottie' && provider !== 'rive') {
    return report(new Error('Use a .json, .lottie or .riv file'));
  }
  try {
    const src = await uploadChecked(file);
    return await insertEmbed({ provider, src }, file.name.replace(/\.[^.]+$/, ''));
  } catch (e) {
    return report(e);
  }
}

/**
 * Lottie/Rive by URL: copies to assets/lottie|rive/ (offline-first) and uses the relative src. If
 * the download fails (network, document without a path, invalid file), keeps the URL and warns: the embed
 * still works with a network, and the user sees the reason instead of losing the insertion.
 */
export async function localizeAnimation(spec: EmbedSpec): Promise<EmbedSpec> {
  const src = spec.src;
  if ((spec.provider !== 'lottie' && spec.provider !== 'rive') || !src || !/^https?:/i.test(src))
    return spec;
  try {
    return { ...spec, src: await daemon.fetchAsset(src, spec.provider) };
  } catch (e) {
    ui.toast(
      `Could not copy the file to assets/ (${e instanceof Error ? e.message : String(e)}). Using the URL: it only works with a network.`,
      'info',
    );
    return spec;
  }
}

/** Inserts what the URL represents (video, YouTube, Lottie, Rive or iframe). */
export async function insertFromUrl(url: string): Promise<string | null> {
  const spec = specFromUrl(url);
  if (!spec) return report(new Error('Enter a valid http(s) URL.'));
  if (spec.kind === 'video') return insertVideoSrc(spec.src);
  return insertEmbed(await localizeAnimation(spec.spec));
}

/** Creates a Three.js island with the default code and opens the code editor. */
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
