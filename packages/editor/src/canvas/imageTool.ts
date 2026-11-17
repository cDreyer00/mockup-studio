/** Image insertion: file picker, upload to the daemon and node creation on the canvas. */
import type { Node, Op } from '@mockup/core';
import { daemon } from '../client/daemon';
import { makeFrame, makeImage } from '../model/factory';
import { currentPageId } from '../state/hooks';
import { useDoc } from '../state/docStore';
import { ui, useUi } from '../state/uiStore';
import { canvasApi } from './canvasApi';
import { buildCreateOps, planPlacement } from './placement';

const MAX_IMAGE_W = 800;
const FALLBACK_SIZE = { w: 240, h: 160 };

/** Opens the image file picker; `null` if cancelled. */
export function pickImageFile(): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
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

/** Natural dimensions of the image (bitmap, with `<img>` fallback); `null` if unreadable. */
async function readImageSize(file: File): Promise<{ w: number; h: number } | null> {
  try {
    const bmp = await createImageBitmap(file);
    const size = { w: bmp.width, h: bmp.height };
    bmp.close();
    if (size.w > 0 && size.h > 0) return size;
  } catch {
    // SVG and formats without bitmap decoding fall back.
  }
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img.naturalWidth > 0 ? { w: img.naturalWidth, h: img.naturalHeight || 1 } : null);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      resolve(null);
    };
    img.src = url;
  });
}

/**
 * Sends the image to the daemon and inserts it into the container under `at` (world; default: screen center).
 * Without a container, creates a root frame the size of the image. Returns the node id or `null`.
 */
export async function insertImageFile(
  file: File,
  at?: { x: number; y: number },
  size?: { w: number; h: number },
): Promise<string | null> {
  try {
    const src = await daemon.uploadAsset(file, file.name);
    let w: number;
    let h: number;
    if (size) {
      ({ w, h } = size);
    } else {
      const nat = (await readImageSize(file)) ?? FALLBACK_SIZE;
      const k = nat.w > MAX_IMAGE_W ? MAX_IMAGE_W / nat.w : 1;
      w = Math.max(1, Math.round(nat.w * k));
      h = Math.max(1, Math.round(nat.h * k));
    }
    const doc = useDoc.getState().doc;
    const pageId = currentPageId();
    if (!doc || !pageId) throw new Error('No document open');
    const center = canvasApi.viewportCenter();
    const point = at ?? { x: center.x - w / 2, y: center.y - h / 2 };
    const plan = planPlacement(doc, point);
    const alt = file.name.replace(/\.[^.]+$/, '');
    let image: Node;
    let ops: Op[];
    if (!plan.parentId) {
      image = makeImage(src, { w, h, alt });
      const frame = makeFrame(point.x, point.y, w, h, 'Image');
      frame.children.push(image);
      ops = buildCreateOps(pageId, plan, frame);
    } else {
      image = makeImage(src, { w, h, alt, x: plan.x, y: plan.y, absolute: !plan.flow });
      ops = buildCreateOps(pageId, plan, image);
    }
    const ack = await daemon.applySafe(ops);
    if (!ack) return null;
    ui.select([image.id]);
    if (useUi.getState().tool === 'image') ui.setTool('select');
    return image.id;
  } catch (e) {
    ui.toast(e instanceof Error ? e.message : String(e), 'error');
    return null;
  }
}
