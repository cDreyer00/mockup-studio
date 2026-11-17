// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useDoc } from '../state/docStore';
import { useUi } from '../state/uiStore';
import { makeDoc } from '../test/fixtures';
import { ImportUrlDialog, NO_RENDER_MESSAGE, validateImportUrl } from './ImportUrlButton';

const fetchMock = vi.fn();

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockReset();
  useDoc.setState({ doc: makeDoc().doc, activeDocId: 'doc-1' });
  useUi.setState({ selection: [], toast: null, focusRequest: null });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  useDoc.setState({ doc: null, activeDocId: null });
});

const type = (label: string | RegExp, value: string) =>
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
const submit = () => fireEvent.click(screen.getByRole('button', { name: 'Import' }));

describe('validateImportUrl', () => {
  it('accepts only http(s)', () => {
    expect(validateImportUrl('')).toBeTruthy();
    expect(validateImportUrl('ftp://a.com')).toBeTruthy();
    expect(validateImportUrl('not a url')).toBeTruthy();
    expect(validateImportUrl('https://a.com')).toBeNull();
    expect(validateImportUrl(' http://localhost:3000 ')).toBeNull();
  });
});

describe('ImportUrlDialog', () => {
  it('invalid URL shows an error and does not call the daemon', async () => {
    render(<ImportUrlDialog onClose={() => undefined} />);
    type('URL', 'ftp://x');
    submit();
    expect((await screen.findByRole('alert')).textContent).toContain('http');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('width outside the shared limits shows an error and does not call the daemon', async () => {
    render(<ImportUrlDialog onClose={() => undefined} />);
    type('URL', 'https://example.com');
    for (const w of ['250', '4000', 'abc']) {
      type('Viewport width', w);
      submit();
      expect((await screen.findByRole('alert')).textContent).toBe(
        'Viewport width between 320 and 3840',
      );
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('503 shows the render engine message', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 503,
      json: async () => ({ error: 'no render' }),
    });
    render(<ImportUrlDialog onClose={() => undefined} />);
    type('URL', 'https://example.com');
    submit();
    expect((await screen.findByRole('alert')).textContent).toBe(NO_RENDER_MESSAGE);
  });

  it('other errors show the daemon message', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 502,
      json: async () => ({ error: 'page timeout' }),
    });
    render(<ImportUrlDialog onClose={() => undefined} />);
    type('URL', 'https://example.com');
    submit();
    expect((await screen.findByRole('alert')).textContent).toBe('page timeout');
  });

  it('success: sends the right body, disables while sending, selects and closes', async () => {
    const frameId = useDoc.getState().doc!.pages[0]!.frames[0]!.id;
    let resolve!: (v: unknown) => void;
    fetchMock.mockReturnValue(new Promise((r) => (resolve = r)));
    const onClose = vi.fn();
    render(<ImportUrlDialog onClose={onClose} />);
    type('URL', 'https://example.com');
    type(/CSS selector/, '.hero');
    type('Viewport width', '1280');
    fireEvent.click(screen.getByLabelText('Attach reference image'));
    submit();
    const busy = await screen.findByRole('button', { name: 'Importing…' });
    expect((busy as HTMLButtonElement).disabled).toBe(true);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/import/url');
    expect(JSON.parse(init.body as string)).toMatchObject({
      url: 'https://example.com',
      selector: '.hero',
      viewport: { width: 1280 },
      reference: false,
      docId: 'doc-1',
    });
    resolve({ ok: true, status: 200, json: async () => ({ frameId, nodes: 7, warnings: [] }) });
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(useUi.getState().selection).toEqual([frameId]);
    expect(useUi.getState().focusRequest?.nodeIds).toEqual([frameId]);
    expect(useUi.getState().toast?.text).toBe('Section imported (7 nodes)');
  });
});
