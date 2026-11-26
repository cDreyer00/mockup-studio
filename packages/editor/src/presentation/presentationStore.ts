/**
 * Presentation mode: the visible root frames of a page are played as slides, full screen, on top of
 * the editor. The canvas stays mounted underneath (page, zoom and scroll are never touched), the
 * document is only read (the view with expanded components) and follows live edits from the user or
 * the MCP.
 */
import { create } from 'zustand';
import {
  COMPONENT_EDIT_PAGE_ID,
  NO_PRESENTATION,
  navigateSlide,
  presentationSlides,
  reconcileSlideIndex,
  frameMotionTimeline,
  slideIndexOfNode,
  startSlideIndex,
  transitionPlan,
} from '@mockup/core';
import type {
  Document,
  Node,
  Page,
  PresentationSlide,
  PresentationState,
  SlideNav,
  TransitionPlan,
} from '@mockup/core';
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
  /**
   * With `index`/`frameId`/`step`: click builds already played on the target slide (default 0).
   * Alone: that build of the current slide.
   */
  build?: number;
}

/**
 * What the last navigation asks the view to play. `seq` changes on every navigation (slide or
 * build); the view reacts to it, so the store never touches the DOM.
 */
export interface SlideNavState {
  seq: number;
  /** A slide came in (start, slide change, restart): its build 0 plays and it fades or transitions in. */
  enter: boolean;
  /** Slide being left, kept mounted while the transition runs (only with a `plan`). */
  leaving: Node | null;
  plan: TransitionPlan | null;
  /** Navigating to an earlier slide. */
  reverse: boolean;
  /** Same slide, next build: play it (otherwise builds jump). */
  animate: boolean;
}

const NO_NAV: SlideNavState = {
  seq: 0,
  enter: true,
  leaving: null,
  plan: null,
  reverse: false,
  animate: false,
};

