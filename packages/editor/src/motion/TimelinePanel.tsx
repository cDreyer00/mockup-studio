/**
 * Motion timeline (bottom of the canvas area): the linear timeline of a frame with its builds, one
 * row per animated layer and one bar per animation. Bars drag (delay) and resize (duration); the
 * ruler and the playhead scrub the canvas. The playhead and the time readout are written straight
 * to the DOM from a requestAnimationFrame loop: React never re-renders per frame.
 */
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import { AlertTriangle, Pause, Play, Repeat, Square, X, ZoomIn, ZoomOut } from 'lucide-react';
import { frameMotionTimeline, getMotionPreset } from '@mockup/core';
import type { MotionTimeline, MotionTimelineItem, Node } from '@mockup/core';
import { getFrameOf, getNode } from '../model/tree';
import { runOps } from '../properties/styleOps';
import { useDoc } from '../state/docStore';
import { selectPage } from '../state/hooks';
import { ui, useUi } from '../state/uiStore';
import { IconButton } from '../ui/controls';
import { kindBadge } from './kinds';
import { formatMs, snapMs, updateAnimationOp } from './motionOps';
import { motionPreview, useMotionPreview } from './preview';
import './motion.css';

const NAME_W = 132;
const RULER_H = 22;
const META_H = 18;
const MIN_ZOOM = 20;
const MAX_ZOOM = 1200;
const DEFAULT_ZOOM = 120;

const seconds = (ms: number): string => (ms / 1000).toFixed(2);

/** Nice tick step (ms) so labels stay about 64 px apart. */
export function tickStep(pxPerMs: number): number {
  const steps = [50, 100, 250, 500, 1000, 2000, 5000, 10000, 30000];
  return steps.find((s) => s * pxPerMs >= 64) ?? 60000;
}

/** Visible extent (ms) of the timeline: the finite duration plus room, loops included. */
export function timelineExtent(tl: MotionTimeline): number {
  let end = tl.duration;
  for (const i of tl.items) end = Math.max(end, i.end ?? i.start + i.duration * 2);
  return Math.max(3000, Math.ceil((end * 1.15 + 400) / 500) * 500);
}

/* ------------------------------ bars ------------------------------ */

interface BarDrag {
  pointerId: number;
  startX: number;
  mode: 'move' | 'resize';
  moved: boolean;
  value: number;
  base: { left: number; width: number; main: number };
}

