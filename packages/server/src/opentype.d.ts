/** Minimal types for `opentype.js` 2.x (the package ships no declarations), only what `outlines.ts` uses. */
declare module 'opentype.js' {
  export interface Path {
    /** Integer `decimals`: decimal places, without flipping the Y axis. */
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
    /** Ascender and descender (hhea; the descender is negative). */
    ascender: number;
    descender: number;
    tables: Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
    names: Record<string, Record<string, string> | undefined>;
    /** Present in variable fonts. */
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
