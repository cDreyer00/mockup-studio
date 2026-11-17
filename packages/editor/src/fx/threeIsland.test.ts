import { describe, expect, it } from 'vitest';
import { inScript, threeSrcdoc } from './threeIsland';

const LS = String.fromCharCode(0x2028);
const PS = String.fromCharCode(0x2029);
const count = (text: string, part: string): number => text.split(part).length - 1;

describe('inScript', () => {
  const code = `a = '</script><script>alert(1)</script>'; // <!-- x ${LS} y ${PS} z`;

  it('não deixa < nem U+2028/U+2029 no texto e faz ida e volta', () => {
    const out = inScript(code);
    expect(out).not.toContain('<');
    expect(out).not.toContain(LS);
    expect(out).not.toContain(PS);
    expect(out).toContain('u003c/script>');
    expect(JSON.parse(out)).toBe(code);
    expect(JSON.parse(inScript({ k: [code] }))).toEqual({ k: [code] });
  });
});

describe('threeSrcdoc', () => {
  it('o código com </script> e <!-- não fecha o script nem abre comentário', () => {
    const code = `const s = '</script>'; // <!-- fim ${LS}`;
    const html = threeSrcdoc(code, 'http://localhost:5173');
    // só os fechamentos reais: o do <script src> e o do script da ilha
    expect(count(html, '</script>')).toBe(2);
    expect(html).not.toContain('<!--');
    expect(html).not.toContain(LS);
  });
});
