import { describe, expect, it } from 'vitest';
import { inScript, threeSrcdoc } from './threeIsland';

const LS = String.fromCharCode(0x2028);
const PS = String.fromCharCode(0x2029);
const count = (text: string, part: string): number => text.split(part).length - 1;

describe('inScript', () => {
  const code = `a = '</script><script>alert(1)</script>'; // <!-- x ${LS} y ${PS} z`;

  it('leaves no < or U+2028/U+2029 in the text and round-trips', () => {
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
  it('code with </script> and <!-- does not close the script or open a comment', () => {
    const code = `const s = '</script>'; // <!-- end ${LS}`;
    const html = threeSrcdoc(code, 'http://localhost:5173');
    // only the real closings: the <script src> one and the island script one
    expect(count(html, '</script>')).toBe(2);
    expect(html).not.toContain('<!--');
    expect(html).not.toContain(LS);
  });
});
