import { createContext, createElement, Fragment } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import { splitText } from '@mockup/core';
import type { MotionScope } from './scope';

/**
 * Motion scope of the rendering surface (canvas, presentation, render page). `null` = no motion:
 * the design state, without Web Animations (thumbnails, tests).
 */
export const MotionScopeContext = createContext<MotionScope | null>(null);

/** Id of the root frame being rendered (the motion timeline the nodes belong to). */
export const MotionFrameContext = createContext('');

const SEG: CSSProperties = { display: 'inline-block' };
/** A word whose characters animate: atomic, so the line never breaks inside it. */
const WORD: CSSProperties = { display: 'inline-block', whiteSpace: 'nowrap' };

/**
 * Children of a text split for word/character animations: one inline-block `span[data-motion-seg]`
 * per segment (the order matches `compileNodeMotion`); whitespace stays plain text.
 */
export function splitTextChildren(text: string, mode: 'words' | 'chars'): ReactNode[] {
  const segs = splitText(text, mode);
  const out: ReactNode[] = [];
  if (mode === 'words') {
    segs.forEach((s, i) =>
      out.push(
        s.space
          ? s.text
          : createElement('span', { key: i, 'data-motion-seg': '', style: SEG }, s.text),
      ),
    );
    return out;
  }
  let word: ReactNode[] = [];
  let key = 0;
  const flush = (): void => {
    if (!word.length) return;
    out.push(createElement('span', { key: `w${key++}`, style: WORD }, ...word));
    word = [];
  };
  segs.forEach((s, i) => {
    if (s.space) {
      flush();
      out.push(createElement(Fragment, { key: `s${i}` }, s.text));
    } else {
      word.push(createElement('span', { key: i, 'data-motion-seg': '', style: SEG }, s.text));
    }
  });
  flush();
  return out;
}
