import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { frameMotionTimeline, serializeDocument } from '@mockup/core';
import type { Document, Node } from '@mockup/core';
import { E2E_DIR, Mcp, api, createDoc, getDoc, gotoEditor } from './helpers';

/**
 * Motion stress scenario: 12 slides with ~18 animated layers each (character-split titles,
 * staggered cards, springs, blur, loops and click builds), slide transitions on every slide.
 * Measures frame times on the canvas (idle with loops running, panning, timeline preview) and in
 * the presentation, main-thread busy time from Chromium's metrics, MCP latency and file size. The
 * numbers go to the console, the test annotations and `<e2e dir>/motion-perf.json`; the limits are
 * loose (they catch gross regressions).
 */

const FRAMES = 12;
const CARDS = 12;
const TRANSITIONS = [
  { preset: 'push', direction: 'left' },
  { preset: 'cube', direction: 'left' },
  { preset: 'zoom' },
  { preset: 'magic' },
  { preset: 'cover', direction: 'up' },
  { preset: 'blur' },
];

const attr = (v: unknown): string => JSON.stringify(v).replace(/'/g, '&#39;');

function slideHtml(f: number): string {
  const cards = Array.from({ length: CARDS }, (_, i) => {
    const motion: unknown[] = [
      { kind: 'in', preset: i % 4 === 1 ? 'blur' : 'pop', delay: 500 + i * 60 },
    ];
    if (i % 3 === 0) motion.push({ kind: 'emphasis', preset: 'float', delay: 1600 });
    return `<div class="card" data-name="card-${f}-${i}" data-motion='${attr(motion)}'></div>`;
  }).join('');
  const bullets = [1, 2, 3]
    .map(
      (b) =>
        `<li data-name="bullet-${f}-${b}" data-motion='${attr([{ kind: 'in', preset: 'fade-left', build: b }])}'>Point number ${b}</li>`,
    )
    .join('');
  return [
    `<h1 data-name="title-${f}" data-motion='${attr([{ kind: 'in', preset: 'rise', split: 'chars', stagger: 25 }])}'>Motion stress slide ${f + 1}</h1>`,
    `<p data-name="Logo" data-motion='${attr([{ kind: 'in', preset: 'fade-up', delay: 400 }])}'>Dozens of animated layers at sixty frames per second</p>`,
    `<div class="grid" data-name="grid-${f}">${cards}</div>`,
    `<span class="badge" data-name="badge-${f}" data-motion='${attr([
      { kind: 'in', preset: 'pop', delay: 600 },
      { kind: 'emphasis', preset: 'spin' },
    ])}'>★</span>`,
    `<ul class="bullets" data-name="bullets-${f}">${bullets}</ul>`,
  ].join('');
}

const CSS = [
  '.grid{display:grid;grid-template-columns:repeat(6,1fr);gap:16px;width:100%}',
  '.card{height:110px;border-radius:16px;background:linear-gradient(135deg,#6c5ce7,#00b894)}',
  '.badge{position:absolute;right:48px;top:40px;font-size:40px;color:#ffd166}',
  '.bullets{display:flex;gap:32px;font-size:22px;color:#e9ecef}',
].join('');

interface Stats {
  frames: number;
  fps: number;
  p50: number;
  p95: number;
  max: number;
  /** Frames longer than 25 ms (a dropped frame at 60 Hz). */
  long: number;
}

function stats(intervals: number[], ms: number): Stats {
  const sorted = [...intervals].sort((a, b) => a - b);
  const at = (q: number): number =>
    sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))] ?? 0;
  return {
    frames: intervals.length,
    fps: Math.round((intervals.length / ms) * 1000 * 10) / 10,
    p50: Math.round(at(0.5) * 10) / 10,
    p95: Math.round(at(0.95) * 10) / 10,
    max: Math.round((sorted[sorted.length - 1] ?? 0) * 10) / 10,
    long: intervals.filter((d) => d > 25).length,
  };
}

/** Frame intervals (rAF) for `ms`, while `during` runs. */
async function sample(page: Page, ms: number, during?: () => Promise<void>): Promise<Stats> {
  const done = page.evaluate(
    (ms) =>
      new Promise<number[]>((resolve) => {
        const out: number[] = [];
        let last = performance.now();
        const end = last + ms;
        const tick = (t: number): void => {
          out.push(t - last);
          last = t;
          if (t < end) requestAnimationFrame(tick);
          else resolve(out.slice(1));
        };
        requestAnimationFrame(tick);
      }),
    ms,
  );
  if (during) await during();
  return stats(await done, ms);
}

