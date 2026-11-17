import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { walk, type Document } from '@mockup/core';
import { startDaemon, type DaemonHandle } from './index.js';
import { findKitsDir, listKitNames, loadKit } from './kits.js';
import type { CaptureRequest, RenderProvider } from './render.js';
import { makeWorkspace } from './test-utils.js';

type Ws = ReturnType<typeof makeWorkspace>;
type Content = { type: string; text?: string };

const textOf = (r: unknown): string =>
  (r as { content: Content[] }).content
    .filter((c) => c.type === 'text')
    .map((c) => c.text)
    .join('\n');

describe('MCP components: kits, instances, overrides and render', () => {
  let ws: Ws;
  let daemon: DaemonHandle;
  let client: Client;
  let captures: CaptureRequest[];
  let measures: { nodeId: string; doc: Document }[];

  const render: RenderProvider = {
    async capture(req) {
      captures.push(req);
      return {
        data: Buffer.from([0x89]),
        mime: 'image/png',
        width: 100,
        height: 50,
        pixelWidth: 100,
        pixelHeight: 50,
      };
    },
    async measure(t) {
      measures.push({ nodeId: t.nodeId, doc: t.doc });
      return {
        id: t.nodeId,
        name: 'Measured',
        tag: 'button',
        x: 0,
        y: 0,
        width: 80,
        height: 36,
        children: [],
      };
    },
  };

  beforeEach(async () => {
    ws = makeWorkspace();
    captures = [];
    measures = [];
    daemon = await startDaemon({ port: 0, dataDir: ws.dataDir, writeInfo: false, render });
    client = new Client({ name: 'test', version: '0.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(daemon.mcpUrl)));
    await client.callTool({ name: 'open_document', arguments: { path: ws.file } });
  });

  afterEach(async () => {
    await client.close();
    await daemon.close();
    ws.cleanup();
  });

  const call = (name: string, args: Record<string, unknown> = {}) =>
    client.callTool({ name, arguments: args });
  const ok = async (name: string, args: Record<string, unknown> = {}) => {
    const r = await call(name, args);
    expect(r.isError, textOf(r)).toBeFalsy();
    return textOf(r);
  };
  const fail = async (name: string, args: Record<string, unknown> = {}) => {
    const r = await call(name, args);
    expect(r.isError, textOf(r)).toBe(true);
    return textOf(r);
  };
  const doc = async (): Promise<Document> => {
    const res = await fetch(`${daemon.url}/api/docs`);
    const { activeDocId } = (await res.json()) as { activeDocId: string };
    const r = await fetch(`${daemon.url}/api/docs/${activeDocId}`);
    return ((await r.json()) as { doc: Document }).doc;
  };
  const instanceId = (t: string): string => /Instance created: (\S+)/.exec(t)![1]!;
  const insertButton = async (props: Record<string, unknown> = {}, extra = {}): Promise<string> =>
    instanceId(
      await ok('insert_component', {
        component: 'shadcn-like/Button',
        parentId: ws.frameId,
        props,
        ...extra,
      }),
    );

  it('list_components: empty library and shadcn-like kit available', async () => {
    const t = await ok('list_components');
    expect(t).toContain('Document components (0)');
    expect(t).toContain('shadcn-like/Button');
    expect(t).toContain('shadcn-like/Card');
    expect(t).toContain('slots: content, footer');
  });

  it('insert_component shadcn-like/Button: imports the kit, applies variant/label and reads through the virtual id', async () => {
    const t = await ok('insert_component', {
      component: 'shadcn-like/Button',
      parentId: ws.frameId,
      props: { variant: 'outline', label: 'Save' },
    });
    expect(t).toContain('Kit "shadcn-like" imported');
    const inst = instanceId(t);
    expect(t).toContain('◆Button');

    // the expanded instance: virtual ids and HTML with the text
    const tree = await ok('get_tree_summary', { nodeId: inst, depth: 4 });
    expect(tree).toContain(`${inst}/tx_sbtnlabl`);
    const html = await ok('get_html', { nodeId: inst });
    expect(html).toContain('Save');
    expect(html).not.toContain('{{label}}');
    expect(await ok('get_html', { nodeId: `${inst}/tx_sbtnlabl` })).toContain('Save');

    // expanded outline styles (1px border and theme background), not the default (primary) ones
    const styles = await ok('get_styles', { nodeIds: [inst] });
    expect(styles).toContain('border-width: 1px');
    expect(styles).toMatch(/background-color: (#|rgb|oklch|color)/);
    const def = await ok('insert_component', {
      component: 'Button',
      parentId: ws.frameId,
    });
    const defStyles = await ok('get_styles', { nodeIds: [instanceId(def)] });
    expect(defStyles).toContain('border-width: 0');

    const info = await ok('get_node_info', { nodeId: `${inst}/tx_sbtnlabl` });
    expect(info).toContain('Inner node of an instance');
    const infoInst = await ok('get_node_info', { nodeId: inst });
    expect(infoInst).toContain('instance of Button');
    expect(infoInst).toContain('variant=outline');

    const children = await ok('get_children', { nodeId: inst });
    expect(children).toContain(`${inst}/tx_sbtnlabl`);
  });

  it('the imported kit and the instance go into a single history entry (undo/redo)', async () => {
    const inst = await insertButton({ label: 'Ok' });
    expect((await doc()).components?.length).toBeGreaterThan(5);
    await ok('undo');
    const after = await doc();
    expect(after.components ?? []).toHaveLength(0);
    expect(JSON.stringify(after.pages)).not.toContain(inst);
    await ok('redo');
    const back = await doc();
    expect(back.components?.some((c) => c.name === 'Button')).toBe(true);
    expect(JSON.stringify(back.pages)).toContain(inst);
  });

  it('errors: missing component, invalid prop and enum outside the options', async () => {
    expect(await fail('insert_component', { component: 'Ghost', parentId: ws.frameId })).toContain(
      'list_components',
    );
    expect(
      await fail('insert_component', { component: 'shadcn-like/Nothing', parentId: ws.frameId }),
    ).toContain('Components: ');
    const inst = await insertButton();
    const bad = await fail('set_instance_props', { nodeIds: [inst], set: { color: 'x' } });
    expect(bad).toContain('variant');
    expect(bad).toContain('label');
    const badEnum = await fail('set_instance_props', { nodeIds: [inst], set: { variant: 'neon' } });
    expect(badEnum).toContain('outline');
    expect(await fail('set_instance_props', { nodeIds: [ws.frameId], set: { a: 1 } })).toContain(
      'not a component instance',
    );
    expect(
      await fail('insert_component', {
        component: 'shadcn-like/Button',
        parentId: ws.frameId,
        slots: { x: '<p/>' },
      }),
    ).toContain('has no slot');
  });

  it('get_component: props with options, variants, tree and HTML; also from a kit not imported', async () => {
    const fromKit = await ok('get_component', { component: 'shadcn-like/Button' });
    expect(fromKit).toContain('not in the document yet');
    expect(fromKit).toContain('enum, options: default | secondary | outline | ghost | destructive');
    expect(fromKit).toContain('when variant=outline');
    expect(fromKit).toContain('tx_sbtnlabl');
    expect(fromKit).toContain('{{label}}');
    await ok('import_kit', { name: 'shadcn-like' });
    const t = await ok('get_component', { component: 'Button' });
    expect(t).toContain('cp_sbutton1');
    expect(t).toContain('— 0 instance(s) (+5 inside other components)');
    expect(t).not.toContain('not in the document yet');
    const lib = await ok('list_components');
    expect(lib).toContain('Document components (8)');
    expect(lib).toContain('cp_sbutton1 "Button" [kit shadcn-like]');
  });

  it('import_kit is idempotent (and accepts an absolute path)', async () => {
    const first = await ok('import_kit', { name: 'shadcn-like' });
    expect(first).toContain('Button (added)');
    const rev = (await doc()).meta.updatedAt;
    const again = await ok('import_kit', { name: 'shadcn-like' });
    expect(again).toContain('is already imported');
    const d = await doc();
    expect(d.components).toHaveLength(8);
    expect(d.meta.updatedAt).toBe(rev);
    const kitFile = path.join(findKitsDir()!, 'shadcn-like.mockup.json');
    expect(await ok('import_kit', { name: kitFile })).toContain('is already imported');
    expect(await fail('import_kit', { name: 'does-not-exist' })).toContain('shadcn-like');
  });

  it('insert_component from a kit imports only what is missing and preserves an edited or renamed main component', async () => {
    const first = await ok('insert_component', {
      component: 'shadcn-like/Card',
      parentId: ws.frameId,
    });
    expect(first).toContain('Kit "shadcn-like" imported (8 component(s)');
    // Edits and renames Button, deletes Dialog (no instances) and inserts Dialog again.
    await ok('update_styles', { nodeIds: ['el_sbtnroot'], styles: { color: 'red' } });
    await ok('update_component', { componentId: 'cp_sbutton1', name: 'Renamed' });
    await ok('delete_component', { componentId: 'cp_sdialog1' });
    const dlg = await ok('insert_component', {
      component: 'shadcn-like/Dialog',
      parentId: ws.frameId,
    });
    expect(dlg).toContain('Kit "shadcn-like" imported (1 component(s))');
    // `shadcn-like/Button` is not found by name (renamed), but the kit id is already in the document.
    const again = await ok('insert_component', {
      component: 'shadcn-like/Button',
      parentId: ws.frameId,
    });
    expect(again).toContain('of "Renamed"');
    expect(again).not.toContain('imported');
    const d = await doc();
    const btn = d.components!.find((c) => c.id === 'cp_sbutton1')!;
    expect(btn.name).toBe('Renamed');
    expect(btn.root.style.color).toBe('red');
    expect(d.components).toHaveLength(8);
  });

  it('import_kit without overwrite lists the diverged ones; with overwrite it updates', async () => {
    await ok('import_kit', { name: 'shadcn-like' });
    await ok('update_styles', { nodeIds: ['el_sbtnroot'], styles: { color: 'red' } });
    await ok('delete_component', { componentId: 'cp_slist001' });
    const t = await ok('import_kit', { name: 'shadcn-like' });
    expect(t).toContain('List (added)');
    expect(t).toContain('Button (diverged)');
    expect(t).toContain('Diverged from the kit (kept with your edits): Button');
    expect(t).toContain('overwrite: true');
    let d = await doc();
    expect(d.components!.find((c) => c.id === 'cp_sbutton1')!.root.style.color).toBe('red');
    expect(d.components!.some((c) => c.id === 'cp_slist001')).toBe(true);
    // Repeating without overwrite: nothing to import, the diverged one stays listed.
    const rev = d.meta.updatedAt;
    const same = await ok('import_kit', { name: 'shadcn-like' });
    expect(same).toContain('nothing to import');
    expect(same).toContain('Diverged');
    expect((await doc()).meta.updatedAt).toBe(rev);
    const over = await ok('import_kit', { name: 'shadcn-like', overwrite: true });
    expect(over).toContain('Button (updated)');
    d = await doc();
    expect(d.components!.find((c) => c.id === 'cp_sbutton1')!.root.style.color).toBe(
      'var(--color-primary-foreground)',
    );
    expect(await ok('import_kit', { name: 'shadcn-like' })).toContain('is already imported');
  });

  it('slots via HTML (Card): content becomes real nodes in the slot container', async () => {
    const t = await ok('insert_component', {
      component: 'shadcn-like/Card',
      parentId: ws.frameId,
      props: { title: 'Pro Plan' },
      slots: { content: '<p id="x" style="color:#123456">Everything included</p>' },
    });
    const inst = instanceId(t);
    expect(t).toMatch(/Slots .*content=el_\w+/);
    const html = await ok('get_html', { nodeId: inst });
    expect(html).toContain('Pro Plan');
    expect(html).toContain('Everything included');
    expect(html).not.toContain('Card content');
    // empty footer uses the main component default content (nested button)
    expect(html).toContain('Action');
    const d = await doc();
    const instNode = d.pages[0]!.frames[0]!.children.find((c) => c.id === inst)!;
    expect(instNode.children.map((c) => c.attrs['data-slot'])).toEqual(['content', 'footer']);
    expect(instNode.children[0]!.children).toHaveLength(1);

    // Tailwind in a slot: compiled to style
    const tw = await ok('insert_component', {
      component: 'Card',
      parentId: ws.frameId,
      slots: { content: '<div class="flex gap-4 p-4">Hello</div>' },
    });
    const inst2 = instanceId(tw);
    const slotId = /content=(\S+?)[,.]/.exec(tw)![1]!;
    const slotTree = await ok('get_tree_summary', { nodeId: slotId, depth: 2 });
    expect(slotTree).toContain('tw');
    expect(inst2).not.toBe(inst);
  });

  it('create_component with bind, inferred props, undo and redo', async () => {
    const html = await ok('write_html', {
      parentId: ws.frameId,
      tailwind: 'off',
      html: '<button style="padding:8px 16px;background:#2563eb;color:#fff"><span>Submit</span></button>',
    });
    const btn = /Nodes created: ([^.\n,]+)/.exec(html)![1]!.trim();
    const tree = await ok('get_tree_summary', { nodeId: btn });
    const span = /(tx_\w+|el_\w+)(?= "Span")/.exec(tree)?.[1] ?? /\n\s+(\w+) /.exec(tree)![1]!;
    const t = await ok('create_component', {
      nodeId: btn,
      name: 'Action',
      description: 'Action button',
      props: [
        { name: 'label', type: 'string', bind: { nodeId: span, target: 'text' } },
        { name: 'bg', type: 'color', bind: { nodeId: btn, target: 'style:background' } },
      ],
    });
    expect(t).toContain('Component created: cp_');
    expect(t).toContain('label:string="Submit"');
    const d = await doc();
    const def = d.components!.find((c) => c.name === 'Action')!;
    expect(def.root.style['background']).toBe('{{bg}}');
    expect(def.props.find((p) => p.name === 'bg')?.default).toBe('#2563eb');
    const inst = /instance (in_\w+)/.exec(t)![1]!;
    expect(await ok('get_html', { nodeId: inst })).toContain('Submit');
    await ok('set_instance_props', { nodeIds: [inst], set: { label: 'Save', bg: '#16a34a' } });
    const h = await ok('get_html', { nodeId: inst });
    expect(h).toContain('Save');
    expect(h).toContain('#16a34a');

    await ok('undo'); // instance props
    await ok('undo'); // component creation
    expect((await doc()).components ?? []).toHaveLength(0);
    expect(JSON.stringify((await doc()).pages)).toContain(btn);
    await ok('redo');
    await ok('redo');
    expect((await doc()).components).toHaveLength(1);
    expect(await ok('get_html', { nodeId: inst })).toContain('Save');
    expect(await fail('create_component', { nodeId: ws.frameId })).toContain('frame');
  });

  it('set_instance_props / set_instance_override (merges) / reset_instance', async () => {
    const inst = await insertButton({ label: 'Ok' });
    await ok('set_instance_props', {
      nodeIds: [inst],
      set: { variant: 'destructive' },
      unset: ['label'],
    });
    let d = await doc();
    const node = d.pages[0]!.frames[0]!.children.find((c) => c.id === inst)!;
    expect(node.props).toEqual({ variant: 'destructive' });

    const label = `tx_sbtnlabl`;
    await ok('set_instance_override', { nodeId: inst, path: label, style: { color: '#ff0000' } });
    await ok('set_instance_override', {
      nodeId: inst,
      path: label,
      text: 'Delete',
      style: { 'font-size': '20px' },
    });
    d = await doc();
    const ov = d.pages[0]!.frames[0]!.children.find((c) => c.id === inst)!.overrides![label]!;
    expect(ov.style).toEqual({ color: '#ff0000', 'font-size': '20px' });
    expect(ov.text).toBe('Delete');
    expect(await ok('get_html', { nodeId: inst })).toContain('Delete');
    expect(await ok('get_styles', { nodeIds: [`${inst}/${label}`] })).toContain('color: #ff0000');

    expect(
      await fail('set_instance_override', { nodeId: inst, path: 'el_none', text: 'x' }),
    ).toContain('does not exist');
    expect(await fail('set_instance_override', { nodeId: inst, path: label })).toContain(
      'Provide at least',
    );

    // update_styles directly on the virtual id also becomes an override
    await ok('update_styles', {
      nodeIds: [`${inst}/${label}`],
      styles: { 'letter-spacing': '2px' },
    });
    d = await doc();
    expect(
      d.pages[0]!.frames[0]!.children.find((c) => c.id === inst)!.overrides![label]!.style,
    ).toMatchObject({
      'letter-spacing': '2px',
    });

    await ok('reset_instance', { nodeIds: [inst] });
    d = await doc();
    expect(d.pages[0]!.frames[0]!.children.find((c) => c.id === inst)!.overrides).toBeUndefined();
    expect(await ok('get_html', { nodeId: inst })).not.toContain('Delete');
  });

  it('push_overrides_to_main propagates to the other instances; detach_instance returns the new id', async () => {
    const a = await insertButton({ label: 'A' });
    const b = await insertButton({ label: 'B' });
    await ok('set_instance_override', {
      nodeId: a,
      path: 'tx_sbtnlabl',
      style: { 'font-style': 'italic' },
    });
    expect(await ok('get_styles', { nodeIds: [`${b}/tx_sbtnlabl`] })).not.toContain('italic');
    const t = await ok('push_overrides_to_main', { nodeId: a });
    expect(t).toContain('affects 2 instance(s) (+5 inside other components)');
    expect(await ok('get_styles', { nodeIds: [`${b}/tx_sbtnlabl`] })).toContain(
      'font-style: italic',
    );
    expect(await ok('push_overrides_to_main', { nodeId: a })).toContain('nothing to push');

    const det = await ok('detach_instance', { nodeId: b });
    const newId = /New id: (\S+?)\./.exec(det)![1]!;
    expect(newId).not.toBe(b);
    const d = await doc();
    const frame = d.pages[0]!.frames[0]!;
    expect(frame.children.some((c) => c.id === b)).toBe(false);
    const detached = frame.children.find((c) => c.id === newId)!;
    expect(detached.type).toBe('element');
    expect(detached.componentId).toBeUndefined();
    expect(JSON.stringify(detached)).toContain('B');
    expect(await fail('detach_instance', { nodeId: newId })).toContain('not a component instance');
  });

  it('update_component_html propagates to the instances, keeps {{prop}} and warns', async () => {
    const inst = await insertButton({ label: 'Save' });
    const t = await ok('update_component_html', {
      componentId: 'Button',
      html: '<button style="padding:4px 8px;background:#0f172a;color:#fff"><span>{{label}}</span> <b>{{icon}}</b></button>',
    });
    expect(t).toContain('updated: 1 instance(s)');
    expect(t).toContain('Props created from the HTML: icon:string');
    // variant and size are still used by the main component variants: no warning
    expect(t).not.toContain('props unused in the HTML');
    const input = await ok('update_component_html', {
      componentId: 'Input',
      html: '<input style="padding:4px" placeholder="{{placeholder}}">',
    });
    expect(input).toContain('props unused in the HTML');
    expect(input).toMatch(/unused.*value/);
    const html = await ok('get_html', { nodeId: inst });
    expect(html).toContain('Save');
    expect(html).toContain('#0f172a');
    expect(
      await fail('update_component_html', { componentId: 'Button', html: '<p>a</p><p>b</p>' }),
    ).toContain('single root element');
    await ok('undo'); // Input
    await ok('undo'); // Button
    expect(await ok('get_html', { nodeId: inst })).not.toContain('#0f172a');
  });

  it('update_component_html with Tailwind compiles the classes and creates slots', async () => {
    await ok('import_kit', { name: 'shadcn-like' });
    const t = await ok('update_component_html', {
      componentId: 'List',
      html: '<ul class="flex flex-col gap-2"><li data-slot="items">x</li></ul>',
    });
    expect(t).toContain('Tailwind classes compiled');
    const d = await doc();
    const def = d.components!.find((c) => c.name === 'List')!;
    expect(def.root.style['gap']).toBeTruthy();
    expect(def.props.some((p) => p.type === 'slot' && p.name === 'items')).toBe(true);
    expect(d.cssBase).toBe('tailwind');
  });

  it('editing the main component with update_styles on main component ids propagates to the instances; go_to_main', async () => {
    const a = await insertButton({ label: 'A' });
    const b = await insertButton({ label: 'B' });
    const t = await ok('go_to_main', { nodeId: `${a}/tx_sbtnlabl` });
    expect(t).toContain('el_sbtnroot');
    expect(t).toContain('tx_sbtnlabl');
    expect(await ok('get_selection')).toContain('el_sbtnroot');
    // main component ids are valid for reading
    expect(await ok('get_html', { nodeId: 'el_sbtnroot' })).toContain('{{label}}');
    expect(await ok('get_node_info', { nodeId: 'tx_sbtnlabl' })).toContain('main component');
    await ok('update_styles', { nodeIds: ['tx_sbtnlabl'], styles: { 'font-size': '33px' } });
    expect(await ok('get_styles', { nodeIds: [`${a}/tx_sbtnlabl`, `${b}/tx_sbtnlabl`] })).toMatch(
      /font-size: 33px[\s\S]*font-size: 33px/,
    );
    await ok('set_selection', { nodeIds: [a] });
    expect(await ok('go_to_main', { nodeId: a })).toContain('Main component "Button"');
    expect(await fail('go_to_main', { nodeId: ws.frameId })).toContain('is not an instance');
  });

  it('delete_component refuses with instances; detach_instances detaches and deletes', async () => {
    const inst = await insertButton({ label: 'X' });
    const refused = await fail('delete_component', { componentId: 'cp_sbutton1' });
    expect(refused).toContain('detach_instances');
    const t = await ok('delete_component', { componentId: 'Button', detach_instances: true });
    expect(t).toContain('6 instance(s) detached');
    const d = await doc();
    expect(d.components?.some((c) => c.name === 'Button')).toBeFalsy();
    expect(JSON.stringify(d.pages)).not.toContain(inst);
    expect(JSON.stringify(d.pages)).toContain('X');
    await ok('undo');
    expect((await doc()).components?.some((c) => c.name === 'Button')).toBe(true);
  });

  it('get_screenshot/get_layout hand the expanded document to the provider', async () => {
    const inst = await insertButton({ variant: 'outline', label: 'Save' });
    await ok('get_screenshot', { nodeId: inst });
    expect(captures).toHaveLength(1);
    let instances = 0;
    for (const page of captures[0]!.doc.pages)
      for (const f of page.frames)
        walk(f, (n) => {
          if (n.type === 'instance') instances++;
        });
    expect(instances).toBe(0);
    expect(JSON.stringify(captures[0]!.doc.pages)).toContain('Save');
    expect(captures[0]!.nodeId).toBe(inst);

    // id virtual
    await ok('get_screenshot', { nodeId: `${inst}/tx_sbtnlabl` });
    expect(captures[1]!.nodeId).toBe(`${inst}/tx_sbtnlabl`);

    await ok('get_layout', { nodeId: inst });
    expect(measures[0]!.nodeId).toBe(inst);
    expect(JSON.stringify(measures[0]!.doc.pages)).toContain('Save');

    // main component (cp_ and main component root node): preview as a default instance
    for (const ref of ['cp_sbutton1', 'el_sbtnroot']) {
      captures.length = 0;
      await ok('get_screenshot', { nodeId: ref });
      const req = captures[0]!;
      expect(req.nodeId).toBe('in_preview0');
      expect(req.doc.pages).toHaveLength(1);
      const s = JSON.stringify(req.doc.pages);
      expect(s).not.toContain('"type":"instance"');
      expect(s).toContain('Button');
    }
    // did not change the document
    expect((await doc()).pages).toHaveLength(1);
  });

  it('/render route uses the expanded document', async () => {
    const inst = await insertButton({ label: 'Route' });
    const info = (await (await fetch(`${daemon.url}/api/docs`)).json()) as { activeDocId: string };
    const res = await fetch(`${daemon.url}/render/${info.activeDocId}/${inst}.png`);
    expect(res.status).toBe(200);
    expect(JSON.stringify(captures[0]!.doc.pages)).toContain('Route');
    expect(JSON.stringify(captures[0]!.doc.pages)).not.toContain('"type":"instance"');
    const missing = await fetch(`${daemon.url}/render/${info.activeDocId}/does_not_exist.png`);
    expect(missing.status).toBe(404);
  });

  it('get_code (html/react) and export accept an instance, a virtual id and a main component node', async () => {
    const inst = await insertButton({ variant: 'outline', label: 'Save' });
    const html = await ok('get_code', { nodeId: inst, format: 'html' });
    expect(html).toContain('Save');
    const virt = await ok('get_code', { nodeId: `${inst}/tx_sbtnlabl`, format: 'html' });
    expect(virt).toContain('Save');
    const main = await ok('get_code', { nodeId: 'el_sbtnroot', format: 'html' });
    expect(main).toContain('{{label}}');
    const react = await ok('get_code', { nodeId: inst, format: 'react' });
    expect(react).toContain('Button');
    const out = path.join(ws.dir, 'out');
    const exp = await ok('export', { nodeIds: [inst], format: 'html', outputDir: out });
    expect(exp).toContain('Save');
    expect(fs.readdirSync(out).length).toBeGreaterThan(0);
  });

  it('get_guide("components") and instructions mention components', async () => {
    const g = await ok('get_guide', { topic: 'components' });
    for (const n of [
      'insert_component',
      'shadcn-like',
      'bind',
      'update_component_html',
      'detach_instance',
      'React',
    ]) {
      expect(g).toContain(n);
    }
    expect(client.getInstructions()).toContain('insert_component');
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    for (const n of [
      'list_components',
      'get_component',
      'create_component',
      'update_component',
      'update_component_html',
      'delete_component',
      'insert_component',
      'set_instance_props',
      'set_instance_override',
      'reset_instance',
      'detach_instance',
      'push_overrides_to_main',
      'go_to_main',
      'import_kit',
    ]) {
      expect(names).toContain(n);
    }
  });

  describe('kits and HTTP routes', () => {
    it('GET /api/kits lists the kits with components and props', async () => {
      const res = await fetch(`${daemon.url}/api/kits`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        kits: {
          name: string;
          components: {
            id: string;
            name: string;
            description?: string;
            props: { name: string; type: string }[];
          }[];
        }[];
      };
      const kit = body.kits.find((k) => k.name === 'shadcn-like')!;
      expect(kit.components.map((c) => c.name)).toEqual(
        expect.arrayContaining([
          'Button',
          'Input',
          'Card',
          'Navbar',
          'Tabs',
          'Dialog',
          'Table',
          'List',
        ]),
      );
      const button = kit.components.find((c) => c.name === 'Button')!;
      expect(button.id).toBe('cp_sbutton1');
      expect(button.description).toContain('Button');
      expect(button.props.map((p) => p.name)).toEqual(['variant', 'size', 'label']);
    });

    it('GET /api/kits/:name returns the kit document; a missing name or one with a path gives 404', async () => {
      const res = await fetch(`${daemon.url}/api/kits/shadcn-like`);
      expect(res.status).toBe(200);
      const kit = (await res.json()) as Document;
      expect(kit.components?.length).toBe(8);
      expect(Object.keys(kit.tokens)).toContain('--color-primary');
      expect((await fetch(`${daemon.url}/api/kits/does-not-exist`)).status).toBe(404);
      expect((await fetch(`${daemon.url}/api/kits/..%2Fpackage`)).status).toBe(404);
    });

    it('findKitsDir/loadKit: MOCKUP_KITS_DIR, mtime cache and errors', async () => {
      expect(listKitNames()).toContain('shadcn-like');
      expect(loadKit('SHADCN-LIKE')).toBe(loadKit('shadcn-like'));
      const dir = fs.mkdtempSync(path.join(ws.dir, 'kits-'));
      fs.copyFileSync(
        path.join(findKitsDir()!, 'shadcn-like.mockup.json'),
        path.join(dir, 'mine.mockup.json'),
      );
      fs.writeFileSync(path.join(dir, 'broken.mockup.json'), '{ not json');
      const prev = process.env.MOCKUP_KITS_DIR;
      process.env.MOCKUP_KITS_DIR = dir;
      try {
        expect(findKitsDir()).toBe(path.resolve(dir));
        expect(listKitNames()).toEqual(['broken', 'mine']);
        const k = loadKit('mine');
        expect(loadKit('mine')).toBe(k);
        expect(() => loadKit('broken')).toThrow(/Invalid/);
        // Path: extension required; malformed JSON without the raw parser message.
        const broken = path.join(dir, 'broken.mockup.json');
        expect(() => loadKit(broken)).toThrow(`Invalid kit (${broken}): Invalid JSON`);
        const noExt = path.join(dir, 'mine.json');
        fs.copyFileSync(path.join(dir, 'mine.mockup.json'), noExt);
        expect(() => loadKit(noExt)).toThrow('must have the .mockup.json extension');
        expect(await fail('import_kit', { name: noExt })).toContain(
          'must have the .mockup.json extension',
        );
        const viaMcp = await fail('import_kit', { name: broken });
        expect(viaMcp).toContain('Invalid JSON');
        expect(viaMcp).not.toMatch(/not json|Unexpected|position/);
        // Invalid document: the schema errors.
        const bad = path.join(dir, 'invalid.mockup.json');
        fs.writeFileSync(bad, JSON.stringify({ version: 2, id: 'x', name: 'x', pages: [] }));
        expect(() => loadKit(bad)).toThrow(/Invalid kit .*unsupported version/);
        const res = await fetch(`${daemon.url}/api/kits`);
        const body = (await res.json()) as { kits: { name: string }[] };
        expect(body.kits.map((x) => x.name)).toEqual(['mine']); // the broken one is ignored
        expect((await fetch(`${daemon.url}/api/kits/broken`)).status).toBe(400);
      } finally {
        if (prev === undefined) delete process.env.MOCKUP_KITS_DIR;
        else process.env.MOCKUP_KITS_DIR = prev;
      }
    });
  });
});
