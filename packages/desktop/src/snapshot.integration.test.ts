/**
 * Integração REAL da importação de páginas: sobe o Electron headless, um servidor http estático com
 * as fixtures do snapshot-core e chama `import_url`/`import_html` pelo MCP (Streamable HTTP em /mcp).
 * Requer `npm run build` (snapshot-core, server, desktop e editor) antes.
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
    if (child.exitCode !== null) throw new Error(`Electron encerrou (código ${child.exitCode})`);
    try {
      const r = await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(1000) });
      if (r.ok && ((await r.json()) as { render?: boolean }).render === true) return;
    } catch {
      /* ainda subindo */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('Timeout aguardando /api/health com render: true');
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

/** Servidor estático simples; procura o arquivo em cada raiz, na ordem. */
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
    res.writeHead(404).end('não encontrado');
  });
  // sem host: escuta em :: (dual-stack), então `localhost` também chega aqui e o teste de bloqueio
  // prova que foi o guarda (e não uma falha de conexão) que impediu a requisição
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

describe.skipIf(!built || !editorReady)('import_url / import_html (integração Electron)', () => {
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
    // mesma origem (relativa) x outra origem da mesma máquina (localhost, porta igual)
    fs.writeFileSync(
      path.join(extraDir, 'rede.html'),
      `<!doctype html><html><body style="margin:0"><section class="alvo" style="padding:8px">
  <h1>Rede</h1>
  <img alt="mesma" src="/mesma.svg" width="20" height="20">
  <img alt="outra" src="http://localhost:${webPort}/outra.svg" width="20" height="20">
</section></body></html>`,
    );
    fs.copyFileSync(path.join(extraDir, 'px.svg'), path.join(extraDir, 'mesma.svg'));
    fs.copyFileSync(path.join(extraDir, 'px.svg'), path.join(extraDir, 'outra.svg'));
    fs.copyFileSync(path.join(extraDir, 'px.svg'), path.join(extraDir, 'semBase.svg'));
    fs.copyFileSync(path.join(extraDir, 'px.svg'), path.join(extraDir, 'comBase.svg'));

    // páginas hostis: tentam ler arquivo local e chamar a API do daemon
    fs.writeFileSync(
      path.join(extraDir, 'hostil.html'),
      `<!doctype html><html><body style="margin:0">
<section class="alvo" style="padding:24px;background:#eef">
  <h1>Página hostil</h1>
  <img alt="local" src="file:///C:/Windows/win.ini" width="40" height="40">
  <img alt="daemon" src="${daemonUrl}/api/health" width="40" height="40">
  <p>Texto normal</p>
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
      body: JSON.stringify({ path: file, name: 'Importação' }),
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

  it('import_url de .hero da landing em menos de 10 s: frame, imagens em assets/ e Referência oculta', async () => {
    const t0 = Date.now();
    const r = await call('import_url', { url: `${webUrl}/landing/index.html`, selector: '.hero' });
    const ms = Date.now() - t0;
    console.log(`[snapshot] import_url (.hero) levou ${ms} ms`);
    const text = textOf(r);
    expect(r.isError, `${text}\n${stderr}`).toBeFalsy();
    expect(ms).toBeLessThan(10_000);
    expect(text).toMatch(/fr_\w+/);

    const all = await frames();
    const imported = all.find((f) => text.includes(f.id) && !f.hidden);
    expect(imported, text).toBeTruthy();
    expect(imported!.children.length).toBeGreaterThan(0);
    const ref = all.find((f) => /Refer[eê]ncia/i.test(f.name));
    expect(ref, 'frame Referência').toBeTruthy();
    expect(ref!.hidden).toBe(true);

    const assetsDir = path.join(docDir, 'assets');
    expect(fs.existsSync(assetsDir)).toBe(true);
    expect(fs.readdirSync(assetsDir, { recursive: true }).length).toBeGreaterThan(0);
  });

  it('import_url com file:/// é recusado', async () => {
    const bad = pathToFileURL(path.join(extraDir, 'hostil.html')).href;
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

  it('página que tenta carregar file:// e chamar o daemon não quebra a importação', async () => {
    const r = await call('import_url', { url: `${webUrl}/hostil.html`, selector: '.alvo' });
    expect(r.isError, `${textOf(r)}\n${stderr}`).toBeFalsy();
    expect(textOf(r)).toMatch(/fr_\w+/);
    // o daemon segue de pé
    expect((await fetch(`${daemonUrl}/api/health`)).ok).toBe(true);
  });

  it('import_html com render funciona', async () => {
    const r = await call('import_html', {
      html: '<section class="x" style="padding:16px"><h2>Olá</h2><p>Mundo</p></section>',
      css: '.x { background: #fafafa; }',
      selector: '.x',
    });
    expect(r.isError, `${textOf(r)}\n${stderr}`).toBeFalsy();
    expect(textOf(r)).toMatch(/fr_\w+/);
  });

  const sawHit = (p: string): boolean => hits.includes(p);
  const docText = async (): Promise<string> => JSON.stringify(await getDoc());

  it('navegação principal em http://127.0.0.1 (dev server local) funciona; subrequisição de outra origem local é bloqueada', async () => {
    const r = await call('import_url', { url: `${webUrl}/rede.html`, selector: '.alvo' });
    expect(
      r.isError,
      `${textOf(r)}
${stderr}`,
    ).toBeFalsy();
    expect(sawHit('/rede.html')).toBe(true);
    expect(sawHit('/mesma.svg')).toBe(true);
    expect(sawHit('/outra.svg')).toBe(false);
  });

  it('import_html sem baseUrl: o JavaScript da página não roda e a rede local é bloqueada', async () => {
    const r = await call('import_html', {
      html: `<section class="alvo"><h1>Original</h1>
<img alt="x" src="${webUrl}/semBase.svg" width="20" height="20">
<script>document.querySelector('h1').textContent = 'JS RODOU'</script></section>`,
      selector: '.alvo',
    });
    expect(
      r.isError,
      `${textOf(r)}
${stderr}`,
    ).toBeFalsy();
    const doc = await docText();
    expect(doc).toContain('Original');
    expect(doc).not.toContain('JS RODOU');
    expect(sawHit('/semBase.svg')).toBe(false);
  });

  it('import_html com assets_base_url 127.0.0.1: os assets dessa origem carregam', async () => {
    const r = await call('import_html', {
      html: '<section class="alvo"><h1>Com base</h1><img alt="x" src="/comBase.svg" width="20" height="20"></section>',
      assets_base_url: `${webUrl}/`,
      selector: '.alvo',
    });
    expect(
      r.isError,
      `${textOf(r)}
${stderr}`,
    ).toBeFalsy();
    expect(sawHit('/comBase.svg')).toBe(true);
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

  it('seletor inexistente falha rápido com mensagem clara (import_html estático e import_url)', async () => {
    const html = await failure('import_html', {
      html: '<section class="alvo"><h1>x</h1></section>',
      selector: '.nao-existe',
    });
    console.log(`[snapshot] import_html com seletor inexistente falhou em ${html.ms} ms`);
    expect(html.text).toMatch(/Seletor "\.nao-existe" não encontrado no HTML informado/);
    expect(html.ms).toBeLessThan(5_000);

    const url = await failure('import_url', {
      url: `${webUrl}/landing/index.html`,
      selector: '.nao-existe',
    });
    console.log(`[snapshot] import_url com seletor inexistente falhou em ${url.ms} ms`);
    expect(url.text).toMatch(/Seletor "\.nao-existe" não encontrado em http/);
    expect(url.ms).toBeLessThan(10_000);
  });

  it('import_url de página que responde 404 importa com aviso do status HTTP', async () => {
    const r = await call('import_url', { url: `${webUrl}/nao-existe.html` });
    expect(r.isError, `${textOf(r)}\n${stderr}`).toBeFalsy();
    expect(textOf(r)).toContain('respondeu HTTP 404');
  });

  it('import_url de página 200 não avisa status HTTP', async () => {
    const r = await call('import_url', { url: `${webUrl}/rede.html`, selector: '.alvo' });
    expect(r.isError, `${textOf(r)}\n${stderr}`).toBeFalsy();
    expect(textOf(r)).not.toContain('respondeu HTTP');
  });
});
