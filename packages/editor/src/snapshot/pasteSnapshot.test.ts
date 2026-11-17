// @vitest-environment happy-dom
import { encodeClipboard } from '@mockup/snapshot-core';
import type { SnapshotPayload } from '@mockup/snapshot-core';
import { createNodeFromTag } from '@mockup/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { classifyPaste } from '../clipboard/paste';
import { canvasApi, registerCanvasApi } from '../canvas/canvasApi';
import { useDoc } from '../state/docStore';
import { useUi } from '../state/uiStore';
import { makeDoc } from '../test/fixtures';
import { importToastText, pasteSnapshot } from './pasteSnapshot';

function payload(): SnapshotPayload {
  return {
    format: 'mockup-snapshot',
    version: 1,
    source: {
      url: 'https://example.com',
      title: 'Example',
      capturedAt: '2026-01-01T00:00:00.000Z',
      viewport: { width: 1440, height: 900 },
      devicePixelRatio: 1,
    },
    root: createNodeFromTag('div', { name: 'Root' }),
    width: 400,
    height: 200,
    assets: [],
    fonts: [],
    stats: { nodes: 1, truncated: false, warnings: [] },
  };
}

describe('classifyPaste', () => {
  it('recognizes a snapshot in text/plain, before images and HTML', () => {
    const text = encodeClipboard(payload());
    expect(classifyPaste({ html: '', text, imageCount: 0 }, null)).toBe('snapshot');
    expect(classifyPaste({ html: '<div>x</div>', text, imageCount: 1 }, null)).toBe('snapshot');
    expect(classifyPaste({ html: '', text: '{"a":1}', imageCount: 0 }, null)).toBe('text');
  });
});

describe('importToastText', () => {
  it('warns when there are warnings', () => {
    expect(importToastText({ nodes: 5, warnings: [] })).toBe('Section imported (5 nodes)');
    expect(importToastText({ nodes: 5, warnings: ['a', 'b'] })).toBe(
      'Section imported (5 nodes). Warning: a (+1)',
    );
  });
});

describe('pasteSnapshot', () => {
  const fetchMock = vi.fn();
  let unregister: () => void;
  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock);
    const { doc, frame } = makeDoc();
    useDoc.setState({ doc, activeDocId: 'doc-1' });
    useUi.setState({ selection: [], toast: null, pageId: null });
    unregister = registerCanvasApi({
      ...canvasApi,
      viewportCenter: () => ({ x: 1000, y: 500 }),
    });
    fetchMock.mockReset();
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ frameId: frame.id, nodes: 12, warnings: [] }),
    });
  });
  afterEach(() => {
    unregister();
    vi.unstubAllGlobals();
    useDoc.setState({ doc: null, activeDocId: null });
    useUi.setState({ selection: [], toast: null });
  });

  it('sends the payload centered in the viewport and selects the frame', async () => {
    const p = payload();
    await pasteSnapshot(encodeClipboard(p));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/snapshot');
    const body = JSON.parse(init.body as string);
    expect(body.docId).toBe('doc-1');
    expect(body.pageId).toBe(useDoc.getState().doc!.pages[0]!.id);
    expect(body.x).toBe(800);
    expect(body.y).toBe(400);
    expect(body.payload.root.name).toBe('Root');
    expect(useUi.getState().selection).toEqual([useDoc.getState().doc!.pages[0]!.frames[0]!.id]);
    expect(useUi.getState().toast?.text).toBe('Section imported (12 nodes)');
  });

  it('shows the daemon message on error', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 400,
      json: async () => ({ error: 'bad payload' }),
    });
    await pasteSnapshot(encodeClipboard(payload()));
    expect(useUi.getState().toast).toMatchObject({ text: 'bad payload', kind: 'error' });
    expect(useUi.getState().selection).toEqual([]);
  });
});
