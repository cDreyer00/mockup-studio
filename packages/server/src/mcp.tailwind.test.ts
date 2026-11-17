import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import fs from 'node:fs';
import { parseDocument } from '@mockup/core';
import { clearTailwindEngines, peekTailwindEngine } from '@mockup/core/tailwind';
import { startDaemon, type DaemonHandle } from './index.js';
import type { CaptureRequest, RenderProvider } from './render.js';
import { makeWorkspace } from './test-utils.js';

type Ws = ReturnType<typeof makeWorkspace>;
type Content = { type: string; text?: string };

const textOf = (r: unknown): string =>
  (r as { content: Content[] }).content
    .filter((c) => c.type === 'text')
    .map((c) => c.text)
    .join('\n');

// Markup do shadcn/ui v4 (new-york), como colado do site.
const BUTTON =
  '<button data-slot="button" class="inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium transition-all disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none shrink-0 outline-none focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px] aria-invalid:ring-destructive/20 bg-primary text-primary-foreground shadow-xs hover:bg-primary/90 h-9 px-4 py-2 has-[>svg]:px-3">Salvar</button>';
const CARD =
  '<div data-slot="card" class="bg-card text-card-foreground flex flex-col gap-6 rounded-xl border py-6 shadow-sm"><div data-slot="card-header" class="px-6"><div data-slot="card-title" class="leading-none font-semibold">Título</div><div data-slot="card-description" class="text-muted-foreground text-sm">Descrição</div></div><div data-slot="card-content" class="px-6">Conteúdo</div></div>';

