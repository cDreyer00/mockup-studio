/** "Slide transition" section: how a root frame enters in a presentation (root frames only). */
import { useContext } from 'react';
import { SLIDE_TRANSITIONS, TRANSITION_DIRECTIONS, getSlideTransition } from '@mockup/core';
import type { Node, SlideTransition, TransitionDirection } from '@mockup/core';
import { LockedContext, runOps } from '../properties/styleOps';
import { Body } from '../properties/shared';
import { useActivePage } from '../state/hooks';
import { Row, Section, SelectInput } from '../ui/controls';
import { NumberInput } from '../ui/NumberInput';
import { ui } from '../state/uiStore';
import { mergeTransition, parseMs, setTransitionOp, transitionToAllOp } from './motionOps';
import { EasingOptions } from './easingOptions';
import './motion.css';

const DIRECTION_LABELS: Record<TransitionDirection, string> = {
  left: 'From the right (←)',
  right: 'From the left (→)',
  up: 'Upwards (↑)',
  down: 'Downwards (↓)',
};

export function TransitionSection({ frames }: { frames: readonly Node[] }) {
  const locked = useContext(LockedContext);
  const page = useActivePage();
  const first = frames[0]?.slideTransition;
  const same = frames.every((f) => JSON.stringify(f.slideTransition) === JSON.stringify(first));
  const def = first ? getSlideTransition(first.preset) : undefined;
  const send = (t: SlideTransition | null): void => void runOps([setTransitionOp(frames, t)]);
  const patch = (p: Partial<SlideTransition>): void => {
    if (first) send(mergeTransition(first, p));
  };

  return (
    <Section id="props-transition" title="Slide transition">
      <Body>
        <Row label="Preset">
          <select
            className="select-input"
            data-testid="transition-preset"
            value={same ? (first?.preset ?? '') : '__mixed'}
            title={def?.description}
            disabled={locked}
            onChange={(e) => {
              const v = e.target.value;
              if (v === '__mixed') return;
              send(v ? { preset: v } : null);
            }}
          >
            {!same && <option value="__mixed">Mixed</option>}
            <option value="">None</option>
            {SLIDE_TRANSITIONS.map((t) => (
              <option key={t.name} value={t.name} title={t.description}>
                {t.label}
              </option>
            ))}
          </select>
        </Row>
        {same && first && (
          <>
            {def?.directional && (
              <Row label="Direction">
                <SelectInput
                  value={first.direction ?? 'left'}
                  options={TRANSITION_DIRECTIONS.map((d) => ({
                    value: d,
                    label: DIRECTION_LABELS[d],
                  }))}
                  onChange={(d) => d && patch({ direction: d as TransitionDirection })}
                />
              </Row>
            )}
            <Row label="Duration">
              <div className="mo-num" data-testid="transition-duration">
                <NumberInput
                  label="D"
                  title="Duration (ms)"
                  value={`${first.duration ?? def?.duration ?? 500}ms`}
                  unit="ms"
                  min={0}
                  step={10}
                  disabled={locked}
                  onCommit={(t) => {
                    const n = parseMs(t);
                    if (n === null) ui.toast('Enter a duration in ms', 'error');
                    else patch({ duration: n });
                  }}
                />
              </div>
            </Row>
            <Row label="Easing">
              <select
                className="select-input"
                data-testid="transition-easing"
                value={first.easing ?? def?.easing ?? 'smooth'}
                disabled={locked}
                onChange={(e) => patch({ easing: e.target.value })}
              >
                <EasingOptions />
              </select>
            </Row>
            {page && page.frames.length > 1 && (
              <button
                type="button"
                className="btn mo-add-btn"
                data-testid="transition-apply-all"
                disabled={locked}
                onClick={() => void runOps([transitionToAllOp(page, first)])}
              >
                Apply to all frames on this page
              </button>
            )}
          </>
        )}
      </Body>
    </Section>
  );
}
