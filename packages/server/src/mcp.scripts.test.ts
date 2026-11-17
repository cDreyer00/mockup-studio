import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { findNode } from '@mockup/core';
import { startDaemon, type DaemonHandle } from './index.js';
import { createMcpServer } from './mcp/server.js';
import type { CaptureRequest, RenderProvider } from './render.js';
import { ScriptService } from './scripts/service.js';
import { makeWorkspace } from './test-utils.js';

type Ws = ReturnType<typeof makeWorkspace>;
type Content = { type: string; text?: string; data?: string; mimeType?: string };

const contentOf = (r: unknown): Content[] => (r as { content: Content[] }).content;
const textOf = (r: unknown): string =>
  contentOf(r)
    .filter((c) => c.type === 'text')
    .map((c) => c.text)
    .join('\n');

const PNG_1x1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==',
  'base64',
);

describe('MCP: run_script and list_scripts', () => {
  let ws: Ws;
  let daemon: DaemonHandle;
  let client: Client;
  let captures: CaptureRequest[];

  const render: RenderProvider = {
    async capture(req) {
      captures.push(req);
      return {
        data: PNG_1x1,
        mime: 'image/png',
        width: 1440,
        height: 900,
        pixelWidth: 1,
        pixelHeight: 1,
      };
    },
    async measure() {
      throw new Error('not used');
    },
  };

  const start = async (withRender: boolean) => {
    ws = makeWorkspace();
    captures = [];
    daemon = await startDaemon({
      port: 0,
      dataDir: ws.dataDir,
      writeInfo: false,
      render: withRender ? render : undefined,
    });
    client = new Client({ name: 'test', version: '0.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(daemon.mcpUrl)));
    await client.callTool({ name: 'open_document', arguments: { path: ws.file } });
  };
  const stop = async () => {
    await client.close();
    await daemon.close();
    ws.cleanup();
  };
  const call = (name: string, args: Record<string, unknown> = {}) =>
    client.callTool({ name, arguments: args });
  const docId = () => daemon.store.list()[0]!.docId;
  const names = (): string[] => {
    const out: string[] = [];
    const walk = (list: { name: string; children: unknown[] }[]) => {
      for (const n of list) {
        out.push(n.name);
        walk(n.children as never);
      }
    };
    walk(daemon.store.get(docId()).pages[0]!.frames as never);
    return out;
  };

  describe('without render', () => {
    beforeEach(() => start(false));
    afterEach(stop);

    it('get_guide("scripts") returns the full API', async () => {
      const t = textOf(await call('get_guide', { topic: 'scripts' }));
      expect(t.startsWith('# ')).toBe(true);
      expect(t.length).toBeGreaterThan(200);
      for (const s of [
        'doc.select',
        'doc.selectOne',
        'doc.apply',
        'doc.screenshot',
        'doc.setTokens',
        'node.style',
        'duplicate',
        'timeout',
        'run_script',
      ]) {
        expect(t, s).toContain(s);
      }
    });

    it('lists the tools with a short description, example and described parameters', async () => {
      const { tools } = await client.listTools();
      for (const name of ['run_script', 'list_scripts']) {
        const t = tools.find((x) => x.name === name);
        expect(t, name).toBeTruthy();
        expect(t!.description!.length).toBeLessThanOrEqual(300);
        const props = (t!.inputSchema.properties ?? {}) as Record<string, { description?: string }>;
        for (const [k, v] of Object.entries(props))
          expect(v.description, `${name}.${k}`).toBeTruthy();
      }
    });

    it('runs a script, returns text with ops, result and summary; one undo reverts it', async () => {
      await call('create_node', {
        parentId: ws.frameId,
        tag: 'button',
        text: 'A',
        name: 'Button A',
      });
      await call('create_node', {
        parentId: ws.frameId,
        tag: 'button',
        text: 'B',
        name: 'Button B',
      });
      const r = await call('run_script', {
        code: `
          const buttons = doc.select("button");
          buttons.forEach((b, i) => { b.name = "CTA " + (i + 1); b.style.background = "#2563eb"; });
          console.log("found", buttons.length);
          return buttons.map((b) => b.id).length;`,
      });
      expect(r.isError).toBeFalsy();
      const t = textOf(r);
      expect(t).toContain('Script ok: 4 op(s)');
      expect(t).toContain('found 2');
      expect(t).toContain('Result: 2');
      expect(t).toContain('CTA 1');
      expect(t).toContain('CTA 2');
      expect(names()).toContain('CTA 2');
      const u = await call('undo');
      expect(textOf(u)).toContain('Undone');
      expect(names()).toContain('Button A');
      expect(names()).toContain('Button B');
      expect(names()).not.toContain('CTA 1');
    });

    it('a read-only script applies no ops and includes no summary', async () => {
      const r = await call('run_script', { code: 'return doc.frames().map(f => f.name);' });
      const t = textOf(r);
      expect(t).toContain('Script ok: 0 op(s)');
      expect(t).toContain('"Desktop"');
      expect(t).not.toContain('Summary:');
    });

    it('a script error becomes isError with logs and the number of ops already applied', async () => {
      const r = await call('run_script', {
        code: `
          console.log("starting");
          doc.frames()[0].name = "Renamed";
          throw new Error("went wrong");`,
      });
      expect(r.isError).toBe(true);
      const t = textOf(r);
      expect(t).toContain('Script failed: went wrong');
      expect(t).toContain('starting');
      expect(t).toContain('1 op(s) were already applied');
      expect(names()).toContain('Renamed');
      await call('undo');
      expect(names()).toContain('Desktop');
    });

    it('a syntax error, a timeout and an escape attempt are clear errors and the server keeps going', async () => {
      const syn = await call('run_script', { code: 'let = = 1' });
      expect(syn.isError).toBe(true);
      expect(textOf(syn)).toContain('Syntax error');
      const loop = await call('run_script', { code: 'while (true) {}', timeoutMs: 300 });
      expect(loop.isError).toBe(true);
      expect(textOf(loop)).toContain('time limit');
      const esc = await call('run_script', {
        code: 'return this.constructor.constructor("return process")();',
      });
      expect(esc.isError).toBe(true);
      const ok = await call('run_script', { code: 'return 1 + 1;' });
      expect(textOf(ok)).toContain('Result: 2');
    });

    it('requires code OR name and validates the types', async () => {
      const none = await call('run_script', {});
      expect(none.isError).toBe(true);
      expect(textOf(none)).toContain('code');
      const both = await call('run_script', { code: '1', name: 'x' });
      expect(both.isError).toBe(true);
      const big = await call('run_script', { code: '1', timeoutMs: 999_999 });
      expect(big.isError).toBe(true);
    });

    it('screenshot without render explains the unavailability', async () => {
      const r = await call('run_script', { code: 'doc.screenshot();' });
      expect(r.isError).toBe(true);
      expect(textOf(r)).toContain('render engine is not available');
    });

    it('list_scripts and run_script({ name }) use the scripts/ folder next to the document', async () => {
      const empty = textOf(await call('list_scripts'));
      expect(empty).toContain('No scripts');
      expect(empty).toContain(path.join(ws.dir, 'scripts'));
      fs.mkdirSync(path.join(ws.dir, 'scripts'));
      fs.writeFileSync(
        path.join(ws.dir, 'scripts', 'count-frames.js'),
        'return doc.frames().length;',
      );
      fs.writeFileSync(path.join(ws.dir, 'scripts', 'a-first.js'), 'return 0;');
      const list = textOf(await call('list_scripts'));
      expect(list).toContain('2 script(s)');
      expect(list.indexOf('a-first.js')).toBeLessThan(list.indexOf('count-frames.js'));
      const r = await call('run_script', { name: 'count-frames' });
      expect(textOf(r)).toContain('Result: 1');
      const miss = await call('run_script', { name: 'does-not-exist' });
      expect(miss.isError).toBe(true);
      expect(textOf(miss)).toContain('not found');
      const evil = await call('run_script', { name: '../../x' });
      expect(evil.isError).toBe(true);
      expect(textOf(evil)).toContain('Invalid');
    });

    it('doc.create + doc.apply over MCP and the document reflects the changes', async () => {
      const r = await call('run_script', {
        code: `
          const card = doc.create(doc.frames()[0], { tag: "section", name: "Card", children: [{ tag: "h2", text: "Hi" }] });
          doc.apply({ type: "updateStyles", nodeIds: [card.id], styles: { padding: "16px" } });
          return card.id;`,
      });
      expect(r.isError).toBeFalsy();
      const id = /Result: "(el_[0-9a-z]+)"/.exec(textOf(r))![1]!;
      const n = findNode(daemon.store.get(docId()), id)!.node;
      expect(n.style['padding']).toBe('16px');
      expect(n.children[0]!.text).toBe('Hi');
    });
  });

  describe('with render', () => {
    beforeEach(() => start(true));
    afterEach(stop);

    it('doc.screenshot() goes into the result as an image, before the text', async () => {
      const r = await call('run_script', {
        code: 'const i = doc.screenshot(); return i;',
      });
      expect(r.isError).toBeFalsy();
      const [img, txt] = contentOf(r);
      expect(img!.type).toBe('image');
      expect(img!.mimeType).toBe('image/png');
      expect(Buffer.from(img!.data!, 'base64').equals(PNG_1x1)).toBe(true);
      expect(txt!.text).toContain('Images: 1');
      expect(txt!.text).toContain(`${ws.frameId} 1440x900`);
      expect(captures[0]).toMatchObject({ nodeId: ws.frameId, scale: 1, format: 'png' });
    });
  });
});

describe('MCP: run_script inside an assistant turn', () => {
  let ws: Ws;
  let daemon: DaemonHandle;
  let client: Client;
  let turnOpen = true;

  beforeEach(async () => {
    ws = makeWorkspace();
    turnOpen = true;
    daemon = await startDaemon({ port: 0, dataDir: ws.dataDir, writeInfo: false });
    const { docId } = await daemon.store.open(ws.file);
    const server = createMcpServer(daemon.store, {
      services: { scripts: new ScriptService(daemon.store) },
      turn: () => (turnOpen ? { turnId: 't1', docId, group: 'turn:t1' } : null),
    });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(b);
    client = new Client({ name: 'test', version: '0.0.0' });
    await client.connect(a);
  });
  afterEach(async () => {
    await client.close();
    await daemon.close();
    ws.cleanup();
  });

  it("the script joins the turn's undo group (and does not close it)", async () => {
    const { docId } = daemon.store.list()[0]!;
    const run = (code: string) => client.callTool({ name: 'run_script', arguments: { code } });
    await run('doc.frames()[0].name = "One";');
    await client.callTool({
      name: 'rename_nodes',
      arguments: { nodeIds: [ws.frameId], names: ['Two'] },
    });
    await run('doc.frames()[0].name = "Three";');
    expect(daemon.store.get(docId).pages[0]!.frames[0]!.name).toBe('Three');
    daemon.store.undo(docId, 'editor');
    expect(daemon.store.get(docId).pages[0]!.frames[0]!.name).toBe('Desktop');
  });

  it('turn ended: the script is rejected without running', async () => {
    turnOpen = false;
    const { docId } = daemon.store.list()[0]!;
    const r = await client.callTool({
      name: 'run_script',
      arguments: { code: 'doc.frames()[0].name = "X";' },
    });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toContain('already ended');
    expect(daemon.store.get(docId).pages[0]!.frames[0]!.name).toBe('Desktop');
  });
  it('the turn ends during a script in a write loop: it stops and writes no more', async () => {
    const { docId } = daemon.store.list()[0]!;
    const name = () => daemon.store.get(docId).pages[0]!.frames[0]!.name;
    setTimeout(() => (turnOpen = false), 300);
    const t0 = Date.now();
    const r = await client.callTool({
      name: 'run_script',
      arguments: {
        code: 'let i = 0; for (;;) { doc.frames()[0].name = "N" + i++; }',
        timeoutMs: 30_000,
      },
    });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toContain('assistant turn ended');
    expect(Date.now() - t0).toBeLessThan(3000);
    const after = name();
    expect(after).toMatch(/^N\d+$/);
    await new Promise((res) => setTimeout(res, 300));
    expect(name()).toBe(after);
  });

  it('the turn ends during a loop with no API calls: the watchdog stops the worker', async () => {
    const { docId } = daemon.store.list()[0]!;
    setTimeout(() => (turnOpen = false), 300);
    const t0 = Date.now();
    const r = await client.callTool({
      name: 'run_script',
      arguments: {
        code: 'doc.frames()[0].name = "Once"; while (true) {}',
        timeoutMs: 30_000,
      },
    });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toContain('assistant turn ended');
    expect(textOf(r)).toContain('1 op(s) were already applied');
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(daemon.store.get(docId).pages[0]!.frames[0]!.name).toBe('Once');
  });
});
