import { describe, expect, it } from 'vitest';
import { svgToVector } from './svg.js';

const wrap = (inner: string, attrs = ''): string =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"${attrs}>${inner}</svg>`;

describe('svgToVector: sanitização', () => {
  it('remove <script> e mantém o path', () => {
    const v = svgToVector(wrap('<script>alert(1)</script><path d="M0 0L5 5"/>'));
    expect(v.raw).not.toMatch(/script|alert/i);
    expect(v.paths).toHaveLength(1);
  });

  it('remove handlers on*', () => {
    const v = svgToVector(wrap('<path d="M0 0L5 5" onclick="x()"/>', ' onload="evil()"'));
    expect(v.raw).not.toMatch(/onload|onclick|evil|x\(\)/i);
    expect(JSON.stringify(v.attrs ?? {})).not.toMatch(/onload/i);
  });

  // Política atual de sanitizeSvg: href http(s) em <a>/<image> é mantido (só javascript: e data:
  // não-imagem caem; <use> só aceita "#fragmento"). Este teste documenta o comportamento.
  it('href http(s) em <a> e <image> é mantido (política atual); data: não-imagem cai', () => {
    const v = svgToVector(
      wrap(
        '<a href="http://ok.example/x"><path d="M0 0L5 5"/></a><image href="data:text/html;base64,AAAA" width="5" height="5"/>',
      ),
    );
    expect(v.raw).toContain('ok.example');
    expect(v.raw).not.toContain('data:text/html');
  });

  it('<use href externo> some do raw e paths fica vazio', () => {
    const v = svgToVector(wrap('<use href="http://evil.example/s.svg#a"/><path d="M0 0L5 5"/>'));
    expect(v.raw).not.toContain('evil.example');
    expect(v.paths).toEqual([]);
  });

  it('<use> interno também zera paths (não é simples)', () => {
    const v = svgToVector(wrap('<defs><path id="a" d="M0 0L5 5"/></defs><use href="#a"/>'));
    expect(v.paths).toEqual([]);
  });

  it('javascript: em href é removido', () => {
    const v = svgToVector(wrap('<a href="javascript:alert(1)"><path d="M0 0L5 5"/></a>'));
    expect(v.raw).not.toMatch(/javascript:/i);
  });
});
