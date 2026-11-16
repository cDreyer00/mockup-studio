import { describe, expect, it } from 'vitest';
import { htmlToNodes, nodesToHtml, slugify } from './html.js';
import type { Node } from './types.js';

describe('htmlToNodes', () => {
  it('aplica <style>, inline vence e ignora class/id/style em attrs', () => {
    const [n] = htmlToNodes(
      `<style>.box { color: red; padding: 8px } div { color: blue }</style>
       <div id="x" class="box hero" style="padding: 16px" data-name="Caixa" title="t">Oi</div>`,
    );
    expect(n.tag).toBe('div');
    expect(n.type).toBe('text');
    expect(n.text).toBe('Oi');
    expect(n.name).toBe('Caixa');
    expect(n.style).toEqual({ color: 'blue', padding: '16px' });
    expect(n.attrs).toEqual({ title: 't' });
  });

  it('usa o parâmetro css e seletores compostos, descendentes e filhos diretos', () => {
    const nodes = htmlToNodes(
      `<section class="a"><div class="b"><p class="c">x</p></div><p class="c">y</p></section>`,
      {
        css: `
          section p { color: red }
          section > p.c { margin: 1px }
          div#nope { color: green }
          p:hover { color: pink }
          a[href] { color: pink }
          #zz, .b { border: 1px solid }
          @media (min-width: 1px) { .c { color: black } }
        `,
      },
    );
    const section = nodes[0];
    const [div, p2] = section.children;
    expect(div.style).toEqual({ border: '1px solid' });
    expect(div.children[0].style).toEqual({ color: 'red' });
    expect(p2.style).toEqual({ color: 'red', margin: '1px' });
    expect(section.name).toBe('A');
  });

  it('texto misto vira span; espaços inline preservados, quebras de linha são formatação', () => {
    // Regra: whitespace sem quebra de linha vira 1 espaço (conteúdo); com quebra é descartado nas pontas.
    const [p] = htmlToNodes('<p>  Olá   <b>mundo</b>\n  fim </p>');
    expect(p.type).toBe('element');
    expect(p.children.map((c) => [c.tag, c.type, c.text])).toEqual([
      ['span', 'text', ' Olá '],
      ['b', 'text', 'mundo'],
      ['span', 'text', 'fim '],
    ]);
  });

  it('img, svg, script, comentários e html/body', () => {
    const nodes = htmlToNodes(
      `<!doctype html><html><head><title>t</title><style>img{width:10px}</style></head>
       <body><!-- c --><script>alert(1)</script>
       <img src="assets/a.png" alt="A" class="logo">
       <svg viewBox="0 0 10 10" width="10"><path d="M0 0"/></svg></body></html>`,
    );
    expect(nodes).toHaveLength(2);
    expect(nodes[0]).toMatchObject({
      type: 'image',
      tag: 'img',
      src: 'assets/a.png',
      attrs: { alt: 'A' },
      style: { width: '10px' },
      name: 'Logo',
    });
    expect(nodes[1].type).toBe('svg');
    expect(nodes[1].svg).toContain('viewBox="0 0 10 10"');
    expect(nodes[1].svg).toContain('<path');
  });

  it('descarta tags bloqueadas (math, template, frameset...) sem lançar', () => {
    const nodes = htmlToNodes(
      `<math><mi>x</mi></math><template><p>t</p></template><frameset></frameset>
       <portal></portal><div>ok</div><svg viewBox="0 0 1 1"></svg>`,
    );
    expect(nodes.map((n) => [n.type, n.tag])).toEqual([
      ['text', 'div'],
      ['svg', 'svg'],
    ]);
  });

  it('decodifica entidades', () => {
    const [n] = htmlToNodes('<p>a &amp; b &lt;c&gt;</p>');
    expect(n.text).toBe('a & b <c>');
  });
});

describe('nodesToHtml', () => {
  const nodes: Node[] = htmlToNodes(
    `<div style="display: flex; gap: 8px" data-name="Hero Section">
       <h1 style="font-size: 32px; font-family: &quot;Inter&quot;, sans-serif">Título &amp; mais</h1>
       <img src="a.png" alt="x" style="width: 10px">
       <button type="button">Ok</button>
       <br>
     </div>`,
  );

  it('modo inline (padrão)', () => {
    const { html, css } = nodesToHtml(nodes);
    expect(css).toBe('');
    expect(html).toContain('<div style="display: flex; gap: 8px">');
    expect(html).toContain(
      '<h1 style="font-size: 32px; font-family: &quot;Inter&quot;, sans-serif">Título &amp; mais</h1>',
    );
    expect(html).toContain('<img src="a.png" alt="x" style="width: 10px">');
    expect(html).toContain('<br>');
    expect(html).not.toContain('</br>');
    expect(html).toContain('\n  <h1');
  });

  it('modo classes', () => {
    const { html, css } = nodesToHtml(nodes, { mode: 'classes' });
    const cls = `hero-section-${nodes[0].id.slice(-4)}`;
    expect(html).toContain(`<div class="${cls}">`);
    expect(css).toContain(`.${cls} {\n  display: flex;\n  gap: 8px;\n}`);
    expect(html).not.toContain('style=');
  });

  it('omite hidden e permite indent:false', () => {
    const copy = structuredClone(nodes);
    copy[0].children[0].hidden = true;
    const { html } = nodesToHtml(copy, { indent: false });
    expect(html).not.toContain('<h1');
    expect(html).not.toContain('\n');
  });

  it('round-trip preserva tags, texto e estilos', () => {
    for (const mode of ['inline', 'classes'] as const) {
      const { html, css } = nodesToHtml(nodes, { mode });
      const back = htmlToNodes(html, { css });
      const shape = (ns: Node[]): unknown =>
        ns.map((n) => ({
          tag: n.tag,
          text: n.text,
          style: n.style,
          attrs: n.attrs,
          children: shape(n.children),
        }));
      expect(shape(back)).toEqual(shape(nodes));
    }
  });

  it('svg inline recebe estilo e round-trip não duplica atributos', () => {
    const [svg] = htmlToNodes('<svg viewBox="0 0 1 1" style="width: 24px"></svg>');
    const { html } = nodesToHtml(svg);
    expect(html.match(/style=/g)).toHaveLength(1);
    const [again] = htmlToNodes(html);
    expect(again.style).toEqual({ width: '24px' });
    expect(nodesToHtml(again).html).toBe(html);
  });
});

describe('slugify', () => {
  it('normaliza acentos e símbolos', () => {
    expect(slugify('Seção Herói!')).toBe('secao-heroi');
    expect(slugify('***')).toBe('node');
  });
});