describe('MCP Tailwind', () => {
  let ws: Ws;
  let daemon: DaemonHandle;
  let client: Client;
  let captures: CaptureRequest[];

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
    async measure() {
      throw new Error('não usado');
    },
  };

  beforeEach(async () => {
    ws = makeWorkspace();
    captures = [];
    daemon = await startDaemon({ port: 0, dataDir: ws.dataDir, writeInfo: false, render });
    client = new Client({ name: 'teste', version: '0.0.0' });
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
  const created = (t: string): string[] =>
    /Nós criados: ([^.\n]+)\./
      .exec(t)![1]!
      .split(', ')
      .map((s) => s.trim());
  const info = (id: string) => ok('get_node_info', { nodeId: id });

  it('write_html detecta Tailwind, liga o cssBase e avisa; undo desfaz tudo', async () => {
    const t = await ok('write_html', {
      parentId: ws.frameId,
      html: '<div class="flex gap-4 p-6 bg-red-500 rounded-lg hover:bg-red-600 foo-bar group-hover:flex">Oi</div>',
    });
    expect(t).toContain('Tailwind aplicado');
    expect(t).toContain('set_css_base("default")');
    expect(t).toContain('foo-bar');
    expect(t).toContain('group-hover');
    expect(t).toContain('get_screenshot');
    const [id] = created(t);
    const node = await info(id!);
    expect(node).toContain('display: flex');
    expect(node).toContain('gap: 1rem');
    expect(node).toContain('classes: flex gap-4');
    expect(node).toContain('hover {');
    expect(await ok('get_tailwind_config')).toContain('cssBase: tailwind');
    await ok('undo');
    expect(await ok('get_tailwind_config')).toContain('cssBase: default');
    expect(await ok('get_tree_summary', { nodeId: ws.frameId })).not.toContain(id!);
  });

  it('css: "tailwind" força o Tailwind e não é tratado como CSS', async () => {
    const t = await ok('write_html', {
      parentId: ws.frameId,
      html: '<p class="mystery">x</p>',
      css: 'tailwind',
    });
    expect(t).toContain('Tailwind aplicado');
    expect(t).toContain('mystery');
    expect(await ok('get_tailwind_config')).toContain('cssBase: tailwind');
    const bad = await call('write_html', {
      html: '<p class="p-4">x</p>',
      css: 'tailwind',
      tailwind: 'off',
    });
    expect(bad.isError).toBe(true);
  });

  it('tailwind "off" mantém o comportamento antigo (class é só seletor de CSS)', async () => {
    const t = await ok('write_html', {
      parentId: ws.frameId,
      tailwind: 'off',
      html: '<div class="flex p-4">Oi</div>',
    });
    expect(t).toContain('HTML aplicado (append)');
    expect(t).not.toContain('Tailwind');
    const [id] = created(t);
    const node = await info(id!);
    expect(node).not.toContain('classes:');
    expect(node).not.toContain('display: flex');
    expect(await ok('get_tailwind_config')).toContain('cssBase: default');
  });

  it('HTML com CSS próprio não é tratado como Tailwind (auto)', async () => {
    const t = await ok('write_html', {
      parentId: ws.frameId,
      html: '<section class="hero"><h1>Olá</h1></section>',
      css: '.hero{display:flex;gap:16px}',
    });
    expect(t).toContain('HTML aplicado (append)');
    expect(await ok('get_tailwind_config')).toContain('cssBase: default');
  });

  it('import_component cria os tokens shadcn e compila botão e card', async () => {
    const t = await ok('import_component', {
      parentId: ws.frameId,
      html: `${BUTTON}${CARD}`,
    });
    expect(t).toContain('Tokens do preset shadcn');
    const ids = created(t);
    const tokens = await ok('get_tokens', { format: 'json' });
    expect(tokens).toContain('--color-primary');
    expect(tokens).toContain('--color-card');
    expect(tokens).toContain('--radius');

    const button = await info(ids[0]!);
    expect(button).toContain('background-color: var(--color-primary)');
    expect(button).toContain('color: var(--color-primary-foreground)');
    expect(button).toMatch(/hover \{[^}]*var\(--color-primary\)/);
    expect(button).toContain('data-slot: button');

    const card = await info(ids[1]!);
    expect(card).toContain('background-color: var(--color-card)');
    // borda sem cor ganha a cor do preset (como o `* { border-color }` do shadcn)
    expect(card).toContain('border-color: var(--color-border)');

    const code = await ok('get_code', { nodeId: ids[0]!, format: 'tailwind' });
    for (const c of [
      'bg-primary',
      'text-primary-foreground',
      'h-9',
      'px-4',
      'py-2',
      'rounded-md',
      'hover:bg-primary/90',
    ])
      expect(code, c).toContain(c);
    const cardCode = await ok('get_code', { nodeId: ids[1]!, format: 'tailwind' });
    for (const c of ['rounded-xl', 'border', 'shadow-sm', 'bg-card']) {
      expect(cardCode, c).toContain(c);
    }
    const react = await ok('get_code', { nodeId: ids[0]!, format: 'react' });
    expect(react).toContain('bg-primary');

    // um undo só desfaz nós, tokens e cssBase
    await ok('undo');
    expect(await ok('get_tokens', { format: 'json' })).not.toContain('--color-primary"');
    expect(await ok('get_tailwind_config')).toContain('cssBase: default');
  });

  it('import_component com tokens "none" não cria tokens', async () => {
    await ok('import_component', {
      parentId: ws.frameId,
      html: BUTTON,
      tokens: 'none',
    });
    expect(await ok('get_tokens', { format: 'json' })).not.toContain('--color-primary"');
  });

  it('get_code com styles inline não carrega o motor Tailwind', async () => {
    const doc = parseDocument(fs.readFileSync(ws.file, 'utf8'));
    clearTailwindEngines();
    const id = created(
      await ok('write_html', { parentId: ws.frameId, tailwind: 'off', html: '<div>x</div>' }),
    )[0]!;
    clearTailwindEngines();
    await ok('get_code', { nodeId: id, format: 'react', styles: 'inline' });
    expect(peekTailwindEngine(doc)).toBeUndefined();
    await ok('get_code', { nodeId: id, format: 'react' });
    expect(peekTailwindEngine(doc)).toBeDefined();
  });

  it('set_classes: replace, add e remove com undo', async () => {
    const id = created(
      await ok('write_html', {
        parentId: ws.frameId,
        tailwind: 'on',
        html: '<div class="p-4 bg-blue-500">x</div>',
      }),
    )[0]!;
    const r = await ok('set_classes', { nodeIds: [id], classes: 'flex gap-2 p-8' });
    expect(r).toContain(`${id}: flex gap-2 p-8`);
    let n = await info(id);
    expect(n).toContain('padding: 2rem');
    expect(n).not.toContain('background');

    await ok('set_classes', { nodeIds: [id], classes: 'p-2 hover:underline', mode: 'add' });
    n = await info(id);
    expect(n).toContain('padding: 0.5rem');
    expect(n).toContain('classes: flex gap-2 p-2 hover:underline');
    expect(n).toContain('hover {');

    await ok('set_classes', { nodeIds: [id], classes: 'gap-2 hover:underline', mode: 'remove' });
    n = await info(id);
    expect(n).toContain('classes: flex p-2');
    expect(n).not.toContain('gap:');
    expect(n).not.toContain('hover {');

    await ok('undo');
    expect(await info(id)).toContain('classes: flex gap-2 p-2 hover:underline');
    const warn = await ok('set_classes', {
      nodeIds: [id],
      classes: 'p-2 nao-existe-xyz',
      mode: 'add',
    });
    expect(warn).toContain('nao-existe-xyz');
  });

  it('set_classes replace num filho absoluto mantém position/left/top', async () => {
    const id = created(
      await ok('write_html', {
        parentId: ws.frameId,
        tailwind: 'off',
        html: '<div style="position: absolute; left: 12px; top: 34px; color: red">x</div>',
      }),
    )[0]!;
    await ok('set_classes', { nodeIds: [id], classes: 'p-4' });
    const n = await info(id);
    expect(n).toContain('position: absolute');
    expect(n).toContain('left: 12px');
    expect(n).toContain('top: 34px');
    expect(n).toContain('padding: 1rem');
    expect(n).not.toContain('color: red');
  });

  it('set_classes em frame raiz preserva largura e altura', async () => {
    await ok('set_classes', { nodeIds: [ws.frameId], classes: 'bg-white p-4' });
    const n = await info(ws.frameId);
    expect(n).toContain('width: 1440px');
    expect(n).toContain('height: 900px');
  });

  it('get_classes mostra escritas, idiomáticas e o resto', async () => {
    const id = created(
      await ok('write_html', {
        parentId: ws.frameId,
        tailwind: 'on',
        html: '<div class="flex gap-4 p-6" style="clip-path: circle(40%)">x</div>',
      }),
    )[0]!;
    const t = await ok('get_classes', { nodeIds: [id] });
    expect(t).toContain('escritas: flex gap-4 p-6');
    expect(t).toMatch(/atuais: .*flex/);
    expect(t).toContain('gap-4');
    expect(t).toContain('clip-path');
  });

  it('suggest_classes devolve autocomplete, inclusive com variante e tokens', async () => {
    const t = await ok('suggest_classes', { query: 'justify-', limit: 5 });
    expect(t.split('\n').length).toBeLessThanOrEqual(5);
    expect(t).toContain('justify-');
    expect(await ok('suggest_classes', { query: 'hover:bg-', limit: 3 })).toContain('hover:bg-');
    await ok('set_tokens', { tokens: { '--color-brand': '#ff0066' } });
    expect(await ok('suggest_classes', { query: 'bg-bran' })).toContain('bg-brand');
  });

  it('get_tailwind_config reflete token novo (cache invalida) e lista estados', async () => {
    const before = await ok('get_tailwind_config');
    expect(before).toContain('cssBase: default');
    expect(before).toContain('md: 768px');
    expect(before).toContain('hover');
    expect(before).not.toContain('--color-brand');
    await ok('set_tokens', { tokens: { '--color-brand': '#ff0066' } });
    const after = await ok('get_tailwind_config');
    expect(after).toContain('--color-brand: #ff0066');
    const id = created(
      await ok('write_html', {
        parentId: ws.frameId,
        tailwind: 'on',
        html: '<div class="bg-brand">x</div>',
      }),
    )[0]!;
    expect(await info(id)).toContain('var(--color-brand)');
  });

  it('set_css_base alterna e é idempotente', async () => {
    expect(await ok('set_css_base', { base: 'tailwind' })).toContain('"tailwind"');
    expect(await ok('get_tailwind_config')).toContain('cssBase: tailwind');
    expect(await ok('set_css_base', { base: 'tailwind' })).toContain('já é');
    await ok('set_css_base', { base: 'default' });
    expect(await ok('get_tailwind_config')).toContain('cssBase: default');
  });

  it('update_styles com state grava e mescla no estado; get_styles mostra o efetivo', async () => {
    const id = created(
      await ok('write_html', {
        parentId: ws.frameId,
        tailwind: 'off',
        html: '<div style="color: red; padding: 8px">x</div>',
      }),
    )[0]!;
    await ok('update_styles', { nodeIds: [id], state: 'hover', styles: { color: 'blue' } });
    await ok('update_styles', { nodeIds: [id], state: 'hover', styles: { opacity: '0.5' } });
    const n = await info(id);
    expect(n).toMatch(/hover \{[^}]*color: blue/);
    expect(n).toMatch(/hover \{[^}]*opacity: 0\.5/);
    expect(n).toContain('color: red');
    expect(await ok('get_styles', { nodeIds: [id] })).toContain('color: red');
    expect(await ok('get_styles', { nodeIds: [id], state: 'hover' })).toContain('color: blue');
    await ok('update_styles', { nodeIds: [id], state: 'hover', unset: ['color', 'opacity'] });
    expect(await info(id)).not.toContain('states:');
    await ok('update_styles', {
      nodeIds: [id],
      state: 'hover',
      styles: { backgroundColor: 'red', 'font-size': '12px' },
    });
    expect(await info(id)).toContain('background-color: red');
    await ok('update_styles', {
      nodeIds: [id],
      state: 'hover',
      unset: ['backgroundColor', 'fontSize'],
    });
    expect(await info(id)).not.toContain('states:');
    const bad = await call('update_styles', { nodeIds: [id], state: 'hovr', styles: { a: 'b' } });
    expect(bad.isError).toBe(true);
    expect(textOf(bad)).toContain('Estado inválido');
  });

  it('breakpoints: md vale no frame de 1440px e não num de 390px', async () => {
    const id = created(
      await ok('write_html', {
        parentId: ws.frameId,
        tailwind: 'on',
        html: '<div class="p-2 md:p-8">x</div>',
      }),
    )[0]!;
    expect(await ok('get_styles', { nodeIds: [id] })).toContain('padding: 2rem');
    const frame = /Frame criado: (\S+)/.exec(
      await ok('create_frame', { name: 'Mobile', width: 390, height: 800 }),
    )![1]!;
    const copy = created(
      await ok('write_html', {
        parentId: frame,
        tailwind: 'on',
        html: '<div class="p-2 md:p-8">x</div>',
      }),
    )[0]!;
    expect(await ok('get_styles', { nodeIds: [copy] })).toContain('padding: 0.5rem');
  });

  it('get_screenshot repassa state ao provider', async () => {
    const r = await call('get_screenshot', { nodeId: ws.frameId, state: 'hover' });
    expect(r.isError).toBeFalsy();
    expect(captures.at(-1)?.state).toBe('hover');
    expect(textOf(r)).toContain('hover');
    await ok('get_screenshot', { nodeId: ws.frameId });
    expect(captures.at(-1)?.state).toBeUndefined();
    const bad = await call('get_screenshot', { nodeId: ws.frameId, state: 'visited' });
    expect(bad.isError).toBe(true);
  });

  it('export tailwind/react usa o motor (classes do autor) e grava arquivos', async () => {
    const id = created(await ok('import_component', { parentId: ws.frameId, html: BUTTON }))[0]!;
    const t = await ok('export', { nodeIds: [id], format: 'tailwind', outputDir: ws.dir });
    expect(t).toContain('bg-primary');
    expect(t).toContain('hover:bg-primary/90');
    const r = await ok('export', { nodeIds: [id], format: 'react', outputDir: ws.dir });
    expect(r).toContain('bg-primary');
  });

  it('get_guide("tailwind") existe e é citado nas instruções', async () => {
    const g = await ok('get_guide', { topic: 'tailwind' });
    for (const k of ['import_component', 'set_classes', 'get_screenshot', '768', 'group-']) {
      expect(g).toContain(k);
    }
    expect(client.getInstructions()).toContain("get_guide('tailwind')");
  });
});