const Bar = memo(function Bar({
  item,
  k,
  extent,
  selected,
  tip,
}: {
  item: MotionTimelineItem;
  k: number;
  extent: number;
  selected: boolean;
  tip: (e: { x: number; y: number; text: string } | null) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const mainRef = useRef<HTMLDivElement>(null);
  const drag = useRef<BarDrag | null>(null);
  const infinite = item.end === null;
  const iterations = item.iterations === 'infinite' ? 1 : item.iterations;
  const mainMs = item.duration * iterations;
  const totalMs = infinite ? Math.max(extent - item.start, mainMs) : item.end! - item.start;
  const left = item.start * k;
  const width = Math.max(4, totalMs * k);
  const main = Math.min(width, Math.max(4, mainMs * k));
  const badge = kindBadge(item.kind, item.iterations);
  const label = getMotionPreset(item.preset)?.label ?? item.preset;

  const down = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    const resize = (e.target as HTMLElement).dataset.handle === '1';
    drag.current = {
      pointerId: e.pointerId,
      startX: e.clientX,
      mode: resize ? 'resize' : 'move',
      moved: false,
      value: resize ? item.duration : item.delay,
      base: { left, width, main },
    };
    e.currentTarget.setPointerCapture?.(e.pointerId);
    e.stopPropagation();
  };

  const move = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    const bar = ref.current;
    const mainEl = mainRef.current;
    if (!d || !bar || !mainEl) return;
    const dx = e.clientX - d.startX;
    if (!d.moved && Math.abs(dx) < 3) return;
    d.moved = true;
    const step = e.shiftKey ? 100 : 10;
    if (d.mode === 'move') {
      const next = Math.max(0, snapMs(item.delay + dx / k, step));
      d.value = next;
      bar.style.transform = `translateX(${(next - item.delay) * k}px)`;
      tip({ x: e.clientX, y: e.clientY, text: `Delay ${formatMs(next)}` });
    } else {
      const next = Math.max(10, snapMs(item.duration + dx / k / iterations, step));
      d.value = next;
      const grow = (next - item.duration) * iterations * k;
      bar.style.width = `${Math.max(4, d.base.width + grow)}px`;
      mainEl.style.width = `${Math.max(4, d.base.main + grow)}px`;
      tip({ x: e.clientX, y: e.clientY, text: `Duration ${formatMs(next)}` });
    }
  };

  const up = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    drag.current = null;
    tip(null);
    if (!d) return;
    e.currentTarget.releasePointerCapture?.(e.pointerId);
    if (!d.moved) {
      ui.select([item.nodeId]);
      ui.selectMotion({ nodeId: item.nodeId, index: item.index });
      return;
    }
    const doc = useDoc.getState().doc;
    const node = doc ? getNode(doc, item.nodeId) : undefined;
    const unchanged = d.value === (d.mode === 'move' ? item.delay : item.duration);
    const op =
      node && !unchanged
        ? updateAnimationOp(
            node,
            item.index,
            d.mode === 'move'
              ? { delay: d.value > 0 ? d.value : undefined }
              : { duration: d.value },
          )
        : null;
    const reset = () => {
      const bar = ref.current;
      const mainEl = mainRef.current;
      if (bar) {
        bar.style.transform = '';
        bar.style.width = '';
      }
      if (mainEl) mainEl.style.width = '';
    };
    if (!op) return reset();
    void runOps([op]).then(() => requestAnimationFrame(reset));
  };

  return (
    <div
      ref={ref}
      className={`mt-bar ${badge.cls}${selected ? ' selected' : ''}${infinite ? ' infinite' : ''}`}
      data-testid="motion-bar"
      data-node={item.nodeId}
      data-index={item.index}
      style={{ left, width }}
      title={`${label} · ${badge.label}\nStart ${formatMs(item.start)} · ${formatMs(item.duration)}${
        item.split ? ` · split ${item.split} (${item.targets})` : ''
      }`}
      onPointerDown={down}
      onPointerMove={move}
      onPointerUp={up}
      onPointerCancel={up}
    >
      <div ref={mainRef} className="mt-bar-main" style={{ width: main }}>
        <span className="mt-bar-label">{label}</span>
        <span className="mt-handle" data-handle="1" />
      </div>
      {width > main + 1 && <div className="mt-bar-tail" />}
      {infinite && <span className="mt-inf">∞</span>}
    </div>
  );
});

/* ------------------------------ panel ------------------------------ */

function useTimelineFrame(): Node | null {
  const first = useUi((s) => s.selection[0]);
  const pageId = useUi((s) => s.pageId);
  return useDoc((s) => {
    const doc = s.doc;
    if (!doc) return null;
    const frame = first ? getFrameOf(doc, first) : undefined;
    if (frame) return frame;
    return selectPage(doc, pageId)?.frames.find((f) => !f.hidden) ?? null;
  });
}

