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
 * Documento de teste: frame Desktop > header (h1, nav > 2 links), section.actions (3 botões),
 * p e footer. `ids` indexa os nós pelo nome.
 */
async function setup(
  extra: { render?: RenderProvider; assistant?: AssistantServiceApi } = {},
): Promise<Fixture> {
  const ws = makeWorkspace();
  const store = new DocumentStore({ dataDir: ws.dataDir, autosaveMs: 60_000 });
  const { docId } = await store.open(ws.file);
  const mk = createNodeFromTag;
  const btn = (text: string, bg: string) =>
    mk('button', { name: `Botão ${text}`, text, styles: { background: bg, color: '#fff' } });
  const h1 = mk('h1', { name: 'Título', text: 'Olá mundo', styles: { 'font-size': '32px' } });
  const link1 = mk('a', { name: 'Link Home', text: 'Home', attrs: { href: '/' } });
  const link2 = mk('a', { name: 'Link Sobre', text: 'Sobre', attrs: { href: '/sobre' } });
  const nav = mk('nav', { name: 'Menu', children: [link1, link2] });
  const header = mk('header', { name: 'Cabeçalho', children: [h1, nav] });
  const b1 = btn('Comprar', 'red');
  const b2 = btn('Saiba mais', 'blue');
  const b3 = btn('Cancelar', 'gray');
  const actions = mk('section', { name: 'Ações', children: [b1, b2, b3] });
  const p = mk('p', { name: 'Parágrafo', text: 'Texto do parágrafo.' });
  const footer = mk('footer', { name: 'Rodapé', children: [] });
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

describe('ScriptService: API do documento', () => {
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

  it('doc.id, doc.name, pages e frames', async () => {
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
    const bad = await run(`return doc.frames("pg_inexistente");`);
    expect(bad.ok).toBe(false);
    expect(bad.error).toContain('Página não encontrada');
  });

  it('doc.get devolve o handle ou null', async () => {
    expect(await val(`return doc.get("${f.ids['Título']}").name;`)).toBe('Título');
    expect(await val(`return doc.get("el_naoexiste");`)).toBeNull();
    expect(await val(`return doc.get(doc.get("${f.ids['Título']}")).id;`)).toBe(f.ids['Título']);
  });

  describe('select', () => {
    const ids = async (q: string) =>
      (await val(`return doc.select(${q}).map(n => n.name);`)) as string[];

    it('seletor: *, tipos e tags', async () => {
      expect((await ids('"*"')).length).toBe(12);
      expect(await ids('"frame"')).toEqual(['Desktop']);
      expect(await ids('"text"')).toEqual([
        'Título',
        'Link Home',
        'Link Sobre',
        'Botão Comprar',
        'Botão Saiba mais',
        'Botão Cancelar',
        'Parágrafo',
      ]);
      expect(await ids('"button"')).toEqual([
        'Botão Comprar',
        'Botão Saiba mais',
        'Botão Cancelar',
      ]);
      expect(await ids('"h1, p"')).toEqual(['Título', 'Parágrafo']);
      expect(await ids('"BUTTON"')).toHaveLength(3);
      expect(await ids('"instance"')).toEqual([]);
    });

    it('seletor: #id e .classe', async () => {
      expect(await ids(`"#${f.ids['Menu']}"`)).toEqual(['Menu']);
      expect(await ids('"#el_nada"')).toEqual([]);
      const cls = await run(
        `doc.apply({ type: "setClasses", changes: [{ nodeId: "${f.ids['Título']}", classes: "text-xl font-bold" }] });
         return doc.select(".font-bold").map(n => n.name);`,
      );
      expect(cls.result).toEqual(['Título']);
    });

    it('seletor: atributos =, ^=, *=, $=, presença, style.* e attrs.*', async () => {
      expect(await ids('`[name="Botão Comprar"]`')).toEqual(['Botão Comprar']);
      expect(await ids('"[name^=Botão]"')).toHaveLength(3);
      expect(await ids('"[name*=mais]"')).toEqual(['Botão Saiba mais']);
      expect(await ids('"[name$=ancelar]"')).toEqual(['Botão Cancelar']);
      expect(await ids(`"[text*='mundo']"`)).toEqual(['Título']);
      expect(await ids('"[tag=a]"')).toEqual(['Link Home', 'Link Sobre']);
      expect(await ids('"[type=frame]"')).toEqual(['Desktop']);
      expect(await ids('"[style.font-size]"')).toEqual(['Título']);
      expect(await ids('"[style.fontSize=32px]"')).toEqual(['Título']);
      expect(await ids('"button[style.background=blue]"')).toEqual(['Botão Saiba mais']);
      expect(await ids('"[attrs.href$=sobre]"')).toEqual(['Link Sobre']);
      expect(await ids('"[hidden]"')).toEqual([]);
    });

    it('seletor: combinadores descendente e filho', async () => {
      expect(await ids('"header a"')).toEqual(['Link Home', 'Link Sobre']);
      expect(await ids('"header > a"')).toEqual([]);
      expect(await ids('"nav > a"')).toEqual(['Link Home', 'Link Sobre']);
      expect(await ids('"frame > section > button"')).toHaveLength(3);
      expect(await ids('"frame>section>button"')).toHaveLength(3);
      expect(await ids('"section button, h1"')).toHaveLength(4);
      expect(await ids('"header nav a[attrs.href=\\"/\\"]"')).toEqual(['Link Home']);
    });

    it('seletor inválido devolve erro claro', async () => {
      for (const q of ['""', '"[name"', '"a >"', '"a $"', '"[x=1]"', '"> a"', '"a,"']) {
        const r = await run(`return doc.select(${q});`);
        expect(r.ok, q).toBe(false);
        expect(r.error, q).toMatch(/Seletor inválido|Atributo desconhecido/);
      }
    });

    it('função predicado recebe o snapshot JSON do nó', async () => {
      expect(
        await val(
          `return doc.select(n => n.tag === "button" && n.style.background === "red").map(n => n.name);`,
        ),
      ).toEqual(['Botão Comprar']);
      expect(
        await val(`return doc.select(n => n.childIds.length === 3).map(n => n.name);`),
      ).toEqual(['Ações']);
      expect(await val(`return doc.select(n => n.parentId === null).map(n => n.name);`)).toEqual([
        'Desktop',
      ]);
    });

    it('objeto: type, tag, name e text (string exata ou RegExp) e within', async () => {
      expect(await ids('{ type: "frame" }')).toEqual(['Desktop']);
      expect(await ids('{ tag: "a" }')).toEqual(['Link Home', 'Link Sobre']);
      expect(await ids('{ name: "Menu" }')).toEqual(['Menu']);
      expect(await ids('{ name: "Men" }')).toEqual([]);
      expect(await ids('{ name: /^Botão/ }')).toHaveLength(3);
      expect(await ids('{ type: "text", text: /mais|Home/ }')).toEqual([
        'Link Home',
        'Botão Saiba mais',
      ]);
      expect(await ids('{ text: "Home" }')).toEqual(['Link Home']);
      expect(await ids(`{ tag: "a", within: "${f.ids['Cabeçalho']}" }`)).toHaveLength(2);
      expect(await ids(`{ tag: "button", within: "${f.ids['Cabeçalho']}" }`)).toEqual([]);
    });

    it('regex global não é afetada por lastIndex entre os nós', async () => {
      expect(await ids('{ name: /Bot/g }')).toHaveLength(3);
    });

    it('selectOne, consulta inválida e node.select (só descendentes)', async () => {
      expect(await val(`return doc.selectOne("button").name;`)).toBe('Botão Comprar');
      expect(await val(`return doc.selectOne("video");`)).toBeNull();
      const bad = await run(`return doc.select(42);`);
      expect(bad.error).toContain('Consulta inválida');
      expect(
        await val(`return doc.get("${f.ids['Cabeçalho']}").select("a").map(n => n.name);`),
      ).toEqual(['Link Home', 'Link Sobre']);
      expect(await val(`return doc.get("${f.ids['Cabeçalho']}").select("header").length;`)).toBe(0);
      expect(
        await val(`return doc.get("${f.ids['Ações']}").select({ type: "text" }).length;`),
      ).toBe(3);
      expect(await val(`return doc.get("${f.ids['Ações']}").select(n => true).length;`)).toBe(3);
      // o ancestral fora do escopo ainda vale no seletor composto
      expect(await val(`return doc.get("${f.ids['Ações']}").select("frame button").length;`)).toBe(
        3,
      );
    });
  });

  describe('NodeHandle', () => {
    it('leituras: id, type, tag, name, text, classes, position, parent, children, frame, toJSON', async () => {
      const r = (await val(`
        const b = doc.selectOne("button");
        return {
          id: b.id, type: b.type, tag: b.tag, name: b.name, text: b.text, classes: b.classes,
          position: b.position, parent: b.parent.name, frame: b.frame.name,
          filhosDoPai: b.parent.children.map(c => c.name),
          raizPai: doc.frames()[0].parent,
          json: JSON.parse(JSON.stringify(b)),
        };`)) as Record<string, unknown>;
      expect(r).toMatchObject({
        id: f.ids['Botão Comprar'],
        type: 'text',
        tag: 'button',
        name: 'Botão Comprar',
        text: 'Comprar',
        classes: '',
        parent: 'Ações',
        frame: 'Desktop',
        filhosDoPai: ['Botão Comprar', 'Botão Saiba mais', 'Botão Cancelar'],
        raizPai: null,
      });
      expect(r['json']).toMatchObject({
        id: f.ids['Botão Comprar'],
        tag: 'button',
        parentId: f.ids['Ações'],
      });
      expect(await val(`return doc.frames()[0].position;`)).toEqual({ x: 0, y: 0 });
    });

    it('name e text: escrita vira renameNodes e setText', async () => {
      const r = await run(`
        const b = doc.selectOne("button");
        b.name = "CTA"; b.text = "Comprar já";
        return [b.name, b.text];`);
      expect(r.result).toEqual(['CTA', 'Comprar já']);
      expect(r.opsCount).toBe(2);
      const n = findNode(doc(), f.ids['Botão Comprar']!)!.node;
      expect(n.name).toBe('CTA');
      expect(n.text).toBe('Comprar já');
    });

    it('style: ler, atribuir, delete, camelCase, Object.keys e setStyle', async () => {
      const r = await run(`
        const b = doc.selectOne("button");
        const antes = b.style.background;
        b.style.background = "green";
        b.style.borderRadius = "8px";
        b.style["--x"] = "1";
        delete b.style.color;
        b.setStyle({ padding: "4px 8px", gap: "" });
        return { antes, depois: b.style.background, radius: b.style["border-radius"], tem: "color" in b.style,
                 chaves: Object.keys(b.style).sort(), json: JSON.stringify(b.style) };`);
      expect(r.error).toBeUndefined();
      expect(r.result).toMatchObject({
        antes: 'red',
        depois: 'green',
        radius: '8px',
        tem: false,
        chaves: ['--x', 'background', 'border-radius', 'padding'],
      });
      const st = findNode(doc(), f.ids['Botão Comprar']!)!.node.style;
      expect(st).toEqual({
        background: 'green',
        'border-radius': '8px',
        '--x': '1',
        padding: '4px 8px',
      });
    });

    it('style: valor vazio/null remove e atribuir objeto ao style orienta', async () => {
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

    it('attrs: ler, atribuir e delete', async () => {
      const r = await run(`
        const a = doc.selectOne("a");
        const antes = a.attrs.href;
        a.attrs.href = "/inicio";
        a.attrs.target = "_blank";
        delete a.attrs.target;
        a.attrs.title = "Ir";
        return { antes, depois: a.attrs.href, chaves: Object.keys(a.attrs).sort() };`);
      expect(r.result).toEqual({ antes: '/', depois: '/inicio', chaves: ['href', 'title'] });
      expect(findNode(doc(), f.ids['Link Home']!)!.node.attrs).toEqual({
        href: '/inicio',
        title: 'Ir',
      });
    });

    it('position: ler e atribuir', async () => {
      const r = await run(`
        const fr = doc.frames()[0];
        fr.position = { x: 40, y: 50 };
        return fr.position;`);
      expect(r.result).toEqual({ x: 40, y: 50 });
    });

    it('duplicate devolve o clone; remove apaga; nó removido gera erro claro', async () => {
      const r = await run(`
        const b = doc.selectOne("button");
        const c = b.duplicate();
        c.name = "Clone";
        const total = doc.select("button").length;
        b.remove();
        let erro = null;
        try { b.name; } catch (e) { erro = e.message; }
        return { cloneId: c.id, diferente: c.id !== b.id, total, depois: doc.select("button").length, erro };`);
      expect(r.error).toBeUndefined();
      const v = r.result as { diferente: boolean; total: number; depois: number; erro: string };
      expect(v.diferente).toBe(true);
      expect(v.total).toBe(4);
      expect(v.depois).toBe(3);
      expect(v.erro).toContain('não existe mais');
      expect(findNode(doc(), f.ids['Botão Comprar']!)).toBeUndefined();
    });

    it('doc.create cria nós (com filhos) e frames', async () => {
      const r = await run(`
        const card = doc.create(doc.get("${f.ids['Rodapé']}"), {
          tag: "div", name: "Card", style: { padding: 8, display: "flex" },
          children: [{ tag: "h2", text: "Título", name: "T" }, { tag: "img", attrs: { alt: "x" } }],
        });
        const novo = doc.create(null, { name: "Mobile", style: { width: "390px", height: "800px" } });
        return { card: card.children.map(c => c.tag), pad: card.style.padding, frame: novo.type, nome: novo.name, pos: novo.position };`);
      expect(r.error).toBeUndefined();
      expect(r.result).toMatchObject({
        card: ['h2', 'img'],
        pad: '8',
        frame: 'frame',
        nome: 'Mobile',
      });
      expect(doc().pages[0]!.frames).toHaveLength(2);
      const bad = await run(`doc.create("el_nada", { tag: "div" });`);
      expect(bad.error).toContain('Nó pai não encontrado');
    });
  });

  describe('doc.apply, tokens, console e return', () => {
    it('apply com array devolve um resultado por op e aplica em lote', async () => {
      const r = await run(`
        const res = doc.apply([
          { type: "renameNodes", changes: [{ nodeId: "${f.ids['Título']}", name: "H1" }] },
          { type: "updateStyles", nodeIds: ["${f.ids['Título']}"], styles: { color: "blue" } },
          { type: "duplicateNodes", nodeIds: ["${f.ids['Parágrafo']}"] },
        ]);
        return { n: res.length, idMap: Object.keys(res[2].idMap).length, op: "op" in res[2] };`);
      expect(r.result).toMatchObject({ n: 3, idMap: 1, op: false });
      expect(r.opsCount).toBe(3);
      expect(node('Título').name).toBe('H1');
      expect(doc().pages[0]!.frames[0]!.children).toHaveLength(5);
      expect(await val(`return doc.apply([]);`)).toEqual([]);
    });

    it('op inválida vira Error no script (capturável) e o lote é atômico', async () => {
      const r = await run(`
        let erro = null;
        try {
          doc.apply([
            { type: "renameNodes", changes: [{ nodeId: "${f.ids['Título']}", name: "Meio" }] },
            { type: "renameNodes", changes: [{ nodeId: "el_nao_existe", name: "x" }] },
          ]);
        } catch (e) { erro = e.message; }
        let desconhecida = null;
        try { doc.apply({ type: "naoExiste" }); } catch (e) { desconhecida = e.message; }
        return { erro, desconhecida, nome: doc.get("${f.ids['Título']}").name };`);
      const v = r.result as { erro: string; desconhecida: string; nome: string };
      expect(v.erro).toContain('Operação #2');
      expect(v.desconhecida).toContain('Operação inválida');
      expect(v.nome).toBe('Título'); // lote atômico: nada aplicado
      expect(r.opsCount).toBe(0);
    });

    it('tokens e setTokens (prefixo -- opcional, null remove)', async () => {
      const r = await run(`
        const a = doc.tokens();
        const b = doc.setTokens({ "--cor": "#fff", fonte: "Inter" });
        const c = doc.setTokens({ fonte: null });
        return { a, b, c };`);
      expect(r.error).toBeUndefined();
      expect(r.result).toEqual({
        a: {},
        b: { '--cor': '#fff', '--fonte': 'Inter' },
        c: { '--cor': '#fff' },
      });
      expect(doc().tokens).toEqual({ '--cor': '#fff' });
      const bad = await run(`doc.setTokens("x");`);
      expect(bad.ok).toBe(false);
    });

    it('console.log coleta e return é serializado', async () => {
      const r = await run(`
        console.log("achei", doc.select("button").length, { a: 1 });
        console.warn("atenção");
        return doc.select("button").map(b => ({ id: b.id, name: b.name }));`);
      expect(r.ok).toBe(true);
      expect(r.logs).toEqual(['achei 3 {"a":1}', '[warn] atenção']);
      expect(r.result).toHaveLength(3);
      expect(r.images).toEqual([]);
      expect(r.durationMs).toBeGreaterThanOrEqual(0);
    });

    it('doc.selection usa opts.selection ou a do daemon e ignora ids que não existem', async () => {
      f.store.setSelection(f.docId, [f.ids['Título']!, 'el_fantasma'], 'editor');
      expect(await val(`return doc.selection().map(n => n.name);`)).toEqual(['Título']);
      const r = await run(`return doc.selection().map(n => n.name);`, {
        selection: [f.ids['Menu']!],
      });
      expect(r.result).toEqual(['Menu']);
    });
  });

  describe('undo por execução', () => {
    it('renomear 10 nós vira UMA entrada de undo', async () => {
      const make = await run(`
        for (let i = 0; i < 10; i++) doc.create(doc.get("${f.ids['Rodapé']}"), { tag: "span", name: "item" + i, text: "i" });
        return 1;`);
      expect(make.opsCount).toBe(10);
      const before = doc()
        .pages[0]!.frames[0]!.children.at(-1)!
        .children.map((c) => c.name);
      expect(before).toHaveLength(10);
      const r = await run(`
        const nodes = doc.select("footer > span");
        nodes.forEach((n, i) => { n.name = "Novo " + i; });
        return nodes.length;`);
      expect(r.ok).toBe(true);
      expect(r.opsCount).toBe(10);
      const names = () =>
        doc()
          .pages[0]!.frames[0]!.children.at(-1)!
          .children.map((c) => c.name);
      expect(names()[3]).toBe('Novo 3');
      f.store.undo(f.docId, 'editor');
      expect(names()).toEqual(before); // um undo restaura os 10 nomes
      f.store.undo(f.docId, 'editor'); // o seguinte desfaz a criação dos 10 nós (outra execução)
      expect(doc().pages[0]!.frames[0]!.children.at(-1)!.children).toHaveLength(0);
    });

    it('erro no meio: as ops anteriores ficam aplicadas, no mesmo grupo, e ok é false', async () => {
      const r = await run(`
        doc.get("${f.ids['Título']}").name = "Mudou";
        doc.get("${f.ids['Parágrafo']}").text = "Mudou também";
        throw new Error("falhou no meio");`);
      expect(r.ok).toBe(false);
      expect(r.error).toBe('falhou no meio (linha 4)');
      expect(r.opsCount).toBe(2);
      expect(node('Título').name).toBe('Mudou');
      f.store.undo(f.docId, 'editor');
      expect(node('Título').name).toBe('Título');
      expect(node('Parágrafo').text).toBe('Texto do parágrafo.');
    });

    it('execuções seguidas têm grupos separados; grupo recebido por opts é compartilhado', async () => {
      await run(`doc.get("${f.ids['Título']}").name = "A";`);
      await run(`doc.get("${f.ids['Título']}").name = "B";`);
      f.store.undo(f.docId, 'editor');
      expect(node('Título').name).toBe('A');
      f.store.undo(f.docId, 'editor');
      expect(node('Título').name).toBe('Título');

      await run(`doc.get("${f.ids['Título']}").name = "C";`, { group: 'turno:1' });
      await run(`doc.get("${f.ids['Parágrafo']}").text = "D";`, { group: 'turno:1' });
      f.store.undo(f.docId, 'editor');
      expect(node('Título').name).toBe('Título');
      expect(node('Parágrafo').text).toBe('Texto do parágrafo.');
    });

    it('as ops saem com a origem pedida (editor por padrão, mcp no run_script)', async () => {
      const sources: string[] = [];
      f.store.on('doc:changed', (e) => sources.push(e.source));
      await run(`doc.get("${f.ids['Título']}").name = "A";`);
      await run(`doc.get("${f.ids['Título']}").name = "B";`, { source: 'mcp' });
      expect(sources).toEqual(['editor', 'mcp']);
    });
  });

  describe('screenshot', () => {
    it('sem render: erro com a mensagem de render indisponível', async () => {
      const r = await run(`doc.screenshot();`);
      expect(r.ok).toBe(false);
      expect(r.error).toContain('motor de render não está disponível');
      expect(r.images).toEqual([]);
    });

    it('com render: devolve metadados ao script e a imagem em images', async () => {
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
          throw new Error('não usado');
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
        expect(r.images[1]).toMatchObject({ nodeId: g.ids['Botão Comprar'], mime: 'image/jpeg' });
        expect(r.result).toEqual([
          { nodeId: g.ids['Menu'], width: 1440, height: 900, mime: 'image/png' },
          { nodeId: g.ids['Botão Comprar'], width: 1440, height: 900, mime: 'image/jpeg' },
          { nodeId: g.ids['frame'], width: 1440, height: 900, mime: 'image/png' },
        ]);
        expect(calls[1]).toMatchObject({ scale: 2, format: 'jpg' });
        // sem seleção usa o primeiro frame
        g.store.setSelection(g.docId, [], 'editor');
        const d = await g.svc.run(g.docId, `return doc.screenshot().nodeId;`);
        expect(d.result).toBe(g.ids['frame']);
        const bad = await g.svc.run(g.docId, `doc.screenshot("el_nada");`);
        expect(bad.error).toContain('Nó não encontrado');
        const badScale = await g.svc.run(g.docId, `doc.screenshot(null, { scale: 9 });`);
        expect(badScale.error).toContain('scale');
        const many = await g.svc.run(g.docId, `for (let i = 0; i < 20; i++) doc.screenshot();`);
        expect(many.error).toContain('Screenshots demais');
        expect(many.images).toHaveLength(8);
      } finally {
        await g.store.closeAll();
        g.ws.cleanup();
      }
    });
  });

  it('documento inexistente rejeita a execução', async () => {
    await expect(f.svc.run('doc_nao_existe', 'return 1')).rejects.toThrow();
  });

  it('execuções além do limite de concorrência esperam a vez', async () => {
    const svc = new ScriptService(f.store, { maxConcurrent: 1 });
    const t0 = Date.now();
    const [a, b] = await Promise.all([
      svc.run(f.docId, 'return 1;'),
      svc.run(f.docId, 'return 2;'),
    ]);
    expect([a.result, b.result]).toEqual([1, 2]);
    expect(Date.now() - t0).toBeGreaterThan(0);
  });

  it('timeout: interrompe, devolve ok:false e as ops já feitas continuam no grupo', async () => {
    const r = await run(`doc.get("${f.ids['Título']}").name = "Antes do laço"; for (;;) {}`, {
      timeoutMs: 300,
    });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('tempo limite');
    expect(r.opsCount).toBe(1);
    f.store.undo(f.docId, 'editor');
    expect(node('Título').name).toBe('Título');
  });

  describe('cancelamento (alive e signal)', () => {
    it('alive() vira falso no meio: ops anteriores ficam, nenhuma nova', async () => {
      let alive = true;
      let writes = 0;
      // depois da primeira escrita o turno "termina"
      f.store.on('doc:changed', () => {
        if (++writes === 1) alive = false;
      });
      const r = await run(
        `doc.get("${f.ids['Título']}").name = "Primeiro";
         const erros = [];
         const tenta = (fn) => { try { fn(); erros.push(null); } catch (e) { erros.push(e.message); } };
         tenta(() => { doc.get("${f.ids['Parágrafo']}").name = "Segundo"; });
         tenta(() => doc.create(null, { tag: "div" }));
         tenta(() => doc.setTokens({ "--cor": "red" }));
         tenta(() => doc.apply({ type: "deleteNodes", nodeIds: ["${f.ids['Rodapé']}"] }));
         tenta(() => doc.get("${f.ids['Rodapé']}").remove());
         tenta(() => doc.get("${f.ids['Rodapé']}").duplicate());
         tenta(() => { doc.get("${f.ids['Título']}").style.color = "red"; });
         tenta(() => doc.get("${f.ids['Título']}").setStyle({ color: "red" }));
         return erros;`,
        { alive: () => alive, group: 'turno:t1' },
      );
      expect(r.ok, r.error).toBe(true);
      const erros = r.result as (string | null)[];
      expect(erros).toHaveLength(8);
      for (const e of erros) expect(e).toContain('turno do assistente terminou');
      expect(r.opsCount).toBe(1);
      expect(node('Título').name).toBe('Primeiro');
      expect(node('Parágrafo').name).toBe('Parágrafo');
      expect(node('Rodapé')).toBeTruthy();
      expect(node('Título').style['color']).not.toBe('red');
      expect(doc().tokens['--cor']).toBeUndefined();
    });

    it('signal abortado durante um laço encerra rápido com ok:false e mantém as ops já feitas', async () => {
      const ac = new AbortController();
      const t0 = Date.now();
      const p = run(`doc.get("${f.ids['Título']}").name = "Antes"; while (true) {}`, {
        timeoutMs: 30_000,
        signal: ac.signal,
      });
      setTimeout(() => ac.abort(), 300);
      const r = await p;
      expect(r.ok).toBe(false);
      expect(r.error).toContain('cancelada');
      expect(r.opsCount).toBe(1);
      expect(Date.now() - t0).toBeLessThan(2000);
    });

    it('vigia: alive() falso encerra um laço sem chamadas à API', async () => {
      let alive = true;
      setTimeout(() => (alive = false), 200);
      const t0 = Date.now();
      const r = await run('while (true) {}', { timeoutMs: 30_000, alive: () => alive });
      expect(r.ok).toBe(false);
      expect(r.error).toContain('turno do assistente terminou');
      expect(Date.now() - t0).toBeLessThan(1500);
    });
  });
});

describe('ScriptService: biblioteca scripts/*.js', () => {
  let f: Fixture;
  beforeEach(async () => {
    f = await setup();
  });
  afterEach(async () => {
    await f.store.closeAll();
    f.ws.cleanup();
  });

  it('normaliza nomes e recusa path traversal', () => {
    expect(normalizeScriptName('renomear')).toBe('renomear.js');
    expect(normalizeScriptName('Trocar cor-1.v2.js')).toBe('Trocar cor-1.v2.js');
    expect(normalizeScriptName('botões.JS')).toBe('botões.js');
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
      '.oculto',
      'con',
      'nul.js',
      'a;b',
      'a$b',
      'x'.repeat(120),
      '.js',
    ]) {
      expect(() => normalizeScriptName(bad), JSON.stringify(bad)).toThrow(/inválido|Informe/);
    }
    expect(() => normalizeScriptName(5)).toThrow();
  });

  it('salvar, listar (ordenado), ler e excluir', async () => {
    expect(await f.svc.list(f.docId)).toEqual({
      dir: path.join(f.ws.dir, 'scripts'),
      scripts: [],
    });
    expect(await f.svc.save(f.docId, 'zebra', 'return 1;')).toEqual({ name: 'zebra.js' });
    await f.svc.save(f.docId, 'Alfa.js', 'return "a";');
    await f.svc.save(f.docId, 'beta', 'return 22;');
    fs.writeFileSync(path.join(f.ws.dir, 'scripts', 'leia-me.txt'), 'x');
    fs.mkdirSync(path.join(f.ws.dir, 'scripts', 'pasta.js'));
    const list = await f.svc.list(f.docId);
    expect(list.scripts.map((s) => s.name)).toEqual(['Alfa.js', 'beta.js', 'zebra.js']);
    expect(list.scripts[1]).toMatchObject({ name: 'beta.js', size: 10 });
    expect(Date.parse(list.scripts[1]!.updatedAt)).not.toBeNaN();
    expect(await f.svc.read(f.docId, 'beta')).toEqual({ name: 'beta.js', code: 'return 22;' });
    await f.svc.save(f.docId, 'beta.js', 'return 23;');
    expect((await f.svc.read(f.docId, 'beta.js')).code).toBe('return 23;');
    await f.svc.remove(f.docId, 'beta');
    expect((await f.svc.list(f.docId)).scripts.map((s) => s.name)).toEqual(['Alfa.js', 'zebra.js']);
    await expect(f.svc.read(f.docId, 'beta')).rejects.toThrow(/não encontrado/);
    await expect(f.svc.remove(f.docId, 'beta')).rejects.toThrow(/não encontrado/);
  });

  it('recusa nomes perigosos sem tocar o disco', async () => {
    for (const bad of ['../fora', '..\\fora', 'a/../../fora', '/abs', 'sub/dir']) {
      await expect(f.svc.save(f.docId, bad, 'x')).rejects.toThrow(/inválido/);
      await expect(f.svc.read(f.docId, bad)).rejects.toThrow(/inválido/);
      await expect(f.svc.remove(f.docId, bad)).rejects.toThrow(/inválido/);
    }
    expect(fs.existsSync(path.join(f.ws.dir, 'fora.js'))).toBe(false);
    expect(fs.existsSync(path.join(f.ws.dir, 'scripts'))).toBe(false);
    await expect(f.svc.save(f.docId, 'ok', 'x'.repeat(600_000))).rejects.toThrow(/grande demais/);
  });

  it('documento sem caminho: lista vazia com dir null e erro claro ao salvar', async () => {
    const orig = f.store.getInfo.bind(f.store);
    f.store.getInfo = (id: string) => ({ ...orig(id), path: null });
    expect(await f.svc.list(f.docId)).toEqual({ dir: null, scripts: [] });
    await expect(f.svc.save(f.docId, 'a', 'x')).rejects.toThrow(/salve-o/);
    await expect(f.svc.read(f.docId, 'a')).rejects.toThrow(/salve-o/);
  });

  it('script:* pelo handle (mensagens do WebSocket)', async () => {
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
    await expect(h({ type: 'script:read', name: 7 })).rejects.toThrow(/nome do script/);
  });
});