type Cdp = Awaited<ReturnType<ReturnType<Page['context']>['newCDPSession']>>;

async function metrics(cdp: Cdp): Promise<Record<string, number>> {
  const r = (await cdp.send('Performance.getMetrics')) as {
    metrics: { name: string; value: number }[];
  };
  return Object.fromEntries(r.metrics.map((m) => [m.name, m.value]));
}

/** Share of wall time the renderer main thread was busy (Chromium TaskDuration). */
async function mainThread(
  cdp: Cdp,
  ms: number,
  page: Page,
): Promise<{ busy: number; style: number }> {
  const a = await metrics(cdp);
  await page.waitForTimeout(ms);
  const b = await metrics(cdp);
  const wall = (b.Timestamp! - a.Timestamp!) * 1000;
  return {
    busy: Math.round(((b.TaskDuration! - a.TaskDuration!) * 1000 * 1000) / wall) / 10,
    style:
      Math.round(((b.RecalcStyleDuration! - a.RecalcStyleDuration!) * 1000 * 1000) / wall) / 10,
  };
}

function strip(doc: Document): Document {
  const clean = (n: Node): Node => {
    const rest: Node = { ...n, children: n.children.map(clean) };
    delete rest.animations;
    delete rest.slideTransition;
    return rest;
  };
  return { ...doc, pages: doc.pages.map((p) => ({ ...p, frames: p.frames.map(clean) })) };
}

function count(doc: Document): {
  nodes: number;
  animated: number;
  animations: number;
  loops: number;
} {
  let nodes = 0;
  let animated = 0;
  let animations = 0;
  let loops = 0;
  const walk = (n: Node): void => {
    nodes++;
    if (n.animations?.length) {
      animated++;
      animations += n.animations.length;
      loops += n.animations.filter((a) => ['float', 'spin'].includes(a.preset)).length;
    }
    n.children.forEach(walk);
  };
  doc.pages.forEach((p) => p.frames.forEach(walk));
  return { nodes, animated, animations, loops };
}

