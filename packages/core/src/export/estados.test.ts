import fs from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { createDocument, createNodeFromTag } from '../document.js';
import { parseDocument } from '../schema.js';
import { getTailwindEngine } from '../tailwind/cache.js';
import { createTailwindEngine, type TailwindEngine } from '../tailwind/engine.js';
import type { Document, Node } from '../types.js';
import { exportHtml } from './html.js';
import { exportReact } from './react.js';
import { exportSvg } from './svg.js';
import { exportTailwind, neutralLeadingSizes, tailwindThemeCss } from './tailwind.js';

const landing = parseDocument(
  fs.readFileSync(new URL('../../../../examples/landing.mockup.json', import.meta.url), 'utf8'),
);

function docWith(root: Node, tokens: Record<string, string> = {}): Document {
  const doc = createDocument('Estados', { id: 'doc_estado01' });
  root.id = 'fr_estado001';
  doc.pages[0].frames.push(root);
  Object.assign(doc.tokens, tokens);
  return doc;
}

function button(): Node {
  const btn = createNodeFromTag('button', {
    name: 'Botão',
    text: 'Enviar',
    styles: { 'background-color': '#6c5ce7', padding: '8px 16px', color: '#fff' },
  });
  btn.id = 'el_estado001';
  btn.states = {
    hover: { 'background-color': '#5b4bd6' },
    md: { padding: '12px 24px' },
    dark: { 'background-color': '#222' },
    'md:hover': { 'background-color': '#4a3cc0' },
    disabled: { opacity: '0.5' },
  };
  return btn;
}

function withButton(tokens: Record<string, string> = {}): Document {
  const frame = createNodeFromTag('div', {
    name: 'Tela',
    isRoot: true,
    styles: { width: '800px' },
  });
  frame.children = [button()];
  return docWith(frame, tokens);
}

function textNode(name: string, styles: Record<string, string>): Node {
  const n = createNodeFromTag('p', { name, text: name, styles });
  n.id = `tx_${name.toLowerCase().replace(/\W/g, '').slice(0, 8).padEnd(8, '0')}`;
  return n;
}

function docWithTexts(...texts: Node[]): Document {
  const frame = createNodeFromTag('div', { name: 'Tela', isRoot: true });
  frame.children = texts;
  return docWith(frame);
}

describe('exportTailwind: neutralização do line-height', () => {
  it('neutraliza o tamanho usado por nó sem line-height', () => {
    const doc = docWithTexts(textNode('Sem lh', { 'font-size': '14px' }));
    expect(neutralLeadingSizes(doc)).toEqual(new Set(['sm']));
    expect(tailwindThemeCss(doc)).toContain('--text-sm--line-height: inherit;');
  });

  it('neutraliza quando o line-height difere do padrão do tamanho', () => {
    const doc = docWithTexts(textNode('Lh 1.7', { 'font-size': '0.875rem', 'line-height': '1.7' }));
    expect(tailwindThemeCss(doc)).toContain('--text-sm--line-height: inherit;');
  });

  it('dispensa quando todos os nós têm o line-height padrão (unitless ou em px)', () => {
    const doc = docWithTexts(
      textNode('Importado', { 'font-size': '0.875rem', 'line-height': '1.4286' }),
      textNode('Em px', { 'font-size': '14px', 'line-height': '20px' }),
      textNode('Grande', { 'font-size': '1.125rem', 'line-height': '1.5556' }),
    );
    expect(neutralLeadingSizes(doc).size).toBe(0);
    expect(tailwindThemeCss(doc)).not.toContain('line-height: inherit');
  });

  it('um nó fora do padrão neutraliza só o seu tamanho', () => {
    const doc = docWithTexts(
      textNode('Padrão', { 'font-size': '0.875rem', 'line-height': '1.4286' }),
      textNode('Outro', { 'font-size': '1.125rem', 'line-height': '1.2' }),
    );
    expect(neutralLeadingSizes(doc)).toEqual(new Set(['lg']));
    const css = tailwindThemeCss(doc);
    expect(css).toContain('--text-lg--line-height: inherit;');
    expect(css).not.toContain('--text-sm--line-height');
  });

  it('tamanhos sem nome e estados com font-size entram na conta', () => {
    const odd = textNode('Odd', { 'font-size': '13px' });
    const withState = textNode('Estado', { 'font-size': '1rem', 'line-height': '1.5' });
    withState.states = { md: { 'font-size': '1.25rem' } };
    const doc = docWithTexts(odd, withState);
    // md: 1.25rem herda o line-height base 1.5, que não é o padrão de xl (1.4)
    expect(neutralLeadingSizes(doc)).toEqual(new Set(['xl']));
  });
});

