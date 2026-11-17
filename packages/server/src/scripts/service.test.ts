import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createNodeFromTag, findNode, walk, type Node } from '@mockup/core';
import type { RenderProvider } from '../render.js';
import type { AssistantServiceApi } from '../services.js';
import { DocumentStore } from '../store.js';
import { makeWorkspace } from '../test-utils.js';
import { ScriptService, normalizeScriptName } from './service.js';

type Ws = ReturnType<typeof makeWorkspace>;

interface Fixture {
  ws: Ws;
  store: DocumentStore;
  svc: ScriptService;
  docId: string;
  ids: Record<string, string>;
}

/**
 * Test document: Desktop frame > header (h1, nav > 2 links), section.actions (3 buttons),
 * p and footer. `ids` indexes the nodes by name.
 */
async function setup(
  extra: { render?: RenderProvider; assistant?: AssistantServiceApi } = {},
): Promise<Fixture> {
  const ws = makeWorkspace();
  const store = new DocumentStore({ dataDir: ws.dataDir, autosaveMs: 60_000 });
  const { docId } = await store.open(ws.file);
  const mk = createNodeFromTag;
  const btn = (text: string, bg: string) =>
    mk('button', { name: `Button ${text}`, text, styles: { background: bg, color: '#fff' } });
  const h1 = mk('h1', { name: 'Title', text: 'Hello world', styles: { 'font-size': '32px' } });
  const link1 = mk('a', { name: 'Link Home', text: 'Home', attrs: { href: '/' } });
  const link2 = mk('a', { name: 'Link About', text: 'About', attrs: { href: '/about' } });
  const nav = mk('nav', { name: 'Menu', children: [link1, link2] });
  const header = mk('header', { name: 'Header', children: [h1, nav] });
  const b1 = btn('Buy', 'red');
  const b2 = btn('Learn more', 'blue');
  const b3 = btn('Cancel', 'gray');
  const actions = mk('section', { name: 'Actions', children: [b1, b2, b3] });
  const p = mk('p', { name: 'Paragraph', text: 'Paragraph text.' });
  const footer = mk('footer', { name: 'Footer', children: [] });
  store.applyOps(
    docId,
    [header, actions, p, footer].map((node) => ({
      type: 'createNode' as const,
      parentId: ws.frameId,
      node,
    })),
    { source: 'mcp', label: 'fixture' },
  );
  const ids: Record<string, string> = { frame: ws.frameId };
  walk(store.get(docId), (n: Node) => {
    ids[n.name] = n.id;
  });
  const svc = new ScriptService(store, extra);
  return { ws, store, svc, docId, ids };
}

