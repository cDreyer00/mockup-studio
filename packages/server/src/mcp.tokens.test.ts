import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { startDaemon, type DaemonHandle } from './index.js';
import { makeWorkspace } from './test-utils.js';

type Ws = ReturnType<typeof makeWorkspace>;

function textOf(r: unknown): string {
  const c = (r as { content: Array<{ type: string; text: string }> }).content;
  return c.map((x) => x.text).join('\n');
}

describe('MCP tokens e temas', () => {
  let ws: Ws;
  let daemon: DaemonHandle;
  let client: Client;

  beforeEach(async () => {
    ws = makeWorkspace();
    daemon = await startDaemon({ port: 0, dataDir: ws.dataDir, writeInfo: false });
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
  const json = async (args: Record<string, unknown> = {}) =>
    JSON.parse(await ok('get_tokens', { format: 'json', ...args })) as {
      tokens: {
        name: string;
        group: string;
        value?: string;
        resolved?: string;
        description?: string;
        usage: { nodeIds: string[] };
        problem?: { level: string };
        themes: Record<string, string>;
      }[];
      themes: { name: string; overrides: number; frames: string[] }[];
      unused: string[];
      broken: { missing: string }[];
    };

  /** Cria um nó filho do frame com estilos e devolve o id. */
  async function node(styles: Record<string, string>): Promise<string> {
    const r = textOf(
      await call('create_node', { parentId: ws.frameId, tag: 'div', name: 'Caixa' }),
    );
    const id = /(el_[0-9a-z]+)/.exec(r)?.[1];
    if (!id) throw new Error('id não encontrado: ' + r);
    await ok('update_styles', { nodeIds: [id], styles });
    return id;
  }

  it('lista as ferramentas novas', async () => {
    const names = (await client.listTools()).tools.map((t) => t.name);
    for (const n of [
      'get_tokens',
      'set_tokens',
      'rename_token',
      'apply_token',
      'create_theme',
      'delete_theme',
      'rename_theme',
      'set_frame_theme',
      'import_tokens',
      'export_tokens',
    ]) {
      expect(names).toContain(n);
    }
  });

  it('get_tokens sem tokens explica como criar', async () => {
    const t = await ok('get_tokens');
    expect(t).toContain('Nenhum token');
    expect(t).toContain('set_tokens');
  });

  it('set_tokens com e sem "--" (uso antigo), grupos e descrições', async () => {
    const t = await ok('set_tokens', {
      tokens: { primary: '#2563eb', '--space-4': '16px' },
      groups: { primary: 'color' },
      descriptions: { '--primary': 'Ação principal' },
    });
    expect(t).toContain('--primary: #2563eb');
    const r = await json();
    const p = r.tokens.find((x) => x.name === '--primary')!;
    expect(p.group).toBe('color');
    expect(p.description).toBe('Ação principal');
    expect(r.tokens.find((x) => x.name === '--space-4')!.group).toBe('spacing');

    // descrição nova mescla com o grupo existente; texto vazio apaga
    await ok('set_tokens', { descriptions: { '--primary': 'Outra' } });
    let again = (await json()).tokens.find((x) => x.name === '--primary')!;
    expect(again.description).toBe('Outra');
    expect(again.group).toBe('color');
    await ok('set_tokens', { descriptions: { '--primary': '' } });
    again = (await json()).tokens.find((x) => x.name === '--primary')!;
    expect(again.description).toBeUndefined();
  });

  it('set_tokens: warning de tipo entra na resposta e valor inválido recusa tudo', async () => {
    const w = await ok('set_tokens', { tokens: { '--space-x': '#ff0000', '--ok': '1px' } });
    expect(w).toContain('Avisos');
    expect(w).toContain('--space-x');

    const bad = await call('set_tokens', { tokens: { '--novo': '1px', '--quebrado': 'rgb(1, 2' } });
    expect(bad.isError).toBe(true);
    expect(textOf(bad)).toContain('--quebrado');
    expect((await json()).tokens.map((x) => x.name)).not.toContain('--novo');

    const empty = await call('set_tokens', {});
    expect(empty.isError).toBe(true);
    const unknownGroup = await call('set_tokens', { groups: { '--nao-existe': 'color' } });
    expect(unknownGroup.isError).toBe(true);
  });

  it('get_tokens em texto e json: grupos, usos, não usado e quebrado', async () => {
    await ok('set_tokens', {
      tokens: {
        '--color-primary': '#2563eb',
        '--color-alias': 'var(--color-primary)',
        '--color-orphan': '#000000',
        '--space-4': '16px',
      },
    });
    const id = await node({ background: 'var(--color-primary)', color: 'var(--color-ghost)' });

    const text = await ok('get_tokens');
    expect(text).toContain('## Cores');
    expect(text).toContain('## Espaçamento');
    expect(text).toContain('Não usados:');
    expect(text).toContain('--color-orphan');
    expect(text).toContain('Referências quebradas');
    expect(text).toContain('--color-ghost');
    expect(text).toContain(id);

    const only = await ok('get_tokens', { group: 'color' });
    expect(only).toContain('--color-primary');
    expect(only).not.toContain('--space-4');

    const r = await json();
    const p = r.tokens.find((x) => x.name === '--color-primary')!;
    expect(p.usage.nodeIds).toContain(id);
    expect(r.unused).toContain('--color-orphan');
    expect(r.broken.map((b) => b.missing)).toContain('--color-ghost');
    expect((await json({ group: 'color' })).tokens.every((x) => x.group === 'color')).toBe(true);
  });

  it('rename_token atualiza estilos e tokens; undo restaura tudo', async () => {
    await ok('set_tokens', {
      tokens: { '--brand': '#2563eb', '--accent': 'var(--brand)' },
      groups: { '--brand': 'color' },
    });
    const id = await node({ background: 'var(--brand)' });
    const msg = await ok('rename_token', { from: 'brand', to: '--color-primary' });
    expect(msg).toContain('--brand -> --color-primary');

    const styles = await ok('get_html', { nodeId: id });
    expect(styles).toContain('var(--color-primary)');
    expect(styles).not.toContain('--brand');
    const r = await json();
    expect(r.tokens.map((x) => x.name)).toContain('--color-primary');
    expect(r.tokens.find((x) => x.name === '--accent')!.value).toBe('var(--color-primary)');
    expect(r.tokens.find((x) => x.name === '--color-primary')!.group).toBe('color');

    await ok('undo');
    expect(await ok('get_html', { nodeId: id })).toContain('var(--brand)');
    const back = await json();
    expect(back.tokens.map((x) => x.name)).not.toContain('--color-primary');
    expect(back.tokens.find((x) => x.name === '--accent')!.value).toBe('var(--brand)');

    const dup = await call('rename_token', { from: '--brand', to: '--accent' });
    expect(dup.isError).toBe(true);
  });

  it('apply_token liga a propriedade ao token e informa o valor resolvido', async () => {
    await ok('set_tokens', { tokens: { '--color-primary': '#2563eb' } });
    const id = await node({ width: '10px' });
    const t = await ok('apply_token', {
      nodeIds: [id],
      property: 'background',
      token: 'color-primary',
    });
    expect(t).toContain('var(--color-primary)');
    expect(t).toContain('#2563eb');
    expect(await ok('get_html', { nodeId: id })).toContain('var(--color-primary)');
    const bad = await call('apply_token', { nodeIds: [id], property: 'color', token: '--nope' });
    expect(bad.isError).toBe(true);
    expect(textOf(bad)).toContain('set_tokens');
  });

  it('temas: create_theme + set_frame_theme + get_styles mostra o valor do tema', async () => {
    await ok('set_tokens', { tokens: { '--blue': '#2563eb', '--color-primary': 'var(--blue)' } });
    const id = await node({ background: 'var(--color-primary)' });
    const created = await ok('create_theme', { name: 'dark', overrides: { blue: '#60a5fa' } });
    expect(created).toContain('dark');

    expect(await ok('get_styles', { nodeIds: [id] })).toContain('background: #2563eb');
    // theme explícito, sem mexer no frame
    expect(await ok('get_styles', { nodeIds: [id], theme: 'dark' })).toContain(
      'background: #60a5fa',
    );
    const missing = await call('get_styles', { nodeIds: [id], theme: 'nao-existe' });
    expect(missing.isError).toBe(true);

    await ok('set_frame_theme', { nodeIds: [ws.frameId], theme: 'dark' });
    // o alias acompanha o tema do frame
    expect(await ok('get_styles', { nodeIds: [id] })).toContain('background: #60a5fa');
    const r = await json();
    expect(r.themes).toEqual([{ name: 'dark', overrides: 1, frames: [ws.frameId] }]);
    const themed = await ok('get_tokens', { theme: 'dark', group: 'color' });
    expect(themed).toContain('=> #60a5fa');

    await ok('set_frame_theme', { nodeIds: [ws.frameId], theme: null });
    expect(await ok('get_styles', { nodeIds: [id] })).toContain('background: #2563eb');

    const bad = await call('set_frame_theme', { nodeIds: [ws.frameId], theme: 'nada' });
    expect(bad.isError).toBe(true);
    expect(textOf(bad)).toContain('create_theme');
    const dupe = await call('create_theme', { name: 'dark' });
    expect(dupe.isError).toBe(true);
    const badValue = await call('create_theme', { name: 'x', overrides: { '--a': 'rgb(1,' } });
    expect(badValue.isError).toBe(true);
  });

  it('set_tokens com theme grava nas sobrescritas; unset sem tema limpa base, meta e temas', async () => {
    await ok('set_tokens', {
      tokens: { '--color-bg': '#fff', '--color-fg': '#000' },
      groups: { '--color-fg': 'color' },
    });
    await ok('create_theme', { name: 'dark', overrides: { '--color-bg': '#111' } });
    const noTheme = await call('set_tokens', { tokens: { '--x': '1px' }, theme: 'nada' });
    expect(noTheme.isError).toBe(true);

    await ok('set_tokens', { theme: 'dark', tokens: { '--color-fg': '#eee' } });
    let r = await json();
    expect(r.tokens.find((x) => x.name === '--color-fg')!.themes).toEqual({ dark: '#eee' });
    expect(r.themes[0]!.overrides).toBe(2);

    await ok('set_tokens', { theme: 'dark', unset: ['--color-fg'] });
    r = await json();
    expect(r.themes[0]!.overrides).toBe(1);
    expect(r.tokens.find((x) => x.name === '--color-fg')).toBeTruthy();

    await ok('set_tokens', { unset: ['--color-bg'] });
    r = await json();
    expect(r.tokens.map((x) => x.name)).toEqual(['--color-fg']);
    expect(r.themes[0]!.overrides).toBe(0);
  });

  it('delete_theme e rename_theme atualizam data-theme', async () => {
    await ok('set_tokens', { tokens: { '--a': '#fff' } });
    await ok('create_theme', { name: 'dark', overrides: { '--a': '#000' } });
    await ok('set_frame_theme', { nodeIds: [ws.frameId], theme: 'dark' });
    expect(await ok('get_html', { nodeId: ws.frameId })).toContain('data-theme="dark"');

    await ok('rename_theme', { from: 'dark', to: 'night' });
    expect(await ok('get_html', { nodeId: ws.frameId })).toContain('data-theme="night"');
    expect((await json()).themes[0]).toMatchObject({ name: 'night', frames: [ws.frameId] });
    const same = await call('rename_theme', { from: 'night', to: 'night' });
    expect(same.isError).toBe(true);

    await ok('delete_theme', { name: 'night' });
    expect(await ok('get_html', { nodeId: ws.frameId })).not.toContain('data-theme');
    expect((await json()).themes).toEqual([]);
    const gone = await call('delete_theme', { name: 'night' });
    expect(gone.isError).toBe(true);
  });

  it('import_tokens CSS e JSON, merge e replace', async () => {
    await ok('set_tokens', { tokens: { '--keep': '1px', '--color-primary': '#000000' } });
    const css =
      ':root { --color-primary: #2563eb; --radius-md: 8px; }\n[data-theme="dark"] { --color-primary: #60a5fa; }';
    const t = await ok('import_tokens', { content: css, format: 'css' });
    expect(t).toContain('2 token(s)');
    expect(t).toContain('1 tema(s)');
    let r = await json();
    expect(r.tokens.map((x) => x.name).sort()).toEqual([
      '--color-primary',
      '--keep',
      '--radius-md',
    ]);
    expect(r.tokens.find((x) => x.name === '--color-primary')!.value).toBe('#2563eb');
    expect(r.themes[0]!.name).toBe('dark');

    const dtcg = JSON.stringify({
      color: { brand: { $type: 'color', $value: '#ff0000', $description: 'Marca' } },
    });
    const j = await ok('import_tokens', { content: dtcg, format: 'json', mode: 'replace' });
    expect(j).toContain('replace');
    r = await json();
    expect(r.tokens.map((x) => x.name)).toEqual(['--color-brand']);
    expect(r.tokens[0]!.description).toBe('Marca');
    expect(r.themes).toEqual([]);

    const none = await call('import_tokens', { content: '/* nada */', format: 'css' });
    expect(none.isError).toBe(true);
    const broken = await call('import_tokens', { content: '{ nao json', format: 'json' });
    expect(broken.isError).toBe(true);
  });

  it('export_tokens nos três formatos', async () => {
    const empty = await call('export_tokens', { format: 'css' });
    expect(empty.isError).toBe(true);

    await ok('set_tokens', {
      tokens: { '--color-primary': '#2563eb' },
      descriptions: { '--color-primary': 'Ação' },
    });
    await ok('create_theme', { name: 'dark', overrides: { '--color-primary': '#60a5fa' } });
    const css = await ok('export_tokens', { format: 'css' });
    expect(css).toContain(':root');
    expect(css).toContain('--color-primary: #2563eb');
    expect(css).toContain('[data-theme="dark"]');
    const j = JSON.parse(await ok('export_tokens', { format: 'json' }));
    expect(JSON.stringify(j)).toContain('#2563eb');
    expect(JSON.stringify(j)).toContain('mockup-studio');
    const tw = await ok('export_tokens', { format: 'tailwind' });
    expect(tw).toContain('@theme');
    expect(tw).toContain('@custom-variant');

    // ida e volta: o que foi exportado reimporta igual
    await ok('import_tokens', { content: css, format: 'css', mode: 'replace' });
    const r = await json();
    expect(r.tokens.find((x) => x.name === '--color-primary')!.value).toBe('#2563eb');
    expect(r.themes[0]!.name).toBe('dark');
  });

  it('cada escrita é uma entrada de undo', async () => {
    await ok('set_tokens', { tokens: { '--a': '#fff', '--b': '1px' }, groups: { '--a': 'color' } });
    await ok('undo');
    expect((await json()).tokens).toEqual([]);
  });
});
