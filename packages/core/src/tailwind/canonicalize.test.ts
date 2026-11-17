import { __unstable__loadDesignSystem } from 'tailwindcss';
import { beforeAll, describe, expect, it } from 'vitest';
import { createDocument } from '../document.js';
import {
  CANON_HEAVY_PROP,
  canonGroupOf,
  createTailwindEngine,
  tailwindInputCss,
  type TailwindEngine,
} from './engine.js';

type DesignSystem = Awaited<ReturnType<typeof __unstable__loadDesignSystem>>;
type AstNode = ReturnType<DesignSystem['candidatesToAst']>[number][number];

const HEAVY = ['mask', 'scroll', 'scrollbar'];

let engine: TailwindEngine;
/** Design system sem filtro: a referência do resultado da canonicalização. */
let full: DesignSystem;

beforeAll(async () => {
  const doc = createDocument('Canonicalização');
  doc.tokens['--color-primary'] = '#6c5ce7';
  doc.tokens['--radius-card'] = '14px';
  const css = tailwindInputCss(doc);
  [engine, full] = await Promise.all([
    createTailwindEngine(doc),
    __unstable__loadDesignSystem(css, { base: '/' }),
  ]);
}, 30000);

/** Propriedades, variáveis e `@property` declarados no AST. */
function declared(nodes: AstNode[], out = new Set<string>()): Set<string> {
  for (const n of nodes) {
    if (n.kind === 'declaration') out.add(n.property);
    else if (n.kind === 'at-rule' && n.name === '@property') out.add(n.params.trim());
    else if ('nodes' in n && Array.isArray(n.nodes)) declared(n.nodes as AstNode[], out);
  }
  return out;
}

describe('canonicalização leve (sem mask-*, scroll-*, scrollbar-*)', { timeout: 30000 }, () => {
  it('as classes deixadas de fora só declaram propriedades de CANON_HEAVY_PROP', () => {
    // Garante a premissa da otimização (revalidar ao atualizar o Tailwind).
    const heavy = full
      .getClassList()
      .map(([name]) => name)
      .filter((name) => HEAVY.includes(canonGroupOf(name)));
    expect(heavy.length).toBeGreaterThan(1000);
    const roots = Array.from(full.utilities.keys('functional')).filter((r) =>
      HEAVY.includes(canonGroupOf(r)),
    );
    const arbitrary = roots.flatMap((r) => [`${r}-[3px]`, `${r}-[red]`, `${r}-[url(x.png)]`]);
    const bad = new Set<string>();
    for (const ast of full.candidatesToAst([...heavy, ...arbitrary])) {
      for (const p of declared(ast ?? [])) if (!CANON_HEAVY_PROP.test(p)) bad.add(p);
    }
    expect([...bad]).toEqual([]);
  });

  it('dá o mesmo resultado que o design system completo', () => {
    const inputs = [
      ['p-[16px]'],
      ['mt-[8px]', 'mb-[8px]'],
      ['w-[1440px]', 'flex', 'flex-col', 'min-h-[900px]'],
      ['text-[56px]', 'font-extrabold', 'leading-[1.1]', 'max-w-[800px]'],
      ['text-base', 'leading-normal', 'text-gray-500'],
      ['bg-[#fff]', 'rounded-[8px]', 'border', 'border-solid'],
      ['bg-[#6c5ce7]', 'rounded-[14px]'],
      ['bg-[var(--color-primary)]', 'text-[color:white]'],
      ['[padding:16px]', '[margin-top:4px]', '[margin-bottom:4px]'],
      ['top-[0px]', 'right-[0px]', 'bottom-[0px]', 'left-[0px]'],
      ['shadow-[0_1px_2px_0_rgb(0_0_0/0.05)]', 'opacity-[0.5]'],
      ['px-[12px]', 'py-[12px]', 'gap-[24px]'],
    ];
    for (const classes of inputs) {
      expect(engine.canonicalize(classes), classes.join(' ')).toEqual(
        full.canonicalizeCandidates(classes, { rem: 16, collapse: true }),
      );
    }
  });

  it('entradas com propriedades de máscara ou scroll usam a lista completa', () => {
    const inputs = [
      ['[mask-image:none]', 'p-[16px]'],
      ['[scroll-margin-top:16px]'],
      ['[scrollbar-width:thin]', 'mask-[url(x.png)]'],
    ];
    for (const classes of inputs) {
      expect(engine.canonicalize(classes), classes.join(' ')).toEqual(
        full.canonicalizeCandidates(classes, { rem: 16, collapse: true }),
      );
    }
    expect(engine.canonicalize(['[scroll-margin-top:16px]'])).toEqual(['scroll-mt-4']);
  });

  it('o cache devolve cópias (o chamador pode mexer no array)', () => {
    const a = engine.canonicalize(['p-[16px]']);
    a.push('x');
    expect(engine.canonicalize(['p-[16px]'])).toEqual(['p-4']);
  });
});

describe('API __unstable__ do tailwindcss (o motor depende de sua forma)', () => {
  const hint = 'A API interna do tailwindcss mudou: revise createTailwindEngine em engine.ts. ';

  it('ds.utilities.keys é função e devolve iterável com "functional"', () => {
    expect(typeof full.utilities.keys, hint + 'utilities.keys deixou de ser função').toBe(
      'function',
    );
    const keys = [...full.utilities.keys('functional')];
    expect(keys.length, hint + 'utilities.keys("functional") vazio').toBeGreaterThan(0);
    expect(keys, hint).toContain('p');
  });

  it('ds.getClassList devolve array de [nome, ...]', () => {
    const list = full.getClassList();
    expect(Array.isArray(list), hint + 'getClassList não devolve array').toBe(true);
    expect(Array.isArray(list[0]), hint + 'itens de getClassList não são arrays').toBe(true);
    expect(typeof list[0][0], hint + 'primeiro item não é o nome').toBe('string');
  });

  it('canonicalizeCandidates existe', () => {
    expect(typeof full.canonicalizeCandidates, hint + 'canonicalizeCandidates sumiu').toBe(
      'function',
    );
  });

  it.each([[['p-[16px]', 'm-4']], [['px-[8px]', 'py-[8px]']]])(
    'canonicalização leve = completa para %j',
    (input) => {
      const ref = full.canonicalizeCandidates(input, { rem: 16, collapse: true });
      expect(engine.canonicalize(input), hint + 'leve e completa divergem').toEqual(ref);
    },
  );
});
