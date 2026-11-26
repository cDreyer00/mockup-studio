/**
 * Plays a slide transition with the Web Animations API: both slots (full-stage layers) get the
 * keyframes of the plan; perspective, back face and transform origin are set while it runs and
 * cleared when it ends. Without Web Animations it returns `null` and the caller cuts.
 */
import { resolveEasing, toWaapiKeyframes } from '@mockup/core';
import type { SlidePart, TransitionPlan } from '@mockup/core';
import type { MagicRun } from './magic';

export interface TransitionHandle {
  /** Ends it now: animations dropped, slot styles cleared, `onDone` called (once). */
  finish(): void;
}

export interface RunTransition {
  plan: TransitionPlan;
  stage: HTMLElement;
  incoming: HTMLElement;
  outgoing: HTMLElement;
  /** Magic move: builds the ghosts before the slots start animating (null = plain crossfade). */
  magic?: () => MagicRun | null;
  onDone(): void;
}

/** Duration of the fade of a slide that comes in without a transition. */
export const FADE_MS = 200;

export const canAnimate = (el: Element): boolean =>
  typeof (el as HTMLElement).animate === 'function';

export const prefersReducedMotion = (): boolean =>
  typeof window !== 'undefined' &&
  typeof window.matchMedia === 'function' &&
  window.matchMedia('(prefers-reduced-motion: reduce)').matches;

function settled(a: Animation): Promise<unknown> {
  if (a.finished) return a.finished;
  return new Promise((resolve) => {
    a.onfinish = resolve;
  });
}

export function runTransition(o: RunTransition): TransitionHandle | null {
  const { plan, stage, incoming, outgoing } = o;
  if (!canAnimate(incoming) || !canAnimate(outgoing)) return null;
  let magic: MagicRun | null = null;
  if (plan.magic && o.magic) {
    try {
      magic = o.magic();
    } catch {
      magic = null;
    }
  }
  const slots: [HTMLElement, SlidePart, number][] = [
    [incoming, plan.incoming, plan.top === 'incoming' ? 2 : 1],
    [outgoing, plan.outgoing, plan.top === 'incoming' ? 1 : 2],
  ];
  const anims: Animation[] = [...(magic?.animations ?? [])];
  let done = false;
  const finish = (): void => {
    if (done) return;
    done = true;
    for (const a of anims) {
      try {
        a.cancel();
      } catch {
        /* already gone */
      }
    }
    for (const [slot] of slots) {
      slot.style.zIndex = '';
      slot.style.transformOrigin = '';
      slot.style.backfaceVisibility = '';
    }
    stage.style.perspective = '';
    magic?.cleanup();
    o.onDone();
  };
  try {
    if (plan.perspective !== undefined) stage.style.perspective = `${plan.perspective}px`;
    const easing = resolveEasing(plan.easing);
    for (const [slot, part, z] of slots) {
      slot.style.zIndex = String(z);
      if (plan.backface) slot.style.backfaceVisibility = 'hidden';
      if (part.origin) slot.style.transformOrigin = part.origin;
      anims.push(
        slot.animate(toWaapiKeyframes(part.keyframes) as Keyframe[], {
          duration: plan.duration,
          easing,
          fill: 'both',
          direction: part.reverse ? 'reverse' : 'normal',
        }),
      );
    }
  } catch {
    finish();
    return null;
  }
  Promise.all(anims.map(settled)).then(finish, finish);
  return { finish };
}

/** The quick fade of a slide that comes in with no transition. */
export function fadeIn(slot: HTMLElement): Animation | null {
  if (!canAnimate(slot)) return null;
  try {
    const a = slot.animate([{ opacity: 0 }, { opacity: 1 }], {
      duration: FADE_MS,
      easing: 'ease-out',
    });
    // Cancelling rejects `finished`: nobody waits for it.
    a.finished?.catch(() => undefined);
    return a;
  } catch {
    return null;
  }
}