describe('exportTailwind: estados sem o motor', () => {
  it('exporta node.states como classes com prefixo de variante', () => {
    const html = exportTailwind(withButton(), { fragment: true });
    expect(html).toContain('hover:bg-[#5b4bd6]');
    expect(html).toContain('md:py-3');
    expect(html).toContain('md:px-6');
    expect(html).toContain('dark:bg-[#222]');
    expect(html).toContain('md:hover:bg-[#4a3cc0]');
    expect(html).toContain('disabled:opacity-50');
    expect(html).not.toContain('style=');
  });

  it('o tema traz o @custom-variant dark só quando algum nó usa dark', () => {
    const doc = withButton();
    const css = tailwindThemeCss(doc);
    expect(css).toContain(
      '@custom-variant dark (&:where([data-theme=dark], [data-theme=dark] *));',
    );
    expect(css.indexOf('@import')).toBeLessThan(css.indexOf('@custom-variant'));
    delete doc.pages[0].frames[0].children[0].states!.dark;
    expect(tailwindThemeCss(doc)).not.toContain('@custom-variant');
    expect(tailwindThemeCss(landing)).not.toContain('@custom-variant');
  });

  it('o documento completo inclui o @custom-variant no <style type="text/tailwindcss">', () => {
    const html = exportTailwind(withButton());
    expect(html).toContain('@custom-variant dark');
    expect(html).not.toContain('@import "tailwindcss"');
  });
});

describe('exportHtml: breakpoints customizados', () => {
  it('usa --breakpoint-* do documento na @media', () => {
    const custom = exportHtml(withButton({ '--breakpoint-md': '900px' }));
    expect(custom).toContain('@media (min-width: 900px)');
    expect(custom).not.toContain('@media (min-width: 768px)');
    expect(exportHtml(withButton({ '--breakpoint-md': '900px' }), { mode: 'inline' })).toContain(
      '@media (min-width: 900px)',
    );
    expect(exportHtml(withButton())).toContain('@media (min-width: 768px)');
  });
});

describe('cssBase', () => {
  it('Tailwind: só o body da camada base muda', () => {
    const doc = withButton();
    const normal = tailwindThemeCss(doc);
    expect(normal).toContain('body { font-family:system-ui');
    doc.cssBase = 'tailwind';
    const tw = tailwindThemeCss(doc);
    expect(tw).toContain('body { font-family:-apple-system');
    expect(tw).toContain('line-height:1.5');
    expect(tw).not.toContain('border:0 solid');
  });

  it('HTML: com cssBase tailwind inclui o preflight', () => {
    const doc = withButton();
    expect(exportHtml(doc)).not.toContain('border:0 solid');
    doc.cssBase = 'tailwind';
    const html = exportHtml(doc);
    expect(html).toContain('box-sizing:border-box;margin:0;padding:0;border:0 solid');
    expect(html).toContain('h1,h2,h3,h4,h5,h6{font-size:inherit;font-weight:inherit}');
  });

  it('React inline e SVG seguem o cssBase', () => {
    const doc = withButton();
    doc.cssBase = 'tailwind';
    const r = exportReact(doc, { nodeId: 'fr_estado001', styles: 'inline' });
    expect(r.css).toContain('border:0 solid');
    const svg = exportSvg(doc, { nodeId: 'fr_estado001' });
    expect(svg).toContain('border:0 solid');
  });
});

describe('exportHtml: estados', () => {
  it('modo classes: regras por pseudo-classe, breakpoint, dark e combinações', () => {
    const html = exportHtml(withButton(), { fragment: true });
    expect(html).toContain('.botao:hover {\n    background-color: #5b4bd6;\n  }');
    expect(html).toContain('.botao:disabled {\n    opacity: 0.5;\n  }');
    expect(html).toContain(
      '.botao:where([data-theme="dark"], [data-theme="dark"] *) {\n    background-color: #222;\n  }',
    );
    expect(html).toContain(
      '@media (min-width: 768px) {\n    .botao {\n      padding: 12px 24px;\n    }\n  }',
    );
    expect(html).toContain(
      '@media (min-width: 768px) {\n    .botao:hover {\n      background-color: #4a3cc0;\n    }\n  }',
    );
    // o estado vem depois da regra base do mesmo nó
    expect(html.indexOf('.botao {')).toBeLessThan(html.indexOf('.botao:hover'));
    expect(html).toMatchSnapshot();
  });

  it('modo inline: base no style e estados em <style> com !important', () => {
    const html = exportHtml(withButton(), { fragment: true, mode: 'inline' });
    expect(html).toContain('<button class="botao" style="background-color: #6c5ce7;');
    expect(html).toContain('.botao:hover {\n    background-color: #5b4bd6 !important;\n  }');
    expect(html).toContain(
      '@media (min-width: 768px) {\n    .botao {\n      padding: 12px 24px !important;',
    );
  });

  it('nó só com estados (sem style) também ganha classe', () => {
    const frame = createNodeFromTag('div', { name: 'Tela', isRoot: true });
    const n = createNodeFromTag('a', { name: 'Link', text: 'ir' });
    n.id = 'el_estado002';
    n.states = { hover: { 'text-decoration': 'underline' } };
    frame.children = [n];
    const html = exportHtml(docWith(frame), { fragment: true });
    expect(html).toContain('<a class="link">ir</a>');
    expect(html).toContain('.link:hover {');
  });

  it('estados com valores inseguros ou chaves inválidas não saem', () => {
    const doc = withButton();
    const node = doc.pages[0].frames[0].children[0];
    node.states!['group-hover'] = { color: 'red' };
    node.states!.focus = { color: 'red; x: y' };
    const html = exportHtml(doc, { fragment: true });
    expect(html).not.toContain('group-hover');
    expect(html).not.toContain('x: y');
    expect(html).not.toContain(':focus');
  });

  it('sem estados a saída não muda (sem regras extras)', () => {
    const html = exportHtml(landing);
    expect(html).not.toContain(':hover');
    expect(html).not.toContain('@media');
  });
});

