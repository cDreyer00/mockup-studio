import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { Mcp, createDoc, findByName, getDoc, gotoEditor } from './helpers';

/**
 * Builds a deck: one root frame per entry (600x400, side by side), replaced with the given HTML
 * (a single root element; `data-motion` / `data-motion-transition` are read by write_html).
 */
async function deck(name: string, slides: string[]) {
  const info = await createDoc(name);
  const mcp = await new Mcp().init();
  for (const [i, html] of slides.entries()) {
    await mcp.call('create_frame', {
      name: `Slide ${i + 1}`,
      width: 600,
      height: 400,
      x: i * 700,
      y: 0,
    });
    const doc = await getDoc(info.docId);
    await mcp.call('write_html', {
      parentId: doc.pages[0]!.frames[i]!.id,
      mode: 'replace',
      html,
    });
  }
  return { info, mcp, doc: await getDoc(info.docId) };
}

const slideHtml = (
  label: string,
  opts: { transition?: object; inner?: string; bg?: string } = {},
): string =>
  `<div data-name="${label}" ${
    opts.transition ? `data-motion-transition='${JSON.stringify(opts.transition)}'` : ''
  } style="position:relative;width:600px;height:400px;background:${opts.bg ?? '#fff'};font-family:sans-serif">${
    opts.inner ?? ''
  }<h1 style="margin:0;padding:24px;font-size:36px">${label}</h1></div>`;

const counter = (page: Page) => page.getByTestId('presentation-counter');
const slots = (page: Page) => page.locator('.pres-slot');

async function present(page: Page): Promise<void> {
  await gotoEditor(page);
  await expect(page.locator('[data-testid^="frame-label-"]')).toHaveCount(3);
  await page.getByTestId('present-button').click();
  await expect(page.getByTestId('presentation')).toBeVisible();
}

const opacityOf = (page: Page, id: string) =>
  page
    .locator(`[data-testid="presentation-slide"] [data-node-id="${id}"]`)
    .evaluate((e) => getComputedStyle(e).opacity);

test('builds play on click, slides push in, back undoes builds then slides', async ({ page }) => {
  const box =
    `<div data-name="Box" data-motion='[{"kind":"in","preset":"fade-up","build":1,"duration":300}]' ` +
    `style="position:absolute;left:300px;top:200px;width:100px;height:100px;background:#e11"></div>`;
  const { doc } = await deck('motion-builds', [
    slideHtml('One', { inner: box }),
    slideHtml('Two', { transition: { preset: 'push', direction: 'left', duration: 800 } }),
    slideHtml('Three'),
  ]);
  const boxId = findByName(doc, 'Box')!.id;
  await present(page);
  await expect(counter(page)).toContainText('1 / 3');
  await expect(page.getByTestId('presentation-builds')).toContainText('0/1');
  await expect.poll(() => opacityOf(page, boxId)).toBe('0');

  // First click: the build plays, the slide stays.
  await page.keyboard.press('ArrowRight');
  await expect(counter(page)).toContainText('1 / 3');
  await expect(page.getByTestId('presentation-builds')).toContainText('1/1');
  await expect.poll(() => opacityOf(page, boxId)).toBe('1');

  // Second click: push to slide 2 (two slots while it runs, one after).
  await page.keyboard.press('ArrowRight');
  await expect(counter(page)).toContainText('2 / 3');
  await expect(slots(page)).toHaveCount(2);
  await expect(slots(page)).toHaveCount(1, { timeout: 5000 });

  // Back: slide 1 with all its builds played; then one build less (instant); then nothing more.
  await page.keyboard.press('ArrowLeft');
  await expect(counter(page)).toContainText('1 / 3');
  await expect(page.getByTestId('presentation-builds')).toContainText('1/1');
  await expect(slots(page)).toHaveCount(1, { timeout: 5000 });
  await expect.poll(() => opacityOf(page, boxId)).toBe('1');
  await page.keyboard.press('ArrowLeft');
  await expect(page.getByTestId('presentation-builds')).toContainText('0/1');
  await expect.poll(() => opacityOf(page, boxId)).toBe('0');
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('presentation')).toHaveCount(0);
});

test('navigating during a transition finishes it and lands on the right slide', async ({
  page,
}) => {
  await deck('motion-fast', [
    slideHtml('One'),
    slideHtml('Two', { transition: { preset: 'push', direction: 'left', duration: 3000 } }),
    slideHtml('Three', { transition: { preset: 'push', direction: 'left', duration: 3000 } }),
  ]);
  await present(page);
  await page.keyboard.press('ArrowRight');
  await expect(slots(page)).toHaveCount(2);
  await page.keyboard.press('ArrowRight');
  await expect(counter(page)).toContainText('3 / 3');
  await expect(slots(page)).toHaveCount(2);
  await page.keyboard.press('End');
  await expect(counter(page)).toContainText('3 / 3');
});

test('magic move: the layer named Logo morphs to its new place', async ({ page }) => {
  const logo = (x: number, y: number, size: number) =>
    `<div data-name="Logo" style="position:absolute;left:${x}px;top:${y}px;width:${size}px;height:${size}px;background:#36f"></div>`;
  const { doc } = await deck('motion-magic', [
    slideHtml('One', { inner: logo(40, 300, 40) }),
    slideHtml('Two', {
      transition: { preset: 'magic', duration: 1500 },
      inner: logo(400, 60, 120),
    }),
    slideHtml('Three'),
  ]);
  const logoNew = doc.pages[0]!.frames[1]!.children.find((c) => c.name === 'Logo')!.id;
  await present(page);
  await page.keyboard.press('ArrowRight');
  await expect(counter(page)).toContainText('2 / 3');
  // While it runs: ghosts above the slots, the real Logo hidden.
  await expect(page.locator('.pres-ghost-slot')).toHaveCount(1);
  await expect(slots(page)).toHaveCount(2);
  const mid = await page
    .locator('.pres-ghost-slot [style*="position: absolute"]')
    .first()
    .boundingBox();
  expect(mid).not.toBeNull();
  // Done: the ghosts are gone and the real Logo sits at the new place (400/600 of the slide width).
  await expect(page.locator('.pres-ghost-slot')).toHaveCount(0, { timeout: 6000 });
  await expect(slots(page)).toHaveCount(1);
  const frame = page.getByTestId('presentation-slide').locator('[data-node-id]').first();
  const fb = (await frame.boundingBox())!;
  const lb = (await page
    .locator(`[data-testid="presentation-slide"] [data-node-id="${logoNew}"]`)
    .boundingBox())!;
  expect((lb.x - fb.x) / fb.width).toBeCloseTo(400 / 600, 1);
  expect((lb.y - fb.y) / fb.height).toBeCloseTo(60 / 400, 1);
  // Going back plays the morph the other way and ends with the Logo at its old place.
  await page.keyboard.press('ArrowLeft');
  await expect(counter(page)).toContainText('1 / 3');
  await expect(page.locator('.pres-ghost-slot')).toHaveCount(0, { timeout: 6000 });
  await expect(slots(page)).toHaveCount(1);
});
