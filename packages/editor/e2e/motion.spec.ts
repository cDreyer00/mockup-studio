import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { Mcp, createDoc, getDoc, gotoEditor } from './helpers';

/** Motion design: Animation section, preset picker, timeline panel (scrub, play, retime) and undo. */

async function setup(name: string) {
  const info = await createDoc(name);
  const mcp = await new Mcp().init();
  await mcp.call('create_frame', { name: 'Screen', width: 800, height: 600, x: 0, y: 0 });
  await mcp.call('write_html', {
    html: '<p class="t">Hello motion</p>',
    css: '.t{margin:0;font-size:32px;color:#222}',
  });
  const frame = (await getDoc(info.docId)).pages[0]!.frames[0]!;
  const text = frame.children[0]!;
  return { info, mcp, frame, text };
}

const nodeEl = (page: Page, id: string) =>
  page.getByTestId('canvas-world').locator(`[data-node-id="${id}"]`).first();

const opacity = (page: Page, id: string) =>
  nodeEl(page, id).evaluate((el) => Number(getComputedStyle(el).opacity));

test('animate a text: picker, timeline scrub/play, retime and undo', async ({ page }) => {
  const { info, frame, text } = await setup('motion');
  const animations = async () =>
    (await getDoc(info.docId)).pages[0]!.frames[0]!.children[0]!.animations;
  await gotoEditor(page);

  await page.getByTestId('tab-layers').click();
  await page.getByTestId(`layer-row-${text.id}`).click();

  // Add through the picker.
  await page.getByTestId('motion-add').click();
  await expect(page.getByTestId('motion-picker')).toBeVisible();
  await page.getByTestId('motion-preset-fade-up').click();
  await expect(page.getByTestId('motion-picker')).toBeHidden();
  await expect.poll(animations).toEqual([{ kind: 'in', preset: 'fade-up' }]);
  await expect(page.getByTestId('motion-row')).toHaveCount(1);

  // Timeline: bar + scrub.
  await page.getByTestId('motion-toggle').click();
  await expect(page.getByTestId('motion-timeline')).toBeVisible();
  await expect(page.getByTestId('motion-bar')).toHaveCount(1);
  const ruler = (await page.getByTestId('motion-ruler').boundingBox())!;
  await page.mouse.click(ruler.x, ruler.y + 12);
  await expect.poll(() => opacity(page, text.id)).toBeLessThan(0.05);
  await page.mouse.click(ruler.x + 300, ruler.y + 12);
  await expect.poll(() => opacity(page, text.id)).toBeGreaterThan(0.95);

  // Play to the end.
  await page.getByTestId('motion-stop').click();
  await page.getByTestId('motion-play').click();
  await expect(page.getByTestId('motion-play')).toHaveAttribute('data-playing', 'true');
  await expect(page.getByTestId('motion-play')).toHaveAttribute('data-playing', 'false', {
    timeout: 5000,
  });
  await expect.poll(() => opacity(page, text.id)).toBeGreaterThan(0.95);

  // Retime through the panel, then undo.
  await page.getByTestId('motion-row-toggle').click();
  const delay = page.locator('[data-testid=motion-delay] input');
  if (!(await delay.isVisible())) await page.getByTestId('motion-row-toggle').click();
  await delay.fill('250');
  await delay.press('Enter');
  await expect.poll(animations).toEqual([{ kind: 'in', preset: 'fade-up', delay: 250 }]);
  await page.keyboard.press('Control+z');
  await expect.poll(animations).toEqual([{ kind: 'in', preset: 'fade-up' }]);

  // Closing the timeline goes back to the design state.
  await page.getByTestId('motion-close').click();
  await expect(page.getByTestId('motion-timeline')).toBeHidden();
  await expect.poll(() => opacity(page, text.id)).toBeGreaterThan(0.95);
  expect(frame.id).toBeTruthy();
});

test('seeded animations show in the timeline and the M shortcut toggles it', async ({ page }) => {
  const info = await createDoc('motion-seed');
  const mcp = await new Mcp().init();
  await mcp.call('create_frame', { name: 'Screen', width: 800, height: 600, x: 0, y: 0 });
  await mcp.call('write_html', {
    html: `<p class="t" data-motion='[{"kind":"in","preset":"fade-up"}]'>Seeded</p>`,
    css: '.t{margin:0;font-size:32px}',
  });
  const text = (await getDoc(info.docId)).pages[0]!.frames[0]!.children[0]!;
  expect(text.animations).toHaveLength(1);
  await gotoEditor(page);
  await page.getByTestId('tab-layers').click();
  await page.getByTestId(`layer-row-${text.id}`).click();
  await page.keyboard.press('m');
  await expect(page.getByTestId('motion-bar')).toHaveCount(1);
  await page.keyboard.press('m');
  await expect(page.getByTestId('motion-timeline')).toBeHidden();
});
