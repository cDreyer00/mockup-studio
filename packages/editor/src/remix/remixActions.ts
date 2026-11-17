/** Remix: generates variations of a node side by side (each remix = one undo entry). */
import type { RemixKind } from '@mockup/core';
import { isVirtualId } from '@mockup/core';
import { daemon } from '../client/daemon';
import { COMPONENT_FRAME_ID } from '../components/model';
import { useDoc } from '../state/docStore';
import { ui, useUi } from '../state/uiStore';
import { prompt } from '../ui/overlays';

export const REMIX_DEFAULT_COUNT = 3;
export const REMIX_MAX_COUNT = 10;

export const REMIX_LABELS: Record<Exclude<RemixKind, 'ai'>, string> = {
  'color-scale': 'Remix: color scale',
  'font-pairs': 'Remix: font pairs',
  spacing: 'Remix: spacing',
  layout: 'Remix: layout',
};

/** Node the remix would use: exactly 1 selected, real (not an expanded instance). */
export function remixTarget(selection: readonly string[]): string | null {
  if (selection.length !== 1) return null;
  const id = selection[0]!;
  if (isVirtualId(id) || id === COMPONENT_FRAME_ID) return null;
  return id;
}

export function parseCount(raw: string | undefined): number {
  const n = Math.round(Number(raw));
  if (!Number.isFinite(n) || n < 1) return REMIX_DEFAULT_COUNT;
  return Math.min(n, REMIX_MAX_COUNT);
}

/** Runs the remix of the selected node and frames the created frames. */
export async function runRemix(
  kind: RemixKind,
  opts: { count?: number; prompt?: string } = {},
): Promise<void> {
  const nodeId = remixTarget(useUi.getState().selection);
  const docId = useDoc.getState().activeDocId;
  if (!nodeId || !docId) return;
  if (kind === 'ai') {
    // Progress (text and tools of the turn) shows up in the Assistant.
    ui.setRightTab('assistant');
    ui.toast('Remix with AI in progress…');
  }
  try {
    const res = await daemon.remix(nodeId, kind, { ...opts, docId });
    if (res.frameIds.length > 0) {
      // The daemon already selected the created frames; ensure local selection and framing.
      ui.select(res.frameIds);
      ui.focus(res.frameIds);
      ui.toast(
        `${res.frameIds.length} ${res.frameIds.length === 1 ? 'variation created' : 'variations created'} — Ctrl+Z undoes all`,
      );
    } else if (kind === 'ai') {
      ui.toast('Remix with AI done');
    }
  } catch (e) {
    ui.toast(e instanceof Error ? e.message : String(e), 'error');
  }
}

/** "Remix with AI…": asks for the request and the number of variations. */
export async function runAiRemix(): Promise<void> {
  const r = await prompt({
    title: 'Remix with AI',
    message: 'Describe how the variations should differ from the selected node.',
    fields: [
      {
        name: 'prompt',
        label: 'Request',
        placeholder: 'e.g. bolder versions, with more contrast',
      },
      { name: 'count', label: 'Number of variations', value: String(REMIX_DEFAULT_COUNT) },
    ],
    confirmLabel: 'Generate',
  });
  const text = r?.prompt?.trim();
  if (!r || !text) return;
  await runRemix('ai', { prompt: text, count: parseCount(r.count) });
}
