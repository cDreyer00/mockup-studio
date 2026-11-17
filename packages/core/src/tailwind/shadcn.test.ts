import { beforeAll, describe, expect, it } from 'vitest';
import { applyOps } from '../apply.js';
import { createDocument, walk } from '../document.js';
import { exportHtml } from '../export/html.js';
import { exportTailwind } from '../export/tailwind.js';
import { htmlToNodes } from '../html.js';
import type { Node } from '../types.js';
import { applyTailwindToNodes } from './apply.js';
import { createTailwindEngine, type TailwindEngine } from './engine.js';
import { planShadcnTokens, shadcnDarkOverrides, shadcnTokens, usesShadcnColor } from './shadcn.js';

/** Botão do shadcn/ui v4 (variant default, size default). */
const BUTTON_CLASSES =
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium transition-all disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg:not([class*='size-'])]:size-4 shrink-0 [&_svg]:shrink-0 outline-none focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px] aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 aria-invalid:border-destructive bg-primary text-primary-foreground shadow-xs hover:bg-primary/90 h-9 px-4 py-2 has-[>svg]:px-3";

const CARD_HTML = `<div data-slot="card" class="bg-card text-card-foreground flex flex-col gap-6 rounded-xl border py-6 shadow-sm">
  <div data-slot="card-header" class="@container/card-header grid auto-rows-min grid-rows-[auto_auto] items-start gap-1.5 px-6 has-data-[slot=card-action]:grid-cols-[1fr_auto] [.border-b]:pb-6">
    <div data-slot="card-title" class="leading-none font-semibold">Entrar</div>
    <div data-slot="card-description" class="text-muted-foreground text-sm">Use seu e-mail</div>
  </div>
  <div data-slot="card-content" class="px-6"><button data-slot="button" class="${BUTTON_CLASSES}">Continuar</button></div>
  <div data-slot="card-footer" class="flex items-center px-6 [.border-t]:pt-6">Esqueceu a senha?</div>
</div>`;

let engine: TailwindEngine;
let doc: ReturnType<typeof createDocument>;
let root: Node;

function find(name: string): Node {
  let out: Node | undefined;
  walk(root, (n) => {
    if (n.name === name) out = n;
  });
  if (!out) throw new Error(`nó ${name} não encontrado`);
  return out;
}

beforeAll(async () => {
  doc = createDocument('shadcn');
  Object.assign(doc.tokens, shadcnTokens());
  engine = await createTailwindEngine(doc);
  // aquecimento da canonicalização (~1 s) fora do tempo dos testes
  engine.warmup();
  const nodes = htmlToNodes(CARD_HTML, { keepClasses: true });
  const report = applyTailwindToNodes(nodes, engine, { defaultBorderColor: 'var(--color-border)' });
  expect(report.unknown).toEqual([]);
  root = nodes[0];
  root.type = 'frame';
  root.style.width = '380px';
  doc.pages[0].frames.push(root);
}, 30000);

describe('shadcn/ui v4: import com o motor', () => {
  it('nomeia pelos data-slot e guarda as classes como dica', () => {
    expect(root.name).toBe('Card');
    expect(root.classes).toContain('bg-card');
    expect(find('Button').classes).toBe(BUTTON_CLASSES);
  });

  it('card: tokens do documento viram var(--...) e o raio vem do token', () => {
    expect(root.style['background-color']).toBe('var(--color-card)');
    expect(root.style.color).toBe('var(--color-card-foreground)');
    expect(root.style['border-radius']).toBe('var(--radius-xl)');
    expect(root.style['border-width']).toBe('1px');
    expect(root.style['border-color']).toBe('var(--color-border)');
    expect(root.style['padding-block']).toBe('1.5rem');
    expect(root.style.gap).toBe('1.5rem');
    expect(root.style['flex-direction']).toBe('column');
  });

  it('botão: estilo base resolvido', () => {
    const b = find('Button');
    expect(b.style['background-color']).toBe('var(--color-primary)');
    expect(b.style.color).toBe('var(--color-primary-foreground)');
    expect(b.style['border-radius']).toBe('var(--radius-md)');
    expect(b.style['font-size']).toBe('0.875rem');
    expect(b.style.height).toBe('2.25rem');
    expect(b.style['padding-inline']).toBe('1rem');
    expect(b.style['padding-block']).toBe('0.5rem');
  });

  it('botão: variantes viram estados', () => {
    const b = find('Button');
    expect(Object.keys(b.states ?? {}).sort()).toEqual(['disabled', 'focus-visible', 'hover']);
    expect(b.states!.hover['background-color']).toBe(
      'color-mix(in oklab, var(--color-primary) 90%, transparent)',
    );
    expect(b.states!.disabled.opacity).toBe('50%');
    expect(b.states!['focus-visible']['border-color']).toBe('var(--color-ring)');
  });

  it('variantes que o modelo não representa ficam só em node.classes', () => {
    const b = find('Button');
    expect(b.classes).toContain('has-[>svg]:px-3');
    expect(b.classes).toContain('aria-invalid:border-destructive');
    expect(b.classes).toContain("[&_svg:not([class*='size-'])]:size-4");
  });
});

