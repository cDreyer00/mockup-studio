import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import type { Document } from '@mockup/core';
import { Mcp, createDoc, getDoc } from './helpers';

/**
 * Frame render (the same `/render.html` page the desktop app uses for screenshots):
 * switching the frame's `data-theme` must change what is painted.
 */

/** Renders the frame in the render page, as the Electron main process does. */
async function renderFrame(page: Page, doc: Document, docId: string, nodeId: string) {
  await page.waitForFunction(() => window.__mockupRenderReady === true);
  await page.evaluate((p) => window.__mockupRender!.render(p), { doc, docId, nodeId });
  const frame = page.locator(`[data-node-id="${nodeId}"]`).first();
  const bg = await frame.evaluate((el) => getComputedStyle(el).backgroundColor);
  const png = await page.screenshot({ clip: { x: 0, y: 0, width: 200, height: 120 } });
  return { bg, png };
}

test('frame render changes when the theme (data-theme) is switched', async ({ page }) => {
  const info = await createDoc('theme-render');
  const mcp = await new Mcp().init();
  await mcp.call('create_frame', { name: 'Screen', width: 300, height: 200, x: 0, y: 0 });
  await mcp.call('set_tokens', { tokens: { '--bg': '#ffffff' } });
  await mcp.call('create_theme', { name: 'dark', overrides: { '--bg': '#000000' } });
  const frameId = (await getDoc(info.docId)).pages[0]!.frames[0]!.id;
  await mcp.call('update_styles', { nodeIds: [frameId], styles: { background: 'var(--bg)' } });

  await page.setViewportSize({ width: 300, height: 200 });
  await page.goto('/render.html');

  const light = await renderFrame(page, await getDoc(info.docId), info.docId, frameId);
  expect(light.bg).toBe('rgb(255, 255, 255)');

  await mcp.call('set_frame_theme', { nodeIds: [frameId], theme: 'dark' });
  const themed = await getDoc(info.docId);
  expect(themed.pages[0]!.frames[0]!.attrs?.['data-theme']).toBe('dark');
  const dark = await renderFrame(page, themed, info.docId, frameId);
  expect(dark.bg).toBe('rgb(0, 0, 0)');
  expect(dark.png.equals(light.png)).toBe(false);

  // going back to the base theme restores the original render
  await mcp.call('set_frame_theme', { nodeIds: [frameId], theme: null });
  const back = await renderFrame(page, await getDoc(info.docId), info.docId, frameId);
  expect(back.bg).toBe('rgb(255, 255, 255)');
  expect(back.png.equals(light.png)).toBe(true);
});
