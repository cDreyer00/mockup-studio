/**
 * Curated font pairs for the `font-pairs` remix. The order is fixed and interleaves the categories
 * (editorial, neutral, display, technical, humanist, classic) so the first pairs are always
 * varied. They mix popular Google Fonts (used when installed or
 * embedded in the document) and system fonts common on Windows/macOS, so that there are almost always
 * pairs available.
 */

export type FontGeneric = 'serif' | 'sans-serif' | 'monospace';

export interface FontPair {
  category: string;
  heading: string;
  body: string;
}

/** CSS generic family of each font in the curated list (becomes the `font-family` fallback). */
export const FONT_GENERIC: Record<string, FontGeneric> = {
  'Playfair Display': 'serif',
  Lora: 'serif',
  Merriweather: 'serif',
  'Source Serif 4': 'serif',
  Georgia: 'serif',
  Cambria: 'serif',
  'Palatino Linotype': 'serif',
  'Times New Roman': 'serif',
  Inter: 'sans-serif',
  Roboto: 'sans-serif',
  'Open Sans': 'sans-serif',
  Montserrat: 'sans-serif',
  'DM Sans': 'sans-serif',
  Poppins: 'sans-serif',
  Lato: 'sans-serif',
  Oswald: 'sans-serif',
  'Bebas Neue': 'sans-serif',
  'Space Grotesk': 'sans-serif',
  Nunito: 'sans-serif',
  'Source Sans 3': 'sans-serif',
  'IBM Plex Sans': 'sans-serif',
  'Segoe UI': 'sans-serif',
  'Trebuchet MS': 'sans-serif',
  Calibri: 'sans-serif',
  Verdana: 'sans-serif',
  Arial: 'sans-serif',
  'JetBrains Mono': 'monospace',
  'IBM Plex Mono': 'monospace',
  'Space Mono': 'monospace',
  Consolas: 'monospace',
  'Courier New': 'monospace',
};

const pair = (category: string, heading: string, body: string): FontPair => ({
  category,
  heading,
  body,
});

export const FONT_PAIRS: readonly FontPair[] = [
  pair('Editorial', 'Playfair Display', 'Inter'),
  pair('Neutral', 'Inter', 'Roboto'),
  pair('Display', 'Space Grotesk', 'Inter'),
  pair('Technical', 'JetBrains Mono', 'Inter'),
  pair('Humanist', 'Nunito', 'Open Sans'),
  pair('Classic', 'Georgia', 'Verdana'),
  pair('Editorial', 'Lora', 'Source Sans 3'),
  pair('Neutral', 'Montserrat', 'Open Sans'),
  pair('Display', 'Bebas Neue', 'Roboto'),
  pair('Technical', 'IBM Plex Mono', 'IBM Plex Sans'),
  pair('Humanist', 'Source Sans 3', 'Source Serif 4'),
  pair('Classic', 'Palatino Linotype', 'Segoe UI'),
  pair('Editorial', 'Merriweather', 'Lato'),
  pair('Neutral', 'DM Sans', 'Inter'),
  pair('Display', 'Oswald', 'Lato'),
  pair('Technical', 'Space Mono', 'DM Sans'),
  pair('Humanist', 'Trebuchet MS', 'Georgia'),
  pair('Classic', 'Times New Roman', 'Arial'),
  pair('Editorial', 'Cambria', 'Calibri'),
  pair('Neutral', 'Segoe UI', 'Arial'),
  pair('Display', 'Poppins', 'Nunito'),
  pair('Technical', 'Consolas', 'Segoe UI'),
  pair('Technical', 'Courier New', 'Arial'),
];

/** `font-family` value with the family quoted and the generic as a fallback: `"Georgia", serif`. */
export function fontFamilyValue(family: string): string {
  return `"${family}", ${FONT_GENERIC[family] ?? 'sans-serif'}`;
}
