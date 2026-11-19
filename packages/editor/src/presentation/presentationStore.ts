/**
 * Presentation mode: the visible root frames of a page are played as slides, full screen, on top of
 * the editor. The canvas stays mounted underneath (zoom and scroll are never touched), the document
 * is only read (the view with expanded components) and follows live edits from the user or the MCP.
 */
import { create } from 'zustand';
import {
  COMPONENT_EDIT_PAGE_ID,
  NO_PRESENTATION,
  navigateSlide,
  presentationSlides,
  reconcileSlideIndex,
  slideIndexOfNode,
  startSlideIndex,
} from '@mockup/core';
import type { Document, Page, PresentationSlide, PresentationState, SlideNav } from '@mockup/core';
import { getDesktop } from '../desktop/bridge';
import { fxClock, useFxClock } from '../fx/clock';
import { useDoc } from '../state/docStore';
import { selectPage } from '../state/hooks';
import { ui, useUi } from '../state/uiStore';

export interface StartOptions {
  /** Page to present. Default: the page shown in the editor. */
  pageId?: string;
  /** Slide to start from (a root frame, or any node inside one). */
  frameId?: string;
  /** Without `frameId`: `first` = first slide; `selection` (default) = the frame of the selection. */
  from?: 'first' | 'selection';
}

export interface GotoOptions {
  index?: number;
  frameId?: string;
  step?: 'next' | 'previous' | 'first' | 'last';
}

interface PresentationStoreState {
  active: boolean;
  docId: string | null;
  pageId: string | null;
  slides: PresentationSlide[];
  /** Current slide (0-based); -1 with no slides. */
  index: number;
  /** Real full screen (browser or desktop window). */
  fullscreen: boolean;
  /** Frame the presentation started on (to restore the selection on exit). */
  startFrameId: string | null;
  /** Started in main component edit mode (the selection is not touched on exit). */
  inComponentEdit: boolean;
  /** Animations were playing before the presentation (the clock is forced to play meanwhile). */
  wasPlaying: boolean;
}

const IDLE: PresentationStoreState = {
  active: false,
  docId: null,
  pageId: null,
  slides: [],
  index: -1,
  fullscreen: false,
  startFrameId: null,
  inComponentEdit: false,
  wasPlaying: true,
};

export const usePresentation = create<PresentationStoreState>(() => IDLE);

/* ---------------- helpers ---------------- */

/** Page to present: explicit, or the displayed one (the page you came from in component edit mode). */
function resolvePage(doc: Document, pageId: string | undefined): Page {
  if (pageId !== undefined) {
    const page = doc.pages.find((p) => p.id === pageId && p.id !== COMPONENT_EDIT_PAGE_ID);
    if (!page) throw new Error(`Page "${pageId}" not found.`);
    return page;
  }
  const shown = displayedPage(doc, useUi.getState().pageId, useUi.getState().componentEdit);
  if (!shown) throw new Error('This document has no pages.');
  return shown;
}

/** Page shown by the editor that a presentation would play (the page you came from in component edit mode). */
export function displayedPage(
  doc: Document | null,
  pageId: string | null,
  componentEdit: { fromPageId: string | null } | null,
): Page | null {
  const shown = selectPage(doc, pageId);
  if (shown?.id !== COMPONENT_EDIT_PAGE_ID) return shown;
  return doc?.pages.find((p) => p.id === componentEdit?.fromPageId) ?? doc?.pages[0] ?? null;
}

const sameSlides = (a: PresentationSlide[], b: PresentationSlide[]): boolean =>
  a.length === b.length && a.every((s, i) => s.id === b[i]!.id && s.name === b[i]!.name);

/* ---------------- full screen ---------------- */

/** The browser's full screen was entered by us (so we only leave what we entered). */
let browserFullscreen = false;
/** Pending full screen request (the desktop answers asynchronously); see `presentation.settled`. */
let fullscreenPending: Promise<void> = Promise.resolve();
let detach: (() => void) | null = null;
let unsubDoc: (() => void) | null = null;

function setFullscreen(on: boolean): void {
  if (usePresentation.getState().active && usePresentation.getState().fullscreen !== on) {
    usePresentation.setState({ fullscreen: on });
  }
}

/**
 * Asks for full screen. In the browser the request must run synchronously inside the user
 * gesture; without a gesture (MCP) it is refused and the presentation stays inside the window.
 */
function enterFullscreen(): void {
  fullscreenPending = Promise.resolve();
  const desktop = getDesktop();
  if (desktop) {
    if (!desktop.setPresentationFullScreen) return;
    fullscreenPending = desktop
      .setPresentationFullScreen(true)
      .then(setFullscreen, () => undefined);
    return;
  }
  const el = typeof document === 'undefined' ? undefined : document.documentElement;
  if (typeof el?.requestFullscreen !== 'function') return;
  try {
    fullscreenPending = Promise.resolve(el.requestFullscreen()).then(
      () => {
        if (!document.fullscreenElement) return;
        browserFullscreen = true;
        setFullscreen(true);
      },
      () => undefined,
    );
  } catch {
    /* unavailable: keeps presenting in the window */
  }
}

function leaveFullscreen(): void {
  const desktop = getDesktop();
  if (desktop) {
    void desktop.setPresentationFullScreen?.(false)?.catch(() => undefined);
    return;
  }
  const entered = browserFullscreen;
  browserFullscreen = false;
  if (entered && typeof document !== 'undefined' && document.fullscreenElement) {
    void document.exitFullscreen().catch(() => undefined);
  }
}

