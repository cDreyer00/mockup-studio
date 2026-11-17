import { describe, expect, it } from 'vitest';
import { createDocument } from '@mockup/core';
import type { Op } from '@mockup/core';
import { shadcnTokens } from '@mockup/core/tailwind';
import { htmlToPasteNodes } from './paste';

const CARD =
  '<div class="bg-card rounded-xl border py-6 shadow-sm"><button class="h-9 px-4 py-2 hover:bg-primary/90">Ok</button></div>';

describe('htmlToPasteNodes', () => {
  it('Tailwind HTML keeps the classes, compiles style and states and requests the preflight', async () => {
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

  it('does not repeat setCssBase if the document is already Tailwind', async () => {
    const doc = createDocument('T');
    doc.cssBase = 'tailwind';
    doc.tokens = { '--color-card': '#ffffff', '--color-primary': '#18181b' };
    const { ops, tailwind } = await htmlToPasteNodes(CARD, doc);
    expect(tailwind).toBe(true);
    expect(ops).toEqual([]);
  }, 20_000);

  it('non-Tailwind HTML follows the previous path (no classes, no ops)', async () => {
    const doc = createDocument('T');
    const html = '<style>.box{padding:8px}</style><div class="box"><span>a</span></div>';
    const { nodes, ops, tailwind } = await htmlToPasteNodes(html, doc);
    expect(tailwind).toBe(false);
    expect(ops).toEqual([]);
    expect(nodes[0]!.classes).toBeUndefined();
    expect(nodes[0]!.style.padding).toBe('8px');
  });

  it('HTML without a class attribute does not even load the engine', async () => {
    const doc = createDocument('T');
    const r = await htmlToPasteNodes('<div style="padding:4px"><p>x</p></div>', doc);
    expect(r.tailwind).toBe(false);
    expect(r.nodes).toHaveLength(1);
  });

  it('doc without shadcn tokens: creates the tokens in the same paste and uses the preset border color', async () => {
    const doc = createDocument('T');
    const { nodes, ops, notes } = await htmlToPasteNodes(CARD, doc);
    expect(ops.map((o) => o.type)).toEqual([
      'setCssBase',
      'setTokens',
      'setTokenMeta',
      'setThemes',
    ]);
    const set = (ops[1] as Extract<Op, { type: 'setTokens' }>).set;
    expect(set).toBeDefined();
    expect(set!['--color-primary']).toBeTruthy();
    expect(set!['--color-border']).toBeTruthy();
    expect(notes).toHaveLength(1);
    const card = nodes[0]!;
    expect(card.style['background-color']).toBe('var(--color-card)');
    expect(card.style['border-color']).toBe('var(--color-border)');
  }, 20_000);

  it('doc with the shadcn tokens: does not recreate tokens and applies defaultBorderColor', async () => {
    const doc = createDocument('T');
    doc.cssBase = 'tailwind';
    doc.tokens = shadcnTokens();
    const { nodes, ops, notes } = await htmlToPasteNodes(CARD, doc);
    expect(ops).toEqual([]);
    expect(notes).toEqual([]);
    expect(nodes[0]!.style['border-color']).toBe('var(--color-border)');
  }, 20_000);

  it('HTML without shadcn colors does not create tokens', async () => {
    const doc = createDocument('T');
    const { ops, notes } = await htmlToPasteNodes('<div class="p-4 bg-blue-500">x</div>', doc);
    expect(ops).toEqual([{ type: 'setCssBase', base: 'tailwind' }]);
    expect(notes).toEqual([]);
  }, 20_000);
});
