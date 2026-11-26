/**
 * Text split for word/character animations. The canvas, the render page and the exporters render a
 * text with a `split: 'words' | 'chars'` animation as one inline-block `<span data-motion-seg>` per
 * segment (whitespace stays plain text, so lines still break between words).
 */

export interface TextSegment {
  text: string;
  /** Whitespace between segments: rendered as plain text, not animated. */
  space: boolean;
}

type Segmenter = { segment(input: string): Iterable<{ segment: string }> };

let graphemes: Segmenter | null | undefined;

function chars(text: string): string[] {
  if (graphemes === undefined) {
    const Ctor = (Intl as unknown as { Segmenter?: new (l?: string, o?: object) => Segmenter })
      .Segmenter;
    graphemes = Ctor ? new Ctor(undefined, { granularity: 'grapheme' }) : null;
  }
  if (!graphemes) return Array.from(text);
  return Array.from(graphemes.segment(text), (s) => s.segment);
}

/** Splits a text into animated segments (words or characters) and the whitespace between them. */
export function splitText(text: string, mode: 'words' | 'chars'): TextSegment[] {
  const out: TextSegment[] = [];
  for (const part of text.split(/(\s+)/)) {
    if (!part) continue;
    if (/^\s+$/.test(part)) {
      out.push({ text: part, space: true });
      continue;
    }
    if (mode === 'words') out.push({ text: part, space: false });
    else for (const c of chars(part)) out.push({ text: c, space: false });
  }
  return out;
}

/** Number of animated segments (words or characters) of a text. */
export function countTextSegments(text: string, mode: 'words' | 'chars'): number {
  return splitText(text, mode).filter((s) => !s.space).length;
}
