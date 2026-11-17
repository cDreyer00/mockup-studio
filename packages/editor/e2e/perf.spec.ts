import { expect, test } from '@playwright/test';
import { Mcp, createDoc, drag, getDoc, gotoEditor } from './helpers';

/**
 * Performance measurements with ~300 nodes (6 frames × 50). The numbers go to the console and to the test
 * annotations; the limits are loose (they catch gross regressions, not micro-variations).
 */
test('document with 300 nodes: MCP → canvas latency and drag smoothness', async ({ page }) => {
  const info = await createDoc('perf-300');
  const mcp = await new Mcp().init();
  const items = Array.from({ length: 49 }, (_, i) =>
    i % 3 === 0 ? `<p class="t">Text ${i}</p>` : `<div class="c" data-i="${i}"></div>`,
  ).join('');
  for (let f = 0; f < 6; f++) {
    await mcp.call('create_frame', { name: `F${f}`, width: 1440, height: 900, x: f * 1600, y: 0 });
    const frameId = (await getDoc(info.docId)).pages[0]!.frames[f]!.id;
    await mcp.call('write_html', {
      parentId: frameId,
      html: items,
      css: '.t{font-size:16px;color:#222}.c{width:120px;height:40px;background:#eee;border-radius:6px}',
    });
  }
  await mcp.call('update_styles', {
    nodeIds: (await getDoc(info.docId)).pages[0]!.frames.map((f) => f.id),
    styles: { display: 'flex', 'flex-wrap': 'wrap', gap: '12px' },
  });
  const doc = await getDoc(info.docId);
  let count = 0;
  const walk = (n: { children: unknown[] }) => {
    count++;
    (n.children as { children: unknown[] }[]).forEach(walk);
  };
  doc.pages[0]!.frames.forEach(walk);
  expect(count).toBeGreaterThanOrEqual(300);

  await gotoEditor(page);
  const target = doc.pages[0]!.frames[0]!.children[1]!;
  const el = page.getByTestId('canvas-world').locator(`[data-node-id="${target.id}"]`);
  await expect(el).toBeVisible();

  // 1) Latency of an MCP op until the DOM reflects it (includes HTTP, store, WS and re-render).
  const latencies: number[] = [];
  for (let i = 0; i < 10; i++) {
    const width = `${130 + i}px`;
    const t0 = performance.now();
    await mcp.call('update_styles', { nodeIds: [target.id], styles: { width } });
    await expect(el).toHaveCSS('width', width);
    latencies.push(performance.now() - t0);
  }
  const avg = latencies.reduce((a, b) => a + b, 0) / latencies.length;

  // 2) Smoothness: intervals between frames (rAF) while dragging a frame with 50 nodes.
  await page.evaluate(() => {
    const w = window as unknown as { __frames: number[]; __stop: boolean };
    w.__frames = [];
    w.__stop = false;
    let last = performance.now();
    const tick = (t: number) => {
      w.__frames.push(t - last);
      last = t;
      if (!w.__stop) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  const frameId = doc.pages[0]!.frames[0]!.id;
  const label = (await page.getByTestId(`frame-label-${frameId}`).boundingBox())!;
  const from = { x: label.x + 8, y: label.y + label.height / 2 };
  await drag(page, from, { x: from.x + 300, y: from.y + 120 }, { steps: 40 });
  const frames = await page.evaluate(() => {
    const w = window as unknown as { __frames: number[]; __stop: boolean };
    w.__stop = true;
    return w.__frames.slice(1);
  });
  const sorted = [...frames].sort((a, b) => a - b);
  const p95 = sorted[Math.floor(sorted.length * 0.95)] ?? 0;

  const summary = `nodes=${count} MCP→DOM latency avg=${avg.toFixed(1)}ms max=${Math.max(...latencies).toFixed(1)}ms; drag: ${frames.length} frames, p95=${p95.toFixed(1)}ms`;
  console.log(`[perf] ${summary}`);
  test.info().annotations.push({ type: 'perf', description: summary });
  expect(avg).toBeLessThan(250);
  expect(p95).toBeLessThan(100);
});
