import { z } from 'zod';
import {
  SLIDE_STEPS,
  presentationSlides,
  slideIndexOfNode,
  type Document,
  type EditorCommand,
  type Node,
  type Page,
  type PresentationState,
} from '@mockup/core';
import { NO_EDITOR_MESSAGE } from '../../editors.js';
import { ToolError, WRITE, docIdField, type Annotations, type ToolContext } from '../context.js';

const IDEMPOTENT: Annotations = { ...WRITE, idempotentHint: true };

const hasNode = (node: Node, id: string): boolean =>
  node.id === id || node.children.some((c) => hasNode(c, id));

const slideLine = (s: { index: number; id: string; name: string }): string =>
  `${s.index}. ${s.name} (${s.id})`;

/** "slide N / total — "name" (id)" for the current slide (N is 1-based). */
function currentSlide(state: PresentationState): string {
  const s = state.slides[state.index];
  if (!s) return 'no slides';
  return `slide ${state.index + 1} / ${state.slides.length} — "${s.name}" (${s.id})`;
}

export function registerPresentationTools(ctx: ToolContext): void {
  const { tool, store, opts } = ctx;

  /** Sends a command to the editor window; no editor connected becomes a `ToolError`. */
  async function send(cmd: EditorCommand): Promise<PresentationState> {
    const editors = opts.services?.editors;
    if (!editors || editors.count() === 0) throw new ToolError(NO_EDITOR_MESSAGE);
    try {
      return await editors.command(cmd);
    } catch (e) {
      throw new ToolError(e instanceof Error ? e.message : String(e));
    }
  }

  function resolvePage(doc: Document, pageId?: string, frameId?: string): Page | undefined {
    if (pageId) {
      const page = doc.pages.find((p) => p.id === pageId);
      if (!page)
        throw new ToolError(`Page not found: "${pageId}". Use get_basic_info to see the pages.`);
      return page;
    }
    if (frameId) {
      const page = doc.pages.find((p) => p.frames.some((f) => hasNode(f, frameId)));
      if (!page)
        throw new ToolError(
          `Node not found: "${frameId}". Use get_tree_summary to list valid ids.`,
        );
      return page;
    }
    return undefined;
  }

  tool(
    'start_presentation',
    {
      title: 'Start presentation',
      description:
        'Presents a page in the focused editor window: each visible root frame is a slide, in page order. Makes docId the active document first (even if presenting then fails). If already presenting, switches page and slide in place. Returns the slide order; then presentation_goto / stop_presentation.',
      example: { pageId: 'pg_ab12cd34', frameId: 'fr_ab12cd34' },
      inputSchema: {
        pageId: z
          .string()
          .optional()
          .describe(
            'Page to present, e.g. "pg_ab12cd34" (default: the page shown in the editor, or the one containing frameId).',
          ),
        frameId: z
          .string()
          .optional()
          .describe(
            'Slide to start from: a root frame of the page or any node inside it, e.g. "fr_ab12cd34" (default: the selection, or the first slide).',
          ),
        docId: docIdField,
      },
      annotations: WRITE,
    },
    async ({ pageId, frameId, docId }) => {
      const id = store.resolveDocId(docId);
      const doc = store.get(id);
      const page = resolvePage(doc, pageId, frameId);
      let startFrame: string | undefined;
      if (page) {
        const slides = presentationSlides(page);
        if (slides.length === 0)
          throw new ToolError(`Page "${page.name}" has no visible frames to present.`);
        if (frameId) {
          const i = slideIndexOfNode(page, slides, frameId);
          if (i < 0)
            throw new ToolError(
              `Frame not found on page "${page.name}" (or hidden): "${frameId}". Use get_basic_info to see the frames.`,
            );
          startFrame = slides[i]!.id;
        }
      }
      // Make sure there is an editor before changing the active document.
      const editors = opts.services?.editors;
      if (!editors || editors.count() === 0) throw new ToolError(NO_EDITOR_MESSAGE);
      if (docId && store.getActive()?.id !== id) store.setActive(id);
      const state = await send({
        type: 'presentation:start',
        docId: id,
        ...(page ? { pageId: page.id } : {}),
        ...(startFrame ? { frameId: startFrame } : {}),
      });
      const pageName = doc.pages.find((p) => p.id === state.pageId)?.name ?? page?.name;
      const lines = [
        `Presentation started${pageName ? ` on page "${pageName}"` : ''}${state.fullscreen ? ' in full screen' : ''}.`,
      ];
      if (!state.fullscreen)
        lines.push(
          'Not in full screen: the editor presents inside its window because the browser only allows full screen from a user gesture.',
        );
      lines.push(`Current: ${currentSlide(state)}.`);
      lines.push('Slides:');
      for (const s of state.slides)
        lines.push(`${slideLine(s)}${s.index === state.index ? '  <- current' : ''}`);
      lines.push('Use presentation_goto to change slide and stop_presentation to end.');
      return lines.join('\n');
    },
  );

  tool(
    'presentation_goto',
    {
      title: 'Go to slide',
      description:
        'Navigates the running presentation. Pass exactly one of index (0-based), frameId or step (next, previous, first, last). Fails if no presentation is running (use start_presentation).',
      example: { step: 'next' },
      inputSchema: {
        index: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe('0-based slide index, e.g. 2 (clamped to the last slide).'),
        frameId: z
          .string()
          .optional()
          .describe('Frame of the slide to show, e.g. "fr_ab12cd34" (any node inside it works).'),
        step: z
          .enum(SLIDE_STEPS)
          .optional()
          .describe('"next", "previous", "first" or "last" (stays at the edges).'),
      },
      // `step: "next"` moves again on every call: not idempotent.
      annotations: WRITE,
    },
    async ({ index, frameId, step }) => {
      const given = [index, frameId, step].filter((v) => v !== undefined).length;
      if (given !== 1)
        throw new ToolError(
          'Pass exactly one of index, frameId or step. E.g. { step: "next" } or { index: 0 }.',
        );
      const state = await send({
        type: 'presentation:goto',
        ...(index !== undefined ? { index } : {}),
        ...(frameId !== undefined ? { frameId } : {}),
        ...(step !== undefined ? { step } : {}),
      });
      return `Now at ${currentSlide(state)}.`;
    },
  );

  tool(
    'stop_presentation',
    {
      title: 'Stop presentation',
      description:
        'Ends presentation mode in the connected editor window. Not an error if none is running.',
      example: {},
      inputSchema: {},
      annotations: IDEMPOTENT,
    },
    async () => {
      // The editor answers with the state from before stopping (inactive = nothing was running).
      const state = await send({ type: 'presentation:stop' });
      return state.active ? 'Presentation stopped.' : 'No presentation was running.';
    },
  );
}