describe('exportReact e exportSvg: estados', () => {
  it('React tailwind sem motor leva as variantes no className', () => {
    const { code } = exportReact(withButton(), { nodeId: 'fr_estado001' });
    expect(code).toContain('hover:bg-[#5b4bd6]');
    expect(code).toContain('md:hover:bg-[#4a3cc0]');
  });

  it('React inline não exporta estados (style={{}} não tem variantes)', () => {
    const { code } = exportReact(withButton(), { nodeId: 'fr_estado001', styles: 'inline' });
    expect(code).not.toContain('hover');
    expect(code).not.toContain('5b4bd6');
  });

  it('nós com estados diferentes não são extraídos como repetição', () => {
    const frame = createNodeFromTag('ul', { name: 'Lista', isRoot: true });
    const mk = (i: number, hover: string): Node => {
      const li = createNodeFromTag('li', {
        name: 'Item',
        text: `Item ${i}`,
        styles: { color: 'red' },
      });
      li.id = `el_item000${i}`;
      li.states = { hover: { color: hover } };
      return li;
    };
    frame.children = [mk(1, 'blue'), mk(2, 'green'), mk(3, 'green')];
    const { code } = exportReact(docWith(frame), { nodeId: 'fr_estado001' });
    expect(code).toContain('hover:text-[color:blue]');
    expect(code).toContain('hover:text-[color:green]');
  });

  it('SVG ignora os estados', () => {
    const svg = exportSvg(withButton(), { nodeId: 'fr_estado001' });
    expect(svg).not.toContain('5b4bd6');
    expect(svg).not.toContain(':hover');
  });
});

describe('exportTailwind com o motor', () => {
  let engine: TailwindEngine;
  beforeAll(async () => {
    engine = await createTailwindEngine(landing);
    // aquecimento da canonicalização (~1 s) fora do tempo dos testes; os documentos sem tokens
    // abaixo compartilham o motor do cache
    engine.warmup();
    (await getTailwindEngine(withButton())).warmup();
  }, 30000);

  it('exemplo landing: snapshot com o motor', () => {
    const html = exportTailwind(landing, { tailwind: engine });
    expect(html).toMatchSnapshot();
  });

  it('com o motor as classes são canonicalizadas e as variantes saem do estado', async () => {
    const doc = withButton();
    const e = await getTailwindEngine(doc);
    const html = exportTailwind(doc, { tailwind: e, fragment: true });
    expect(html).toContain('hover:bg-[#5b4bd6]');
    expect(html).toContain('md:hover:bg-[#4a3cc0]');
    expect(html).toContain('dark:bg-[#222]');
    expect(html).toContain('py-2');
    expect(html).toContain('px-4');
    expect(html).toContain('text-white');
  });

  it('neutraliza o line-height no tema e mantém o leading do nó no markup', async () => {
    const doc = docWithTexts(
      textNode('Padrao', { 'font-size': '0.875rem', 'line-height': '1.4286' }),
      textNode('Outro', { 'font-size': '0.875rem', 'line-height': '1.7' }),
      textNode('Sem lh', { 'font-size': '0.875rem' }),
    );
    const e = await getTailwindEngine(doc);
    const html = exportTailwind(doc, { tailwind: e });
    expect(html).toContain('--text-sm--line-height: inherit;');
    const body = html.slice(html.indexOf('<body>'));
    const lines = body.split('\n');
    const padrao = lines.find((l) => l.includes('>Padrao<'))!;
    // o nó com o padrão do Tailwind precisa do leading explícito, já que o tema neutraliza text-sm
    expect(padrao).toMatch(/text-sm/);
    expect(padrao).toMatch(/leading-/);
    const semLh = lines.find((l) => l.includes('>Sem lh<'))!;
    expect(semLh).toMatch(/text-sm/);
    expect(semLh).not.toMatch(/leading-/);
  });

  it('React com o motor usa as classes do motor', async () => {
    const doc = withButton();
    const e = await getTailwindEngine(doc);
    const { code, css } = exportReact(doc, { nodeId: 'fr_estado001', tailwind: e });
    expect(code).toContain('hover:bg-[#5b4bd6]');
    expect(css).toContain('@custom-variant dark');
  });
});