test('motion stress: hundreds of animations stay fluid on the canvas and in the presentation', async ({
  page,
}) => {
  test.setTimeout(300_000);
  const info = await createDoc('motion-stress');
  const mcp = await new Mcp().init();
  const result: Record<string, unknown> = {};

  // 1) Build the deck through the MCP (HTML with data-motion), timing the writes.
  const writes: number[] = [];
  for (let f = 0; f < FRAMES; f++) {
    await mcp.call('create_frame', {
      name: `Slide ${f + 1}`,
      width: 1280,
      height: 720,
      x: (f % 4) * 1400,
      y: Math.floor(f / 4) * 840,
    });
    const frameId = (await getDoc(info.docId)).pages[0]!.frames[f]!.id;
    await mcp.call('update_styles', {
      nodeIds: [frameId],
      styles: {
        display: 'flex',
        'flex-direction': 'column',
        gap: '28px',
        padding: '56px',
        background: '#11131a',
        color: '#f8f9fa',
        'font-size': '20px',
      },
    });
    const t0 = performance.now();
    await mcp.call('write_html', { parentId: frameId, html: slideHtml(f), css: CSS });
    writes.push(performance.now() - t0);
  }
  let doc = await getDoc(info.docId);
  const frameIds = doc.pages[0]!.frames.map((f) => f.id);
  const t1 = performance.now();
  for (let f = 0; f < FRAMES; f++) {
    await mcp.call('set_slide_transition', {
      frameIds: [frameIds[f]],
      ...TRANSITIONS[f % TRANSITIONS.length],
    });
  }
  const transitionsMs = performance.now() - t1;
  // One batch through `animate`: 12 cards of slide 1 get a pulse on click 4, cascaded.
  doc = await getDoc(info.docId);
  const cards = doc.pages[0]!.frames[0]!.children.find((c) => c.name === 'grid-0')!.children.map(
    (c) => c.id,
  );
  const t2 = performance.now();
  await mcp.call('animate', {
    nodeIds: cards,
    preset: 'pulse',
    kind: 'emphasis',
    build: 4,
    cascade: 40,
    replace: false,
  });
  const animateMs = performance.now() - t2;

  doc = await getDoc(info.docId);
  const counts = count(doc);
  const timeline = frameMotionTimeline(doc.pages[0]!.frames[0]!);
  expect(counts.animated).toBeGreaterThanOrEqual(200);
  await api('/api/save', { docId: info.docId });
  const fileBytes = fs.statSync(info.path!).size;
  const plainBytes = Buffer.byteLength(serializeDocument(strip(doc)));
  const motionBytes = Buffer.byteLength(serializeDocument(doc)) - plainBytes;
  result.document = {
    ...counts,
    slides: FRAMES,
    fileKB: Math.round(fileBytes / 102.4) / 10,
    motionKB: Math.round(motionBytes / 102.4) / 10,
    bytesPerAnimation: Math.round(motionBytes / counts.animations),
    slide1: {
      durationMs: timeline.duration,
      clicks: timeline.clicks,
      items: timeline.items.length,
    },
  };
  result.mcp = {
    writeHtmlAvgMs: Math.round(writes.reduce((a, b) => a + b, 0) / writes.length),
    setSlideTransitionAvgMs: Math.round(transitionsMs / FRAMES),
    animate12NodesMs: Math.round(animateMs),
  };

  // 2) Canvas with every slide in view: loops running (design state) vs paused.
  await gotoEditor(page);
  await expect(page.locator(`[data-node-id="${frameIds[FRAMES - 1]}"]`)).toBeVisible();
  await page.keyboard.press('Shift+1');
  await page.waitForTimeout(800);
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Performance.enable');
  const live = (): Promise<number> =>
    page.evaluate(async () => {
      const url = '/src/motion/preview.ts';
      const m = (await import(/* @vite-ignore */ url)) as {
        canvasMotion: { liveCount(): number };
      };
      return m.canvasMotion.liveCount();
    });
  const idle = await sample(page, 3000);
  const idleMain = await mainThread(cdp, 3000, page);
  const loopsLive = await live();
  await page.keyboard.press('Shift+Space');
  await page.waitForTimeout(300);
  const paused = await sample(page, 2000);
  const pausedMain = await mainThread(cdp, 2000, page);
  await page.keyboard.press('Shift+Space');
  result.canvasIdle = { loopsLive, frames: idle, mainThread: idleMain };
  result.canvasLoopsPaused = { frames: paused, mainThread: pausedMain };

  // 3) Panning across the deck while the loops run (wheel scrolls the canvas).
  const box = (await page.getByTestId('canvas').boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  result.canvasPan = {
    frames: await sample(page, 2500, async () => {
      for (let i = 0; i < 50; i++) {
        await page.mouse.wheel(i < 25 ? 18 : -18, i % 2 ? 6 : -6);
        await page.waitForTimeout(40);
      }
    }),
  };

  // 4) Timeline preview of slide 1 (all builds back to back) through the MCP.
  await mcp.call('preview_motion', { frameId: frameIds[0], action: 'play', time: 0 });
  const previewMs = Math.min(timeline.duration, 6000);
  const previewLive = await live();
  result.preview = {
    timelineMs: timeline.duration,
    liveAnimations: previewLive,
    frames: await sample(page, previewMs),
  };
  await mcp.call('preview_motion', { action: 'stop' });

  // 5) Presentation: builds and transitions (push, cube, zoom, magic...).
  await mcp.call('start_presentation', { frameId: frameIds[0] });
  await expect(page.getByTestId('presentation')).toBeVisible();
  result.presentation = {
    frames: await sample(page, 9000, async () => {
      for (let i = 0; i < 12; i++) {
        await page.waitForTimeout(700);
        await page.keyboard.press('ArrowRight');
      }
    }),
  };
  await mcp.call('stop_presentation', {});

  const summary = JSON.stringify(result, null, 2);
  console.log(`[motion-perf] ${summary}`);
  fs.writeFileSync(path.join(E2E_DIR, 'motion-perf.json'), summary);
  test.info().annotations.push({ type: 'motion-perf', description: JSON.stringify(result) });

  const frames = (k: string): Stats => (result[k] as { frames: Stats }).frames;
  for (const k of ['canvasIdle', 'canvasPan', 'preview', 'presentation']) {
    expect(frames(k).p95, `${k} p95 frame time`).toBeLessThan(50);
  }
});
