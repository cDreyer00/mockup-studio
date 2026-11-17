import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import type { Document } from '@mockup/core';
import { Mcp, createDoc, getDoc, gotoEditor } from './helpers';

/** Components in the editor: create (Ctrl+Alt+K), instances with props, main component editing and kit. */

const nodeEl = (page: Page, id: string) =>
  page.getByTestId('canvas-world').locator(`[data-node-id="${id}"]`).first();

const bg = (page: Page, id: string) =>
  nodeEl(page, id).evaluate((el) => getComputedStyle(el).backgroundColor);

const frameOf = async (docId: string) => (await getDoc(docId)).pages[0]!.frames[0]!;

async function setup(name: string) {
  const info = await createDoc(name);
  const mcp = await new Mcp().init();
  await mcp.call('create_frame', { name: 'Screen', width: 800, height: 600, x: 0, y: 0 });
  await mcp.call('write_html', {
    html: '<div class="card"><p class="t">{{label}}</p></div>',
    css: '.card{padding:12px;background:#eeeeee;width:200px}.t{margin:0;font-size:16px;min-height:20px}',
  });
  const frame = await frameOf(info.docId);
  return { info, mcp, frame };
}

/** Selects through the layers panel (Layers tab). */
async function selectLayer(page: Page, id: string) {
  await page.getByTestId('tab-layers').click();
  await page.getByTestId(`layer-row-${id}`).click();
}

async function setLabel(page: Page, value: string) {
  const input = page.locator('[data-testid="instance-prop-label"] input');
  await input.fill(value);
  await input.press('Enter');
}

const component = (doc: Document) => doc.components?.[0];

