/**
 * Presentation overlay: the current slide (a root frame) rendered with the same renderer as the
 * screenshots (`RenderApp`), scaled to fit, with auto-hiding controls and keyboard navigation.
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import { ChevronLeft, ChevronRight, X } from 'lucide-react';
import { resolveEasing } from '@mockup/core';
import type { Document, Node, PreviewState, SlideNav } from '@mockup/core';
import { MotionScope } from '../motion/scope';
import { RenderApp, renderFrameOf } from '../render/RenderApp';
import { useDoc } from '../state/docStore';
import { useUi } from '../state/uiStore';
import { ErrorBoundary } from '../ui/ErrorBoundary';
import { fitSlide } from './fit';
import type { Size } from './fit';
import { magicPairs, startMagic } from './magic';
import { presentation, usePresentation } from './presentationStore';
import { fadeIn, prefersReducedMotion, runTransition } from './transition';
import type { TransitionHandle } from './transition';
import './presentation.css';

/** Controls and cursor hide after this long without mouse movement. */
export const IDLE_MS = 2000;

const ICON = 18;

/** Navigation for a key, or `exit`; `undefined` = not a presentation key. */
export function presentationKey(
  e: Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'metaKey' | 'altKey'>,
): SlideNav | 'exit' | undefined {
  if (e.ctrlKey || e.metaKey || e.altKey) return undefined;
  switch (e.key) {
    case 'ArrowRight':
    case 'ArrowDown':
    case ' ':
    case 'PageDown':
    case 'Enter':
      return { type: 'next' };
    case 'ArrowLeft':
    case 'ArrowUp':
    case 'Backspace':
    case 'PageUp':
      return { type: 'previous' };
    case 'Home':
      return { type: 'first' };
    case 'End':
      return { type: 'last' };
    case 'Escape':
      return 'exit';
    default:
      return undefined;
  }
}

/** The slide at its natural size, scaled to fit the stage keeping the aspect ratio, centered. */
function Slide({
  doc,
  docId,
  frame,
  state,
  stage,
  motion,
}: {
  doc: Document;
  docId: string;
  frame: Node;
  state: PreviewState | null;
  stage: Size;
  motion: MotionScope;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState<Size>({ w: 0, h: 0 });
  const rendered = useMemo(() => renderFrameOf(frame), [frame]);

  // The root frame's layout size ignores transforms; auto-sized frames can change with the content.
  useLayoutEffect(() => {
    const el = ref.current?.querySelector<HTMLElement>(`[data-node-id="${frame.id}"]`);
    if (!el) return;
    const measure = (): void => {
      setSize((s) =>
        s.w === el.offsetWidth && s.h === el.offsetHeight
          ? s
          : { w: el.offsetWidth, h: el.offsetHeight },
      );
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [rendered, frame.id]);

  const fits = size.w > 0 && size.h > 0 && stage.w > 0 && stage.h > 0;
  const fit = fits ? fitSlide(size, stage) : null;
  const scale = fit ? fit.scale : 1;
  const style: CSSProperties = fit
    ? { transform: `translate(${fit.x}px, ${fit.y}px) scale(${fit.scale})` }
    : { visibility: 'hidden' };
  return (
    <div
      ref={ref}
      className="pres-slide"
      data-testid="presentation-slide"
      data-frame-id={frame.id}
      data-scale={fits ? scale : undefined}
      style={style}
    >
      <RenderApp
        doc={doc}
        docId={docId}
        frame={rendered}
        motion={motion}
        {...(state && { state })}
      />
    </div>
  );
}

/** Keys left to the browser while presenting: focus moves between the controls, full screen, dev tools. */
const BROWSER_KEYS = new Set(['Tab', 'F11', 'F12']);

/** Enter or Space typed on a focused control button. */
function isControlActivation(e: KeyboardEvent): boolean {
  if (e.key !== 'Enter' && e.key !== ' ') return false;
  return e.target instanceof Element && e.target.closest('.pres-controls') !== null;
}

/** Keyboard (capture phase, so no editor shortcut runs) and idle tracking while presenting. */
function usePresentationInput(onActivity: () => void): void {
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      // Nothing reaches the editor shortcuts, the canvas or a focused field.
      e.stopImmediatePropagation();
      // Enter / Space on a focused control button (reached with Tab) activate it.
      if (isControlActivation(e)) return;
      const action = presentationKey(e);
      // The browser's own keys (F5 / Ctrl+R reload, Ctrl+P...) are blocked too.
      if (action || !BROWSER_KEYS.has(e.key)) e.preventDefault();
      if (!action) return;
      if (action === 'exit') presentation.stop();
      else presentation.navigate(action);
    };
    window.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('mousemove', onActivity);
    (document.activeElement as HTMLElement | null)?.blur?.();
    return () => {
      window.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('mousemove', onActivity);
    };
  }, [onActivity]);
}

function findFrame(doc: Document | null, pageId: string | null, id: string | undefined) {
  return id ? doc?.pages.find((p) => p.id === pageId)?.frames.find((f) => f.id === id) : undefined;
}

