import { describe, expect, it } from 'vitest';
import { svgToVector } from './svg.js';

const wrap = (inner: string, attrs = ''): string =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"${attrs}>${inner}</svg>`;

describe('svgToVector: sanitization', () => {
  it('removes <script> and keeps the path', () => {
    const v = svgToVector(wrap('<script>alert(1)</script><path d="M0 0L5 5"/>'));
    expect(v.raw).not.toMatch(/script|alert/i);
    expect(v.paths).toHaveLength(1);
  });

  it('removes on* handlers', () => {
    const v = svgToVector(wrap('<path d="M0 0L5 5" onclick="x()"/>', ' onload="evil()"'));
    expect(v.raw).not.toMatch(/onload|onclick|evil|x\(\)/i);
    expect(JSON.stringify(v.attrs ?? {})).not.toMatch(/onload/i);
  });

  // Current sanitizeSvg policy: http(s) href on <a>/<image> is kept (only javascript: and non-image data:
  // are dropped; <use> only accepts "#fragment"). This test documents the behavior.
  it('http(s) href on <a> and <image> is kept (current policy); non-image data: is dropped', () => {
    const v = svgToVector(
      wrap(
        '<a href="http://ok.example/x"><path d="M0 0L5 5"/></a><image href="data:text/html;base64,AAAA" width="5" height="5"/>',
      ),
    );
    expect(v.raw).toContain('ok.example');
    expect(v.raw).not.toContain('data:text/html');
  });

  it('<use href external> disappears from raw and paths is empty', () => {
    const v = svgToVector(wrap('<use href="http://evil.example/s.svg#a"/><path d="M0 0L5 5"/>'));
    expect(v.raw).not.toContain('evil.example');
    expect(v.paths).toEqual([]);
  });

  it('internal <use> also empties paths (not simple)', () => {
    const v = svgToVector(wrap('<defs><path id="a" d="M0 0L5 5"/></defs><use href="#a"/>'));
    expect(v.paths).toEqual([]);
  });

  it('javascript: in href is removed', () => {
    const v = svgToVector(wrap('<a href="javascript:alert(1)"><path d="M0 0L5 5"/></a>'));
    expect(v.raw).not.toMatch(/javascript:/i);
  });
});