describe('ScriptService: document API', () => {
  let f: Fixture;
  beforeEach(async () => {
    f = await setup();
  });
  afterEach(async () => {
    await f.store.closeAll();
    f.ws.cleanup();
  });

  const run = (code: string, opts?: Parameters<ScriptService['run']>[2]) =>
    f.svc.run(f.docId, code, { timeoutMs: 8000, ...opts });
  const val = async (code: string) => {
    const r = await run(code);
    expect(r.error).toBeUndefined();
    expect(r.ok).toBe(true);
    return r.result;
  };
  const doc = () => f.store.get(f.docId);
  const node = (name: string) => findNode(doc(), f.ids[name]!)!.node;

  it('doc.id, doc.name, pages and frames', async () => {
    expect(
      await val(
        `return { id: doc.id, name: doc.name, pages: doc.pages(), frames: doc.frames().map(n => n.id) };`,
      ),
    ).toEqual({
      id: f.docId,
      name: doc().name,
      pages: [{ id: doc().pages[0]!.id, name: doc().pages[0]!.name, frameIds: [f.ws.frameId] }],
      frames: [f.ws.frameId],
    });
    const bad = await run(`return doc.frames("pg_missing");`);
    expect(bad.ok).toBe(false);
    expect(bad.error).toContain('Page not found');
  });

  it('doc.get returns the handle or null', async () => {
    expect(await val(`return doc.get("${f.ids['Title']}").name;`)).toBe('Title');
    expect(await val(`return doc.get("el_missing");`)).toBeNull();
    expect(await val(`return doc.get(doc.get("${f.ids['Title']}")).id;`)).toBe(f.ids['Title']);
  });

  describe('select', () => {
    const ids = async (q: string) =>
      (await val(`return doc.select(${q}).map(n => n.name);`)) as string[];

    it('selector: *, types and tags', async () => {
      expect((await ids('"*"')).length).toBe(12);
      expect(await ids('"frame"')).toEqual(['Desktop']);
      expect(await ids('"text"')).toEqual([
        'Title',
        'Link Home',
        'Link About',
        'Button Buy',
        'Button Learn more',
        'Button Cancel',
        'Paragraph',
      ]);
      expect(await ids('"button"')).toEqual(['Button Buy', 'Button Learn more', 'Button Cancel']);
      expect(await ids('"h1, p"')).toEqual(['Title', 'Paragraph']);
      expect(await ids('"BUTTON"')).toHaveLength(3);
      expect(await ids('"instance"')).toEqual([]);
    });

    it('selector: #id and .class', async () => {
      expect(await ids(`"#${f.ids['Menu']}"`)).toEqual(['Menu']);
      expect(await ids('"#el_nothing"')).toEqual([]);
      const cls = await run(
        `doc.apply({ type: "setClasses", changes: [{ nodeId: "${f.ids['Title']}", classes: "text-xl font-bold" }] });
         return doc.select(".font-bold").map(n => n.name);`,
      );
      expect(cls.result).toEqual(['Title']);
    });

    it('selector: attributes =, ^=, *=, $=, presence, style.* and attrs.*', async () => {
      expect(await ids('`[name="Button Buy"]`')).toEqual(['Button Buy']);
      expect(await ids('"[name^=Button]"')).toHaveLength(3);
      expect(await ids('"[name*=more]"')).toEqual(['Button Learn more']);
      expect(await ids('"[name$=ancel]"')).toEqual(['Button Cancel']);
      expect(await ids(`"[text*='world']"`)).toEqual(['Title']);
      expect(await ids('"[tag=a]"')).toEqual(['Link Home', 'Link About']);
      expect(await ids('"[type=frame]"')).toEqual(['Desktop']);
      expect(await ids('"[style.font-size]"')).toEqual(['Title']);
      expect(await ids('"[style.fontSize=32px]"')).toEqual(['Title']);
      expect(await ids('"button[style.background=blue]"')).toEqual(['Button Learn more']);
      expect(await ids('"[attrs.href$=about]"')).toEqual(['Link About']);
      expect(await ids('"[hidden]"')).toEqual([]);
    });

    it('selector: descendant and child combinators', async () => {
      expect(await ids('"header a"')).toEqual(['Link Home', 'Link About']);
      expect(await ids('"header > a"')).toEqual([]);
      expect(await ids('"nav > a"')).toEqual(['Link Home', 'Link About']);
      expect(await ids('"frame > section > button"')).toHaveLength(3);
      expect(await ids('"frame>section>button"')).toHaveLength(3);
      expect(await ids('"section button, h1"')).toHaveLength(4);
      expect(await ids('"header nav a[attrs.href=\\"/\\"]"')).toEqual(['Link Home']);
    });

    it('an invalid selector returns a clear error', async () => {
      for (const q of ['""', '"[name"', '"a >"', '"a $"', '"[x=1]"', '"> a"', '"a,"']) {
        const r = await run(`return doc.select(${q});`);
        expect(r.ok, q).toBe(false);
        expect(r.error, q).toMatch(/Invalid selector|Unknown attribute/);
      }
    });

    it('a predicate function receives the node JSON snapshot', async () => {
      expect(
        await val(
          `return doc.select(n => n.tag === "button" && n.style.background === "red").map(n => n.name);`,
        ),
      ).toEqual(['Button Buy']);
      expect(
        await val(`return doc.select(n => n.childIds.length === 3).map(n => n.name);`),
      ).toEqual(['Actions']);
      expect(await val(`return doc.select(n => n.parentId === null).map(n => n.name);`)).toEqual([
        'Desktop',
      ]);
    });

    it('object: type, tag, name and text (exact string or RegExp) and within', async () => {
      expect(await ids('{ type: "frame" }')).toEqual(['Desktop']);
      expect(await ids('{ tag: "a" }')).toEqual(['Link Home', 'Link About']);
      expect(await ids('{ name: "Menu" }')).toEqual(['Menu']);
      expect(await ids('{ name: "Men" }')).toEqual([]);
      expect(await ids('{ name: /^Button/ }')).toHaveLength(3);
      expect(await ids('{ type: "text", text: /more|Home/ }')).toEqual([
        'Link Home',
        'Button Learn more',
      ]);
      expect(await ids('{ text: "Home" }')).toEqual(['Link Home']);
      expect(await ids(`{ tag: "a", within: "${f.ids['Header']}" }`)).toHaveLength(2);
      expect(await ids(`{ tag: "button", within: "${f.ids['Header']}" }`)).toEqual([]);
    });

    it('a global regex is not affected by lastIndex across nodes', async () => {
      expect(await ids('{ name: /But/g }')).toHaveLength(3);
    });

    it('selectOne, invalid query and node.select (descendants only)', async () => {
      expect(await val(`return doc.selectOne("button").name;`)).toBe('Button Buy');
      expect(await val(`return doc.selectOne("video");`)).toBeNull();
      const bad = await run(`return doc.select(42);`);
      expect(bad.error).toContain('Invalid query');
      expect(
        await val(`return doc.get("${f.ids['Header']}").select("a").map(n => n.name);`),
      ).toEqual(['Link Home', 'Link About']);
      expect(await val(`return doc.get("${f.ids['Header']}").select("header").length;`)).toBe(0);
      expect(
        await val(`return doc.get("${f.ids['Actions']}").select({ type: "text" }).length;`),
      ).toBe(3);
      expect(await val(`return doc.get("${f.ids['Actions']}").select(n => true).length;`)).toBe(3);
      // an ancestor outside the scope still counts in the compound selector
      expect(
        await val(`return doc.get("${f.ids['Actions']}").select("frame button").length;`),
      ).toBe(3);
    });
  });

  describe('NodeHandle', () => {
    it('reads: id, type, tag, name, text, classes, position, parent, children, frame, toJSON', async () => {
      const r = (await val(`
        const b = doc.selectOne("button");
        return {
          id: b.id, type: b.type, tag: b.tag, name: b.name, text: b.text, classes: b.classes,
          position: b.position, parent: b.parent.name, frame: b.frame.name,
          parentChildren: b.parent.children.map(c => c.name),
          parentOfRoot: doc.frames()[0].parent,
          json: JSON.parse(JSON.stringify(b)),
        };`)) as Record<string, unknown>;
      expect(r).toMatchObject({
        id: f.ids['Button Buy'],
        type: 'text',
        tag: 'button',
        name: 'Button Buy',
        text: 'Buy',
        classes: '',
        parent: 'Actions',
        frame: 'Desktop',
        parentChildren: ['Button Buy', 'Button Learn more', 'Button Cancel'],
        parentOfRoot: null,
      });
      expect(r['json']).toMatchObject({
        id: f.ids['Button Buy'],
        tag: 'button',
        parentId: f.ids['Actions'],
      });
      expect(await val(`return doc.frames()[0].position;`)).toEqual({ x: 0, y: 0 });
    });

    it('name and text: writing becomes renameNodes and setText', async () => {
      const r = await run(`
        const b = doc.selectOne("button");
        b.name = "CTA"; b.text = "Buy now";
        return [b.name, b.text];`);
      expect(r.result).toEqual(['CTA', 'Buy now']);
      expect(r.opsCount).toBe(2);
      const n = findNode(doc(), f.ids['Button Buy']!)!.node;
      expect(n.name).toBe('CTA');
      expect(n.text).toBe('Buy now');
    });

    it('style: read, assign, delete, camelCase, Object.keys and setStyle', async () => {
      const r = await run(`
        const b = doc.selectOne("button");
        const before = b.style.background;
        b.style.background = "green";
        b.style.borderRadius = "8px";
        b.style["--x"] = "1";
        delete b.style.color;
        b.setStyle({ padding: "4px 8px", gap: "" });
        return { before, after: b.style.background, radius: b.style["border-radius"], has: "color" in b.style,
                 keys: Object.keys(b.style).sort(), json: JSON.stringify(b.style) };`);
      expect(r.error).toBeUndefined();
      expect(r.result).toMatchObject({
        before: 'red',
        after: 'green',
        radius: '8px',
        has: false,
        keys: ['--x', 'background', 'border-radius', 'padding'],
      });
      const st = findNode(doc(), f.ids['Button Buy']!)!.node.style;
      expect(st).toEqual({
        background: 'green',
        'border-radius': '8px',
        '--x': '1',
        padding: '4px 8px',
      });
    });

    it('style: an empty/null value removes and assigning an object to style gives guidance', async () => {
      const r = await run(`
        const b = doc.selectOne("button");
        b.style.color = null;
        b.style.background = "";
        return Object.keys(b.style);`);
      expect(r.result).toEqual([]);
      const bad = await run(`doc.selectOne("button").style = { color: "red" };`);
      expect(bad.ok).toBe(false);
      expect(bad.error).toContain('setStyle');
    });

    it('attrs: read, assign and delete', async () => {
      const r = await run(`
        const a = doc.selectOne("a");
        const before = a.attrs.href;
        a.attrs.href = "/start";
        a.attrs.target = "_blank";
        delete a.attrs.target;
        a.attrs.title = "Go";
        return { before, after: a.attrs.href, keys: Object.keys(a.attrs).sort() };`);
      expect(r.result).toEqual({ before: '/', after: '/start', keys: ['href', 'title'] });
      expect(findNode(doc(), f.ids['Link Home']!)!.node.attrs).toEqual({
        href: '/start',
        title: 'Go',
      });
    });

    it('position: read and assign', async () => {
      const r = await run(`
        const fr = doc.frames()[0];
        fr.position = { x: 40, y: 50 };
        return fr.position;`);
      expect(r.result).toEqual({ x: 40, y: 50 });
    });

    it('duplicate returns the clone; remove deletes; a removed node gives a clear error', async () => {
      const r = await run(`
        const b = doc.selectOne("button");
        const c = b.duplicate();
        c.name = "Clone";
        const total = doc.select("button").length;
        b.remove();
        let error = null;
        try { b.name; } catch (e) { error = e.message; }
        return { cloneId: c.id, different: c.id !== b.id, total, after: doc.select("button").length, error };`);
      expect(r.error).toBeUndefined();
      const v = r.result as { different: boolean; total: number; after: number; error: string };
      expect(v.different).toBe(true);
      expect(v.total).toBe(4);
      expect(v.after).toBe(3);
      expect(v.error).toContain('no longer exists');
      expect(findNode(doc(), f.ids['Button Buy']!)).toBeUndefined();
    });

    it('doc.create creates nodes (with children) and frames', async () => {
      const r = await run(`
        const card = doc.create(doc.get("${f.ids['Footer']}"), {
          tag: "div", name: "Card", style: { padding: 8, display: "flex" },
          children: [{ tag: "h2", text: "Title", name: "T" }, { tag: "img", attrs: { alt: "x" } }],
        });
        const created = doc.create(null, { name: "Mobile", style: { width: "390px", height: "800px" } });
        return { card: card.children.map(c => c.tag), pad: card.style.padding, frame: created.type, name: created.name, pos: created.position };`);
      expect(r.error).toBeUndefined();
      expect(r.result).toMatchObject({
        card: ['h2', 'img'],
        pad: '8',
        frame: 'frame',
        name: 'Mobile',
      });
      expect(doc().pages[0]!.frames).toHaveLength(2);
      const bad = await run(`doc.create("el_nothing", { tag: "div" });`);
      expect(bad.error).toContain('Parent node not found');
    });
  });

  describe('doc.apply, tokens, console and return', () => {
    it('apply with an array returns one result per op and applies as a batch', async () => {
      const r = await run(`
        const res = doc.apply([
          { type: "renameNodes", changes: [{ nodeId: "${f.ids['Title']}", name: "H1" }] },
          { type: "updateStyles", nodeIds: ["${f.ids['Title']}"], styles: { color: "blue" } },
          { type: "duplicateNodes", nodeIds: ["${f.ids['Paragraph']}"] },
        ]);
        return { n: res.length, idMap: Object.keys(res[2].idMap).length, op: "op" in res[2] };`);
      expect(r.result).toMatchObject({ n: 3, idMap: 1, op: false });
      expect(r.opsCount).toBe(3);
      expect(node('Title').name).toBe('H1');
      expect(doc().pages[0]!.frames[0]!.children).toHaveLength(5);
      expect(await val(`return doc.apply([]);`)).toEqual([]);
    });

    it('an invalid op becomes an Error in the script (catchable) and the batch is atomic', async () => {
      const r = await run(`
        let error = null;
        try {
          doc.apply([
            { type: "renameNodes", changes: [{ nodeId: "${f.ids['Title']}", name: "Middle" }] },
            { type: "renameNodes", changes: [{ nodeId: "el_does_not_exist", name: "x" }] },
          ]);
        } catch (e) { error = e.message; }
        let unknown = null;
        try { doc.apply({ type: "doesNotExist" }); } catch (e) { unknown = e.message; }
        return { error, unknown, name: doc.get("${f.ids['Title']}").name };`);
      const v = r.result as { error: string; unknown: string; name: string };
      expect(v.error).toContain('Operation #2');
      expect(v.unknown).toContain('Invalid operation');
      expect(v.name).toBe('Title'); // atomic batch: nothing applied
      expect(r.opsCount).toBe(0);
    });

    it('tokens and setTokens (optional -- prefix, null removes)', async () => {
      const r = await run(`
        const a = doc.tokens();
        const b = doc.setTokens({ "--color": "#fff", font: "Inter" });
        const c = doc.setTokens({ font: null });
        return { a, b, c };`);
      expect(r.error).toBeUndefined();
      expect(r.result).toEqual({
        a: {},
        b: { '--color': '#fff', '--font': 'Inter' },
        c: { '--color': '#fff' },
      });
      expect(doc().tokens).toEqual({ '--color': '#fff' });
      const bad = await run(`doc.setTokens("x");`);
      expect(bad.ok).toBe(false);
    });

    it('console.log collects and return is serialized', async () => {
      const r = await run(`
        console.log("found", doc.select("button").length, { a: 1 });
        console.warn("attention");
        return doc.select("button").map(b => ({ id: b.id, name: b.name }));`);
      expect(r.ok).toBe(true);
      expect(r.logs).toEqual(['found 3 {"a":1}', '[warn] attention']);
      expect(r.result).toHaveLength(3);
      expect(r.images).toEqual([]);
      expect(r.durationMs).toBeGreaterThanOrEqual(0);
    });

    it("doc.selection uses opts.selection or the daemon's and ignores ids that do not exist", async () => {
      f.store.setSelection(f.docId, [f.ids['Title']!, 'el_ghost'], 'editor');
      expect(await val(`return doc.selection().map(n => n.name);`)).toEqual(['Title']);
      const r = await run(`return doc.selection().map(n => n.name);`, {
        selection: [f.ids['Menu']!],
      });
      expect(r.result).toEqual(['Menu']);
    });
  });

  describe('undo per run', () => {
    it('renaming 10 nodes becomes ONE undo entry', async () => {
      const make = await run(`
        for (let i = 0; i < 10; i++) doc.create(doc.get("${f.ids['Footer']}"), { tag: "span", name: "item" + i, text: "i" });
        return 1;`);
      expect(make.opsCount).toBe(10);
      const before = doc()
        .pages[0]!.frames[0]!.children.at(-1)!
        .children.map((c) => c.name);
      expect(before).toHaveLength(10);
      const r = await run(`
        const nodes = doc.select("footer > span");
        nodes.forEach((n, i) => { n.name = "New " + i; });
        return nodes.length;`);
      expect(r.ok).toBe(true);
      expect(r.opsCount).toBe(10);
      const names = () =>
        doc()
          .pages[0]!.frames[0]!.children.at(-1)!
          .children.map((c) => c.name);
      expect(names()[3]).toBe('New 3');
      f.store.undo(f.docId, 'editor');
      expect(names()).toEqual(before); // one undo restores the 10 names
      f.store.undo(f.docId, 'editor'); // the next one undoes the creation of the 10 nodes (another run)
      expect(doc().pages[0]!.frames[0]!.children.at(-1)!.children).toHaveLength(0);
    });

    it('error midway: earlier ops stay applied, in the same group, and ok is false', async () => {
      const r = await run(`
        doc.get("${f.ids['Title']}").name = "Changed";
        doc.get("${f.ids['Paragraph']}").text = "Changed too";
        throw new Error("failed midway");`);
      expect(r.ok).toBe(false);
      expect(r.error).toBe('failed midway (line 4)');
      expect(r.opsCount).toBe(2);
      expect(node('Title').name).toBe('Changed');
      f.store.undo(f.docId, 'editor');
      expect(node('Title').name).toBe('Title');
      expect(node('Paragraph').text).toBe('Paragraph text.');
    });

    it('consecutive runs have separate groups; a group received via opts is shared', async () => {
      await run(`doc.get("${f.ids['Title']}").name = "A";`);
      await run(`doc.get("${f.ids['Title']}").name = "B";`);
      f.store.undo(f.docId, 'editor');
      expect(node('Title').name).toBe('A');
      f.store.undo(f.docId, 'editor');
      expect(node('Title').name).toBe('Title');

      await run(`doc.get("${f.ids['Title']}").name = "C";`, { group: 'turn:1' });
      await run(`doc.get("${f.ids['Paragraph']}").text = "D";`, { group: 'turn:1' });
      f.store.undo(f.docId, 'editor');
      expect(node('Title').name).toBe('Title');
      expect(node('Paragraph').text).toBe('Paragraph text.');
    });

    it('ops go out with the requested source (editor by default, mcp in run_script)', async () => {
      const sources: string[] = [];
      f.store.on('doc:changed', (e) => sources.push(e.source));
      await run(`doc.get("${f.ids['Title']}").name = "A";`);
      await run(`doc.get("${f.ids['Title']}").name = "B";`, { source: 'mcp' });
      expect(sources).toEqual(['editor', 'mcp']);
    });
  });

  describe('screenshot', () => {
    it('without render: error with the render-unavailable message', async () => {
      const r = await run(`doc.screenshot();`);
      expect(r.ok).toBe(false);
      expect(r.error).toContain('render engine is not available');
      expect(r.images).toEqual([]);
    });

    it('with render: returns metadata to the script and the image in images', async () => {
      const calls: { nodeId: string; scale?: number; format?: string }[] = [];
      const render: RenderProvider = {
        async capture(req) {
          calls.push({ nodeId: req.nodeId, scale: req.scale, format: req.format });
          return {
            data: Buffer.from([1, 2, 3]),
            mime: req.format === 'jpg' ? 'image/jpeg' : 'image/png',
            width: 1440,
            height: 900,
            pixelWidth: 1440,
            pixelHeight: 900,
          };
        },
        async measure() {
          throw new Error('not used');
        },
      };
      const g = await setup({ render });
      try {
        g.store.setSelection(g.docId, [g.ids['Menu']!], 'editor');
        const r = await g.svc.run(
          g.docId,
          `const a = doc.screenshot();
           const b = doc.screenshot(doc.selectOne("button"), { scale: 2, format: "jpg" });
           const c = doc.screenshot("${g.ids['frame']}");
           return [a, b, c];`,
        );
        expect(r.error).toBeUndefined();
        expect(r.images).toHaveLength(3);
        expect(r.images[0]).toMatchObject({
          nodeId: g.ids['Menu'],
          mime: 'image/png',
          data: 'AQID',
        });
        expect(r.images[1]).toMatchObject({ nodeId: g.ids['Button Buy'], mime: 'image/jpeg' });
        expect(r.result).toEqual([
          { nodeId: g.ids['Menu'], width: 1440, height: 900, mime: 'image/png' },
          { nodeId: g.ids['Button Buy'], width: 1440, height: 900, mime: 'image/jpeg' },
          { nodeId: g.ids['frame'], width: 1440, height: 900, mime: 'image/png' },
        ]);
        expect(calls[1]).toMatchObject({ scale: 2, format: 'jpg' });
        // with no selection it uses the first frame
        g.store.setSelection(g.docId, [], 'editor');
        const d = await g.svc.run(g.docId, `return doc.screenshot().nodeId;`);
        expect(d.result).toBe(g.ids['frame']);
        const bad = await g.svc.run(g.docId, `doc.screenshot("el_nothing");`);
        expect(bad.error).toContain('Node not found');
        const badScale = await g.svc.run(g.docId, `doc.screenshot(null, { scale: 9 });`);
        expect(badScale.error).toContain('scale');
        const many = await g.svc.run(g.docId, `for (let i = 0; i < 20; i++) doc.screenshot();`);
        expect(many.error).toContain('Too many screenshots');
        expect(many.images).toHaveLength(8);
      } finally {
        await g.store.closeAll();
        g.ws.cleanup();
      }
    });
  });

  it('a nonexistent document rejects the run', async () => {
    await expect(f.svc.run('doc_does_not_exist', 'return 1')).rejects.toThrow();
  });

  it('runs beyond the concurrency limit wait their turn', async () => {
    const svc = new ScriptService(f.store, { maxConcurrent: 1 });
    const t0 = Date.now();
    const [a, b] = await Promise.all([
      svc.run(f.docId, 'return 1;'),
      svc.run(f.docId, 'return 2;'),
    ]);
    expect([a.result, b.result]).toEqual([1, 2]);
    expect(Date.now() - t0).toBeGreaterThan(0);
  });

  it('timeout: interrupts, returns ok:false and the ops already done stay in the group', async () => {
    const r = await run(`doc.get("${f.ids['Title']}").name = "Before the loop"; for (;;) {}`, {
      timeoutMs: 300,
    });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('time limit');
    expect(r.opsCount).toBe(1);
    f.store.undo(f.docId, 'editor');
    expect(node('Title').name).toBe('Title');
  });

  describe('cancellation (alive and signal)', () => {
    it('alive() turns false midway: earlier ops stay, no new ones', async () => {
      let alive = true;
      let writes = 0;
      // after the first write the turn "ends"
      f.store.on('doc:changed', () => {
        if (++writes === 1) alive = false;
      });
      const r = await run(
        `doc.get("${f.ids['Title']}").name = "First";
         const errors = [];
         const attempt = (fn) => { try { fn(); errors.push(null); } catch (e) { errors.push(e.message); } };
         attempt(() => { doc.get("${f.ids['Paragraph']}").name = "Second"; });
         attempt(() => doc.create(null, { tag: "div" }));
         attempt(() => doc.setTokens({ "--color": "red" }));
         attempt(() => doc.apply({ type: "deleteNodes", nodeIds: ["${f.ids['Footer']}"] }));
         attempt(() => doc.get("${f.ids['Footer']}").remove());
         attempt(() => doc.get("${f.ids['Footer']}").duplicate());
         attempt(() => { doc.get("${f.ids['Title']}").style.color = "red"; });
         attempt(() => doc.get("${f.ids['Title']}").setStyle({ color: "red" }));
         return errors;`,
        { alive: () => alive, group: 'turn:t1' },
      );
      expect(r.ok, r.error).toBe(true);
      const errors = r.result as (string | null)[];
      expect(errors).toHaveLength(8);
      for (const e of errors) expect(e).toContain('assistant turn ended');
      expect(r.opsCount).toBe(1);
      expect(node('Title').name).toBe('First');
      expect(node('Paragraph').name).toBe('Paragraph');
      expect(node('Footer')).toBeTruthy();
      expect(node('Title').style['color']).not.toBe('red');
      expect(doc().tokens['--color']).toBeUndefined();
    });

    it('a signal aborted during a loop ends quickly with ok:false and keeps the ops already done', async () => {
      const ac = new AbortController();
      const t0 = Date.now();
      const p = run(`doc.get("${f.ids['Title']}").name = "Before"; while (true) {}`, {
        timeoutMs: 30_000,
        signal: ac.signal,
      });
      setTimeout(() => ac.abort(), 300);
      const r = await p;
      expect(r.ok).toBe(false);
      expect(r.error).toContain('cancelled');
      expect(r.opsCount).toBe(1);
      expect(Date.now() - t0).toBeLessThan(2000);
    });

    it('watchdog: a false alive() stops a loop with no API calls', async () => {
      let alive = true;
      setTimeout(() => (alive = false), 200);
      const t0 = Date.now();
      const r = await run('while (true) {}', { timeoutMs: 30_000, alive: () => alive });
      expect(r.ok).toBe(false);
      expect(r.error).toContain('assistant turn ended');
      expect(Date.now() - t0).toBeLessThan(1500);
    });
  });
});

