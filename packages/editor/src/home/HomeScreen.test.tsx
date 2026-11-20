// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OpenDocumentInfo } from '@mockup/core';
import type { FileEntry } from '../client/api';
import { useDoc } from '../state/docStore';
import { clearFilesListCache } from './filesList';
import { HomeScreen } from './HomeScreen';
import { resetThumbnails } from './thumbnails';

function file(name: string, extra: Partial<FileEntry> = {}): FileEntry {
  return {
    path: `/p/${name}.mockup.json`,
    name,
    folder: null,
    tags: [],
    favorite: false,
    open: false,
    mtime: 1,
    size: 1,
    pages: 1,
    frames: 2,
    ...extra,
  };
}

const ALL = [
  file('alfa', { recent: 0, folder: 'Clients/Acme', tags: ['site'] }),
  file('beta', { recent: 1 }),
  file('gama', { folder: 'Personal', tags: ['idea'] }),
];

describe('HomeScreen', () => {
  let urls: string[];
  beforeEach(() => {
    urls = [];
    clearFilesListCache();
    resetThumbnails();
    useDoc.setState({ documents: [] });
    // no layout in happy-dom: thumbnails load right away
    vi.stubGlobal('IntersectionObserver', undefined);
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string) => {
        urls.push(url);
        const u = new URL(url, 'http://x');
        if (u.pathname === '/api/files/thumbnail') {
          return Promise.resolve(
            u.searchParams.get('path')?.includes('alfa')
              ? new Response('{"error":"no render"}', { status: 503 })
              : new Response(new Blob(['png'], { type: 'image/png' })),
          );
        }
        let files = ALL;
        const folder = u.searchParams.get('folder');
        const tag = u.searchParams.get('tag');
        if (folder) files = files.filter((f) => f.folder?.startsWith(folder));
        if (tag) files = files.filter((f) => f.tags.includes(tag));
        return Promise.resolve(
          new Response(
            JSON.stringify({
              files,
              folders: ['Clients/Acme', 'Personal'],
              tags: ['site', 'idea'],
            }),
          ),
        );
      }),
    );
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('shows recent files in order and the folders/tags', async () => {
    render(<HomeScreen />);
    await waitFor(() => expect(screen.getAllByTestId('file-card')).toHaveLength(2));
    expect(screen.getAllByTestId('file-card').map((c) => c.getAttribute('data-path'))).toEqual([
      '/p/alfa.mockup.json',
      '/p/beta.mockup.json',
    ]);
    expect(screen.getByTestId('home-folder-Clients')).toBeTruthy();
    expect(screen.getByTestId('home-folder-Clients/Acme')).toBeTruthy();
    expect(screen.getByTestId('home-tag-site')).toBeTruthy();
  });

  it('filters by folder and by tag by querying the server', async () => {
    render(<HomeScreen />);
    await screen.findAllByTestId('file-card');
    fireEvent.click(screen.getByTestId('home-folder-Personal'));
    await waitFor(() => expect(screen.getAllByTestId('file-card')).toHaveLength(1));
    expect(screen.getByTestId('file-card').getAttribute('data-path')).toBe('/p/gama.mockup.json');
    expect(urls.some((u) => u.includes('folder=Personal') && u.includes('recursive=1'))).toBe(true);
    fireEvent.click(screen.getByTestId('home-tag-site'));
    await waitFor(() =>
      expect(screen.getByTestId('file-card').getAttribute('data-path')).toBe('/p/alfa.mockup.json'),
    );
    expect(urls.some((u) => u.includes('tag=site'))).toBe(true);
  });

  it('search sends a query; thumbnails load through fetch', async () => {
    render(<HomeScreen />);
    await screen.findAllByTestId('file-card');
    await waitFor(() => expect(screen.getAllByRole('img').length).toBeGreaterThan(0));
    expect(urls.some((u) => u.startsWith('/api/files/thumbnail?path='))).toBe(true);
    expect(screen.getAllByRole('img')[0]!.getAttribute('src')).toMatch(/^blob:/);
    fireEvent.change(screen.getByTestId('home-search'), { target: { value: 'acme' } });
    await waitFor(() => expect(urls.some((u) => u.includes('query=acme'))).toBe(true));
  });

  it('thumbnail error falls back to the neutral card; favorite calls /meta', async () => {
    render(<HomeScreen />);
    const cards = await screen.findAllByTestId('file-card');
    // alfa's thumbnail answers 503
    await waitFor(() =>
      expect(cards[0]!.querySelector('[data-testid="file-thumb-fallback"]')).toBeTruthy(),
    );
    fireEvent.click(cards[1]!.querySelector('[data-testid="file-favorite"]')!);
    await waitFor(() =>
      expect(
        (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls.some(
          (c) => c[0] === '/api/files/meta',
        ),
      ).toBe(true),
    );
  });

  it('the list lands while the open documents keep changing', async () => {
    const info = (revision: number, dirty: boolean): OpenDocumentInfo =>
      ({
        docId: 'd1',
        name: 'Open',
        path: '/p/open.mockup.json',
        dirty,
        revision,
      }) as OpenDocumentInfo;
    useDoc.setState({ documents: [info(1, false)] });
    render(<HomeScreen />);
    // an agent edits and saves the open document all the time (every 50 ms)
    let rev = 1;
    const edits = setInterval(() => {
      rev++;
      act(() => useDoc.setState({ documents: [info(rev, rev % 2 === 0)] }));
    }, 50);
    try {
      await waitFor(() => expect(screen.getAllByTestId('file-card')).toHaveLength(2), {
        timeout: 2000,
      });
    } finally {
      clearInterval(edits);
    }
  });

  it('shows the last list at once when it mounts again, then refreshes', async () => {
    const first = render(<HomeScreen />);
    await waitFor(() => expect(screen.getAllByTestId('file-card')).toHaveLength(2));
    first.unmount();
    const before = urls.filter((u) => u.startsWith('/api/files?') || u === '/api/files').length;
    render(<HomeScreen />);
    // synchronously, before any response
    expect(screen.getAllByTestId('file-card')).toHaveLength(2);
    expect(screen.queryByTestId('home-loading')).toBeNull();
    await waitFor(() =>
      expect(urls.filter((u) => u.startsWith('/api/files?') || u === '/api/files').length).toBe(
        before + 1,
      ),
    );
  });

  it('a failed list shows an error with Retry instead of an empty screen', async () => {
    let fail = true;
    const ok = fetch as unknown as (url: string) => Promise<Response>;
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string) =>
        url.startsWith('/api/files') && !url.startsWith('/api/files/') && fail
          ? Promise.reject(new TypeError('Failed to fetch'))
          : ok(url),
      ),
    );
    render(<HomeScreen />);
    expect(screen.getByTestId('home-loading')).toBeTruthy();
    expect(await screen.findByTestId('home-error')).toBeTruthy();
    expect(screen.queryByTestId('home-loading')).toBeNull();
    fail = false;
    fireEvent.click(screen.getByTestId('home-retry'));
    await waitFor(() => expect(screen.getAllByTestId('file-card')).toHaveLength(2));
    expect(screen.queryByTestId('home-error')).toBeNull();
  });
});