describe('shadcn/ui v4: exportação com o motor', () => {
  it('Tailwind: reaproveita as classes do autor', () => {
    const html = exportTailwind(doc, { tailwind: engine, fragment: true });
    // a ordem e as variantes que o modelo não representa saem como o autor escreveu
    expect(html).toContain(
      'bg-card text-card-foreground flex flex-col gap-6 rounded-xl border py-6 shadow-sm',
    );
    expect(html).toContain('leading-none font-semibold');
    expect(html).toContain('text-muted-foreground text-sm');
    expect(html).toContain('hover:bg-primary/90');
    expect(html).toContain('disabled:opacity-50');
    expect(html).toContain('has-[&gt;svg]:px-3');
    expect(html).toContain('[.border-t]:pt-6');
    expect(html).not.toContain('style=');
    expect(html).toMatchSnapshot();
  });

  it('Tailwind: sem o motor gera classes próprias, sem perder os estados', () => {
    const html = exportTailwind(doc, { fragment: true });
    expect(html).toContain('hover:bg-[color-mix(in_oklab,var(--color-primary)_90%,transparent)]');
    expect(html).toContain('disabled:opacity-50');
    expect(html).toContain('bg-primary');
    expect(html).toContain('rounded-md');
  });

  it('HTML: estados viram regras do <style>', () => {
    const html = exportHtml(doc, { fragment: true });
    expect(html).toContain('.button:hover {');
    expect(html).toContain('.button:disabled {');
    expect(html).toContain('.button:focus-visible {');
  });

  it('documento completo: não neutraliza o line-height quando os nós têm o padrão do Tailwind', () => {
    const html = exportTailwind(doc, { tailwind: engine });
    expect(html).not.toContain('--text-sm--line-height');
  });
});

describe('planShadcnTokens / usesShadcnColor', () => {
  it('cria os tokens e o tema dark que faltam e é idempotente', () => {
    const empty = createDocument('vazio');
    const plan = planShadcnTokens(empty);
    expect(plan.created).toContain('--color-primary');
    expect(plan.created).toContain('--radius-xl');
    const { doc: next } = applyOps(empty, plan.ops);
    expect(next.tokens['--color-primary']).toBe(shadcnTokens()['--color-primary']);
    expect(next.themes?.find((t) => t.name === 'dark')?.overrides['--color-primary']).toBe(
      shadcnDarkOverrides()['--color-primary'],
    );
    expect(next.tokenMeta?.['--radius-md']?.group).toBe('radius');
    const again = planShadcnTokens(next);
    expect(again.created).toEqual([]);
    expect(again.ops).toEqual([]);
  });

  it('não toca em tokens já definidos', () => {
    const d = createDocument('com token');
    d.tokens['--color-primary'] = '#ff0000';
    const plan = planShadcnTokens(d);
    expect(plan.created).not.toContain('--color-primary');
    const { doc: next } = applyOps(d, plan.ops);
    expect(next.tokens['--color-primary']).toBe('#ff0000');
    expect(
      next.themes?.find((t) => t.name === 'dark')?.overrides['--color-primary'],
    ).toBeUndefined();
  });

  it('usesShadcnColor reconhece as classes de cor do preset (com variantes)', () => {
    for (const c of [
      'bg-primary',
      'text-primary-foreground',
      'hover:bg-primary/90',
      'dark:border-input',
      'focus-visible:ring-ring/50',
      'md:hover:bg-accent!',
    ])
      expect(usesShadcnColor(c)).toBe(true);
    for (const c of ['bg-blue-500', 'p-4', 'text-sm', 'bg-primary-ish-nope', 'flex']) {
      expect(usesShadcnColor(c)).toBe(false);
    }
  });
});
