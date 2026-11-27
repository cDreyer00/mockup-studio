/** The animated example documents load as saved (nothing dropped) and have clean timelines. */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { expandDocument } from '../components/expand.js';
import { parseDocument, serializeDocument } from '../schema.js';
import { frameMotionTimeline } from './timeline.js';

const examples = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../examples');
const files = [
  'motion-deck.mockup.json',
  ...fs.readdirSync(path.join(examples, 'motion')).map((f) => `motion/${f}`),
].filter((f) => f.endsWith('.mockup.json'));

describe('animated examples', () => {
  it('there is a deck, a component sheet and a landing page', () => {
    expect(files).toEqual(
      expect.arrayContaining([
        'motion/landing-entrance.mockup.json',
        'motion/micro-interactions.mockup.json',
        'motion/product-launch-deck.mockup.json',
      ]),
    );
  });

  it.each(files)('%s keeps every animation and has no timeline warnings', (file) => {
    const text = fs.readFileSync(path.join(examples, file), 'utf8').replace(/\r\n/g, '\n');
    const doc = parseDocument(JSON.parse(text));
    // the lenient reader drops invalid motion: the canonical form must be the file itself
    expect(serializeDocument(doc).trim()).toBe(text.trim());
    const timelines = expandDocument(doc).pages.flatMap((p) => p.frames.map(frameMotionTimeline));
    expect(timelines.flatMap((t) => t.warnings)).toEqual([]);
    expect(timelines.reduce((n, t) => n + t.items.length, 0)).toBeGreaterThan(0);
  });
});
