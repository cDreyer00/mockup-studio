// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useDoc } from '../state/docStore';
import { ui, useUi } from '../state/uiStore';
import { makeDoc } from '../test/fixtures';
import { TimelinePanel } from './TimelinePanel';
import * as preview from './preview';

describe('TimelinePanel', () => {
  beforeEach(() => {
    vi.spyOn(preview.motionPreview, 'scrub').mockImplementation(() => {});
    vi.spyOn(preview.motionPreview, 'seek').mockImplementation(() => {});
    vi.spyOn(preview.motionPreview, 'stop').mockImplementation(() => {});
    Element.prototype.getBoundingClientRect = () =>
      ({
        left: 100,
        top: 0,
        right: 900,
        bottom: 20,
        width: 800,
        height: 20,
        x: 100,
        y: 0,
      }) as DOMRect;
  });
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    useUi.setState({ selection: [], motionSelection: null });
  });

  it('shows the empty state without animations', () => {
    const { doc } = makeDoc();
    useDoc.setState({ doc });
    render(<TimelinePanel />);
    expect(screen.getByTestId('motion-timeline-empty').textContent).toContain('MCP');
  });

  it('renders one bar per animation and seeks on a ruler click', () => {
    const { doc, frame, a, b } = makeDoc();
    a.animations = [{ kind: 'in', preset: 'fade-up' }];
    b.animations = [
      { kind: 'in', preset: 'fade', build: 1 },
      { kind: 'emphasis', preset: 'pulse' },
    ];
    useDoc.setState({ doc });
    ui.select([a.id]);
    render(<TimelinePanel />);
    expect(screen.getAllByTestId('motion-bar')).toHaveLength(3);
    expect(screen.getAllByTestId('motion-build').map((e) => e.textContent)).toEqual([
      'On start',
      'Click 1',
    ]);
    fireEvent.pointerDown(screen.getByTestId('motion-ruler'), { clientX: 100, button: 0 });
    expect(preview.motionPreview.scrub).toHaveBeenCalledWith(frame.id, 0);
    fireEvent.pointerUp(screen.getByTestId('motion-ruler'), { clientX: 100 });
    expect(preview.motionPreview.seek).toHaveBeenCalledWith(frame.id, 0);
  });

  it('clicking a bar selects its node and the animation', () => {
    const { doc, b } = makeDoc();
    b.animations = [{ kind: 'in', preset: 'fade' }];
    useDoc.setState({ doc });
    render(<TimelinePanel />);
    const bar = screen.getByTestId('motion-bar');
    fireEvent.pointerDown(bar, { clientX: 150, button: 0 });
    fireEvent.pointerUp(bar, { clientX: 150 });
    expect(useUi.getState().selection).toEqual([b.id]);
    expect(useUi.getState().motionSelection).toEqual({ nodeId: b.id, index: 0 });
  });

  it('closing (unmount) returns to the design state', () => {
    const { doc } = makeDoc();
    useDoc.setState({ doc });
    const { unmount } = render(<TimelinePanel />);
    act(() => unmount());
    expect(preview.motionPreview.stop).toHaveBeenCalled();
  });
});
