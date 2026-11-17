import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { fontFaceCss } from '@mockup/core';
import type * as AssetsModule0 from './assets.js';
import { startDaemon, type DaemonHandle } from './index.js';
import { mergeIdenticalFiles } from './mcp/tools/fonts.js';
import { makeWorkspace } from './test-utils.js';

type AssetsModule = typeof AssetsModule0;

// No network: the CSS and files from Google come from mocked responses.
const { variable } = vi.hoisted(() => ({ variable: { current: true } }));
vi.mock('./assets.js', async (orig) => {
  const real = await orig<AssetsModule>();
  return {
    ...real,
    fetchBytes: async (url: string, opts: Parameters<typeof real.fetchBytes>[1]) => {
      if (url.startsWith('https://fonts.googleapis.com/')) {
        const weights = /wght@([\d;]+)/.exec(url)![1]!.split(';');
        const css = weights
          .map(
            (w) =>
              `/* latin */\n@font-face {\n  font-family: 'Inter';\n  font-style: normal;\n  font-weight: ${w};\n  src: url(https://fonts.gstatic.com/inter-${variable.current ? 'var' : w}.woff2) format('woff2');\n}`,
          )
          .join('\n');
        return { bytes: Buffer.from(css), contentType: 'text/css' };
      }
      if (url.startsWith('https://fonts.gstatic.com/'))
        return { bytes: Buffer.from(url), contentType: 'font/woff2' };
      return real.fetchBytes(url, opts);
    },
  };
});

const textOf = (r: unknown): string =>
  (r as { content: { type: string; text?: string }[] }).content
    .filter((c) => c.type === 'text')
    .map((c) => c.text)
    .join('\n');

describe('add_font google: variable font', () => {
  let ws: ReturnType<typeof makeWorkspace>;
  let daemon: DaemonHandle;
  let client: Client;

  beforeEach(async () => {
    ws = makeWorkspace();
    daemon = await startDaemon({ port: 0, dataDir: ws.dataDir, writeInfo: false });
    client = new Client({ name: 'test', version: '0.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(daemon.mcpUrl)));
    await client.callTool({ name: 'open_document', arguments: { path: ws.file } });
  });
  afterEach(async () => {
    variable.current = true;
    await client.close();
    await daemon.close();
    ws.cleanup();
  });
  const doc = () => daemon.store.get(daemon.store.resolveDocId());
  const fontsDir = () => path.join(ws.dir, 'assets', 'fonts');

  it('same content for several weights: one file and one @font-face with a range', async () => {
    const r = await client.callTool({
      name: 'add_font',
      arguments: { family: 'Inter', source: 'google', weights: [400, 500, 600, 700] },
    });
    expect(r.isError, textOf(r)).toBeFalsy();
    expect(fs.readdirSync(fontsDir())).toHaveLength(1);
    const font = doc().fonts[0]!;
    expect(font.files).toHaveLength(1);
    expect(font.weights).toEqual([400, 500, 600, 700]);
    const css = fontFaceCss(doc(), (f) => `assets/${f}`);
    expect(css.split('\n')).toHaveLength(1);
    expect(css).toContain('font-weight:400 700');
  });

  it('different files per weight stay one per weight', async () => {
    variable.current = false;
    await client.callTool({
      name: 'add_font',
      arguments: { family: 'Inter', source: 'google', weights: [400, 700] },
    });
    expect(fs.readdirSync(fontsDir())).toHaveLength(2);
    expect(doc().fonts[0]!.weights).toEqual([400, 700]);
    const css = fontFaceCss(doc(), (f) => f);
    expect(css).toContain('font-weight:400;');
    expect(css).toContain('font-weight:700;');
  });
});

describe('mergeIdenticalFiles: normal and italic', () => {
  const f = (weight: number, style: 'normal' | 'italic', content: string) => ({
    bytes: Buffer.from(content),
    ext: 'woff2',
    weight,
    style,
  });

  it('merges per style when each group has identical files', () => {
    const out = mergeIdenticalFiles([
      f(400, 'normal', 'N'),
      f(700, 'normal', 'N'),
      f(400, 'italic', 'I'),
      f(700, 'italic', 'I'),
    ]);
    expect(out).toHaveLength(2);
    expect(out.map((x) => [x.style, x.weight, x.weightMax])).toEqual([
      ['normal', 400, 700],
      ['italic', 400, 700],
    ]);
  });

  it('merges nothing if a group has different files (weights would end up mixed)', () => {
    const files = [
      f(400, 'normal', 'N'),
      f(700, 'normal', 'N'),
      f(400, 'italic', 'I1'),
      f(700, 'italic', 'I2'),
    ];
    expect(mergeIdenticalFiles(files)).toEqual(files);
  });

  it('merges nothing if a style has only one file', () => {
    const files = [f(400, 'normal', 'N'), f(700, 'normal', 'N'), f(400, 'italic', 'I')];
    expect(mergeIdenticalFiles(files)).toEqual(files);
  });
});
