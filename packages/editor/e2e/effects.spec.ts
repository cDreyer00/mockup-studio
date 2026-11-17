import { expect, test } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';
import type { Node } from '@mockup/core';
import { Mcp, createDoc, getDoc, gotoEditor } from './helpers';

/** Effects (panel, properties, rendered image), embed by URL and the Three.js island editor. */

async function setup(name: string) {
  const info = await createDoc(name);
  const mcp = await new Mcp().init();
  await mcp.call('create_frame', { name: 'Screen', width: 800, height: 600, x: 0, y: 0 });
  const frame = (await getDoc(info.docId)).pages[0]!.frames[0]!;
  return { info, frame };
}

const frameOf = async (docId: string) => (await getDoc(docId)).pages[0]!.frames[0]!;

const nodeEl = (page: Page, id: string) =>
  page.getByTestId('canvas-world').locator(`[data-node-id="${id}"]`).first();

/** Applies an effect preset as the frame background and returns the created `effect` node. */
async function applyMeshGradient(page: Page, docId: string, frameId: string): Promise<Node> {
  await page.getByTestId(`layer-row-${frameId}`).click();
  await page.getByTestId('effects-button').click();
  await expect(page.getByTestId('effects-panel')).toBeVisible();
  await page.getByTestId('effect-preset-mesh-gradient-sunset').click();
  await expect(page.getByTestId('effects-panel')).toBeHidden();
  await expect
    .poll(async () => (await frameOf(docId)).children.find((c) => c.type === 'effect'))
    .toBeTruthy();
  return (await frameOf(docId)).children.find((c) => c.type === 'effect')!;
}

/** Decodes the PNG in the browser and counts the distinct colors (channels quantized to 4 bits). */
async function distinctColors(page: Page, target: Locator): Promise<number> {
  const png = (await target.screenshot()).toString('base64');
  return page.evaluate(async (b64) => {
    const blob = await (await fetch(`data:image/png;base64,${b64}`)).blob();
    const bmp = await createImageBitmap(blob);
    const cv = document.createElement('canvas');
    cv.width = bmp.width;
    cv.height = bmp.height;
    const ctx = cv.getContext('2d')!;
    ctx.drawImage(bmp, 0, 0);
    const data = ctx.getImageData(0, 0, cv.width, cv.height).data;
    const seen = new Set<number>();
    for (let i = 0; i < data.length; i += 4) {
      seen.add(((data[i]! >> 4) << 8) | ((data[i + 1]! >> 4) << 4) | (data[i + 2]! >> 4));
    }
    return seen.size;
  }, png);
}

test('effects panel: preset as the frame background and parameter slider', async ({ page }) => {
  const { info, frame } = await setup('fx-panel');
  await gotoEditor(page);
  const fx = await applyMeshGradient(page, info.docId, frame.id);

  expect(fx.effect?.kind).toBe('mesh-gradient');
  expect(fx.effect?.params?.color1).toBe('#ff5e62'); // preset "Sunset"
  expect((await frameOf(info.docId)).children[0]!.id).toBe(fx.id); // stays in the background (index 0)
  await expect(page.getByTestId('effect-kind')).toBeVisible(); // Effect section with the node selected

  const slider = page.getByTestId('effect-param-distortion');
  await slider.fill('0.9');
  await expect
    .poll(async () => (await frameOf(info.docId)).children[0]!.effect?.params?.distortion)
    .toBe(0.9);

  // Preset through the chip in the properties section.
  await page.getByTestId('effect-chip-ocean').click();
  await expect
    .poll(async () => (await frameOf(info.docId)).children[0]!.effect?.params?.color1)
    .toBe('#03045e');
});

test('mesh gradient as the frame background renders a non-uniform image', async ({ page }) => {
  const { info, frame } = await setup('fx-pixels');
  await gotoEditor(page);
  const fx = await applyMeshGradient(page, info.docId, frame.id);
  const el = nodeEl(page, fx.id);
  await expect(el).toBeVisible();
  await expect.poll(() => distinctColors(page, el), { timeout: 15_000 }).toBeGreaterThan(8);
});

test('embed by URL dialog: detects the provider and inserts the embed node', async ({ page }) => {
  const { info } = await setup('fx-embed');
  await gotoEditor(page);
  await page.getByTestId('media-button').click();
  await page.getByTestId('media-embed-url').click();
  const dialog = page.getByTestId('embed-dialog');
  await expect(dialog).toBeVisible();
  const input = page.getByTestId('embed-url-input');
  const provider = page.getByTestId('embed-provider');

  await input.fill('https://www.youtube.com/watch?v=dQw4w9WgXcQ');
  await expect(provider).toHaveText('YouTube');
  await input.fill('https://example.com/animation.json');
  await expect(provider).toHaveText('Lottie');
  await input.fill('any text');
  await expect(page.getByTestId('embed-provider-none')).toBeVisible();
  await expect(page.getByTestId('embed-insert')).toBeDisabled();
  await input.fill('https://example.com');
  await expect(provider).toHaveText('Iframe');

  await page.getByTestId('embed-insert').click();
  await expect(dialog).toBeHidden();
  await expect
    .poll(async () => (await frameOf(info.docId)).children.find((c) => c.type === 'embed'))
    .toBeTruthy();
  const embed = (await frameOf(info.docId)).children.find((c) => c.type === 'embed')!;
  expect(embed.embed?.provider).toBe('iframe');
  expect(embed.embed?.url).toBe('https://example.com');
});

test('Three.js island editor: edits the code, shows the preview and saves to the node', async ({
  page,
}) => {
  const { info } = await setup('fx-three');
  await gotoEditor(page);
  await page.getByTestId('media-button').click();
  await page.getByTestId('media-three').click();
  const editor = page.getByTestId('three-editor');
  await expect(editor).toBeVisible();

  const preview = page.getByTestId('three-preview').locator('iframe');
  await expect(preview).toHaveAttribute('sandbox', /allow-scripts/);
  await expect(preview).toHaveAttribute('srcdoc', /.+/);

  await expect
    .poll(async () => (await frameOf(info.docId)).children.find((c) => c.type === 'embed'))
    .toBeTruthy();
  const before = (await frameOf(info.docId)).children.find((c) => c.type === 'embed')!;
  expect(before.embed?.provider).toBe('three');
  const oldCode = before.embed!.code!;

  const marker = '/* e2e-color: 0xff0000 */\n';
  await page.locator('[data-testid="three-code"] .cm-content').click();
  await page.keyboard.press('Control+Home');
  await page.keyboard.type(marker);
  // The preview reloads with the new code (debounce) and now contains the marker.
  await expect(preview).toHaveAttribute('srcdoc', /e2e-color: 0xff0000/);

  await page.getByTestId('three-apply').click();
  await expect(editor).toBeHidden();
  await expect
    .poll(
      async () => (await frameOf(info.docId)).children.find((c) => c.type === 'embed')?.embed?.code,
    )
    .toContain('e2e-color: 0xff0000');
  const after = (await frameOf(info.docId)).children.find((c) => c.type === 'embed')!;
  expect(after.embed!.code!.length).toBeGreaterThan(oldCode.length);
});