function Presenting() {
  const doc = useDoc((s) => s.doc);
  const previewState = useUi((s) => s.previewState);
  const { docId, pageId, slides, index, build, builds, nav } = usePresentation();
  const stageRef = useRef<HTMLDivElement>(null);
  const [stage, setStage] = useState<Size>({ w: 0, h: 0 });
  const [idle, setIdle] = useState(false);
  const idleTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  // One motion scope per presentation (disposed on exit).
  const [scope] = useState(() => new MotionScope());
  useEffect(() => () => scope.dispose(), [scope]);
  // The slot of each mounted slide, by frame id; the transition in flight; the last one finished.
  const slots = useRef(new Map<string, HTMLDivElement>());
  const run = useRef<TransitionHandle | null>(null);
  const fade = useRef<Animation | null>(null);
  const [doneSeq, setDoneSeq] = useState(-1);

  const wake = useMemo(
    () => () => {
      setIdle(false);
      clearTimeout(idleTimer.current);
      idleTimer.current = setTimeout(() => setIdle(true), IDLE_MS);
    },
    [],
  );
  useEffect(() => {
    wake();
    return () => clearTimeout(idleTimer.current);
  }, [wake]);
  usePresentationInput(wake);

  useLayoutEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const measure = (): void => setStage({ w: el.clientWidth, h: el.clientHeight });
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const frameId = slides[index]?.id;
  const frame = findFrame(doc, pageId, frameId);
  const leaving = nav.leaving && doneSeq !== nav.seq ? nav.leaving : null;
  const total = slides.length;

  // Every navigation: finish what was running, then play the builds and the transition.
  useLayoutEffect(() => {
    run.current?.finish();
    run.current = null;
    fade.current?.cancel();
    fade.current = null;
    if (!frameId) return;
    const stageEl = stageRef.current;
    const incoming = slots.current.get(frameId);
    if (nav.enter) {
      // Fresh state for the slide that comes in: build 0 plays while it appears (builds already
      // played when arriving from the right or jumping are shown finished).
      scope.setMode(frameId, { type: 'rest' });
      scope.setMode(frameId, {
        type: 'builds',
        clicks: build,
        animate: build === 0 && !nav.reverse,
      });
    } else {
      scope.setMode(frameId, { type: 'builds', clicks: build, animate: nav.animate });
    }
    if (!nav.enter || !incoming || !stageEl) return;
    const out = nav.leaving ? slots.current.get(nav.leaving.id) : undefined;
    if (nav.plan && out && !prefersReducedMotion()) {
      const plan = nav.plan;
      const outId = out.dataset.frameId!;
      const handle = runTransition({
        plan,
        stage: stageEl,
        incoming,
        outgoing: out,
        magic: () =>
          startMagic({
            stage: stageEl,
            stageSize: { w: stageEl.clientWidth, h: stageEl.clientHeight },
            incomingSlot: incoming,
            outgoingSlot: out,
            incomingFrameId: frameId,
            outgoingFrameId: outId,
            pairs: nav.leaving && frame ? magicPairs(nav.leaving, frame) : [],
            duration: plan.duration,
            easing: resolveEasing(plan.easing),
          }),
        onDone: () => {
          run.current = null;
          setDoneSeq(nav.seq);
        },
      });
      if (handle) {
        run.current = handle;
        return;
      }
    }
    if (nav.leaving) setDoneSeq(nav.seq);
    if (!nav.plan && !prefersReducedMotion()) fade.current = fadeIn(incoming);
    // The navigation (not the doc) is what restarts this.
  }, [nav.seq, scope]);
  useEffect(
    () => () => {
      run.current?.finish();
      fade.current?.cancel();
    },
    [],
  );

  const setSlot = (id: string) => (el: HTMLDivElement | null) => {
    if (el) slots.current.set(id, el);
    else slots.current.delete(id);
  };
  const renderSlot = (f: Node) => (
    <div key={f.id} ref={setSlot(f.id)} className="pres-slot" data-frame-id={f.id}>
      <ErrorBoundary
        fallback={(error) => (
          <div className="pres-message" role="alert">
            This slide could not be rendered: {error.message}
          </div>
        )}
      >
        <Slide
          doc={doc!}
          docId={docId!}
          frame={f}
          state={previewState}
          stage={stage}
          motion={scope}
        />
      </ErrorBoundary>
    </div>
  );

  return (
    <div
      className={`pres${idle ? ' idle' : ''}`}
      data-testid="presentation"
      role="dialog"
      aria-label="Presentation"
      aria-modal="true"
    >
      <div
        ref={stageRef}
        className="pres-stage"
        data-testid="presentation-stage"
        onClick={() => presentation.navigate({ type: 'next' })}
      >
        {doc && docId && frame ? (
          <>
            {leaving && renderSlot(leaving)}
            {renderSlot(frame)}
          </>
        ) : (
          <div className="pres-message" data-testid="presentation-empty">
            This page has no visible frames.
          </div>
        )}
      </div>
      <div
        className="pres-controls"
        onClick={(e) => e.stopPropagation()}
        onMouseDown={(e) => e.preventDefault()}
      >
        <button
          type="button"
          className="pres-btn"
          data-testid="presentation-prev"
          aria-label="Previous slide"
          title="Previous slide"
          disabled={index <= 0 && build <= 0}
          onClick={() => presentation.navigate({ type: 'previous' })}
        >
          <ChevronLeft size={ICON} />
        </button>
        <span className="pres-counter" data-testid="presentation-counter" aria-live="polite">
          {index + 1} / {total}
          {builds > 0 && (
            <span className="pres-builds" data-testid="presentation-builds">
              {' '}
              · {build}/{builds}
            </span>
          )}
        </span>
        <button
          type="button"
          className="pres-btn"
          data-testid="presentation-next"
          aria-label="Next slide"
          title="Next slide"
          disabled={index >= total - 1 && build >= builds}
          onClick={() => presentation.navigate({ type: 'next' })}
        >
          <ChevronRight size={ICON} />
        </button>
        <button
          type="button"
          className="pres-btn pres-exit"
          data-testid="presentation-exit"
          aria-label="Exit presentation"
          title="Exit presentation (Esc)"
          onClick={() => presentation.stop()}
        >
          <X size={ICON} />
        </button>
      </div>
    </div>
  );
}

/** Mounted once in the app; renders nothing unless a presentation is running. */
export function PresentationView() {
  const active = usePresentation((s) => s.active);
  return active ? <Presenting /> : null;
}
