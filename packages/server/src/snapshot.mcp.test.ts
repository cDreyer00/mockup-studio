import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createNodeFromTag, findNode } from '@mockup/core';
import {
  SNAPSHOT_FORMAT,
  SNAPSHOT_VERSION,
  type PageSnapshotRequest,
  type SnapshotPayload,
} from '@mockup/snapshot-core';
import { startDaemon, type DaemonHandle } from './index.js';
import type { RenderProvider } from './render.js';
import { makeWorkspace } from './test-utils.js';

const textOf = (r: unknown): string =>
  (r as { content: { type: string; text?: string }[] }).content
    .filter((c) => c.type === 'text')
    .map((c) => c.text)
    .join('\n');

/** Payload with empty, unstyled wrappers, so cleanup_imported has something to do. */
function payload(url = 'https://example.com/'): SnapshotPayload {
  const t = (text: string) => createNodeFromTag('p', { text });
  return {
    format: SNAPSHOT_FORMAT,
    version: SNAPSHOT_VERSION,
    source: {
      url,
      title: 'Example',
      capturedAt: new Date().toISOString(),
      viewport: { width: 1440, height: 900 },
      devicePixelRatio: 1,
    },
    root: createNodeFromTag('main', {
      name: 'Main',
      styles: { width: '1000px', height: '500px' },
      children: [
        createNodeFromTag('div'),
        createNodeFromTag('div', {
          children: [
            createNodeFromTag('div', { styles: { width: '1000px' }, children: [t('Hello')] }),
          ],
        }),
      ],
    }),
    width: 1000,
    height: 500,
    assets: [],
    fonts: [],
    stats: { nodes: 6, truncated: false, warnings: ['Capture warning'] },
  };
}

