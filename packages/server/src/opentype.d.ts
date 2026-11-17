/** Tipos mínimos do `opentype.js` 2.x (o pacote não traz declarações), só o que `outlines.ts` usa. */
declare module 'opentype.js' {
  export interface Path {
    /** `decimals` inteiro: casas decimais, sem inverter o eixo Y. */
    toPathData(decimals: number): string;
  }

  export interface Glyph {
    index: number;
    advanceWidth: number;
    getPath(
      x: number,
      y: number,
      fontSize: number,
      options?: Record<string, unknown>,
      font?: Font,
    ): Path;
  }

  export interface Font {
    unitsPerEm: number;
    /** Ascendente e descendente (hhea; o descendente é negativo). */
    ascender: number;
    descender: number;
    tables: Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
    names: Record<string, Record<string, string> | undefined>;
    /** Presente nas fontes variáveis. */
    variation?: { getTransform(glyph: Glyph, coords?: Record<string, number>): Glyph };
    charToGlyphIndex(char: string): number;
    forEachGlyph(
      text: string,
      x: number,
      y: number,
      fontSize: number,
      options: Record<string, unknown>,
      callback: (glyph: Glyph, x: number, y: number, fontSize: number) => void,
    ): number;
  }

  export function parse(buffer: ArrayBuffer, options?: Record<string, unknown>): Font;
  const opentype: { parse: typeof parse };
  export default opentype;
}
