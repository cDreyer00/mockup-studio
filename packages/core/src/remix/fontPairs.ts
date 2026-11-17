/**
 * Pares de fontes curados para o remix `font-pairs`. A ordem é fixa e intercala as categorias
 * (editorial, neutro, display, técnico, humanista, clássico) para que os primeiros pares sempre
 * sejam variados. Misturam fontes populares do Google Fonts (usadas quando instaladas ou
 * embutidas no documento) e fontes de sistema comuns no Windows/macOS, para que quase sempre haja
 * pares disponíveis.
 */

export type FontGeneric = 'serif' | 'sans-serif' | 'monospace';

export interface FontPair {
  category: string;
  heading: string;
  body: string;
}

/** Família genérica CSS de cada fonte da lista curada (vira o fallback do `font-family`). */
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
  pair('Neutro', 'Inter', 'Roboto'),
  pair('Display', 'Space Grotesk', 'Inter'),
  pair('Técnico', 'JetBrains Mono', 'Inter'),
  pair('Humanista', 'Nunito', 'Open Sans'),
  pair('Clássico', 'Georgia', 'Verdana'),
  pair('Editorial', 'Lora', 'Source Sans 3'),
  pair('Neutro', 'Montserrat', 'Open Sans'),
  pair('Display', 'Bebas Neue', 'Roboto'),
  pair('Técnico', 'IBM Plex Mono', 'IBM Plex Sans'),
  pair('Humanista', 'Source Sans 3', 'Source Serif 4'),
  pair('Clássico', 'Palatino Linotype', 'Segoe UI'),
  pair('Editorial', 'Merriweather', 'Lato'),
  pair('Neutro', 'DM Sans', 'Inter'),
  pair('Display', 'Oswald', 'Lato'),
  pair('Técnico', 'Space Mono', 'DM Sans'),
  pair('Humanista', 'Trebuchet MS', 'Georgia'),
  pair('Clássico', 'Times New Roman', 'Arial'),
  pair('Editorial', 'Cambria', 'Calibri'),
  pair('Neutro', 'Segoe UI', 'Arial'),
  pair('Display', 'Poppins', 'Nunito'),
  pair('Técnico', 'Consolas', 'Segoe UI'),
  pair('Técnico', 'Courier New', 'Arial'),
];

/** Valor de `font-family` com a família entre aspas e o genérico como fallback: `"Georgia", serif`. */
export function fontFamilyValue(family: string): string {
  return `"${family}", ${FONT_GENERIC[family] ?? 'sans-serif'}`;
}