interface PresentationStoreState {
  active: boolean;
  docId: string | null;
  pageId: string | null;
  slides: PresentationSlide[];
  /** Current slide (0-based); -1 with no slides. */
  index: number;
  /** Click builds played on the current slide (0 = only the automatic build). */
  build: number;
  /** Click builds of the current slide. */
  builds: number;
  nav: SlideNavState;
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
  build: 0,
  builds: 0,
  nav: NO_NAV,
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

/** Click builds of a slide (cached by node: structural sharing keeps unchanged frames identical). */
const buildsCache = new WeakMap<Node, number>();
function buildsOf(frame: Node | undefined): number {
  if (!frame) return 0;
  let n = buildsCache.get(frame);
  if (n === undefined) {
    n = frameMotionTimeline(frame).clicks;
    buildsCache.set(frame, n);
  }
  return n;
}

const frameOf = (page: Page | undefined, id: string | undefined): Node | undefined =>
  id === undefined ? undefined : page?.frames.find((f) => f.id === id);

const pageOfState = (s: PresentationStoreState): Page | undefined =>
  useDoc.getState().doc?.pages.find((p) => p.id === s.pageId);

/** Build number meaning "all builds played". */
const LAST_BUILD = Number.POSITIVE_INFINITY;

/** Moves to a slide and build (clamped), describing what the view has to play. */
function go(index: number, wantBuild: number): void {
  const s = usePresentation.getState();
  if (!s.active || !s.slides.length) return;
  const to = Math.min(Math.max(0, Math.trunc(index) || 0), s.slides.length - 1);
  const page = pageOfState(s);
  const frame = frameOf(page, s.slides[to]?.id);
  const builds = buildsOf(frame);
  const build = Math.min(Math.max(0, Number.isNaN(wantBuild) ? 0 : Math.trunc(wantBuild)), builds);
  const changed = to !== s.index;
  if (!changed && build === s.build) return;
  const reverse = to < s.index;
  let leaving: Node | null = null;
  let plan: TransitionPlan | null = null;
  if (changed) {
    const from = frameOf(page, s.slides[s.index]?.id);
    // Going back, the slide being left defines the transition (played time-reversed).
    const t = reverse ? from?.slideTransition : frame?.slideTransition;
    plan = from && t ? transitionPlan(t, reverse) : null;
    if (plan) leaving = from!;
  }
  usePresentation.setState({
    index: to,
    build,
    builds,
    nav: {
      seq: s.nav.seq + 1,
      enter: changed,
      leaving,
      plan,
      reverse: changed && reverse,
      animate: !changed && build === s.build + 1,
    },
  });
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
/** Element focused before the presentation (e.g. the Present button), focused again on exit. */
let returnFocus: HTMLElement | null = null;

function saveFocus(): void {
  if (typeof document === 'undefined') return;
  const el = document.activeElement;
  returnFocus = el instanceof HTMLElement && el !== document.body ? el : null;
}

function restoreFocus(): void {
  const el = returnFocus;
  returnFocus = null;
  if (el?.isConnected) el.focus({ preventScroll: true });
}

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
  const sameList = sameSlides(slides, cur.slides);
  const index = sameList ? cur.index : reconcileSlideIndex(cur.slides, cur.index, slides);
  const id = slides[index]?.id;
  const slideChanged = id !== cur.slides[cur.index]?.id;
  const builds = buildsOf(frameOf(page, id));
  const build = slideChanged ? 0 : Math.min(cur.build, builds);
  if (sameList && builds === cur.builds && build === cur.build) return;
  usePresentation.setState({
    slides,
    index,
    builds,
    build,
    // The current slide changed under us, or its builds shrank: the view re-applies the state.
    ...((slideChanged || build !== cur.build) && {
      nav: { ...NO_NAV, seq: cur.nav.seq + 1, enter: slideChanged },
    }),
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
  restoreFocus();
  if (!restore || cur.inComponentEdit) return;
  const last = cur.slides[cur.index]?.id;
  const shown = selectPage(useDoc.getState().doc, useUi.getState().pageId)?.id;
  // Only on the page the editor shows (the MCP can present another one): the page and view stay.
  if (last && shown === cur.pageId && last !== cur.startFrameId) ui.select([last]);
}

export const presentation = {
  /**
   * Starts presenting a page. Throws when there is nothing to present. Call it synchronously from
   * a user gesture so the browser grants full screen. While presenting it switches to the new page
   * and slide without leaving full screen.
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
    if (usePresentation.getState().active) {
      // Restart while presenting: swap the slides in place. Full screen, listeners and what to
      // restore on exit stay as they are (leaving and re-entering full screen would race).
      usePresentation.setState({
        docId: activeDocId,
        pageId: page.id,
        slides,
        index,
        build: 0,
        builds: buildsOf(frameOf(page, slides[index]!.id)),
        nav: { ...NO_NAV, seq: usePresentation.getState().nav.seq + 1 },
      });
      ui.hover(null);
      return presentation.getState();
    }

    saveFocus();
    const inComponentEdit = selectPage(doc, useUi.getState().pageId)?.id === COMPONENT_EDIT_PAGE_ID;
    usePresentation.setState({
      active: true,
      docId: activeDocId,
      pageId: page.id,
      slides,
      index,
      build: 0,
      builds: buildsOf(frameOf(page, slides[index]!.id)),
      nav: { ...NO_NAV, seq: usePresentation.getState().nav.seq + 1 },
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

  /**
   * `next` plays the next click build before moving on; `previous` undoes one build (instantly)
   * before going back, landing on the previous slide with all its builds played.
   */
  navigate(nav: SlideNav): void {
    const s = usePresentation.getState();
    if (!s.active) return;
    switch (nav.type) {
      case 'next':
        if (s.build < s.builds) go(s.index, s.build + 1);
        else if (s.index < s.slides.length - 1) go(s.index + 1, 0);
        return;
      case 'previous':
        if (s.build > 0) go(s.index, s.build - 1);
        else if (s.index > 0) go(s.index - 1, LAST_BUILD);
        return;
      default:
        go(navigateSlide(s.index, s.slides.length, nav), 0);
    }
  },

  /** Jumps to a slide (and build) by index, frame id (or a node inside it) or named step. Throws when it makes no sense. */
  goto(opts: GotoOptions): PresentationState {
    const s = usePresentation.getState();
    if (!s.active) throw new Error('No presentation is running.');
    if (opts.frameId !== undefined) {
      const page = useDoc.getState().doc?.pages.find((p) => p.id === s.pageId);
      const index = slideIndexOfNode(page, s.slides, opts.frameId);
      if (index < 0) throw new Error(`Frame "${opts.frameId}" is not a slide of the presentation.`);
      go(index, opts.build ?? 0);
    } else if (opts.index !== undefined) {
      const index = navigateSlide(s.index, s.slides.length, { type: 'goto', index: opts.index });
      go(index, opts.build ?? 0);
    } else if (opts.step !== undefined) {
      if (opts.build !== undefined && opts.step !== 'next' && opts.step !== 'previous') {
        go(navigateSlide(s.index, s.slides.length, { type: opts.step }), opts.build);
      } else {
        presentation.navigate({ type: opts.step });
      }
    } else if (opts.build !== undefined) {
      go(s.index, opts.build);
    } else {
      throw new Error('Provide index, frameId, step or build.');
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
      build: s.build,
      builds: s.builds,
    };
  },
};
