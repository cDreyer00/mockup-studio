import { describe, expect, it } from 'vitest';
import { fitLineBox, groupLines, pickFrame } from './measure';
import { makeDoc } from '../test/fixtures';

const ch = (c: string, x: number, y: number, w = 6, h = 16) => ({
  ch: c,
  x,
  y,
  width: w,
  height: h,
});

describe('groupLines', () => {
  it('agrupa caracteres por linha e apara espaços das pontas', () => {
    const lines = groupLines([
      ch('O', 0, 0),
      ch('i', 6, 0),
      ch(' ', 12, 0),
      ch('t', 0, 20),
      ch('u', 6, 20),
    ]);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({ text: 'Oi', x: 0, y: 0, width: 18, height: 16 });
    expect(lines[1]).toMatchObject({ text: 'tu', y: 20, width: 12 });
  });

  it('ignora caracteres sem caixa e tolera pequenas variações de topo', () => {
    const lines = groupLines([
      ch('a', 0, 0),
      { ch: ' ', x: 6, y: 0, width: 0, height: 0 },
      ch('b', 6, 1),
    ]);
    expect(lines).toHaveLength(1);
    expect(lines[0]!.text).toBe('ab');
  });

  it('nova linha quando o x volta para trás na mesma altura aproximada', () => {
    const lines = groupLines([ch('a', 50, 0), ch('b', 0, 0)]);
    expect(lines.map((l) => l.text)).toEqual(['a', 'b']);
  });
});

describe('fitLineBox', () => {
  it('centraliza a baseline no line box', () => {
    const r = fitLineBox(
      { x: 0, y: 10, width: 10, height: 20, text: 'x' },
      { ascent: 16, descent: 4 },
      30,
    );
    expect(r).toEqual({ y: 5, height: 30, baseline: 21 });
  });
  it('line-height normal usa a área de conteúdo', () => {
    const r = fitLineBox(
      { x: 0, y: 10, width: 10, height: 20, text: 'x' },
      { ascent: 16, descent: 4 },
      null,
    );
    expect(r).toEqual({ y: 10, height: 20, baseline: 16 });
  });
});

describe('pickFrame', () => {
  it('acha o frame raiz do nó e o fundo da página', () => {
    const { doc, frame, a } = makeDoc();
    doc.pages[0]!.background = '#123456';
    expect(pickFrame(doc, a.id)).toMatchObject({ frame: { id: frame.id }, background: '#123456' });
    expect(pickFrame(doc, frame.id)?.frame.id).toBe(frame.id);
    expect(pickFrame(doc, 'nao_existe')).toBeNull();
  });
});
