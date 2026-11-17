import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import type { Node } from '@mockup/core';
import { Mcp, createDoc, findByName, getDoc, gotoEditor } from './helpers';

/**
 * Tailwind nativo no editor: markup real do shadcn/ui vira estilo no canvas (tokens resolvidos),
 * prévia de estado, edição das classes e "mostrar como Tailwind". O daemon do e2e não tem página
 * de render, então tudo é conferido pelo DOM/estilo computado do canvas.
 */

const BUTTON =
  '<button data-slot="button" class="inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium transition-all bg-primary text-primary-foreground hover:bg-primary/90 h-9 px-4 py-2">Salvar</button>';

const CARD = `<div data-slot="card" class="bg-card text-card-foreground flex flex-col gap-6 rounded-xl border py-6 shadow-sm">
  <div data-slot="card-header" class="px-6"><div data-slot="card-title" class="font-semibold leading-none">Plano Pro</div></div>
  <div data-slot="card-content" class="px-6">${BUTTON}</div>
</div>`;

const nodeEl = (page: Page, id: string) =>
  page.getByTestId('canvas-world').locator(`[data-node-id="${id}"]`).first();

const computed = (page: Page, id: string, prop: string) =>
  nodeEl(page, id).evaluate((el, p) => getComputedStyle(el).getPropertyValue(p), prop);

async function setup(page: Page): Promise<{ docId: string; button: Node; card: Node; mcp: Mcp }> {
  const info = await createDoc('tailwind');
  const mcp = await new Mcp().init();
  await mcp.call('set_tokens', {
    tokens: {
      'color-primary': '#18181b',
      'color-primary-foreground': '#fafafa',
      'color-card': '#ffffff',
      'color-card-foreground': '#09090b',
      'color-border': '#e4e4e7',
      'radius-md': '6px',
      'radius-xl': '14px',
    },
  });
  await mcp.call('create_frame', { name: 'Tela', width: 800, height: 500, x: 0, y: 0 });
  await mcp.call('write_html', { html: CARD });
  const doc = await getDoc(info.docId);
  const button = findByName(doc, 'Button');
  const card = findByName(doc, 'Card');
  if (!button || !card) throw new Error('write_html não criou o card/botão do shadcn');
  await gotoEditor(page);
  await expect(nodeEl(page, button.id)).toBeVisible();
  return { docId: info.docId, button, card, mcp };
}

test('botão e card do shadcn/ui no canvas: altura, raio e cor vêm dos tokens', async ({ page }) => {
  const { button, card } = await setup(page);
  await expect.poll(() => computed(page, button.id, 'height')).toBe('36px');
  await expect.poll(() => computed(page, button.id, 'border-top-left-radius')).toBe('6px');
  await expect.poll(() => computed(page, button.id, 'background-color')).toBe('rgb(24, 24, 27)');
  await expect.poll(() => computed(page, card.id, 'border-top-width')).toBe('1px');
  await expect.poll(() => computed(page, card.id, 'border-top-left-radius')).toBe('14px');
});

test('prévia "hover" troca o fundo do botão e "Nenhum" volta', async ({ page }) => {
  const { button } = await setup(page);
  await expect.poll(() => computed(page, button.id, 'background-color')).toBe('rgb(24, 24, 27)');
  await page.getByTestId('preview-state').selectOption('hover');
  await expect
    .poll(() => computed(page, button.id, 'background-color'))
    .not.toBe('rgb(24, 24, 27)');
  await page.getByTestId('preview-state').selectOption('');
  await expect.poll(() => computed(page, button.id, 'background-color')).toBe('rgb(24, 24, 27)');
});

test('prévia "dark" troca os tokens para os do tema dark e "Nenhum" volta', async ({ page }) => {
  const { button, mcp } = await setup(page);
  await mcp.call('create_theme', {
    name: 'dark',
    overrides: { '--color-primary': '#fafafa', '--color-primary-foreground': '#18181b' },
  });
  await expect.poll(() => computed(page, button.id, 'background-color')).toBe('rgb(24, 24, 27)');
  await page.getByTestId('preview-state').selectOption('dark');
  await expect.poll(() => computed(page, button.id, 'background-color')).toBe('rgb(250, 250, 250)');
  await page.getByTestId('preview-state').selectOption('');
  await expect.poll(() => computed(page, button.id, 'background-color')).toBe('rgb(24, 24, 27)');
});

test('editar o campo de classes (px-4 → px-8) muda o canvas e o documento', async ({ page }) => {
  const { docId, button, mcp } = await setup(page);
  await mcp.call('set_selection', { nodeIds: [button.id] });
  const field = page.getByTestId('prop-classes');
  await expect(field).toBeVisible();
  await expect(field).toHaveValue(/\bpx-4\b/);
  const before = await field.inputValue();

  await field.fill(before.replace(/\bpx-4\b/, 'px-8'));
  await field.press('Enter');

  await expect.poll(() => computed(page, button.id, 'padding-left')).toBe('32px');
  const node = findByName(await getDoc(docId), 'Button')!;
  expect(node.classes).toContain('px-8');
  expect(node.classes).not.toContain('px-4');
  expect(JSON.stringify(node.style)).toContain('2rem');
  // O estado hover continua no nó depois de reaplicar as classes.
  expect(node.states?.hover).toBeTruthy();
  await expect(field).toHaveValue(/\bpx-8\b/);
});

test('"Mostrar como Tailwind" exibe as classes e a lista de estados do nó', async ({ page }) => {
  const { button, mcp } = await setup(page);
  await mcp.call('set_selection', { nodeIds: [button.id] });
  await expect(page.getByTestId('prop-classes')).toBeVisible();
  await page.getByTestId('classes-as-tailwind-toggle').check();
  const text = page.getByTestId('classes-as-tailwind-text');
  await expect(text).toContainText('h-9');
  await expect(text).toContainText('px-4');
  await expect(text).toContainText('hover:bg-primary/90');
  await expect(page.getByTestId('state-row-hover')).toBeVisible();

  // Remover o estado hover tira o hover do documento.
  await page.getByTestId('state-remove-hover').click();
  await expect(page.getByTestId('state-row-hover')).toHaveCount(0);
});

test('autocomplete mostra o CSS da classe destacada', async ({ page }) => {
  const { button, mcp } = await setup(page);
  await mcp.call('set_selection', { nodeIds: [button.id] });
  const field = page.getByTestId('prop-classes');
  await field.fill('rounded-');
  await expect(page.getByTestId('classes-suggestions')).toBeVisible();
  await field.press('ArrowDown');
  await expect(page.getByTestId('classes-css')).toContainText('border-radius');
  await field.press('Escape');
  await field.press('Escape');
});

test('CSS base do documento: o seletor liga o preflight do Tailwind', async ({ page }) => {
  const { docId, mcp } = await setup(page);
  await mcp.call('set_selection', { nodeIds: [] });
  await expect(page.getByTestId('css-base')).toBeVisible();
  // write_html com classes Tailwind já ligou o preflight; troca para o padrão e volta.
  await page.getByTestId('css-base').selectOption('default');
  await expect.poll(async () => (await getDoc(docId)).cssBase).toBeUndefined();
  await page.getByTestId('css-base').selectOption('tailwind');
  await expect.poll(async () => (await getDoc(docId)).cssBase).toBe('tailwind');
});
