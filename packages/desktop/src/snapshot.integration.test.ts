/**
 * REAL page import integration: starts headless Electron, a static http server with
 * the snapshot-core fixtures and calls `import_url`/`import_html` via MCP (Streamable HTTP at /mcp).
 * Requires `npm run build` (snapshot-core, server, desktop and editor) first.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import { createRequire } from 'node:module';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const here = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.resolve(here, '..');
const repo = path.resolve(appDir, '../..');
const fixturesDir = path.join(repo, 'packages/snapshot-core/test/fixtures');
const electronExe = createRequire(import.meta.url)('electron') as string;
const built = fs.existsSync(path.join(appDir, 'out/main/index.js'));
const editorReady = fs.existsSync(path.join(repo, 'packages/editor/dist/render.html'));

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address() as net.AddressInfo;
      s.close(() => resolve(port));
    });
  });
}

async function waitHealth(url: string, child: ChildProcess, ms = 60000): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (child.exitCode !== null) throw new Error(`Electron exited (code ${child.exitCode})`);
    try {
      const r = await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(1000) });
      if (r.ok && ((await r.json()) as { render?: boolean }).render === true) return;
    } catch {
      /* still starting up */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('Timed out waiting for /api/health with render: true');
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.woff2': 'font/woff2',
  '.js': 'text/javascript; charset=utf-8',
};

/** Simple static server; looks for the file in each root, in order. */
function staticServer(
  roots: string[],
  hits: string[] = [],
): Promise<{ server: http.Server; url: string }> {
  const server = http.createServer((req, res) => {
    const rel = decodeURIComponent((req.url ?? '/').split('?')[0]!);
    hits.push(rel);
    for (const root of roots) {
      const file = path.resolve(root, '.' + rel);
      if (!file.startsWith(path.resolve(root) + path.sep)) continue;
      if (fs.existsSync(file) && fs.statSync(file).isFile()) {
        res.writeHead(200, {
          'content-type': MIME[path.extname(file)] ?? 'application/octet-stream',
        });
        res.end(fs.readFileSync(file));
        return;
      }
    }
    res.writeHead(404).end('not found');
  });
  // no host: listens on :: (dual-stack), so `localhost` also gets here and the blocking test
  // proves it was the guard (and not a connection failure) that stopped the request
  return new Promise((resolve) =>
    server.listen(0, () =>
      resolve({ server, url: `http://127.0.0.1:${(server.address() as net.AddressInfo).port}` }),
    ),
  );
}

interface TextResult {
  isError?: boolean;
  content?: { type: string; text?: string }[];
}
const textOf = (r: unknown): string =>
  ((r as TextResult).content ?? [])
    .filter((c) => c.type === 'text')
    .map((c) => c.text ?? '')
    .join('\n');

interface DocNode {
  id: string;
  name: string;
  hidden: boolean;
  children: DocNode[];
}

