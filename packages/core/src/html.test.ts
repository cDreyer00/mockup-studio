import { describe, expect, it } from 'vitest';
import { htmlToNodes, nodesToHtml, slugify } from './html.js';
import type { Node } from './types.js';

describe('htmlToNodes', () => {
  it('applies <style>, inline wins and ignores class/id/style in attrs', () => {
    const [n] = htmlToNodes(
      `<style>.box { color: red; padding: 8px } div { color: blue }</style>
       <div id="x" class="box hero" style="padding: 16px" data-name="Box" title="t">Hi</div>`,
    );
    expect(n.tag).toBe('div');
    expect(n.type).toBe('text');
    expect(n.text).toBe('Hi');
    expect(n.name).toBe('Box');
    expect(n.style).toEqual({ color: 'blue', padding: '16px' });
    expect(n.attrs).toEqual({ title: 't' });
  });

  it('uses the css parameter and compound, descendant and direct-child selectors', () => {
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

  it('mixed text becomes a span; inline spaces preserved, line breaks are formatting', () => {
    // Rule: whitespace without a line break becomes 1 space (content); with a line break it is dropped at the ends.
    const [p] = htmlToNodes('<p>  Hello   <b>world</b>\n  end </p>');
    expect(p.type).toBe('element');
    expect(p.children.map((c) => [c.tag, c.type, c.text])).toEqual([
      ['span', 'text', ' Hello '],
      ['b', 'text', 'world'],
      ['span', 'text', 'end '],
    ]);
  });

  it('img, svg, script, comments and html/body', () => {
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

  it('drops blocked tags (math, template, frameset...) without throwing', () => {
    const nodes = htmlToNodes(
      `<math><mi>x</mi></math><template><p>t</p></template><frameset></frameset>
       <portal></portal><div>ok</div><svg viewBox="0 0 1 1"></svg>`,
    );
    expect(nodes.map((n) => [n.type, n.tag])).toEqual([
      ['text', 'div'],
      ['svg', 'svg'],
    ]);
  });

  it('decodes entities', () => {
    const [n] = htmlToNodes('<p>a &amp; b &lt;c&gt;</p>');
    expect(n.text).toBe('a & b <c>');
  });
});

describe('nodesToHtml', () => {
  const nodes: Node[] = htmlToNodes(
    `<div style="display: flex; gap: 8px" data-name="Hero Section">
       <h1 style="font-size: 32px; font-family: &quot;Inter&quot;, sans-serif">Title &amp; more</h1>
       <img src="a.png" alt="x" style="width: 10px">
       <button type="button">Ok</button>
       <br>
     </div>`,
  );

  it('inline mode (default)', () => {
    const { html, css } = nodesToHtml(nodes);
    expect(css).toBe('');
    expect(html).toContain('<div style="display: flex; gap: 8px">');
    expect(html).toContain(
      '<h1 style="font-size: 32px; font-family: &quot;Inter&quot;, sans-serif">Title &amp; more</h1>',
    );
    expect(html).toContain('<img src="a.png" alt="x" style="width: 10px">');
    expect(html).toContain('<br>');
    expect(html).not.toContain('</br>');
    expect(html).toContain('\n  <h1');
  });

  it('classes mode', () => {
    const { html, css } = nodesToHtml(nodes, { mode: 'classes' });
    const cls = `hero-section-${nodes[0].id.slice(-4)}`;
    expect(html).toContain(`<div class="${cls}">`);
    expect(css).toContain(`.${cls} {\n  display: flex;\n  gap: 8px;\n}`);
    expect(html).not.toContain('style=');
  });

  it('omits hidden and allows indent:false', () => {
    const copy = structuredClone(nodes);
    copy[0].children[0].hidden = true;
    const { html } = nodesToHtml(copy, { indent: false });
    expect(html).not.toContain('<h1');
    expect(html).not.toContain('\n');
  });

  it('round-trip preserves tags, text and styles', () => {
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

  it('inline svg gets styles and round-trip does not duplicate attributes', () => {
    const [svg] = htmlToNodes('<svg viewBox="0 0 1 1" style="width: 24px"></svg>');
    const { html } = nodesToHtml(svg);
    expect(html.match(/style=/g)).toHaveLength(1);
    const [again] = htmlToNodes(html);
    expect(again.style).toEqual({ width: '24px' });
    expect(nodesToHtml(again).html).toBe(html);
  });
});

describe('slugify', () => {
  it('normalizes accents and symbols', () => {
    expect(slugify('Café Crème!')).toBe('cafe-creme');
    expect(slugify('***')).toBe('node');
  });
});
