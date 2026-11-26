/**
 * Presentation mode: the visible root frames of a page are the slides, in the order of the page
 * (the same order as the Layers panel, top first). Pure helpers shared by the editor (which presents)
 * and the daemon (which validates the MCP calls and describes the slide order).
 */
import type { Node, Page } from './types.js';

/** One slide: a visible root frame of the page. */
export interface PresentationSlide {
  /** 0-based position in the slide order. */
  index: number;
  /** Frame id. */
  id: string;
  name: string;
}

/** Presentation state reported by the editor (MCP `start_presentation`, `presentation_goto`...). */
export interface PresentationState {
  active: boolean;
  docId: string | null;
  pageId: string | null;
  /** Current slide (0-based); -1 with no slides. */
  index: number;
  /** Frame of the current slide (null with no slides). */
  frameId: string | null;
  slides: PresentationSlide[];
  /** Real full screen (the browser only grants it from a user gesture). */
  fullscreen: boolean;
  /**
   * Click builds already played on the current slide: 0 = only the automatic build (animations
   * with `build: 0`), up to `builds`.
   */
  build: number;
  /** Click builds of the current slide (distinct `build` values above 0 of its animations). */
  builds: number;
}

/** Inactive state (nothing being presented). */
export const NO_PRESENTATION: PresentationState = {
  active: false,
  docId: null,
  pageId: null,
  index: -1,
  frameId: null,
  slides: [],
  fullscreen: false,
  build: 0,
  builds: 0,
};

/** Slide navigation (keyboard, controls, MCP). */
export type SlideNav =
  | { type: 'next' }
  | { type: 'previous' }
  | { type: 'first' }
  | { type: 'last' }
  | { type: 'goto'; index: number };

/** Named steps accepted by `presentation_goto`. */
export const SLIDE_STEPS = ['next', 'previous', 'first', 'last'] as const;
export type SlideStep = (typeof SLIDE_STEPS)[number];

/** Slides of the page: visible root frames, in page order. */
export function presentationSlides(page: Page | null | undefined): PresentationSlide[] {
  if (!page) return [];
  const out: PresentationSlide[] = [];
  for (const f of page.frames) {
    if (f.hidden) continue;
    out.push({ index: out.length, id: f.id, name: f.name });
  }
  return out;
}

const contains = (node: Node, id: string): boolean =>
  node.id === id || node.children.some((c) => contains(c, id));

/**
 * Slide index of a node: the slide of the root frame that contains it (the frame itself or any
 * descendant). -1 when the node is not on the page or its frame is hidden.
 */
export function slideIndexOfNode(
  page: Page | null | undefined,
  slides: readonly PresentationSlide[],
  nodeId: string,
): number {
  if (!page) return -1;
  const frame = page.frames.find((f) => contains(f, nodeId));
  return frame ? slides.findIndex((s) => s.id === frame.id) : -1;
}

/**
 * First slide of the presentation: the frame of the first node of `nodeIds` (e.g. the selection) that
 * is on a slide; otherwise the first slide. -1 with no slides.
 */
export function startSlideIndex(
  page: Page | null | undefined,
  slides: readonly PresentationSlide[],
  nodeIds: readonly string[] = [],
): number {
  if (!slides.length) return -1;
  for (const id of nodeIds) {
    const i = slideIndexOfNode(page, slides, id);
    if (i >= 0) return i;
  }
  return 0;
}

/** Clamps an index to the slides (`-1` with no slides). */
export function clampSlideIndex(index: number, total: number): number {
  if (total <= 0) return -1;
  if (!Number.isFinite(index)) return 0;
  return Math.min(Math.max(Math.trunc(index), 0), total - 1);
}

/** Index after a navigation; stays on the first/last slide at the edges. */
export function navigateSlide(index: number, total: number, nav: SlideNav): number {
  if (total <= 0) return -1;
  switch (nav.type) {
    case 'next':
      return clampSlideIndex(index + 1, total);
    case 'previous':
      return clampSlideIndex(index - 1, total);
    case 'first':
      return 0;
    case 'last':
      return total - 1;
    case 'goto':
      return clampSlideIndex(nav.index, total);
  }
}

/**
 * Current index after the slide list changed (live edits while presenting): keeps the current frame
 * by id when it still is a slide; otherwise stays at the same position, clamped to the new list.
 */
export function reconcileSlideIndex(
  prev: readonly PresentationSlide[],
  prevIndex: number,
  next: readonly PresentationSlide[],
): number {
  if (!next.length) return -1;
  const currentId = prev[prevIndex]?.id;
  if (currentId !== undefined) {
    const kept = next.findIndex((s) => s.id === currentId);
    if (kept >= 0) return kept;
  }
  return clampSlideIndex(prevIndex < 0 ? 0 : prevIndex, next.length);
}
