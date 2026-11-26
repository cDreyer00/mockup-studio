/** `motion:preview` from the daemon (MCP `preview_motion`): play / seek / stop on the canvas. */
import type { EditorCommand, MotionPreviewState, Node, Page } from '@mockup/core';
import { useDoc } from '../state/docStore';
import { currentPageId } from '../state/hooks';
import { ui, useUi } from '../state/uiStore';
import { canvasMotion, motionPreview } from './preview';

type PreviewCommand = Extract<EditorCommand, { type: 'motion:preview' }>;

/** How long to wait for a frame of another page to mount after switching to it. */
const MOUNT_WAIT_MS = 3000;

const contains = (n: Node, id: string): boolean =>
  n.id === id || n.children.some((c) => contains(c, id));

/** Root frame (and page) of a node in the editor's document view. */
function frameOf(id: string): { page: Page; frame: Node } | null {
  for (const page of useDoc.getState().doc?.pages ?? []) {
    const frame = page.frames.find((f) => contains(f, id));
    if (frame) return { page, frame };
  }
  return null;
}

function defaultFrame(): { page: Page; frame: Node } | null {
  const sel = useUi.getState().selection;
  for (const id of sel) {
    const hit = frameOf(id);
    if (hit) return hit;
  }
  const doc = useDoc.getState().doc;
  const page = doc?.pages.find((p) => p.id === currentPageId()) ?? doc?.pages[0];
  const frame = page?.frames.find((f) => !f.hidden);
  return page && frame ? { page, frame } : null;
}

/** Waits until the canvas rendered the frame (its timeline is registered). */
function waitMounted(frameId: string, timeoutMs: number): Promise<void> {
  if (canvasMotion.timeline(frameId)) return Promise.resolve();
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const tick = (): void => {
      if (canvasMotion.timeline(frameId)) resolve();
      else if (Date.now() > deadline)
        reject(new Error(`Frame "${frameId}" is not rendered on the editor canvas.`));
      else setTimeout(tick, 16);
    };
    tick();
  });
}

export async function runMotionCommand(cmd: PreviewCommand): Promise<MotionPreviewState> {
  if (cmd.action === 'stop') {
    motionPreview.stop();
    return motionPreview.getState();
  }
  const hit = cmd.frameId !== undefined ? frameOf(cmd.frameId) : defaultFrame();
  if (!hit) {
    throw new Error(
      cmd.frameId !== undefined
        ? `Node "${cmd.frameId}" is not in the document open in the editor.`
        : 'There is no frame to preview.',
    );
  }
  if (hit.frame.hidden) throw new Error(`Frame "${hit.frame.id}" is hidden.`);
  if (currentPageId() !== hit.page.id) ui.setPage(hit.page.id);
  await waitMounted(hit.frame.id, MOUNT_WAIT_MS);
  const time = Math.max(0, cmd.time ?? 0);
  if (cmd.action === 'play') motionPreview.play(hit.frame.id, time);
  else motionPreview.seek(hit.frame.id, time);
  return motionPreview.getState();
}