describe('ScriptService: gerar com IA', () => {
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

  it('extrai o bloco ```js``` e envia o prompt de sistema com a API', async () => {
    const seen: { prompt?: string; system?: string } = {};
    f = await setup({
      assistant: fakeAssistant(
        'Claro!\n```js\nreturn doc.select("button").length;\n```\nPronto.',
        seen,
      ),
    });
    f.store.setSelection(f.docId, [f.ids['Menu']!], 'editor');
    const r = await f.svc.generate(f.docId, 'conte os botões');
    expect(r.code).toBe('return doc.select("button").length;');
    expect(seen.prompt).toContain('conte os botões');
    expect(seen.prompt).toContain(f.ids['Menu']);
    expect(seen.system).toContain('doc.select');
    expect(seen.system).toContain('SOMENTE com o código');
    const run = await f.svc.run(f.docId, r.code);
    expect(run.result).toBe(3);
  });

  it('aceita resposta só com código, cerca sem linguagem e cerca sem fechar', async () => {
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

  it('erros: sem assistente, prompt vazio e resposta vazia', async () => {
    f = await setup();
    await expect(f.svc.generate(f.docId, 'x')).rejects.toThrow(/assistente/);
    await f.store.closeAll();
    f.ws.cleanup();
    f = await setup({ assistant: fakeAssistant('   ') });
    await expect(f.svc.generate(f.docId, '  ')).rejects.toThrow(/Descreva/);
    await expect(f.svc.generate(f.docId, 'faça algo')).rejects.toThrow(/não devolveu código/);
  });

  it('script:generate pelo handle', async () => {
    f = await setup({ assistant: fakeAssistant('```js\nreturn 5;\n```') });
    const r = await f.svc.handle({
      type: 'script:generate',
      reqId: 'r',
      docId: f.docId,
      prompt: 'cinco',
    });
    expect(r).toEqual({ code: 'return 5;' });
  });
});