describe.skipIf(!built || !editorReady)('import_url / import_html (Electron integration)', () => {
  let tmp: string;
  let extraDir: string;
  let child: ChildProcess;
  let daemonUrl: string;
  let web: http.Server;
  let webUrl: string;
  let webPort: number;
  const hits: string[] = [];
  let docId: string;
  let docDir: string;
  let client: Client;
  let stderr = '';

  beforeAll(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mockup-snapshot-'));
    const dataDir = path.join(tmp, 'data');
    fs.mkdirSync(dataDir);
    extraDir = path.join(tmp, 'pages');
    fs.mkdirSync(extraDir);
    const port = await freePort();
    daemonUrl = `http://127.0.0.1:${port}`;

    ({ server: web, url: webUrl } = await staticServer([fixturesDir, extraDir], hits));
    webPort = Number(new URL(webUrl).port);
    fs.writeFileSync(
      path.join(extraDir, 'px.svg'),
      '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"><rect width="20" height="20" fill="red"/></svg>',
    );
    // same origin (relative) vs. another origin on the same machine (localhost, same port)
    fs.writeFileSync(
      path.join(extraDir, 'network.html'),
      `<!doctype html><html><body style="margin:0"><section class="target" style="padding:8px">
  <h1>Network</h1>
  <img alt="same" src="/same.svg" width="20" height="20">
  <img alt="other" src="http://localhost:${webPort}/other.svg" width="20" height="20">
</section></body></html>`,
    );
    fs.copyFileSync(path.join(extraDir, 'px.svg'), path.join(extraDir, 'same.svg'));
    fs.copyFileSync(path.join(extraDir, 'px.svg'), path.join(extraDir, 'other.svg'));
    fs.copyFileSync(path.join(extraDir, 'px.svg'), path.join(extraDir, 'noBase.svg'));
    fs.copyFileSync(path.join(extraDir, 'px.svg'), path.join(extraDir, 'withBase.svg'));

    // hostile pages: they try to read a local file and call the daemon API
    fs.writeFileSync(
      path.join(extraDir, 'hostile.html'),
      `<!doctype html><html><body style="margin:0">
<section class="target" style="padding:24px;background:#eef">
  <h1>Hostile page</h1>
  <img alt="local" src="file:///C:/Windows/win.ini" width="40" height="40">
  <img alt="daemon" src="${daemonUrl}/api/health" width="40" height="40">
  <p>Normal text</p>
</section>
<script>
  fetch('${daemonUrl}/api/docs').catch(() => {});
  fetch('file:///C:/Windows/win.ini').catch(() => {});
  new Image().src = 'http://localhost:${port}/api/health';
</script></body></html>`,
    );

    const file = path.join(tmp, 'doc.mockup.json');
    const env: NodeJS.ProcessEnv = { ...process.env, MOCKUP_DATA_DIR: dataDir };
    delete env.ELECTRON_RUN_AS_NODE;
    child = spawn(
      electronExe,
      [appDir, '--headless', '--port', String(port), '--data-dir', dataDir],
      {
        env,
        stdio: ['ignore', 'ignore', 'pipe'],
        windowsHide: true,
      },
    );
    child.stderr!.on('data', (d: Buffer) => (stderr += d.toString()));
    await waitHealth(daemonUrl, child);

    const r = await fetch(`${daemonUrl}/api/new`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: file, name: 'Import' }),
    });
    const info = (await r.json()) as { docId: string };
    docId = info.docId;
    docDir = path.dirname(file);

    client = new Client({ name: 'snapshot-integration', version: '0.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${daemonUrl}/mcp`)));
  });

  afterAll(async () => {
    await client?.close().catch(() => undefined);
    web?.close();
    if (child && child.exitCode === null) {
      const exited = new Promise((r) => child.once('exit', r));
      if (process.platform === 'win32' && child.pid)
        spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
      else child.kill('SIGKILL');
      await Promise.race([exited, new Promise((r) => setTimeout(r, 10000))]);
    }
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  const getDoc = async (): Promise<{ doc: { pages: { frames: DocNode[] }[] } }> => {
    const r = await fetch(`${daemonUrl}/api/docs/${docId}`);
    return (await r.json()) as { doc: { pages: { frames: DocNode[] }[] } };
  };
  const frames = async (): Promise<DocNode[]> =>
    (await getDoc()).doc.pages.flatMap((p) => p.frames);
  const call = (name: string, args: Record<string, unknown>): Promise<TextResult> =>
    client.callTool({ name, arguments: { docId, ...args } }, undefined, {
      timeout: 60000,
    }) as Promise<TextResult>;

  it('import_url of .hero of the landing page in under 10 s: frame, images in assets/ and hidden Reference', async () => {
    const t0 = Date.now();
    const r = await call('import_url', { url: `${webUrl}/landing/index.html`, selector: '.hero' });
    const ms = Date.now() - t0;
    console.log(`[snapshot] import_url (.hero) took ${ms} ms`);
    const text = textOf(r);
    expect(r.isError, `${text}\n${stderr}`).toBeFalsy();
    expect(ms).toBeLessThan(10_000);
    expect(text).toMatch(/fr_\w+/);

    const all = await frames();
    const imported = all.find((f) => text.includes(f.id) && !f.hidden);
    expect(imported, text).toBeTruthy();
    expect(imported!.children.length).toBeGreaterThan(0);
    const ref = all.find((f) => /Reference/i.test(f.name));
    expect(ref, 'Reference frame').toBeTruthy();
    expect(ref!.hidden).toBe(true);

    const assetsDir = path.join(docDir, 'assets');
    expect(fs.existsSync(assetsDir)).toBe(true);
    expect(fs.readdirSync(assetsDir, { recursive: true }).length).toBeGreaterThan(0);
  });

  it('import_url with file:/// is refused', async () => {
    const bad = pathToFileURL(path.join(extraDir, 'hostile.html')).href;
    let failed = false;
    let text = '';
    try {
      const r = await call('import_url', { url: bad });
      failed = !!r.isError;
      text = textOf(r);
    } catch (e) {
      failed = true;
      text = String(e);
    }
    expect(failed, text).toBe(true);
  });

  it('a page that tries to load file:// and call the daemon does not break the import', async () => {
    const r = await call('import_url', { url: `${webUrl}/hostile.html`, selector: '.target' });
    expect(r.isError, `${textOf(r)}\n${stderr}`).toBeFalsy();
    expect(textOf(r)).toMatch(/fr_\w+/);
    // the daemon is still up
    expect((await fetch(`${daemonUrl}/api/health`)).ok).toBe(true);
  });

  it('import_html with render works', async () => {
    const r = await call('import_html', {
      html: '<section class="x" style="padding:16px"><h2>Hello</h2><p>World</p></section>',
      css: '.x { background: #fafafa; }',
      selector: '.x',
    });
    expect(r.isError, `${textOf(r)}\n${stderr}`).toBeFalsy();
    expect(textOf(r)).toMatch(/fr_\w+/);
  });

  const sawHit = (p: string): boolean => hits.includes(p);
  const docText = async (): Promise<string> => JSON.stringify(await getDoc());

  it('main navigation to http://127.0.0.1 (local dev server) works; a subrequest to another local origin is blocked', async () => {
    const r = await call('import_url', { url: `${webUrl}/network.html`, selector: '.target' });
    expect(
      r.isError,
      `${textOf(r)}
${stderr}`,
    ).toBeFalsy();
    expect(sawHit('/network.html')).toBe(true);
    expect(sawHit('/same.svg')).toBe(true);
    expect(sawHit('/other.svg')).toBe(false);
  });

  it('import_html without baseUrl: the page JavaScript does not run and the local network is blocked', async () => {
    const r = await call('import_html', {
      html: `<section class="target"><h1>Original</h1>
<img alt="x" src="${webUrl}/noBase.svg" width="20" height="20">
<script>document.querySelector('h1').textContent = 'JS RAN'</script></section>`,
      selector: '.target',
    });
    expect(
      r.isError,
      `${textOf(r)}
${stderr}`,
    ).toBeFalsy();
    const doc = await docText();
    expect(doc).toContain('Original');
    expect(doc).not.toContain('JS RAN');
    expect(sawHit('/noBase.svg')).toBe(false);
  });

  it('import_html with assets_base_url 127.0.0.1: the assets from that origin load', async () => {
    const r = await call('import_html', {
      html: '<section class="target"><h1>With base</h1><img alt="x" src="/withBase.svg" width="20" height="20"></section>',
      assets_base_url: `${webUrl}/`,
      selector: '.target',
    });
    expect(
      r.isError,
      `${textOf(r)}
${stderr}`,
    ).toBeFalsy();
    expect(sawHit('/withBase.svg')).toBe(true);
  });

  const failure = async (
    name: string,
    args: Record<string, unknown>,
  ): Promise<{ text: string; ms: number }> => {
    const t0 = Date.now();
    let failed: boolean;
    let text: string;
    try {
      const r = await call(name, args);
      failed = !!r.isError;
      text = textOf(r);
    } catch (e) {
      failed = true;
      text = String(e);
    }
    expect(failed, text).toBe(true);
    return { text, ms: Date.now() - t0 };
  };

  it('a nonexistent selector fails fast with a clear message (static import_html and import_url)', async () => {
    const html = await failure('import_html', {
      html: '<section class="target"><h1>x</h1></section>',
      selector: '.does-not-exist',
    });
    console.log(`[snapshot] import_html with a nonexistent selector failed in ${html.ms} ms`);
    expect(html.text).toMatch(/Selector "\.does-not-exist" not found in the provided HTML/);
    expect(html.ms).toBeLessThan(5_000);

    const url = await failure('import_url', {
      url: `${webUrl}/landing/index.html`,
      selector: '.does-not-exist',
    });
    console.log(`[snapshot] import_url with a nonexistent selector failed in ${url.ms} ms`);
    expect(url.text).toMatch(/Selector "\.does-not-exist" not found at http/);
    expect(url.ms).toBeLessThan(10_000);
  });

  it('import_url of a page that responds 404 imports with an HTTP status warning', async () => {
    const r = await call('import_url', { url: `${webUrl}/does-not-exist.html` });
    expect(r.isError, `${textOf(r)}\n${stderr}`).toBeFalsy();
    expect(textOf(r)).toContain('responded with HTTP 404');
  });

  it('import_url of a 200 page does not warn about the HTTP status', async () => {
    const r = await call('import_url', { url: `${webUrl}/network.html`, selector: '.target' });
    expect(r.isError, `${textOf(r)}\n${stderr}`).toBeFalsy();
    expect(textOf(r)).not.toContain('responded with HTTP');
  });
});
