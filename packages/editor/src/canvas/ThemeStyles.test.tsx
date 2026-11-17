// @vitest-environment happy-dom
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { createDocument, createNodeFromTag } from '@mockup/core';
import type { Document } from '@mockup/core';
import { RenderApp, renderFrameOf } from '../render/RenderApp';
import { useDoc } from '../state/docStore';
import { Canvas } from './Canvas';
import { ThemeStyles } from './ThemeStyles';

function themed(): Document {
  const doc = createDocument('Tema');
  doc.tokens = { '--bg': '#ffffff' };
  doc.themes = [{ name: 'dark', overrides: { '--bg': '#111111' } }];
  const frame = createNodeFromTag('div', {
    isRoot: true,
    name: 'Escuro',
    attrs: { 'data-theme': 'dark' },
    styles: { background: 'var(--bg)', width: '100px', height: '100px' },
    position: { x: 0, y: 0 },
  });
  doc.pages[0]!.frames.push(frame);
  return doc;
}

afterEach(() => {
  cleanup();
  useDoc.setState({ doc: null, activeDocId: null });
});

describe('ThemeStyles', () => {
  it('generates the theme rule scoped to the canvas world', () => {
    const doc = themed();
    const { getByTestId } = render(<ThemeStyles tokens={doc.tokens} themes={doc.themes} />);
    const css = getByTestId('theme-styles').textContent ?? '';
    expect(css).toContain('.cv-world [data-theme="dark"]');
    expect(css).toContain('--bg: #111111;');
  });

  it('without themes renders nothing', () => {
    const { container } = render(<ThemeStyles tokens={{ '--a': '1' }} themes={undefined} />);
    expect(container.querySelector('style')).toBeNull();
  });

  it('the canvas injects the rule and the frame gets data-theme', () => {
    const doc = themed();
    useDoc.setState({ doc, activeDocId: doc.id });
    const { getByTestId } = render(<Canvas />);
    const frameEl = getByTestId('canvas-world').querySelector('[data-node-id]')!;
    expect(frameEl.getAttribute('data-theme')).toBe('dark');
    expect(getByTestId('theme-styles').textContent).toContain('.cv-world [data-theme="dark"]');
  });

  it('the render page also injects the rule', () => {
    const doc = themed();
    const frame = doc.pages[0]!.frames[0]!;
    const { getByTestId, container } = render(
      <RenderApp doc={doc} docId={doc.id} frame={renderFrameOf(frame)} />,
    );
    expect(getByTestId('theme-styles').textContent).toContain('[data-theme="dark"]');
    expect(container.querySelector('.cv-world [data-theme="dark"]')).not.toBeNull();
  });
});
