// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDocument, createNodeFromTag } from '@mockup/core';
import type { Document } from '@mockup/core';
import { runDesktopMenu } from '../desktop/useDesktop';
import { isInteractionBlocked } from '../shortcuts/guards';
import { useShortcuts } from '../shortcuts/useShortcuts';
import { useDoc } from '../state/docStore';
import { useUi } from '../state/uiStore';
import { IDLE_MS, PresentationView, presentationKey } from './PresentationView';
import { presentation } from './presentationStore';

function deck(): Document {
  const doc = createDocument('Deck');
  for (const name of ['One', 'Two', 'Three']) {
    doc.pages[0]!.frames.push(
      createNodeFromTag('div', {
        isRoot: true,
        name,
        styles: { width: '400px', height: '300px' },
        children: [createNodeFromTag('p', { name: `T-${name}`, text: `Slide ${name}` })],
      }),
    );
  }
  return doc;
}

function Harness() {
  useShortcuts();
  return <PresentationView />;
}

const key = (k: string, init: KeyboardEventInit = {}) =>
  act(() => {
    fireEvent.keyDown(window, { key: k, ...init });
  });

let doc: Document;
beforeEach(() => {
  doc = deck();
  useDoc.setState({ doc, rawDoc: doc, activeDocId: doc.id });
  useUi.setState({ selection: [], tool: 'select', pageId: null, previewState: null });
});
afterEach(() => {
  act(() => presentation.stop());
  cleanup();
  useDoc.setState({ doc: null, rawDoc: null, activeDocId: null });
  vi.useRealTimers();
});

describe('presentationKey', () => {
  it('maps keys', () => {
    const k = (key: string) =>
      presentationKey({ key, ctrlKey: false, metaKey: false, altKey: false });
    expect(k('ArrowRight')).toEqual({ type: 'next' });
    expect(k(' ')).toEqual({ type: 'next' });
    expect(k('Backspace')).toEqual({ type: 'previous' });
    expect(k('Home')).toEqual({ type: 'first' });
    expect(k('End')).toEqual({ type: 'last' });
    expect(k('Escape')).toBe('exit');
    expect(k('x')).toBeUndefined();
    expect(
      presentationKey({ key: 'ArrowRight', ctrlKey: true, metaKey: false, altKey: false }),
    ).toBe(undefined);
  });
});

describe('PresentationView', () => {
  it('renders nothing while inactive', () => {
    const { queryByTestId } = render(<PresentationView />);
    expect(queryByTestId('presentation')).toBeNull();
  });

  it('shows the current slide with the renderer and the counter', () => {
    const { getByTestId } = render(<PresentationView />);
    act(() => void presentation.start());
    expect(getByTestId('presentation-counter').textContent).toBe('1 / 3');
    const slide = getByTestId('presentation-slide');
    expect(slide.dataset.frameId).toBe(doc.pages[0]!.frames[0]!.id);
    expect(slide.textContent).toContain('Slide One');
    expect(getByTestId('presentation-prev')).toHaveProperty('disabled', true);
  });

  it('navigates with keys, buttons and click; clamps at the edges', () => {
    const { getByTestId } = render(<PresentationView />);
    act(() => void presentation.start());
    const counter = () => getByTestId('presentation-counter').textContent;
    key('ArrowRight');
    expect(counter()).toBe('2 / 3');
    key(' ');
    expect(counter()).toBe('3 / 3');
    expect(getByTestId('presentation-next')).toHaveProperty('disabled', true);
    key('ArrowRight');
    expect(counter()).toBe('3 / 3');
    key('Backspace');
    expect(counter()).toBe('2 / 3');
    key('Home');
    expect(counter()).toBe('1 / 3');
    key('End');
    expect(counter()).toBe('3 / 3');
    fireEvent.click(getByTestId('presentation-prev'));
    expect(counter()).toBe('2 / 3');
    fireEvent.click(getByTestId('presentation-stage'));
    expect(counter()).toBe('3 / 3');
  });

  it('control buttons do not also advance via the stage click', () => {
    const { getByTestId } = render(<PresentationView />);
    act(() => void presentation.start());
    fireEvent.click(getByTestId('presentation-next'));
    expect(getByTestId('presentation-counter').textContent).toBe('2 / 3');
  });

  it('Escape and the exit button stop the presentation', () => {
    const { queryByTestId, getByTestId } = render(<PresentationView />);
    act(() => void presentation.start());
    key('Escape');
    expect(queryByTestId('presentation')).toBeNull();
    act(() => void presentation.start());
    fireEvent.click(getByTestId('presentation-exit'));
    expect(queryByTestId('presentation')).toBeNull();
  });

  it('editor shortcuts do not fire while presenting', () => {
    render(<Harness />);
    const frame = doc.pages[0]!.frames[0]!;
    useUi.setState({ selection: [frame.id] });
    act(() => void presentation.start());
    expect(isInteractionBlocked()).toBe(true);
    key('r');
    key('Delete');
    key('Backspace');
    expect(useUi.getState().tool).toBe('select');
    expect(useDoc.getState().doc!.pages[0]!.frames).toHaveLength(3);
    // F5 inside the presentation does not restart it from the first slide.
    key('ArrowRight');
    key('F5');
    expect(document.querySelector('[data-testid=presentation-counter]')!.textContent).toBe('2 / 3');
    act(() => presentation.stop());
    expect(isInteractionBlocked()).toBe(false);
    key('r');
    expect(useUi.getState().tool).toBe('rect');
  });

  it('F5 and Shift+F5 start from the first frame and from the selection', () => {
    const { getByTestId } = render(<Harness />);
    useUi.setState({ selection: [doc.pages[0]!.frames[1]!.id] });
    key('F5');
    expect(getByTestId('presentation-counter').textContent).toBe('1 / 3');
    act(() => presentation.stop());
    key('F5', { shiftKey: true });
    expect(getByTestId('presentation-counter').textContent).toBe('2 / 3');
  });

  it('desktop menu actions are ignored while presenting except the presentation ones', () => {
    render(<PresentationView />);
    act(() => void presentation.start());
    const frame = doc.pages[0]!.frames[0]!.id;
    useUi.setState({ selection: [frame] });
    act(() => runDesktopMenu('presentFromCurrent'));
    expect(presentation.getState().active).toBe(true);
    act(() => runDesktopMenu('presentFromStart'));
    expect(presentation.getState().index).toBe(0);
  });

  it('follows live edits: counter updates when a frame is removed', () => {
    const { getByTestId } = render(<PresentationView />);
    act(() => void presentation.start());
    const next = structuredClone(doc);
    next.pages[0]!.frames.pop();
    act(() => useDoc.setState({ doc: next, rawDoc: next }));
    expect(getByTestId('presentation-counter').textContent).toBe('1 / 2');
    const empty = structuredClone(next);
    empty.pages[0]!.frames = [];
    act(() => useDoc.setState({ doc: empty, rawDoc: empty }));
    expect(getByTestId('presentation-counter').textContent).toBe('0 / 0');
    expect(getByTestId('presentation-empty')).toBeTruthy();
  });

  it('hides the controls after a while without mouse movement and shows them on move', () => {
    vi.useFakeTimers();
    const { getByTestId } = render(<PresentationView />);
    act(() => void presentation.start());
    const root = getByTestId('presentation');
    expect(root.classList.contains('idle')).toBe(false);
    act(() => void vi.advanceTimersByTime(IDLE_MS + 50));
    expect(root.classList.contains('idle')).toBe(true);
    act(() => void fireEvent.mouseMove(window));
    expect(root.classList.contains('idle')).toBe(false);
  });
});