test('creates a component (Ctrl+Alt+K), 3 instances with props, edits the main component and propagates; undo reverts', async ({
  page,
}) => {
  const { info, frame } = await setup('components');
  const card = frame.children[0]!;
  const textId = card.children[0]!.id;
  await gotoEditor(page);

  // Ctrl+Alt+K turns the node into a component; the node becomes the first instance (selected).
  await selectLayer(page, card.id);
  await page.keyboard.press('Control+Alt+k');
  await expect.poll(async () => (await getDoc(info.docId)).components?.length ?? 0).toBe(1);
  const doc1 = await getDoc(info.docId);
  const cid = component(doc1)!.id;
  const name = component(doc1)!.name;
  const first = (await frameOf(info.docId)).children[0]!;
  expect(first.type).toBe('instance');
  expect(first.componentId).toBe(cid);
  expect(component(doc1)!.props.map((p) => p.name)).toEqual(['label']);
  await expect(page.getByTestId('instance-component-name')).toHaveText(name);
  await expect(page.getByTestId(`layer-row-${first.id}`)).toHaveAttribute(
    'data-component-role',
    'instance',
  );

  // Two more instances from the Components tab (+), each right after the selected one.
  await page.getByTestId('tab-components').click();
  const item = page.getByTestId(`component-item-${cid}`);
  await expect(item).toContainText('1 instance');
  await item.hover();
  await page.getByTestId(`component-insert-${cid}`).click();
  await expect.poll(async () => (await frameOf(info.docId)).children.length).toBe(2);
  await item.hover();
  await page.getByTestId(`component-insert-${cid}`).click();
  await expect.poll(async () => (await frameOf(info.docId)).children.length).toBe(3);
  await expect(item).toContainText('3 instances');
  const ids = (await frameOf(info.docId)).children.map((n) => n.id);
  expect((await frameOf(info.docId)).children.every((n) => n.componentId === cid)).toBe(true);

  // Different props through the properties panel.
  const labels = ['One', 'Two', 'Three'];
  for (let i = 0; i < 3; i++) {
    await selectLayer(page, ids[i]!);
    await setLabel(page, labels[i]!);
    await expect(nodeEl(page, `${ids[i]}/${textId}`)).toHaveText(labels[i]!);
  }
  const insts = (await frameOf(info.docId)).children;
  expect(insts.map((n) => n.props?.label)).toEqual(labels);

  // Instance with a purple outline on selection.
  await expect(page.getByTestId('selection-box')).toHaveAttribute('data-component', '');

  // Go to main: isolated mode (only the main component on the canvas).
  await page.getByTestId('instance-go-main').click();
  await expect(page.getByTestId('component-edit-bar')).toBeVisible();
  await expect(page.getByTestId('component-edit-name')).toHaveText(name);
  await expect(nodeEl(page, card.id)).toBeVisible();
  await expect(nodeEl(page, ids[1]!)).toHaveCount(0);
  await expect(nodeEl(page, card.id)).toContainText('{{label}}');

  // Style on the main component (the root comes selected) and text on a node of the main component.
  const color = page.locator('[title="Background color"] input:not([type="color"])').first();
  await color.fill('#ff0000');
  await color.press('Enter');
  await expect
    .poll(async () => component(await getDoc(info.docId))!.root.style.background)
    .toBe('#ff0000');
  expect(await bg(page, card.id)).toBe('rgb(255, 0, 0)');

  // Done: returns to the page and selects the origin instance; all 3 reflect the main component.
  await page.getByTestId('component-edit-done').click();
  await expect(page.getByTestId('component-edit-bar')).toHaveCount(0);
  await expect(page.getByTestId(`layer-row-${ids[2]}`)).toHaveAttribute('aria-selected', 'true');
  for (const id of ids) await expect.poll(() => bg(page, id)).toBe('rgb(255, 0, 0)');
  for (let i = 0; i < 3; i++)
    await expect(nodeEl(page, `${ids[i]}/${textId}`)).toHaveText(labels[i]!);

  // Undo reverts the main component edit on all instances.
  await page.getByTestId('canvas').focus();
  await page.keyboard.press('Control+z');
  await expect
    .poll(async () => component(await getDoc(info.docId))!.root.style.background)
    .toBe('#eeeeee');
  for (const id of ids) await expect.poll(() => bg(page, id)).toBe('rgb(238, 238, 238)');

  // Text of an inner node becomes an instance override; Reset goes back to the prop value.
  const inner = `${ids[0]}/${textId}`;
  await selectLayer(page, inner);
  await nodeEl(page, inner).dblclick();
  const editor = page.getByTestId('text-editor');
  await expect(editor).toBeVisible();
  await page.keyboard.press('Control+a');
  await page.keyboard.type('Other');
  await page.keyboard.press('Enter');
  await expect
    .poll(async () => (await frameOf(info.docId)).children[0]!.overrides?.[textId]?.text)
    .toBe('Other');
  await expect(nodeEl(page, inner)).toHaveText('Other');
  await expect(nodeEl(page, `${ids[1]}/${textId}`)).toHaveText('Two');
  await selectLayer(page, ids[0]!);
  await expect(page.getByTestId('instance-reset')).toBeEnabled();
  await page.getByTestId('instance-reset').click();
  await expect(nodeEl(page, inner)).toHaveText('One');
  await expect(page.getByTestId('instance-reset')).toBeDisabled();

  // An inner node cannot be deleted (warning, nothing changes).
  await selectLayer(page, inner);
  await page.getByTestId('canvas').focus();
  await page.keyboard.press('Delete');
  await expect(page.getByText(/cannot be moved/)).toBeVisible();
  expect((await frameOf(info.docId)).children).toHaveLength(3);
});

