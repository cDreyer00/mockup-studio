import { describe, expect, it } from 'vitest';
import { createDocument } from '@mockup/core';
import { htmlToPasteNodes } from './paste';

const CARD =
  '<div class="bg-card rounded-xl border py-6 shadow-sm"><button class="h-9 px-4 py-2 hover:bg-primary/90">Ok</button></div>';

describe('htmlToPasteNodes', () => {
  it('HTML Tailwind mantém as classes, compila estilo e estados e pede o preflight', async () => {
    const doc = createDocument('T');
    doc.tokens = { '--color-card': '#ffffff', '--color-primary': '#18181b' };
    const { nodes, ops, tailwind } = await htmlToPasteNodes(CARD, doc);
    expect(tailwind).toBe(true);
    expect(ops).toEqual([{ type: 'setCssBase', base: 'tailwind' }]);
    const card = nodes[0]!;
    expect(card.classes).toBe('bg-card rounded-xl border py-6 shadow-sm');
    expect(card.style['border-radius']).toBeTruthy();
    expect(card.style['border-top-width'] ?? card.style['border-width']).toBe('1px');
    const button = card.children[0]!;
    expect(button.style.height).toMatch(/spacing|2\.25rem/);
    expect(button.states?.hover).toBeTruthy();
  }, 20_000);

  it('não repete setCssBase se o documento já é Tailwind', async () => {
    const doc = createDocument('T');
    doc.cssBase = 'tailwind';
    const { ops, tailwind } = await htmlToPasteNodes(CARD, doc);
    expect(tailwind).toBe(true);
    expect(ops).toEqual([]);
  }, 20_000);

  it('HTML sem Tailwind segue o caminho de antes (sem classes, sem ops)', async () => {
    const doc = createDocument('T');
    const html = '<style>.box{padding:8px}</style><div class="box"><span>a</span></div>';
    const { nodes, ops, tailwind } = await htmlToPasteNodes(html, doc);
    expect(tailwind).toBe(false);
    expect(ops).toEqual([]);
    expect(nodes[0]!.classes).toBeUndefined();
    expect(nodes[0]!.style.padding).toBe('8px');
  });

  it('HTML sem atributo class nem carrega o motor', async () => {
    const doc = createDocument('T');
    const r = await htmlToPasteNodes('<div style="padding:4px"><p>x</p></div>', doc);
    expect(r.tailwind).toBe(false);
    expect(r.nodes).toHaveLength(1);
  });
});