/** Listeners that end the presentation when the user leaves full screen on their own. */
function watchFullscreen(): () => void {
  const offs: (() => void)[] = [];
  const desktop = getDesktop();
  if (desktop?.onLeaveFullScreen) {
    offs.push(desktop.onLeaveFullScreen(() => presentation.stop()));
  }
  if (typeof document !== 'undefined') {
    const onChange = (): void => {
      if (document.fullscreenElement) {
        browserFullscreen = true;
        setFullscreen(true);
      } else if (browserFullscreen) {
        browserFullscreen = false;
        presentation.stop();
      }
    };
    document.addEventListener('fullscreenchange', onChange);
    offs.push(() => document.removeEventListener('fullscreenchange', onChange));
  }
  return () => offs.forEach((off) => off());
}

/* ---------------- live updates ---------------- */

function onDocChange(
  s: ReturnType<typeof useDoc.getState>,
  p: ReturnType<typeof useDoc.getState>,
): void {
  if (s.doc === p.doc && s.activeDocId === p.activeDocId) return;
  const cur = usePresentation.getState();
  if (!cur.active) return;
  if (!s.doc || s.activeDocId !== cur.docId || s.doc.id !== cur.docId) {
    stopInternal(false);
    return;
  }
  const page = s.doc.pages.find((pg) => pg.id === cur.pageId);
  if (!page) {
    stopInternal(false);
    return;
  }
  const slides = presentationSlides(page);
  if (sameSlides(slides, cur.slides)) return;
  usePresentation.setState({
    slides,
    index: reconcileSlideIndex(cur.slides, cur.index, slides),
  });
}

/* ---------------- start / stop ---------------- */

function stopInternal(restore: boolean): void {
  const cur = usePresentation.getState();
  if (!cur.active) return;
  unsubDoc?.();
  unsubDoc = null;
  detach?.();
  detach = null;
  usePresentation.setState(IDLE);
  fxClock.setPlaying(cur.wasPlaying);
  leaveFullscreen();
  ui.hover(null);
  if (!restore || cur.inComponentEdit) return;
  const last = cur.slides[cur.index]?.id;
  const shown = selectPage(useDoc.getState().doc, useUi.getState().pageId)?.id;
  if (cur.pageId && shown !== cur.pageId) {
    // Presented from the MCP a page the editor was not showing: goes to it.
    ui.setPage(cur.pageId);
    if (last) {
      ui.select([last]);
      ui.focus([last]);
    }
  } else if (last && last !== cur.startFrameId) {
    ui.select([last]);
  }
}

export const presentation = {
  /**
   * Starts presenting a page. Throws when there is nothing to present. Call it synchronously from
   * a user gesture so the browser grants full screen.
   */
  start(opts: StartOptions = {}): PresentationState {
    const { doc, activeDocId } = useDoc.getState();
    if (!doc || !activeDocId) throw new Error('No document is open.');
    const page = resolvePage(doc, opts.pageId);
    const slides = presentationSlides(page);
    if (!slides.length) throw new Error('This page has no visible frames to present.');
    let index: number;
    if (opts.frameId !== undefined) {
      index = slideIndexOfNode(page, slides, opts.frameId);
      if (index < 0) throw new Error(`Frame "${opts.frameId}" is not a slide of this page.`);
    } else if (opts.from === 'first') {
      index = 0;
    } else {
      index = startSlideIndex(page, slides, useUi.getState().selection);
    }
    if (usePresentation.getState().active) stopInternal(true);

    const inComponentEdit = selectPage(doc, useUi.getState().pageId)?.id === COMPONENT_EDIT_PAGE_ID;
    usePresentation.setState({
      active: true,
      docId: activeDocId,
      pageId: page.id,
      slides,
      index,
      fullscreen: false,
      startFrameId: slides[index]!.id,
      inComponentEdit,
      wasPlaying: useFxClock.getState().playing,
    });
    fxClock.setPlaying(true);
    ui.hover(null);
    unsubDoc = useDoc.subscribe(onDocChange);
    detach = watchFullscreen();
    enterFullscreen();
    return presentation.getState();
  },

  navigate(nav: SlideNav): void {
    const s = usePresentation.getState();
    if (!s.active) return;
    const index = navigateSlide(s.index, s.slides.length, nav);
    if (index !== s.index) usePresentation.setState({ index });
  },

  /** Jumps to a slide by index, frame id (or a node inside it) or named step. Throws when it makes no sense. */
  goto(opts: GotoOptions): PresentationState {
    const s = usePresentation.getState();
    if (!s.active) throw new Error('No presentation is running.');
    if (opts.frameId !== undefined) {
      const page = useDoc.getState().doc?.pages.find((p) => p.id === s.pageId);
      const index = slideIndexOfNode(page, s.slides, opts.frameId);
      if (index < 0) throw new Error(`Frame "${opts.frameId}" is not a slide of the presentation.`);
      presentation.navigate({ type: 'goto', index });
    } else if (opts.index !== undefined) {
      presentation.navigate({ type: 'goto', index: opts.index });
    } else if (opts.step !== undefined) {
      presentation.navigate({ type: opts.step });
    } else {
      throw new Error('Provide index, frameId or step.');
    }
    return presentation.getState();
  },

  /** Ends the presentation and restores the editor (selection, animations clock, full screen). */
  stop(): void {
    stopInternal(true);
  },

  /** Resolves when the pending full screen request has been answered (desktop: async). */
  settled(): Promise<void> {
    return fullscreenPending;
  },

  getState(): PresentationState {
    const s = usePresentation.getState();
    if (!s.active) return NO_PRESENTATION;
    return {
      active: true,
      docId: s.docId,
      pageId: s.pageId,
      index: s.index,
      frameId: s.slides[s.index]?.id ?? null,
      slides: s.slides,
      fullscreen: s.fullscreen,
    };
  },
};
