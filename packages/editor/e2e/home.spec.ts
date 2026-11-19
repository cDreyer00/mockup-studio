import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { E2E_DIR, Mcp, api, createDoc, getDoc, gotoEditor } from './helpers';

const nameOf = (file: string): string => path.basename(file).replace(/\.mockup\.json$/i, '');
const card = (page: Page, file: string) =>
  page.getByTestId('file-card').filter({ has: page.getByText(nameOf(file), { exact: true }) });

async function listedPaths(): Promise<string[]> {
  const r = await api<{ files: { path: string }[] }>('/api/files');
  return r.files.map((f) => path.resolve(f.path).toLowerCase());
}

/** Opens the editor on the home screen (it shows by itself when nothing is open). */
async function gotoHome(page: Page): Promise<void> {
  await page.goto('/');
  const home = page.getByTestId('home-screen');
  await expect(page.getByTestId('home-button').or(home).first()).toBeVisible();
  if (!(await home.isVisible())) await page.getByTestId('home-button').click();
  await expect(home).toBeVisible();
  await page.getByTestId('home-nav-all').click();
  // the list loaded: either cards or the empty state
  await expect(
    page.getByTestId('file-card').or(page.getByTestId('home-empty')).first(),
  ).toBeVisible();
}

test('Remove from index closes the document and the card stays gone after a reload', async ({
  page,
}) => {
  const info = await createDoc('home-forget');
  const file = info.path!;
  await gotoEditor(page);
  await page.getByTestId('home-button').click();
  await expect(card(page, file)).toBeVisible();

  await card(page, file).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Remove from index' }).click();
  await expect(page.getByRole('status')).toContainText('removed from the index');
  await expect(card(page, file)).toHaveCount(0);

  await gotoHome(page);
  await expect(card(page, file)).toHaveCount(0);
  expect(await listedPaths()).not.toContain(path.resolve(file).toLowerCase());
  const docs = await api<{ documents: { path: string | null }[] }>('/api/docs');
  expect(docs.documents.map((d) => d.path)).not.toContain(file);
  // the file itself is untouched
  expect(fs.existsSync(file)).toBe(true);
});

test('Delete file removes the card, the file and its exclusive asset', async ({ page }) => {
  const info = await createDoc('home-delete');
  const file = info.path!;
  const assetName = `${nameOf(file)}.png`;
  const assetFile = path.join(E2E_DIR, 'assets', assetName);
  fs.mkdirSync(path.dirname(assetFile), { recursive: true });
  // 1x1 transparent PNG
  fs.writeFileSync(
    assetFile,
    Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
      'base64',
    ),
  );
  const mcp = await new Mcp().init();
  await mcp.call('create_frame', { name: 'Frame', width: 200, height: 200, x: 0, y: 0 });
  const frame = (await getDoc(info.docId)).pages[0]!.frames[0]!;
  await mcp.call('write_html', { parentId: frame.id, html: `<img src="assets/${assetName}">` });
  await mcp.call('save_document', { docId: info.docId });
  expect(fs.readFileSync(file, 'utf8')).toContain(`assets/${assetName}`);

  await gotoEditor(page);
  await page.getByTestId('home-button').click();
  await expect(card(page, file)).toBeVisible();

  // Delete on the focused card asks first; Esc cancels and nothing is removed
  await card(page, file).focus();
  await page.keyboard.press('Delete');
  const dialog = page.getByRole('dialog', { name: 'Delete file' });
  await expect(dialog).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  expect(fs.existsSync(file)).toBe(true);

  await card(page, file).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Delete file…' }).click();
  await expect(dialog).toBeVisible();
  const message = page.getByTestId('home-delete-message');
  await expect(message).toContainText(path.basename(file));
  await expect(message).toContainText(assetName);
  await expect(message).toContainText('it will be closed first');
  await expect(message).toContainText('deleted permanently');
  await dialog.getByRole('button', { name: 'Delete permanently' }).click();

  await expect(page.getByRole('status')).toHaveText(`"${nameOf(file)}" deleted`);
  await expect(card(page, file)).toHaveCount(0);
  expect(fs.existsSync(file)).toBe(false);
  expect(fs.existsSync(assetFile)).toBe(false);

  await gotoHome(page);
  await expect(card(page, file)).toHaveCount(0);
  expect(await listedPaths()).not.toContain(path.resolve(file).toLowerCase());
});