export function TimelinePanel() {
  const frame = useTimelineFrame();
  const height = useUi((s) => s.motionHeight);
  const selection = useUi((s) => s.selection);
  const motionSel = useUi((s) => s.motionSelection);
  const mode = useMotionPreview((s) => s.mode);
  const previewFrame = useMotionPreview((s) => s.frameId);
  const storeTime = useMotionPreview((s) => s.time);
  const [zoom, setZoom] = useState(DEFAULT_ZOOM);
  const [showWarnings, setShowWarnings] = useState(false);

  const timeline = useMemo(() => (frame ? frameMotionTimeline(frame) : null), [frame]);
  const k = zoom / 1000;
  const extent = timeline ? timelineExtent(timeline) : 3000;
  const trackW = extent * k;
  const frameId = frame?.id ?? null;
  const total = timeline?.duration ?? 0;
  const mine = previewFrame === frameId;
  const playing = mine && mode === 'play';
  const hasItems = !!timeline && timeline.items.length > 0;

  const scrollRef = useRef<HTMLDivElement>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  const headRef = useRef<HTMLDivElement>(null);
  const timeRef = useRef<HTMLSpanElement>(null);
  const tipRef = useRef<HTMLDivElement>(null);
  const live = useRef({ k, total, frameId });
  live.current = { k, total, frameId };

  /** Writes the playhead and the readout (no React state). */
  const paint = useCallback(() => {
    const { k, total, frameId } = live.current;
    const st = useMotionPreview.getState();
    const t = st.frameId === frameId ? motionPreview.playhead() : 0;
    if (headRef.current) headRef.current.style.transform = `translateX(${t * k}px)`;
    if (timeRef.current) timeRef.current.textContent = `${seconds(t)} / ${seconds(total)} s`;
  }, []);

  // Position on every state change; a rAF loop while playing.
  useLayoutEffect(() => {
    paint();
    if (!playing) return;
    let raf = requestAnimationFrame(function loop() {
      paint();
      raf = requestAnimationFrame(loop);
    });
    return () => cancelAnimationFrame(raf);
  }, [paint, playing, mode, storeTime, previewFrame, zoom, frameId, total]);

  // Closing the panel goes back to the design state.
  useEffect(() => () => motionPreview.stop(), []);

  // Ctrl+wheel zooms around the cursor.
  const anchor = useRef<{ ms: number; x: number } | null>(null);
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const ms = (el.scrollLeft + x - NAME_W) / live.current.k;
      anchor.current = { ms, x };
      setZoom((z) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z * (e.deltaY < 0 ? 1.15 : 1 / 1.15))));
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);
  useLayoutEffect(() => {
    const a = anchor.current;
    const el = scrollRef.current;
    if (!a || !el) return;
    anchor.current = null;
    el.scrollLeft = Math.max(0, a.ms * k + NAME_W - a.x);
  }, [zoom, k]);

  /* ---- scrubbing ---- */
  const scrubbing = useRef(false);
  const timeAt = (clientX: number): number => {
    const rect = trackRef.current?.getBoundingClientRect();
    if (!rect) return 0;
    return Math.round(Math.min(Math.max(0, (clientX - rect.left) / k), Math.max(total, 0)));
  };
  const onScrubDown = (e: ReactPointerEvent<HTMLElement>) => {
    if (e.button !== 0 || !frameId) return;
    scrubbing.current = true;
    e.currentTarget.setPointerCapture?.(e.pointerId);
    motionPreview.scrub(frameId, timeAt(e.clientX));
    paint();
  };
  const onScrubMove = (e: ReactPointerEvent<HTMLElement>) => {
    if (!scrubbing.current || !frameId) return;
    motionPreview.scrub(frameId, timeAt(e.clientX));
    paint();
  };
  const onScrubUp = (e: ReactPointerEvent<HTMLElement>) => {
    if (!scrubbing.current || !frameId) return;
    scrubbing.current = false;
    e.currentTarget.releasePointerCapture?.(e.pointerId);
    motionPreview.seek(frameId, timeAt(e.clientX));
  };

  const togglePlay = () => {
    if (!frameId || !hasItems) return;
    if (playing) motionPreview.pause();
    else motionPreview.play(frameId, mine ? motionPreview.playhead() : 0);
  };

  const tip = useCallback((t: { x: number; y: number; text: string } | null) => {
    const el = tipRef.current;
    if (!el) return;
    if (!t) {
      el.style.display = 'none';
      return;
    }
    el.style.display = 'block';
    el.style.left = `${t.x + 12}px`;
    el.style.top = `${t.y - 30}px`;
    el.textContent = t.text;
  }, []);

  /* ---- resize ---- */
  const onResizeDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    e.currentTarget.setPointerCapture?.(e.pointerId);
    const startY = e.clientY;
    const startH = height;
    const mv = (ev: PointerEvent) => ui.setMotionHeight(startH + (startY - ev.clientY));
    const end = () => {
      window.removeEventListener('pointermove', mv);
      window.removeEventListener('pointerup', end);
    };
    window.addEventListener('pointermove', mv);
    window.addEventListener('pointerup', end);
  };

  /* ---- layout data ---- */
  const rows = useMemo(() => {
    const map = new Map<string, { name: string; items: MotionTimelineItem[] }>();
    for (const item of timeline?.items ?? []) {
      const row = map.get(item.nodeId) ?? { name: item.name, items: [] };
      row.items.push(item);
      map.set(item.nodeId, row);
    }
    return [...map.entries()];
  }, [timeline]);

  const step = tickStep(k);
  const ticks: number[] = [];
  for (let t = 0; t <= extent; t += step) ticks.push(t);
  const transition = timeline?.transition;

  return (
    <section
      className="mt-panel"
      data-testid="motion-timeline"
      style={{ height }}
      tabIndex={0}
      onKeyDown={(e) => {
        const t = e.target as HTMLElement;
        if (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT') return;
        if (e.key === ' ' && !e.shiftKey) {
          e.preventDefault();
          e.stopPropagation();
          togglePlay();
        }
      }}
    >
      <div className="mt-resize" data-testid="motion-resize" onPointerDown={onResizeDown} />
      <header className="mt-header">
        <span className="mt-title" data-testid="motion-frame-name" title={frame?.name}>
          {frame?.name ?? 'No frame'}
        </span>
        <IconButton
          title={playing ? 'Pause (Space)' : 'Play (Space)'}
          data-testid="motion-play"
          data-playing={playing}
          disabled={!hasItems}
          onClick={togglePlay}
        >
          {playing ? <Pause size={13} /> : <Play size={13} />}
        </IconButton>
        <IconButton
          title="Stop: back to the design state"
          data-testid="motion-stop"
          disabled={!mine || mode === 'rest'}
          onClick={() => motionPreview.stop()}
        >
          <Square size={12} />
        </IconButton>
        <span className="mt-time" data-testid="motion-time" ref={timeRef}>
          {`0.00 / ${seconds(total)} s`}
        </span>
        {!!timeline?.loops && (
          <span
            className="mt-chip mt-loops"
            data-testid="motion-loops"
            title="Animations that loop forever keep playing after the timeline ends"
          >
            <Repeat size={11} /> {timeline.loops}
          </span>
        )}
        {transition && (
          <span
            className="mt-chip"
            data-testid="motion-transition"
            title="Slide transition (entering this frame in a presentation)"
          >
            {transition.preset} · {formatMs(transition.duration)}
          </span>
        )}
        {!!timeline?.warnings.length && (
          <button
            type="button"
            className="mt-chip mt-warn"
            data-testid="motion-warnings"
            aria-expanded={showWarnings}
            onClick={() => setShowWarnings((v) => !v)}
          >
            <AlertTriangle size={11} /> {timeline.warnings.length}
          </button>
        )}
        <span className="mt-spacer" />
        <IconButton
          title="Zoom out (Ctrl+wheel)"
          onClick={() => setZoom((z) => Math.max(MIN_ZOOM, z / 1.3))}
        >
          <ZoomOut size={13} />
        </IconButton>
        <IconButton
          title="Zoom in (Ctrl+wheel)"
          onClick={() => setZoom((z) => Math.min(MAX_ZOOM, z * 1.3))}
        >
          <ZoomIn size={13} />
        </IconButton>
        <IconButton
          title="Close the timeline (M)"
          data-testid="motion-close"
          onClick={() => ui.setMotionOpen(false)}
        >
          <X size={13} />
        </IconButton>
      </header>
      {showWarnings && !!timeline?.warnings.length && (
        <ul className="mt-warnings" data-testid="motion-warning-list">
          {timeline.warnings.map((w, i) => (
            <li key={i}>{w}</li>
          ))}
        </ul>
      )}
      <div className="mt-scroll" ref={scrollRef}>
        {!hasItems ? (
          <div className="mt-empty" data-testid="motion-timeline-empty">
            <strong>
              {frame ? 'Nothing animates in this frame yet.' : 'Add a frame to animate.'}
            </strong>
            <span>
              Select a layer and use <em>Add animation</em> in the Design tab, or ask the agent: it
              can animate layers through the MCP (<code>set_motion</code>). Bars show up here and
              can be dragged to retime them.
            </span>
          </div>
        ) : (
          <div className="mt-inner" style={{ width: NAME_W + trackW }}>
            <div className="mt-ruler" style={{ height: RULER_H }}>
              <div className="mt-corner" style={{ width: NAME_W }}>
                Layers
              </div>
              <div
                ref={trackRef}
                className="mt-ruler-track"
                data-testid="motion-ruler"
                style={{ width: trackW }}
                onPointerDown={onScrubDown}
                onPointerMove={onScrubMove}
                onPointerUp={onScrubUp}
                onPointerCancel={onScrubUp}
              >
                {transition && (
                  <div
                    className="mt-transition"
                    style={{ width: Math.max(4, transition.duration * k) }}
                    title={`Transition ${transition.preset} (${formatMs(transition.duration)})`}
                  />
                )}
                {ticks.map((t) => (
                  <span key={t} className="mt-tick" style={{ left: t * k }}>
                    <i />
                    <b>{t % 1000 === 0 ? `${t / 1000}s` : `${seconds(t)}`}</b>
                  </span>
                ))}
              </div>
            </div>
            <div className="mt-meta" style={{ height: META_H, top: RULER_H }}>
              <div className="mt-corner" style={{ width: NAME_W }}>
                Builds
              </div>
              <div className="mt-meta-track" style={{ width: trackW }}>
                {timeline!.builds.map((b) => (
                  <span
                    key={b.build}
                    className={`mt-band-label${b.click % 2 ? ' odd' : ''}`}
                    style={{ left: b.start * k, width: Math.max(b.duration * k, 0) }}
                    data-testid="motion-build"
                    title={`${b.items} animation${b.items === 1 ? '' : 's'}`}
                  >
                    {b.click === 0 ? 'On start' : `Click ${b.click}`}
                  </span>
                ))}
              </div>
            </div>
            <div
              className="mt-bands"
              style={{ left: NAME_W, top: RULER_H + META_H, width: trackW }}
            >
              {timeline!.builds.map((b) => (
                <div
                  key={b.build}
                  className={`mt-band${b.click % 2 ? ' odd' : ''}`}
                  style={{ left: b.start * k, width: Math.max(b.duration * k, 1) }}
                />
              ))}
            </div>
            {rows.map(([nodeId, row]) => (
              <div
                key={nodeId}
                className={`mt-row${selection.includes(nodeId) ? ' sel' : ''}`}
                data-testid="motion-row-timeline"
                data-node={nodeId}
              >
                <button
                  type="button"
                  className="mt-name"
                  style={{ width: NAME_W }}
                  title={row.name}
                  onClick={() => ui.select([nodeId])}
                >
                  {row.name}
                </button>
                <div className="mt-track" style={{ width: trackW }}>
                  {row.items.map((item) => (
                    <Bar
                      key={`${item.index}:${item.start}:${item.duration}:${item.end}`}
                      item={item}
                      k={k}
                      extent={extent}
                      selected={motionSel?.nodeId === nodeId && motionSel.index === item.index}
                      tip={tip}
                    />
                  ))}
                </div>
              </div>
            ))}
            <div
              className="mt-playhead"
              style={{ left: NAME_W }}
              data-testid="motion-playhead-wrap"
            >
              <div ref={headRef} className="mt-playhead-x" data-testid="motion-playhead">
                <span
                  className="mt-playhead-head"
                  onPointerDown={onScrubDown}
                  onPointerMove={onScrubMove}
                  onPointerUp={onScrubUp}
                  onPointerCancel={onScrubUp}
                />
              </div>
            </div>
          </div>
        )}
      </div>
      <div ref={tipRef} className="mt-tip" />
    </section>
  );
}
