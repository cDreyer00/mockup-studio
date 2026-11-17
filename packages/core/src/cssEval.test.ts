import { describe, it, expect } from 'vitest';
import {
  evaluateCalc,
  evaluateColorMix,
  evaluateCss,
  formatHexColor,
  parseCssColor,
} from './cssEval.js';

describe('evaluateCalc', () => {
  it('avalia multiplicação, soma e divisão', () => {
    expect(evaluateCalc('calc(8px * 2)')).toBe('16px');
    expect(evaluateCalc('calc(1rem + 0.5rem)')).toBe('1.5rem');
    expect(evaluateCalc('calc((10px + 2px) / 4)')).toBe('3px');
    expect(evaluateCalc('calc(2 * 3)')).toBe('6');
    expect(evaluateCalc('calc(2 * 3px - 1px)')).toBe('5px');
    expect(evaluateCalc('calc(100% / 3)')).toBe('33.3333%');
  });

  it('respeita a precedência e o calc() aninhado', () => {
    expect(evaluateCalc('calc(1px + 2px * 3)')).toBe('7px');
    expect(evaluateCalc('calc(calc(2px + 2px) * 2)')).toBe('8px');
    expect(evaluateCalc('calc(-1 * 4px)')).toBe('-4px');
  });

  it('devolve null para unidades mistas, divisão por zero e sintaxe inválida', () => {
    expect(evaluateCalc('calc(100% - 16px)')).toBeNull();
    expect(evaluateCalc('calc(10px / 0)')).toBeNull();
    expect(evaluateCalc('calc(10px * 2px)')).toBeNull();
    expect(evaluateCalc('calc(10px / 2px)')).toBeNull();
    expect(evaluateCalc('calc(1px +)')).toBeNull();
    expect(evaluateCalc('calc(1px + var(--x))')).toBeNull();
    expect(evaluateCalc('calc(1px + 2px')).toBeNull();
    expect(evaluateCalc('rgb(1 2 3)')).toBeNull();
  });

  it('formata sem zeros à direita e sem -0', () => {
    expect(evaluateCalc('calc(1px / 3)')).toBe('0.3333px');
    expect(evaluateCalc('calc(1.5 * 1)')).toBe('1.5');
    expect(evaluateCalc('calc(0px * -1)')).toBe('0px');
  });

  it('avalia min, max e clamp com a mesma unidade', () => {
    expect(evaluateCalc('min(10px, 20px)')).toBe('10px');
    expect(evaluateCalc('max(10px, 2px * 3, 8px)')).toBe('10px');
    expect(evaluateCalc('clamp(10px, 5px, 20px)')).toBe('10px');
    expect(evaluateCalc('clamp(10px, 15px, 20px)')).toBe('15px');
    expect(evaluateCalc('clamp(10px, 50px, 20px)')).toBe('20px');
    expect(evaluateCalc('calc(min(4px, 8px) * 2)')).toBe('8px');
  });

  it('devolve null em min, max e clamp com unidades mistas', () => {
    expect(evaluateCalc('min(10px, 5%)')).toBeNull();
    expect(evaluateCalc('max(1rem, 10px)')).toBeNull();
    expect(evaluateCalc('clamp(1rem, 50%, 3rem)')).toBeNull();
    expect(evaluateCalc('clamp(1px, 2px)')).toBeNull();
  });
});