describe('ScriptService: scripts/*.js library', () => {
  let f: Fixture;
  beforeEach(async () => {
    f = await setup();
  });
  afterEach(async () => {
    await f.store.closeAll();
    f.ws.cleanup();
  });

  it('normalizes names and rejects path traversal', () => {
    expect(normalizeScriptName('rename')).toBe('rename.js');
    expect(normalizeScriptName('Change color-1.v2.js')).toBe('Change color-1.v2.js');
    expect(normalizeScriptName('buttons.JS')).toBe('buttons.js');
    for (const bad of [
      '',
      '  ',
      '../x',
      '..',
      'a/b',
      'a\\b',
      '/etc/passwd',
      'C:\\x',
      'a..b',
      '.hidden',
      'con',
      'nul.js',
      'a;b',
      'a$b',
      'x'.repeat(120),
      '.js',
    ]) {
      expect(() => normalizeScriptName(bad), JSON.stringify(bad)).toThrow(/Invalid|Provide/);
    }
    expect(() => normalizeScriptName(5)).toThrow();
  });

  it('save, list (sorted), read and delete', async () => {
    expect(await f.svc.list(f.docId)).toEqual({
      dir: path.join(f.ws.dir, 'scripts'),
      scripts: [],
    });
    expect(await f.svc.save(f.docId, 'zebra', 'return 1;')).toEqual({ name: 'zebra.js' });
    await f.svc.save(f.docId, 'Alpha.js', 'return "a";');
    await f.svc.save(f.docId, 'beta', 'return 22;');
    fs.writeFileSync(path.join(f.ws.dir, 'scripts', 'readme.txt'), 'x');
    fs.mkdirSync(path.join(f.ws.dir, 'scripts', 'folder.js'));
    const list = await f.svc.list(f.docId);
    expect(list.scripts.map((s) => s.name)).toEqual(['Alpha.js', 'beta.js', 'zebra.js']);
    expect(list.scripts[1]).toMatchObject({ name: 'beta.js', size: 10 });
    expect(Date.parse(list.scripts[1]!.updatedAt)).not.toBeNaN();
    expect(await f.svc.read(f.docId, 'beta')).toEqual({ name: 'beta.js', code: 'return 22;' });
    await f.svc.save(f.docId, 'beta.js', 'return 23;');
    expect((await f.svc.read(f.docId, 'beta.js')).code).toBe('return 23;');
    await f.svc.remove(f.docId, 'beta');
    expect((await f.svc.list(f.docId)).scripts.map((s) => s.name)).toEqual([
      'Alpha.js',
      'zebra.js',
    ]);
    await expect(f.svc.read(f.docId, 'beta')).rejects.toThrow(/not found/);
    await expect(f.svc.remove(f.docId, 'beta')).rejects.toThrow(/not found/);
  });

  it('rejects dangerous names without touching the disk', async () => {
    for (const bad of ['../outside', '..\\outside', 'a/../../outside', '/abs', 'sub/dir']) {
      await expect(f.svc.save(f.docId, bad, 'x')).rejects.toThrow(/Invalid/);
      await expect(f.svc.read(f.docId, bad)).rejects.toThrow(/Invalid/);
      await expect(f.svc.remove(f.docId, bad)).rejects.toThrow(/Invalid/);
    }
    expect(fs.existsSync(path.join(f.ws.dir, 'outside.js'))).toBe(false);
    expect(fs.existsSync(path.join(f.ws.dir, 'scripts'))).toBe(false);
    await expect(f.svc.save(f.docId, 'ok', 'x'.repeat(600_000))).rejects.toThrow(/too large/);
  });

  it('document without a path: empty list with dir null and a clear error on save', async () => {
    const orig = f.store.getInfo.bind(f.store);
    f.store.getInfo = (id: string) => ({ ...orig(id), path: null });
    expect(await f.svc.list(f.docId)).toEqual({ dir: null, scripts: [] });
    await expect(f.svc.save(f.docId, 'a', 'x')).rejects.toThrow(/save it/);
    await expect(f.svc.read(f.docId, 'a')).rejects.toThrow(/save it/);
  });

  it('script:* through handle (WebSocket messages)', async () => {
    const h = (msg: Record<string, unknown>) =>
      f.svc.handle({ reqId: 'r', docId: f.docId, ...msg } as never);
    expect(await h({ type: 'script:save', name: 'x', code: 'return doc.name;' })).toEqual({
      name: 'x.js',
    });
    expect(await h({ type: 'script:list' })).toMatchObject({ scripts: [{ name: 'x.js' }] });
    expect(await h({ type: 'script:read', name: 'x' })).toEqual({
      name: 'x.js',
      code: 'return doc.name;',
    });
    const run = (await h({ type: 'script:run', code: 'return doc.selection().length;' })) as {
      ok: boolean;
      result: number;
    };
    expect(run).toMatchObject({ ok: true, result: 0, opsCount: 0 });
    const sel = (await h({
      type: 'script:run',
      code: 'return doc.selection().map(n => n.id);',
      selection: [f.ids['Menu']],
    })) as { result: string[] };
    expect(sel.result).toEqual([f.ids['Menu']]);
    expect(await h({ type: 'script:delete', name: 'x' })).toEqual({});
    await expect(h({ type: 'script:run', code: 5 })).rejects.toThrow(/"code"/);
    await expect(h({ type: 'script:run', code: '1', selection: 'x' })).rejects.toThrow(/selection/);
    await expect(h({ type: 'script:read', name: 7 })).rejects.toThrow(/script name/);
  });
});

