// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { daemon } from '../client/daemon';
import { useDoc } from '../state/docStore';
import { ui, useUi } from '../state/uiStore';
import { makeDoc } from '../test/fixtures';
import { PropertiesPanel } from '../properties/PropertiesPanel';

function setup(animated = true) {
  const m = makeDoc();
  if (animated) m.a.animations = [{ kind: 'in', preset: 'fade-up', delay: 100 }];
  useDoc.setState({ doc: m.doc });
  return m;
}

describe('MotionSection', () => {
  beforeEach(() => {
    vi.spyOn(daemon, 'applySafe').mockResolvedValue(null);
  });
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    useUi.setState({ selection: [], motionSelection: null });
  });

  it('lists the animations of the node', () => {
    const { a } = setup();
    ui.select([a.id]);
    render(<PropertiesPanel />);
    const row = screen.getByTestId('motion-row');
    expect(row.textContent).toContain('Fade up');
    expect(row.textContent).toContain('On start');
  });

  it('adds an animation from the picker with one setMotion op', () => {
    const { b } = setup();
    ui.select([b.id]);
    render(<PropertiesPanel />);
    fireEvent.click(screen.getByTestId('motion-add'));
    fireEvent.click(within(screen.getByTestId('motion-picker')).getByTestId('motion-preset-fade'));
    expect(daemon.applySafe).toHaveBeenCalledWith([
      {
        type: 'setMotion',
        changes: [{ nodeId: b.id, animations: [{ kind: 'in', preset: 'fade' }] }],
      },
    ]);
  });

  it('cascades the delay over a multiple selection', () => {
    const { a, b } = setup(false);
    ui.select([a.id, b.id]);
    render(<PropertiesPanel />);
    const cascade = document.querySelector<HTMLInputElement>('[data-testid=motion-cascade] input')!;
    fireEvent.focus(cascade);
    fireEvent.change(cascade, { target: { value: '80' } });
    fireEvent.blur(cascade);
    fireEvent.click(screen.getByTestId('motion-add'));
    fireEvent.click(screen.getByTestId('motion-preset-fade'));
    expect(daemon.applySafe).toHaveBeenCalledWith([
      {
        type: 'setMotion',
        changes: [
          { nodeId: a.id, animations: [{ kind: 'in', preset: 'fade' }] },
          { nodeId: b.id, animations: [{ kind: 'in', preset: 'fade', delay: 80 }] },
        ],
      },
    ]);
  });

  it('edits the delay and removes the animation', () => {
    const { a } = setup();
    ui.select([a.id]);
    render(<PropertiesPanel />);
    fireEvent.click(screen.getByTestId('motion-row-toggle'));
    const delay = document.querySelector<HTMLInputElement>('[data-testid=motion-delay] input')!;
    fireEvent.focus(delay);
    fireEvent.change(delay, { target: { value: '250' } });
    fireEvent.blur(delay);
    expect(daemon.applySafe).toHaveBeenLastCalledWith([
      {
        type: 'setMotion',
        changes: [{ nodeId: a.id, animations: [{ kind: 'in', preset: 'fade-up', delay: 250 }] }],
      },
    ]);
    fireEvent.click(screen.getByTestId('motion-remove'));
    expect(daemon.applySafe).toHaveBeenLastCalledWith([
      { type: 'setMotion', changes: [{ nodeId: a.id, animations: null }] },
    ]);
  });

  it('shows the slide transition section only for root frames', () => {
    const { frame, a } = setup();
    ui.select([a.id]);
    const { unmount } = render(<PropertiesPanel />);
    expect(screen.queryByTestId('transition-preset')).toBeNull();
    unmount();
    ui.select([frame.id]);
    render(<PropertiesPanel />);
    fireEvent.change(screen.getByTestId('transition-preset'), { target: { value: 'fade' } });
    expect(daemon.applySafe).toHaveBeenCalledWith([
      { type: 'setMotion', changes: [{ nodeId: frame.id, transition: { preset: 'fade' } }] },
    ]);
  });
});
