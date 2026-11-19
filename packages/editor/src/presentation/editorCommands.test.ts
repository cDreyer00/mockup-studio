// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NO_PRESENTATION, createDocument, createNodeFromTag } from '@mockup/core';
import type { Document } from '@mockup/core';
import { useDoc } from '../state/docStore';
import { useUi } from '../state/uiStore';
import { ACTIVE_DOC_WAIT_MS, runEditorCommand } from './editorCommands';
import { presentation } from './presentationStore';

function deck(): Document {
  const doc = createDocument('Deck');
  for (const name of ['One', 'Two', 'Three']) {
    doc.pages[0]!.frames.push(
      createNodeFromTag('div', { isRoot: true, name, styles: { width: '100px' } }),
    );
  }
  return doc;
}

function load(doc: Document): void {
  useDoc.setState({ doc, rawDoc: doc, activeDocId: doc.id });
}

beforeEach(() => {
  useUi.setState({ selection: [], pageId: null, componentEdit: null, editingComponentId: null });
});
afterEach(() => {
  presentation.stop();
  useDoc.setState({ doc: null, rawDoc: null, activeDocId: null });
  vi.useRealTimers();
});

describe('runEditorCommand', () => {
  it('presentation:start presents the document and reports the state', async () => {
    const doc = deck();
    load(doc);
    const st = await runEditorCommand({ type: 'presentation:start', docId: doc.id });
    expect(st).toMatchObject({ active: true, docId: doc.id, index: 0, fullscreen: false });
    expect(st.slides.map((s) => s.name)).toEqual(['One', 'Two', 'Three']);
  });

  it('start honours frameId, restarts when already presenting', async () => {
    const doc = deck();
    load(doc);
    const [, two, three] = doc.pages[0]!.frames;
    await runEditorCommand({ type: 'presentation:start', docId: doc.id, frameId: two!.id });
    const st = await runEditorCommand({
      type: 'presentation:start',
      docId: doc.id,
      frameId: three!.id,
    });
    expect(st.index).toBe(2);
  });

  it('start uses the selection when there is no frameId', async () => {
    const doc = deck();
    load(doc);
    useUi.setState({ selection: [doc.pages[0]!.frames[1]!.id] });
    const st = await runEditorCommand({ type: 'presentation:start', docId: doc.id });
    expect(st.index).toBe(1);
  });

  it('start waits for the document to become active', async () => {
    const doc = deck();
    const pending = runEditorCommand({ type: 'presentation:start', docId: doc.id });
    await Promise.resolve();
    load(doc);
    expect((await pending).active).toBe(true);
  });

  it('start gives up when the document never becomes active', async () => {
    vi.useFakeTimers();
    const pending = runEditorCommand({ type: 'presentation:start', docId: 'ghost' });
    const assertion = expect(pending).rejects.toThrow(/not the active document/);
    await vi.advanceTimersByTimeAsync(ACTIVE_DOC_WAIT_MS + 10);
    await assertion;
  });

  it('start rejects with a clear message on an empty page', async () => {
    const doc = createDocument('Empty');
    load(doc);
    await expect(runEditorCommand({ type: 'presentation:start', docId: doc.id })).rejects.toThrow(
      'This page has no visible frames to present.',
    );
  });

  it('goto navigates and fails when nothing is running', async () => {
    const doc = deck();
    load(doc);
    await expect(runEditorCommand({ type: 'presentation:goto', step: 'next' })).rejects.toThrow(
      'No presentation is running.',
    );
    await runEditorCommand({ type: 'presentation:start', docId: doc.id });
    expect((await runEditorCommand({ type: 'presentation:goto', index: 2 })).index).toBe(2);
    expect((await runEditorCommand({ type: 'presentation:goto', step: 'first' })).index).toBe(0);
    const three = doc.pages[0]!.frames[2]!.id;
    expect((await runEditorCommand({ type: 'presentation:goto', frameId: three })).frameId).toBe(
      three,
    );
    await expect(runEditorCommand({ type: 'presentation:goto', frameId: 'nope' })).rejects.toThrow(
      /not a slide/,
    );
  });

  it('stop answers with the state before stopping, or NO_PRESENTATION when idle', async () => {
    const doc = deck();
    load(doc);
    expect(await runEditorCommand({ type: 'presentation:stop' })).toEqual(NO_PRESENTATION);
    await runEditorCommand({ type: 'presentation:start', docId: doc.id });
    const before = await runEditorCommand({ type: 'presentation:stop' });
    expect(before).toMatchObject({ active: true, docId: doc.id });
    expect(before.slides).toHaveLength(3);
    expect(presentation.getState().active).toBe(false);
  });
});