describe('MCP: website import', () => {
  let ws: ReturnType<typeof makeWorkspace>;
  let daemon: DaemonHandle;
  let client: Client;
  let requests: PageSnapshotRequest[];

  const render: RenderProvider = {
    capture: () => Promise.reject(new Error('unused')),
    measure: () => Promise.reject(new Error('unused')),
    async snapshot(req) {
      requests.push(req);
      return payload(req.kind === 'url' ? req.url : (req.baseUrl ?? 'about:blank'));
    },
  };

  const connect = async (withRender: boolean): Promise<void> => {
    ws = makeWorkspace();
    requests = [];
    daemon = await startDaemon({
      port: 0,
      dataDir: ws.dataDir,
      writeInfo: false,
      openFiles: [ws.file],
      render: withRender ? render : undefined,
    });
    client = new Client({ name: 'test', version: '0.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(daemon.mcpUrl)));
  };
  afterEach(async () => {
    await client.close();
    await daemon.close();
    ws.cleanup();
  });
  const call = (name: string, args: Record<string, unknown> = {}) =>
    client.callTool({ name, arguments: args });
  const docId = (): string => daemon.store.list()[0]!.docId;

  describe('with render', () => {
    beforeEach(() => connect(true));

    it('import_url creates the frame and forwards selector, viewport and timeout to the engine', async () => {
      const r = await call('import_url', {
        url: 'https://example.com/pricing',
        selector: '#pricing',
        width: 1280,
        timeout_ms: 90_000,
        name: 'Pricing',
      });
      expect(r.isError).toBeFalsy();
      expect(requests).toEqual([
        {
          kind: 'url',
          url: 'https://example.com/pricing',
          selector: '#pricing',
          viewport: { width: 1280, height: 900 },
          timeoutMs: 60_000,
        },
      ]);
      expect(daemon.store.get(docId()).pages[0]!.frames).toHaveLength(2);
    });

    it('response: id, name, counts, warnings, summary and next steps', async () => {
      const r = await call('import_url', { url: 'https://example.com/' });
      const t = textOf(r);
      const frame = daemon.store.get(docId()).pages[0]!.frames.at(-1)!;
      expect(t).toContain(`Imported from https://example.com/: ${frame.id} "Example"`);
      expect(t).toMatch(/\(\d+ nodes, 0 images, no new fonts\)/);
      expect(t).toContain('Warnings:');
      expect(t).toContain('- Capture warning');
      expect(t).toContain(`get_screenshot(${frame.id})`);
      expect(t).toContain(`cleanup_imported(${frame.id})`);
      expect(frame.position).toEqual({ x: 1440 + 80, y: 0 });
      expect(findNode(daemon.store.get(docId()), frame.id)).toBeDefined();
    });

    it('uses the mcp source, one history entry, and validates parameters', async () => {
      const sources: string[] = [];
      daemon.store.on('doc:changed', (e) => sources.push(e.source));
      await call('import_url', { url: 'https://example.com/' });
      expect(sources).toEqual(['mcp']);
      const bad = await call('import_url', { url: 'file:///etc/passwd' });
      expect(bad.isError).toBe(true);
      expect(textOf(bad)).toContain('http');
      const wide = await call('import_url', { url: 'https://x.com', width: 100 });
      expect(wide.isError).toBe(true);
      expect(textOf(wide)).toContain('width');
      expect(requests).toHaveLength(1);
    });

    it('import_html uses the computed-styles capture when there is a render engine', async () => {
      const r = await call('import_html', {
        html: '<h1>Hi</h1>',
        css: 'h1{color:red}',
        assets_base_url: 'https://example.com/',
        selector: 'h1',
      });
      expect(r.isError).toBeFalsy();
      expect(textOf(r)).toContain('capture with computed styles');
      expect(requests[0]).toMatchObject({
        kind: 'html',
        html: '<h1>Hi</h1>',
        css: 'h1{color:red}',
        baseUrl: 'https://example.com/',
        selector: 'h1',
        viewport: { width: 1440, height: 900 },
        timeoutMs: 20_000,
      });
    });

    it('cleanup_imported applies in a single history entry; with no changes it says "Nothing to clean"', async () => {
      await call('import_url', { url: 'https://example.com/' });
      const doc0 = daemon.store.get(docId());
      const frame = doc0.pages[0]!.frames.at(-1)!;
      const before = JSON.stringify(frame);
      const r = await call('cleanup_imported', { nodeId: frame.id });
      expect(r.isError).toBeFalsy();
      const t = textOf(r);
      expect(t).toMatch(/1 empty node\(s\) removed, 2 wrapper\(s\) unwrapped, 1 fixed size\(s\)/);
      const after = findNode(daemon.store.get(docId()), frame.id)!.node;
      expect(after.children).toHaveLength(1);
      expect(after.children[0]!.style.width).toBeUndefined();
      expect(after.children[0]!.text).toBe('Hello');
      // one entry: a single undo restores everything
      daemon.store.undo(docId(), 'mcp');
      expect(JSON.stringify(findNode(daemon.store.get(docId()), frame.id)!.node)).toBe(before);
      daemon.store.redo(docId(), 'mcp');
      expect(textOf(await call('cleanup_imported', { nodeId: frame.id }))).toContain(
        'Nothing to clean',
      );
    });

    it('cleanup_imported with options off and a nonexistent node', async () => {
      await call('import_url', { url: 'https://example.com/' });
      const frame = daemon.store.get(docId()).pages[0]!.frames.at(-1)!;
      const none = await call('cleanup_imported', {
        nodeId: frame.id,
        remove_empty: false,
        unwrap: false,
        fluid: false,
      });
      expect(textOf(none)).toContain('Nothing to clean');
      const missing = await call('cleanup_imported', { nodeId: 'el_missing' });
      expect(missing.isError).toBe(true);
    });
  });

  describe('without render', () => {
    beforeEach(() => connect(false));

    it('import_url returns isError explaining and suggesting import_html / the desktop app', async () => {
      const r = await call('import_url', { url: 'https://example.com/' });
      expect(r.isError).toBe(true);
      const t = textOf(r);
      expect(t).toContain('render engine');
      expect(t).toContain('import_html');
      expect(t).toContain('desktop app');
      expect(daemon.store.get(docId()).pages[0]!.frames).toHaveLength(1);
    });

    it('import_html falls back to the core conversion and warns that fidelity is lower', async () => {
      const r = await call('import_html', {
        html: '<section><h1>Title</h1><p>Text</p></section>',
        width: 800,
        height: 600,
        name: 'Section',
      });
      expect(r.isError).toBeFalsy();
      const t = textOf(r);
      expect(t).toContain('conversion without render');
      expect(t).toContain('lower fidelity');
      const frame = daemon.store.get(docId()).pages[0]!.frames.at(-1)!;
      expect(frame.name).toBe('Section');
      expect(frame.style).toMatchObject({ width: '800px', height: '600px' });
      expect(t).toContain(frame.id);
    });

    it('import_html empty or whitespace-only gives the same clear message', async () => {
      const frames = (): number => daemon.store.get(docId()).pages[0]!.frames.length;
      const before = frames();
      for (const html of ['', '   \n\t ']) {
        const r = await call('import_html', { html });
        expect(r.isError, JSON.stringify(html)).toBe(true);
        expect(textOf(r)).toContain('Empty HTML');
      }
      expect(frames()).toBe(before);
    });
  });

  describe('guide', () => {
    beforeEach(() => connect(false));

    it("get_guide('import') covers the tools, the reference and the limitations", async () => {
      const t = textOf(await call('get_guide', { topic: 'import' }));
      expect(t.startsWith('# ')).toBe(true);
      for (const s of [
        'import_url',
        'import_html',
        'cleanup_imported',
        'Reference',
        'hidden:false',
        'set_tokens',
        'selector',
        'width',
        'login',
        'CORS',
      ]) {
        expect(t).toContain(s);
      }
      const { resources } = await client.listResources();
      expect(resources.map((x) => x.uri)).toContain('guide://import');
    });

    it('tools appear with a title, short description and described parameters', async () => {
      const { tools } = await client.listTools();
      for (const name of ['import_url', 'import_html', 'cleanup_imported']) {
        const tool = tools.find((x) => x.name === name)!;
        expect(tool, name).toBeDefined();
        expect(tool.description!.length).toBeLessThanOrEqual(300);
        const props = (tool.inputSchema.properties ?? {}) as Record<
          string,
          { description?: string }
        >;
        for (const [k, v] of Object.entries(props))
          expect(v.description, `${name}.${k}`).toBeTruthy();
      }
    });
  });
});