describe('evaluateColorMix', () => {
  it('mistura em srgb', () => {
    expect(evaluateColorMix('color-mix(in srgb, red 50%, blue)')).toBe('#800080');
    expect(evaluateColorMix('color-mix(in srgb, red, blue)')).toBe('#800080');
    expect(evaluateColorMix('color-mix(in srgb, #000 20%, transparent)')).toBe('#00000033');
    expect(evaluateColorMix('color-mix(in srgb, red, blue 25%)')).toBe('#bf0040');
    expect(evaluateColorMix('color-mix(in srgb, 25% red, 75% blue)')).toBe('#4000bf');
  });

  it('mistura em oklab e lab', () => {
    expect(evaluateColorMix('color-mix(in oklab, white 50%, black)')).toBe('#636363');
    expect(evaluateColorMix('color-mix(in lab, white, black)')).toBe('#777777');
  });

  it('mistura em oklch com matiz', () => {
    expect(evaluateColorMix('color-mix(in oklch, red, blue)')).toBe('#ba00c2');
    // Mesma matiz: equivale à cor intermediária calculada diretamente.
    const meio = parseCssColor('oklch(0.6 0.1 120)')!;
    expect(evaluateColorMix('color-mix(in oklch, oklch(0.5 0.1 120), oklch(0.7 0.1 120))')).toBe(
      formatHexColor(meio),
    );
    // Matiz powerless (branco) assume a matiz da outra cor.
    expect(evaluateColorMix('color-mix(in oklch, white, red)')).toBe('#ffa191');
  });

  it('mistura em hsl com os métodos de matiz', () => {
    expect(evaluateColorMix('color-mix(in hsl, red, blue)')).toBe('#ff00ff');
    expect(evaluateColorMix('color-mix(in hsl longer hue, red, blue)')).toBe('#00ff00');
    expect(evaluateColorMix('color-mix(in srgb longer hue, red, blue)')).toBeNull();
  });

  it('soma de porcentagens menor que 100 reduz o alpha', () => {
    expect(evaluateColorMix('color-mix(in srgb, red 30%, blue 30%)')).toBe('#80008099');
  });

  it('soma maior que 100 normaliza sem mudar o alpha', () => {
    expect(evaluateColorMix('color-mix(in srgb, red 75%, blue 75%)')).toBe('#800080');
  });

  it('devolve null para casos inválidos', () => {
    expect(evaluateColorMix('color-mix(in srgb, currentColor, red)')).toBeNull();
    expect(evaluateColorMix('color-mix(in srgb, red 0%, blue 0%)')).toBeNull();
    expect(evaluateColorMix('color-mix(in srgb, red 120%, blue)')).toBeNull();
    expect(evaluateColorMix('color-mix(in nada, red, blue)')).toBeNull();
    expect(evaluateColorMix('color-mix(in srgb, red)')).toBeNull();
    expect(evaluateColorMix('color-mix(in srgb, var(--a), blue)')).toBeNull();
  });
});

describe('evaluateCss', () => {
  it('avalia várias partes de um valor', () => {
    expect(evaluateCss('0 1px calc(2px * 3) color-mix(in srgb, #000 20%, transparent)')).toBe(
      '0 1px 6px #00000033',
    );
  });

  it('mantém intacta a função com var()', () => {
    expect(evaluateCss('calc(var(--a) * 2)')).toBe('calc(var(--a) * 2)');
    expect(evaluateCss('color-mix(in srgb, var(--a), blue)')).toBe(
      'color-mix(in srgb, var(--a), blue)',
    );
    expect(evaluateCss('calc(1px + 1px) calc(var(--a) + 1px)')).toBe('2px calc(var(--a) + 1px)');
  });

  it('percorre o conteúdo de funções desconhecidas', () => {
    expect(evaluateCss('linear-gradient(color-mix(in srgb, red 50%, blue), white)')).toBe(
      'linear-gradient(#800080, white)',
    );
    expect(evaluateCss('translate(calc(1px + 1px), 0)')).toBe('translate(2px, 0)');
  });

  it('avalia de dentro para fora', () => {
    expect(evaluateCss('color-mix(in srgb, red calc(25% * 2), blue)')).toBe('#800080');
    expect(evaluateCss('color-mix(in srgb, color-mix(in srgb, red, blue) 50%, white)')).toBe(
      '#c080c0',
    );
  });

  it('mantém o texto quando não dá para avaliar', () => {
    expect(evaluateCss('calc(100% - 16px)')).toBe('calc(100% - 16px)');
    expect(evaluateCss('color-mix(in srgb, currentColor, red)')).toBe(
      'color-mix(in srgb, currentColor, red)',
    );
  });

  it('não altera valores sem funções avaliáveis', () => {
    expect(evaluateCss('1px solid #fff')).toBe('1px solid #fff');
    expect(evaluateCss('rgb(1 2 3 / 50%)')).toBe('rgb(1 2 3 / 50%)');
    expect(evaluateCss('url(a.png)')).toBe('url(a.png)');
    expect(evaluateCss('')).toBe('');
  });

  it('não toca em strings entre aspas', () => {
    expect(evaluateCss('"calc(1px + 1px)" calc(1px + 1px)')).toBe('"calc(1px + 1px)" 2px');
    expect(evaluateCss("'a (' calc(2px * 2)")).toBe("'a (' 4px");
    expect(evaluateCss('font-family("a)b", calc(1px + 1px))')).toBe('font-family("a)b", 2px)');
  });

  it('tolera parêntese sem fechar', () => {
    expect(evaluateCss('calc(1px + 1px')).toBe('calc(1px + 1px');
  });
});