test('inserts shadcn-like/Button from the Components tab and switches the variant', async ({
  page,
}) => {
  const info = await createDoc('kit');
  const mcp = await new Mcp().init();
  await mcp.call('create_frame', { name: 'Screen', width: 800, height: 600, x: 0, y: 0 });
  await gotoEditor(page);

  await page.getByTestId('tab-components').click();
  const button = page.getByTestId('kit-item-shadcn-like-Button');
  await expect(button).toBeVisible();
  await button.click();
  await expect.poll(async () => (await frameOf(info.docId)).children.length).toBe(1);
  const doc = await getDoc(info.docId);
  const inst = doc.pages[0]!.frames[0]!.children[0]!;
  expect(inst.type).toBe('instance');
  expect(inst.componentId).toBe('cp_sbutton1');
  expect(doc.components?.find((c) => c.id === 'cp_sbutton1')?.kit).toBe('shadcn-like');
  // Kit tokens imported together (one call).
  expect(doc.tokens['--color-primary']).toBeDefined();

  // On the canvas: <button> with the default text and the kit style.
  const el = nodeEl(page, inst.id);
  await expect(el).toHaveJSProperty('tagName', 'BUTTON');
  await expect(el).toHaveText('Button');
  const st = await el.evaluate((e) => {
    const c = getComputedStyle(e);
    return { display: c.display, height: c.height, bg: c.backgroundColor };
  });
  expect(st.display).toBe('inline-flex');
  expect(st.height).toBe('36px');

  // The document library now lists the Button; switching the variant changes the style.
  await expect(page.getByTestId('component-item-cp_sbutton1')).toContainText('shadcn-like');
  await page.locator('[data-testid="instance-prop-variant"] select').selectOption('outline');
  await expect
    .poll(async () => (await frameOf(info.docId)).children[0]!.props?.variant)
    .toBe('outline');
  await expect.poll(() => bg(page, inst.id)).not.toBe(st.bg);

  // Drag from the kit to the canvas: instance at the drop point (absolute in the non-flex frame).
  const frameId = (await frameOf(info.docId)).id;
  await page
    .getByTestId('kit-item-shadcn-like-Input')
    .dragTo(nodeEl(page, frameId), { targetPosition: { x: 300, y: 200 } });
  await expect.poll(async () => (await frameOf(info.docId)).children.length).toBe(2);
  const dropped = (await frameOf(info.docId)).children[1]!;
  expect(dropped.componentId).toBe('cp_sinput01');
  expect(dropped.style.position).toBe('absolute');
  await expect(nodeEl(page, dropped.id)).toHaveJSProperty('tagName', 'INPUT');
  await page.getByTestId('canvas').focus();
  await page.keyboard.press('Control+z');
  await expect.poll(async () => (await frameOf(info.docId)).children.length).toBe(1);

  // Undo: first the variant; then the whole insertion (imported kit + instance, one entry).
  await page.getByTestId('canvas').focus();
  await page.keyboard.press('Control+z');
  await expect
    .poll(async () => (await frameOf(info.docId)).children[0]!.props?.variant)
    .toBeUndefined();
  await page.keyboard.press('Control+z');
  await expect.poll(async () => (await frameOf(info.docId)).children.length).toBe(0);
  expect((await getDoc(info.docId)).components ?? []).toHaveLength(0);
});

test('editable slot: text created inside the slot content of the kit Card', async ({ page }) => {
  const info = await createDoc('slot');
  const mcp = await new Mcp().init();
  await mcp.call('create_frame', { name: 'Screen', width: 800, height: 600, x: 0, y: 0 });
  await gotoEditor(page);
  await page.getByTestId('tab-components').click();
  await page.getByTestId('kit-item-shadcn-like-Card').click();
  await expect.poll(async () => (await frameOf(info.docId)).children.length).toBe(1);
  const inst = (await frameOf(info.docId)).children[0]!;
  const slot = inst.children.find((c) => c.attrs['data-slot'] === 'content')!;
  // Default content of the main component while the slot is empty.
  await expect(nodeEl(page, slot.id)).toContainText('Card content');

  // The slot button selects the real container; the text (T) goes into it.
  await page.getByTestId('instance-slot-content').click();
  await expect(page.getByTestId(`layer-row-${slot.id}`)).toHaveAttribute(
    'data-component-role',
    'slot',
  );
  const box = (await nodeEl(page, slot.id).boundingBox())!;
  await page.keyboard.press('t');
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await expect(page.getByTestId('text-editor')).toBeVisible();
  await page.keyboard.press('Control+a');
  await page.keyboard.type('Hello slot');
  await page.keyboard.press('Enter');
  await expect
    .poll(async () => {
      const i = (await frameOf(info.docId)).children[0]!;
      return i.children.find((c) => c.id === slot.id)?.children[0]?.text;
    })
    .toBe('Hello slot');
  await expect(nodeEl(page, slot.id)).toContainText('Hello slot');
  await expect(nodeEl(page, slot.id)).not.toContainText('Card content');
});

test('MCP go_to_main enters edit mode; Esc goes back', async ({ page }) => {
  const { info, mcp, frame } = await setup('go-to-main');
  const card = frame.children[0]!;
  await gotoEditor(page);
  await selectLayer(page, card.id);
  await page.keyboard.press('Control+Alt+k');
  await expect.poll(async () => (await getDoc(info.docId)).components?.length ?? 0).toBe(1);
  const inst = (await frameOf(info.docId)).children[0]!;

  await mcp.call('go_to_main', { nodeId: inst.id });
  await expect(page.getByTestId('component-edit-bar')).toBeVisible();
  await expect(page.getByTestId(`layer-row-${card.id}`)).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByTestId('component-section')).toBeVisible();

  // Esc goes up from the root (empty selection) and the second Esc finishes.
  await page.getByTestId('canvas').focus();
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('component-edit-bar')).toHaveCount(0);
  await expect(nodeEl(page, inst.id)).toBeVisible();
});
