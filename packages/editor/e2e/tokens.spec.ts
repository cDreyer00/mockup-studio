import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { Mcp, createDoc, getDoc, gotoEditor } from './helpers';

/** Tokens and themes panel: create/edit/rename, theme with override, bind to token and switch the frame theme. */

async function setup(name: string) {
  const info = await createDoc(name);
  const mcp = await new Mcp().init();
  await mcp.call('create_frame', { name: 'Screen', width: 600, height: 400, x: 0, y: 0 });
  await mcp.call('write_html', {
    html: '<section class="wrap"><div class="box">A</div></section>',
    css: '.wrap{padding:20px;width:500px;height:300px}.box{width:100px;height:60px}',
  });
  const frame = (await getDoc(info.docId)).pages[0]!.frames[0]!;
  return { info, frame };
}

const nodeEl = (page: Page, id: string) =>
  page.getByTestId('canvas-world').locator(`[data-node-id="${id}"]`).first();

const bgOf = (page: Page, id: string) =>
  nodeEl(page, id).evaluate((el) => getComputedStyle(el).backgroundColor);

async function createToken(page: Page, name: string, value: string) {
  await page.getByTestId('tokens-add').click();
  await page.getByTestId('new-token-name').fill(name);
  await page.getByTestId('new-token-value').fill(value);
  await page.getByTestId('new-token-submit').click();
}

async function editValue(page: Page, slug: string, value: string) {
  const row = page.getByTestId(`token-row-${slug}`);
  await row.getByTestId(`token-value-${slug}`).click();
  const input = row.getByTestId('token-value-input');
  await input.fill(value);
  await input.press('Enter');
}

test('tokens and themes: create, edit, rename, theme with override and frame theme switch', async ({
  page,
}) => {
  const { info, frame } = await setup('tokens');
  await gotoEditor(page);

  // Tokens tab.
  await page.getByTestId('tab-tokens').click();
  await expect(page.getByTestId('tokens-panel')).toBeVisible();

  // Create a color token and edit the value.
  await createToken(page, 'color-surface', '#ffffff');
  const row = page.getByTestId('token-row-color-surface');
  await expect(row).toBeVisible();
  await expect
    .poll(async () => (await getDoc(info.docId)).tokens['--color-surface'])
    .toBe('#ffffff');
  await editValue(page, 'color-surface', '#eeeeee');
  await expect
    .poll(async () => (await getDoc(info.docId)).tokens['--color-surface'])
    .toBe('#eeeeee');

  // An invalid value is blocked with a message.
  await row.getByTestId('token-value-color-surface').click();
  await row.getByTestId('token-value-input').fill('rgb(1,2');
  await row.getByTestId('token-value-input').press('Enter');
  await expect(row.getByTestId('inline-error')).toBeVisible();
  await row.getByTestId('token-value-input').press('Escape');
  expect((await getDoc(info.docId)).tokens['--color-surface']).toBe('#eeeeee');

  // Rename (double-click on the name).
  await row.getByTestId('token-name-color-surface').dblclick();
  await row.getByTestId('token-name-input').fill('color-bg');
  await row.getByTestId('token-name-input').press('Enter');
  await expect(page.getByTestId('token-row-color-bg')).toBeVisible();
  await expect
    .poll(async () => Object.keys((await getDoc(info.docId)).tokens))
    .toContain('--color-bg');

  // Create the dark theme and override the token in it.
  await page.getByTestId('tokens-theme-add').click();
  const dialog = page.getByRole('dialog', { name: 'New theme' });
  await dialog.locator('input[name="name"]').fill('dark');
  await dialog.locator('input[name="name"]').press('Enter');
  await expect(page.getByTestId('tokens-theme-select')).toHaveValue('dark');
  await editValue(page, 'color-bg', '#111111');
  await expect(page.getByTestId('token-override-color-bg')).toBeVisible();
  await expect
    .poll(async () => (await getDoc(info.docId)).themes?.[0]?.overrides['--color-bg'])
    .toBe('#111111');
  // The base did not change.
  expect((await getDoc(info.docId)).tokens['--color-bg']).toBe('#eeeeee');
  await page.getByTestId('tokens-theme-select').selectOption('');

  // Bind the frame background to the token through the properties panel selector.
  await page.getByTestId('tab-layers').click();
  await page.getByTestId(`layer-row-${frame.id}`).click();
  await page.locator('.prop-bg [data-testid="token-bind"]').click();
  await page.getByTestId('token-option-color-bg').click();
  await expect
    .poll(async () => (await getDoc(info.docId)).pages[0]!.frames[0]!.style.background)
    .toBe('var(--color-bg)');
  await expect(page.getByTestId('token-chip-name')).toHaveText('--color-bg');
  await expect(page.getByTestId('token-chip-value')).toHaveText('#eeeeee');
  await expect.poll(() => bgOf(page, frame.id)).toBe('rgb(238, 238, 238)');

  // Switch the frame theme: the canvas now uses the override.
  await page.locator('[data-testid="prop-theme"] select').selectOption('dark');
  await expect
    .poll(async () => (await getDoc(info.docId)).pages[0]!.frames[0]!.attrs['data-theme'])
    .toBe('dark');
  await expect(nodeEl(page, frame.id)).toHaveAttribute('data-theme', 'dark');
  await expect.poll(() => bgOf(page, frame.id)).toBe('rgb(17, 17, 17)');
  await expect(page.getByTestId('token-chip-value')).toHaveText('#111111');

  // Back to the default (base).
  await page.locator('[data-testid="prop-theme"] select').selectOption('');
  await expect.poll(() => bgOf(page, frame.id)).toBe('rgb(238, 238, 238)');

  // Unbinding from the token writes the resolved value.
  await page.getByTestId('token-unbind').click();
  await expect
    .poll(async () => (await getDoc(info.docId)).pages[0]!.frames[0]!.style.background)
    .toBe('#eeeeee');
});