describe('parseCssColor', () => {
  it('lê hex curto, longo e com alpha', () => {
    expect(parseCssColor('#fff')).toEqual({ r: 1, g: 1, b: 1, a: 1 });
    expect(parseCssColor('#ff0000')).toEqual({ r: 1, g: 0, b: 0, a: 1 });
    expect(parseCssColor('#f008')).toEqual({ r: 1, g: 0, b: 0, a: 0x88 / 255 });
    expect(parseCssColor('#00000033')).toEqual({ r: 0, g: 0, b: 0, a: 0.2 });
    expect(parseCssColor('#ff')).toBeNull();
    expect(parseCssColor('#gggggg')).toBeNull();
  });

  it('lê rgb moderno e legado', () => {
    expect(parseCssColor('rgb(255 0 0 / 50%)')).toEqual({ r: 1, g: 0, b: 0, a: 0.5 });
    expect(parseCssColor('rgba(0, 0, 255, 0.25)')).toEqual({ r: 0, g: 0, b: 1, a: 0.25 });
    expect(parseCssColor('rgb(100% 0% 0%)')).toEqual({ r: 1, g: 0, b: 0, a: 1 });
  });

  it('lê hsl, hwb e nomes (sem diferenciar maiúsculas)', () => {
    const hsl = parseCssColor('hsl(120deg 100% 50%)')!;
    expect(hsl.r).toBeCloseTo(0);
    expect(hsl.g).toBeCloseTo(1);
    expect(parseCssColor('HSLA(0, 100%, 50%, 0.5)')!.a).toBe(0.5);
    expect(formatHexColor(parseCssColor('hwb(0 0% 0%)')!)).toBe('#ff0000');
    expect(parseCssColor('Rebeccapurple')!.g).toBeCloseTo(0.2);
    expect(parseCssColor('transparent')).toEqual({ r: 0, g: 0, b: 0, a: 0 });
  });

  it('lê oklch, lab, lch e color()', () => {
    const red = parseCssColor('oklch(0.628 0.2577 29.23)')!;
    expect(red.r).toBeCloseTo(1, 2);
    expect(red.g).toBeCloseTo(0, 2);
    expect(red.b).toBeCloseTo(0, 2);
    expect(formatHexColor(parseCssColor('lab(50% 40 59.5)')!)).toBe('#bf5700');
    expect(formatHexColor(parseCssColor('lch(52.2% 72.2 50)')!)).toBe('#cd561a');
    expect(formatHexColor(parseCssColor('color(display-p3 1 0 0)')!)).toBe('#ff0000');
    expect(formatHexColor(parseCssColor('color(xyz 0.9505 1 1.089)')!)).toBe('#ffffff');
    expect(formatHexColor(parseCssColor('oklab(1 0 0)')!)).toBe('#ffffff');
  });

  it('devolve null para o que não é cor', () => {
    expect(parseCssColor('currentColor')).toBeNull();
    expect(parseCssColor('var(--a)')).toBeNull();
    expect(parseCssColor('12px')).toBeNull();
    expect(parseCssColor('')).toBeNull();
    expect(parseCssColor('rgb(1 2)')).toBeNull();
  });
});

describe('formatHexColor', () => {
  it('formata com clamp e arredondamento', () => {
    expect(formatHexColor({ r: 1, g: 0, b: 0, a: 1 })).toBe('#ff0000');
    expect(formatHexColor({ r: 2, g: -1, b: 0.5, a: 1 })).toBe('#ff0080');
    expect(formatHexColor({ r: 0, g: 0, b: 0, a: 0.2 })).toBe('#00000033');
  });
});
