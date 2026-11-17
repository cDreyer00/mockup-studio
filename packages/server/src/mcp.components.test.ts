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

describe('MCP componentes: kits, instâncias, overrides e render', () => {
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
        name: 'Medido',
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
  const instanceId = (t: string): string => /Instância criada: (\S+)/.exec(t)![1]!;
  const insertButton = async (props: Record<string, unknown> = {}, extra = {}): Promise<string> =>
    instanceId(
      await ok('insert_component', {
        component: 'shadcn-like/Button',
        parentId: ws.frameId,
        props,
        ...extra,
      }),
    );

  it('list_components: biblioteca vazia e kit shadcn-like disponível', async () => {
    const t = await ok('list_components');
    expect(t).toContain('Componentes do documento (0)');
    expect(t).toContain('shadcn-like/Button');
    expect(t).toContain('shadcn-like/Card');
    expect(t).toContain('slots: content, footer');
  });

  it('insert_component shadcn-like/Button: importa o kit, aplica variant/label e lê pelo id virtual', async () => {
    const t = await ok('insert_component', {
      component: 'shadcn-like/Button',
      parentId: ws.frameId,
      props: { variant: 'outline', label: 'Salvar' },
    });
    expect(t).toContain('Kit "shadcn-like" importado');
    const inst = instanceId(t);
    expect(t).toContain('◆Button');

    // a instância expandida: ids virtuais e HTML com o texto
    const tree = await ok('get_tree_summary', { nodeId: inst, depth: 4 });
    expect(tree).toContain(`${inst}/tx_sbtnlabl`);
    const html = await ok('get_html', { nodeId: inst });
    expect(html).toContain('Salvar');
    expect(html).not.toContain('{{label}}');
    expect(await ok('get_html', { nodeId: `${inst}/tx_sbtnlabl` })).toContain('Salvar');

    // estilos expandidos do outline (borda de 1px e fundo do tema), não os do default (primary)
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
    expect(info).toContain('Nó interno de uma instância');
    const infoInst = await ok('get_node_info', { nodeId: inst });
    expect(infoInst).toContain('instância de Button');
    expect(infoInst).toContain('variant=outline');

    const children = await ok('get_children', { nodeId: inst });
    expect(children).toContain(`${inst}/tx_sbtnlabl`);
  });

  it('o kit importado e a instância entram numa única entrada de histórico (undo/redo)', async () => {
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

  it('erros: componente inexistente, prop inválida e enum fora das opções', async () => {
    expect(
      await fail('insert_component', { component: 'Fantasma', parentId: ws.frameId }),
    ).toContain('list_components');
    expect(
      await fail('insert_component', { component: 'shadcn-like/Nada', parentId: ws.frameId }),
    ).toContain('Componentes: ');
    const inst = await insertButton();
    const bad = await fail('set_instance_props', { nodeIds: [inst], set: { cor: 'x' } });
    expect(bad).toContain('variant');
    expect(bad).toContain('label');
    const badEnum = await fail('set_instance_props', { nodeIds: [inst], set: { variant: 'neon' } });
    expect(badEnum).toContain('outline');
    expect(await fail('set_instance_props', { nodeIds: [ws.frameId], set: { a: 1 } })).toContain(
      'não é uma instância',
    );
    expect(
      await fail('insert_component', {
        component: 'shadcn-like/Button',
        parentId: ws.frameId,
        slots: { x: '<p/>' },
      }),
    ).toContain('não tem o slot');
  });

  it('get_component: props com opções, variantes, árvore e HTML; também de kit não importado', async () => {
    const fromKit = await ok('get_component', { component: 'shadcn-like/Button' });
    expect(fromKit).toContain('ainda não está no documento');
    expect(fromKit).toContain('enum, opções: default | secondary | outline | ghost | destructive');
    expect(fromKit).toContain('quando variant=outline');
    expect(fromKit).toContain('tx_sbtnlabl');
    expect(fromKit).toContain('{{label}}');
    await ok('import_kit', { name: 'shadcn-like' });
    const t = await ok('get_component', { component: 'Button' });
    expect(t).toContain('cp_sbutton1');
    expect(t).toContain('— 0 instância(s) (+5 dentro de outros componentes)');
    expect(t).not.toContain('ainda não está');
    const lib = await ok('list_components');
    expect(lib).toContain('Componentes do documento (8)');
    expect(lib).toContain('cp_sbutton1 "Button" [kit shadcn-like]');
  });

  it('import_kit é idempotente (e aceita caminho absoluto)', async () => {
    const first = await ok('import_kit', { name: 'shadcn-like' });
    expect(first).toContain('Button (added)');
    const rev = (await doc()).meta.updatedAt;
    const again = await ok('import_kit', { name: 'shadcn-like' });
    expect(again).toContain('já está importado');
    const d = await doc();
    expect(d.components).toHaveLength(8);
    expect(d.meta.updatedAt).toBe(rev);
    const kitFile = path.join(findKitsDir()!, 'shadcn-like.mockup.json');
    expect(await ok('import_kit', { name: kitFile })).toContain('já está importado');
    expect(await fail('import_kit', { name: 'nao-existe' })).toContain('shadcn-like');
  });

  it('insert_component de kit importa só o que falta e preserva o principal editado ou renomeado', async () => {
    const first = await ok('insert_component', {
      component: 'shadcn-like/Card',
      parentId: ws.frameId,
    });
    expect(first).toContain('Kit "shadcn-like" importado (8 componente(s)');
    // Edita e renomeia o Button, apaga o Dialog (sem instâncias) e insere o Dialog de novo.
    await ok('update_styles', { nodeIds: ['el_sbtnroot'], styles: { color: 'red' } });
    await ok('update_component', { componentId: 'cp_sbutton1', name: 'Botao' });
    await ok('delete_component', { componentId: 'cp_sdialog1' });
    const dlg = await ok('insert_component', {
      component: 'shadcn-like/Dialog',
      parentId: ws.frameId,
    });
    expect(dlg).toContain('Kit "shadcn-like" importado (1 componente(s))');
    // `shadcn-like/Button` não acha pelo nome (renomeado), mas o id do kit já está no documento.
    const again = await ok('insert_component', {
      component: 'shadcn-like/Button',
      parentId: ws.frameId,
    });
    expect(again).toContain('de "Botao"');
    expect(again).not.toContain('importado');
    const d = await doc();
    const btn = d.components!.find((c) => c.id === 'cp_sbutton1')!;
    expect(btn.name).toBe('Botao');
    expect(btn.root.style.color).toBe('red');
    expect(d.components).toHaveLength(8);
  });

  it('import_kit sem overwrite lista os divergentes; com overwrite atualiza', async () => {
    await ok('import_kit', { name: 'shadcn-like' });
    await ok('update_styles', { nodeIds: ['el_sbtnroot'], styles: { color: 'red' } });
    await ok('delete_component', { componentId: 'cp_slist001' });
    const t = await ok('import_kit', { name: 'shadcn-like' });
    expect(t).toContain('List (added)');
    expect(t).toContain('Button (diverged)');
    expect(t).toContain('Divergentes do kit (mantidos com as suas edições): Button');
    expect(t).toContain('overwrite: true');
    let d = await doc();
    expect(d.components!.find((c) => c.id === 'cp_sbutton1')!.root.style.color).toBe('red');
    expect(d.components!.some((c) => c.id === 'cp_slist001')).toBe(true);
    // Repetir sem overwrite: nada a importar, o divergente continua listado.
    const rev = d.meta.updatedAt;
    const same = await ok('import_kit', { name: 'shadcn-like' });
    expect(same).toContain('nada a importar');
    expect(same).toContain('Divergentes');
    expect((await doc()).meta.updatedAt).toBe(rev);
    const over = await ok('import_kit', { name: 'shadcn-like', overwrite: true });
    expect(over).toContain('Button (updated)');
    d = await doc();
    expect(d.components!.find((c) => c.id === 'cp_sbutton1')!.root.style.color).toBe(
      'var(--color-primary-foreground)',
    );
    expect(await ok('import_kit', { name: 'shadcn-like' })).toContain('já está importado');
  });

  it('slots por HTML (Card): conteúdo vira nós reais no contêiner do slot', async () => {
    const t = await ok('insert_component', {
      component: 'shadcn-like/Card',
      parentId: ws.frameId,
      props: { title: 'Plano Pro' },
      slots: { content: '<p id="x" style="color:#123456">Tudo incluso</p>' },
    });
    const inst = instanceId(t);
    expect(t).toMatch(/Slots .*content=el_\w+/);
    const html = await ok('get_html', { nodeId: inst });
    expect(html).toContain('Plano Pro');
    expect(html).toContain('Tudo incluso');
    expect(html).not.toContain('Conteúdo do cartão');
    // footer vazio usa o conteúdo padrão do principal (botão aninhado)
    expect(html).toContain('Ação');
    const d = await doc();
    const instNode = d.pages[0]!.frames[0]!.children.find((c) => c.id === inst)!;
    expect(instNode.children.map((c) => c.attrs['data-slot'])).toEqual(['content', 'footer']);
    expect(instNode.children[0]!.children).toHaveLength(1);

    // Tailwind em slot: compilado para estilo
    const tw = await ok('insert_component', {
      component: 'Card',
      parentId: ws.frameId,
      slots: { content: '<div class="flex gap-4 p-4">Olá</div>' },
    });
    const inst2 = instanceId(tw);
    const slotId = /content=(\S+?)[,.]/.exec(tw)![1]!;
    const slotTree = await ok('get_tree_summary', { nodeId: slotId, depth: 2 });
    expect(slotTree).toContain('tw');
    expect(inst2).not.toBe(inst);
  });

  it('create_component com bind, props inferidas, undo e redo', async () => {
    const html = await ok('write_html', {
      parentId: ws.frameId,
      tailwind: 'off',
      html: '<button style="padding:8px 16px;background:#2563eb;color:#fff"><span>Enviar</span></button>',
    });
    const btn = /Nós criados: ([^.\n,]+)/.exec(html)![1]!.trim();
    const tree = await ok('get_tree_summary', { nodeId: btn });
    const span = /(tx_\w+|el_\w+)(?= "Span")/.exec(tree)?.[1] ?? /\n\s+(\w+) /.exec(tree)![1]!;
    const t = await ok('create_component', {
      nodeId: btn,
      name: 'Acao',
      description: 'Botão de ação',
      props: [
        { name: 'label', type: 'string', bind: { nodeId: span, target: 'text' } },
        { name: 'bg', type: 'color', bind: { nodeId: btn, target: 'style:background' } },
      ],
    });
    expect(t).toContain('Componente criado: cp_');
    expect(t).toContain('label:string="Enviar"');
    const d = await doc();
    const def = d.components!.find((c) => c.name === 'Acao')!;
    expect(def.root.style['background']).toBe('{{bg}}');
    expect(def.props.find((p) => p.name === 'bg')?.default).toBe('#2563eb');
    const inst = /instância (in_\w+)/.exec(t)![1]!;
    expect(await ok('get_html', { nodeId: inst })).toContain('Enviar');
    await ok('set_instance_props', { nodeIds: [inst], set: { label: 'Salvar', bg: '#16a34a' } });
    const h = await ok('get_html', { nodeId: inst });
    expect(h).toContain('Salvar');
    expect(h).toContain('#16a34a');

    await ok('undo'); // props da instância
    await ok('undo'); // criação do componente
    expect((await doc()).components ?? []).toHaveLength(0);
    expect(JSON.stringify((await doc()).pages)).toContain(btn);
    await ok('redo');
    await ok('redo');
    expect((await doc()).components).toHaveLength(1);
    expect(await ok('get_html', { nodeId: inst })).toContain('Salvar');
    expect(await fail('create_component', { nodeId: ws.frameId })).toContain('frame');
  });

  it('set_instance_props / set_instance_override (mescla) / reset_instance', async () => {
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
      text: 'Excluir',
      style: { 'font-size': '20px' },
    });
    d = await doc();
    const ov = d.pages[0]!.frames[0]!.children.find((c) => c.id === inst)!.overrides![label]!;
    expect(ov.style).toEqual({ color: '#ff0000', 'font-size': '20px' });
    expect(ov.text).toBe('Excluir');
    expect(await ok('get_html', { nodeId: inst })).toContain('Excluir');
    expect(await ok('get_styles', { nodeIds: [`${inst}/${label}`] })).toContain('color: #ff0000');

    expect(
      await fail('set_instance_override', { nodeId: inst, path: 'el_nada', text: 'x' }),
    ).toContain('não existe');
    expect(await fail('set_instance_override', { nodeId: inst, path: label })).toContain(
      'Informe ao menos',
    );

    // update_styles direto no id virtual também vira override
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
    expect(await ok('get_html', { nodeId: inst })).not.toContain('Excluir');
  });

  it('push_overrides_to_main propaga às outras instâncias; detach_instance devolve o novo id', async () => {
    const a = await insertButton({ label: 'A' });
    const b = await insertButton({ label: 'B' });
    await ok('set_instance_override', {
      nodeId: a,
      path: 'tx_sbtnlabl',
      style: { 'font-style': 'italic' },
    });
    expect(await ok('get_styles', { nodeIds: [`${b}/tx_sbtnlabl`] })).not.toContain('italic');
    const t = await ok('push_overrides_to_main', { nodeId: a });
    expect(t).toContain('afeta 2 instância(s) (+5 dentro de outros componentes)');
    expect(await ok('get_styles', { nodeIds: [`${b}/tx_sbtnlabl`] })).toContain(
      'font-style: italic',
    );
    expect(await ok('push_overrides_to_main', { nodeId: a })).toContain('nada a enviar');

    const det = await ok('detach_instance', { nodeId: b });
    const newId = /Novo id: (\S+?)\./.exec(det)![1]!;
    expect(newId).not.toBe(b);
    const d = await doc();
    const frame = d.pages[0]!.frames[0]!;
    expect(frame.children.some((c) => c.id === b)).toBe(false);
    const detached = frame.children.find((c) => c.id === newId)!;
    expect(detached.type).toBe('element');
    expect(detached.componentId).toBeUndefined();
    expect(JSON.stringify(detached)).toContain('B');
    expect(await fail('detach_instance', { nodeId: newId })).toContain('não é uma instância');
  });

  it('update_component_html propaga às instâncias, mantém {{prop}} e avisa', async () => {
    const inst = await insertButton({ label: 'Salvar' });
    const t = await ok('update_component_html', {
      componentId: 'Button',
      html: '<button style="padding:4px 8px;background:#0f172a;color:#fff"><span>{{label}}</span> <b>{{icone}}</b></button>',
    });
    expect(t).toContain('atualizadas: 1 instância(s)');
    expect(t).toContain('Props criadas a partir do HTML: icone:string');
    // variant e size ainda são usadas pelas variantes do principal: sem aviso
    expect(t).not.toContain('props sem uso');
    const input = await ok('update_component_html', {
      componentId: 'Input',
      html: '<input style="padding:4px" placeholder="{{placeholder}}">',
    });
    expect(input).toContain('props sem uso no HTML');
    expect(input).toMatch(/sem uso.*value/);
    const html = await ok('get_html', { nodeId: inst });
    expect(html).toContain('Salvar');
    expect(html).toContain('#0f172a');
    expect(
      await fail('update_component_html', { componentId: 'Button', html: '<p>a</p><p>b</p>' }),
    ).toContain('único elemento raiz');
    await ok('undo'); // Input
    await ok('undo'); // Button
    expect(await ok('get_html', { nodeId: inst })).not.toContain('#0f172a');
  });

  it('update_component_html com Tailwind compila as classes e cria slots', async () => {
    await ok('import_kit', { name: 'shadcn-like' });
    const t = await ok('update_component_html', {
      componentId: 'List',
      html: '<ul class="flex flex-col gap-2"><li data-slot="items">x</li></ul>',
    });
    expect(t).toContain('Classes Tailwind compiladas');
    const d = await doc();
    const def = d.components!.find((c) => c.name === 'List')!;
    expect(def.root.style['gap']).toBeTruthy();
    expect(def.props.some((p) => p.type === 'slot' && p.name === 'items')).toBe(true);
    expect(d.cssBase).toBe('tailwind');
  });

  it('editar o principal por update_styles nos ids do principal propaga às instâncias; go_to_main', async () => {
    const a = await insertButton({ label: 'A' });
    const b = await insertButton({ label: 'B' });
    const t = await ok('go_to_main', { nodeId: `${a}/tx_sbtnlabl` });
    expect(t).toContain('el_sbtnroot');
    expect(t).toContain('tx_sbtnlabl');
    expect(await ok('get_selection')).toContain('el_sbtnroot');
    // ids do principal valem na leitura
    expect(await ok('get_html', { nodeId: 'el_sbtnroot' })).toContain('{{label}}');
    expect(await ok('get_node_info', { nodeId: 'tx_sbtnlabl' })).toContain('principal');
    await ok('update_styles', { nodeIds: ['tx_sbtnlabl'], styles: { 'font-size': '33px' } });
    expect(await ok('get_styles', { nodeIds: [`${a}/tx_sbtnlabl`, `${b}/tx_sbtnlabl`] })).toMatch(
      /font-size: 33px[\s\S]*font-size: 33px/,
    );
    await ok('set_selection', { nodeIds: [a] });
    expect(await ok('go_to_main', { nodeId: a })).toContain('Principal "Button"');
    expect(await fail('go_to_main', { nodeId: ws.frameId })).toContain('não é uma instância');
  });

  it('delete_component recusa com instâncias; detach_instances destaca e exclui', async () => {
    const inst = await insertButton({ label: 'X' });
    const refused = await fail('delete_component', { componentId: 'cp_sbutton1' });
    expect(refused).toContain('detach_instances');
    const t = await ok('delete_component', { componentId: 'Button', detach_instances: true });
    expect(t).toContain('6 instância(s) destacada(s)');
    const d = await doc();
    expect(d.components?.some((c) => c.name === 'Button')).toBeFalsy();
    expect(JSON.stringify(d.pages)).not.toContain(inst);
    expect(JSON.stringify(d.pages)).toContain('X');
    await ok('undo');
    expect((await doc()).components?.some((c) => c.name === 'Button')).toBe(true);
  });

  it('get_screenshot/get_layout entregam ao provider o documento expandido', async () => {
    const inst = await insertButton({ variant: 'outline', label: 'Salvar' });
    await ok('get_screenshot', { nodeId: inst });
    expect(captures).toHaveLength(1);
    let instances = 0;
    for (const page of captures[0]!.doc.pages)
      for (const f of page.frames)
        walk(f, (n) => {
          if (n.type === 'instance') instances++;
        });
    expect(instances).toBe(0);
    expect(JSON.stringify(captures[0]!.doc.pages)).toContain('Salvar');
    expect(captures[0]!.nodeId).toBe(inst);

    // id virtual
    await ok('get_screenshot', { nodeId: `${inst}/tx_sbtnlabl` });
    expect(captures[1]!.nodeId).toBe(`${inst}/tx_sbtnlabl`);

    await ok('get_layout', { nodeId: inst });
    expect(measures[0]!.nodeId).toBe(inst);
    expect(JSON.stringify(measures[0]!.doc.pages)).toContain('Salvar');

    // principal (cp_ e nó raiz do principal): prévia numa instância padrão
    for (const ref of ['cp_sbutton1', 'el_sbtnroot']) {
      captures.length = 0;
      await ok('get_screenshot', { nodeId: ref });
      const req = captures[0]!;
      expect(req.nodeId).toBe('in_preview0');
      expect(req.doc.pages).toHaveLength(1);
      const s = JSON.stringify(req.doc.pages);
      expect(s).not.toContain('"type":"instance"');
      expect(s).toContain('Botão');
    }
    // não alterou o documento
    expect((await doc()).pages).toHaveLength(1);
  });

  it('rota /render usa o documento expandido', async () => {
    const inst = await insertButton({ label: 'Rota' });
    const info = (await (await fetch(`${daemon.url}/api/docs`)).json()) as { activeDocId: string };
    const res = await fetch(`${daemon.url}/render/${info.activeDocId}/${inst}.png`);
    expect(res.status).toBe(200);
    expect(JSON.stringify(captures[0]!.doc.pages)).toContain('Rota');
    expect(JSON.stringify(captures[0]!.doc.pages)).not.toContain('"type":"instance"');
    const missing = await fetch(`${daemon.url}/render/${info.activeDocId}/nao_existe.png`);
    expect(missing.status).toBe(404);
  });

  it('get_code (html/react) e export aceitam instância, id virtual e nó de principal', async () => {
    const inst = await insertButton({ variant: 'outline', label: 'Salvar' });
    const html = await ok('get_code', { nodeId: inst, format: 'html' });
    expect(html).toContain('Salvar');
    const virt = await ok('get_code', { nodeId: `${inst}/tx_sbtnlabl`, format: 'html' });
    expect(virt).toContain('Salvar');
    const main = await ok('get_code', { nodeId: 'el_sbtnroot', format: 'html' });
    expect(main).toContain('{{label}}');
    const react = await ok('get_code', { nodeId: inst, format: 'react' });
    expect(react).toContain('Button');
    const out = path.join(ws.dir, 'out');
    const exp = await ok('export', { nodeIds: [inst], format: 'html', outputDir: out });
    expect(exp).toContain('Salvar');
    expect(fs.readdirSync(out).length).toBeGreaterThan(0);
  });

  it('get_guide("components") e instruções citam componentes', async () => {
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

  describe('kits e rotas HTTP', () => {
    it('GET /api/kits lista os kits com componentes e props', async () => {
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
      expect(button.description).toContain('Botão');
      expect(button.props.map((p) => p.name)).toEqual(['variant', 'size', 'label']);
    });

    it('GET /api/kits/:name devolve o documento do kit; nome inexistente ou com caminho dá 404', async () => {
      const res = await fetch(`${daemon.url}/api/kits/shadcn-like`);
      expect(res.status).toBe(200);
      const kit = (await res.json()) as Document;
      expect(kit.components?.length).toBe(8);
      expect(Object.keys(kit.tokens)).toContain('--color-primary');
      expect((await fetch(`${daemon.url}/api/kits/nao-existe`)).status).toBe(404);
      expect((await fetch(`${daemon.url}/api/kits/..%2Fpackage`)).status).toBe(404);
    });

    it('findKitsDir/loadKit: MOCKUP_KITS_DIR, cache por mtime e erros', async () => {
      expect(listKitNames()).toContain('shadcn-like');
      expect(loadKit('SHADCN-LIKE')).toBe(loadKit('shadcn-like'));
      const dir = fs.mkdtempSync(path.join(ws.dir, 'kits-'));
      fs.copyFileSync(
        path.join(findKitsDir()!, 'shadcn-like.mockup.json'),
        path.join(dir, 'meu.mockup.json'),
      );
      fs.writeFileSync(path.join(dir, 'quebrado.mockup.json'), '{ nao e json');
      const prev = process.env.MOCKUP_KITS_DIR;
      process.env.MOCKUP_KITS_DIR = dir;
      try {
        expect(findKitsDir()).toBe(path.resolve(dir));
        expect(listKitNames()).toEqual(['meu', 'quebrado']);
        const k = loadKit('meu');
        expect(loadKit('meu')).toBe(k);
        expect(() => loadKit('quebrado')).toThrow(/inválido/);
        const res = await fetch(`${daemon.url}/api/kits`);
        const body = (await res.json()) as { kits: { name: string }[] };
        expect(body.kits.map((x) => x.name)).toEqual(['meu']); // o quebrado é ignorado
        expect((await fetch(`${daemon.url}/api/kits/quebrado`)).status).toBe(400);
      } finally {
        if (prev === undefined) delete process.env.MOCKUP_KITS_DIR;
        else process.env.MOCKUP_KITS_DIR = prev;
      }
    });
  });
});