test('tokens: unused and broken reference warnings; document summary', async ({ page }) => {
  const { info } = await setup('tokens-warnings');
  await gotoEditor(page);
  await page.getByTestId('tab-tokens').click();

  await createToken(page, 'space-loose', '8px');
  await expect(page.getByTestId('token-unused-space-loose')).toBeVisible();

  // A reference to a nonexistent token is accepted (warning) and shows up as a problem with the message.
  await createToken(page, 'color-ref', 'var(--does-not-exist)');
  const problem = page.getByTestId('token-problem-color-ref');
  await expect(problem).toBeVisible();
  await expect(problem).toHaveAttribute('title', /does-not-exist/);
  await expect(page.getByTestId('tokens-footer')).toBeVisible();
  await expect.poll(async () => Object.keys((await getDoc(info.docId)).tokens).length).toBe(2);

  // Search and delete.
  await page.getByTestId('tokens-search').fill('loose');
  await expect(page.getByTestId('token-row-color-ref')).toHaveCount(0);
  await page.getByTestId('token-menu-space-loose').click();
  await page.getByTestId('token-delete-space-loose').click();
  await expect(page.getByTestId('token-row-space-loose')).toHaveCount(0);

  // With no selection, the properties panel shows the summary and opens the Tokens tab.
  await page.getByTestId('tab-layers').click();
  await page.keyboard.press('Escape');
  await page.getByTestId('canvas').click({ position: { x: 5, y: 5 } });
  await expect(page.getByTestId('tokens-summary')).toContainText('1 token');
  await expect(page.getByTestId('tokens-summary-broken')).toBeVisible();
  await page.getByTestId('open-tokens').click();
  await expect(page.getByTestId('tokens-panel')).toBeVisible();
});

test('tokens: import CSS and export', async ({ page }) => {
  const { info } = await setup('tokens-io');
  await gotoEditor(page);
  await page.getByTestId('tab-tokens').click();

  await page.getByTestId('tokens-import').click();
  await page
    .getByTestId('tokens-import-text')
    .fill(
      ':root { --color-brand: #ff00aa; --space-1: 4px; }\n[data-theme="dark"] { --color-brand: #aa00ff; }',
    );
  await expect(page.getByTestId('tokens-import-info')).toContainText('2 tokens');
  await page.getByTestId('tokens-import-confirm').click();
  await expect.poll(async () => (await getDoc(info.docId)).tokens['--color-brand']).toBe('#ff00aa');
  expect((await getDoc(info.docId)).themes?.map((t) => t.name)).toEqual(['dark']);

  await page.getByTestId('tokens-export').click();
  await expect(page.getByTestId('tokens-export-text')).toHaveValue(/--color-brand: #ff00aa/);
  await page.getByTestId('tokens-export-format').selectOption('json');
  await expect(page.getByTestId('tokens-export-text')).toHaveValue(/\$value/);
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('tokens-export-dialog')).toHaveCount(0);
});
