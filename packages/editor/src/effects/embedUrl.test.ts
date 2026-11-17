import { describe, expect, it } from 'vitest';
import { specFromUrl } from './embedUrl';

describe('specFromUrl', () => {
  it('youtube with start time', () => {
    expect(specFromUrl('https://youtu.be/dQw4w9WgXcQ?t=42')).toEqual({
      kind: 'embed',
      spec: {
        provider: 'youtube',
        url: 'https://youtu.be/dQw4w9WgXcQ?t=42',
        params: { start: 42 },
      },
    });
    expect(specFromUrl('https://www.youtube.com/watch?v=dQw4w9WgXcQ')).toEqual({
      kind: 'embed',
      spec: { provider: 'youtube', url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' },
    });
  });
  it('lottie, rive, video and iframe', () => {
    expect(specFromUrl('https://x.dev/a.json')).toEqual({
      kind: 'embed',
      spec: { provider: 'lottie', src: 'https://x.dev/a.json' },
    });
    expect(specFromUrl('https://x.dev/a.riv')?.kind).toBe('embed');
    expect(specFromUrl('https://x.dev/a.mp4')).toEqual({
      kind: 'video',
      src: 'https://x.dev/a.mp4',
    });
    expect(specFromUrl('https://example.com/page')).toEqual({
      kind: 'embed',
      spec: { provider: 'iframe', url: 'https://example.com/page' },
    });
  });
  it('rejects anything that is not http(s)', () => {
    expect(specFromUrl('')).toBeNull();
    expect(specFromUrl('assets/a.json')).toBeNull();
    expect(specFromUrl('javascript:alert(1)')).toBeNull();
  });
});