describe('ScriptService: generate with AI', () => {
  let f: Fixture;
  afterEach(async () => {
    await f.store.closeAll();
    f.ws.cleanup();
  });

  const fakeAssistant = (reply: string, seen: { prompt?: string; system?: string } = {}) =>
    ({
      generateText: async (prompt: string, o?: { system?: string }) => {
        seen.prompt = prompt;
        seen.system = o?.system;
        return reply;
      },
    }) as unknown as AssistantServiceApi;

  it('extracts the ```js``` block and sends the system prompt with the API', async () => {
    const seen: { prompt?: string; system?: string } = {};
    f = await setup({
      assistant: fakeAssistant(
        'Sure!\n```js\nreturn doc.select("button").length;\n```\nDone.',
        seen,
      ),
    });
    f.store.setSelection(f.docId, [f.ids['Menu']!], 'editor');
    const r = await f.svc.generate(f.docId, 'count the buttons');
    expect(r.code).toBe('return doc.select("button").length;');
    expect(seen.prompt).toContain('count the buttons');
    expect(seen.prompt).toContain(f.ids['Menu']);
    expect(seen.system).toContain('doc.select');
    expect(seen.system).toContain("ONLY with the script's JavaScript code");
    const run = await f.svc.run(f.docId, r.code);
    expect(run.result).toBe(3);
  });

  it('accepts a code-only reply, a fence without a language and an unclosed fence', async () => {
    f = await setup({ assistant: fakeAssistant('return 1;') });
    expect((await f.svc.generate(f.docId, 'x')).code).toBe('return 1;');
    await f.store.closeAll();
    f.ws.cleanup();
    f = await setup({ assistant: fakeAssistant('```\nreturn 2;\n```') });
    expect((await f.svc.generate(f.docId, 'x')).code).toBe('return 2;');
    await f.store.closeAll();
    f.ws.cleanup();
    f = await setup({ assistant: fakeAssistant('```javascript\nreturn 3;') });
    expect((await f.svc.generate(f.docId, 'x')).code).toBe('return 3;');
  });

  it('errors: no assistant, empty prompt and empty reply', async () => {
    f = await setup();
    await expect(f.svc.generate(f.docId, 'x')).rejects.toThrow(/assistant/);
    await f.store.closeAll();
    f.ws.cleanup();
    f = await setup({ assistant: fakeAssistant('   ') });
    await expect(f.svc.generate(f.docId, '  ')).rejects.toThrow(/Describe/);
    await expect(f.svc.generate(f.docId, 'do something')).rejects.toThrow(/returned no code/);
  });

  it('script:generate through handle', async () => {
    f = await setup({ assistant: fakeAssistant('```js\nreturn 5;\n```') });
    const r = await f.svc.handle({
      type: 'script:generate',
      reqId: 'r',
      docId: f.docId,
      prompt: 'five',
    });
    expect(r).toEqual({ code: 'return 5;' });
  });
});
