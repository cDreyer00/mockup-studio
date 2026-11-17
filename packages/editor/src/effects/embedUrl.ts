/** Interpretation of URLs pasted into the embed dialog. Pure logic. */
import { detectEmbedProvider, youtubeId, youtubeStart } from '@mockup/core';
import type { EmbedSpec, MediaParamValue } from '@mockup/core';

/** Name of the detected provider, shown while typing. */
export const PROVIDER_LABELS: Record<string, string> = {
  youtube: 'YouTube',
  lottie: 'Lottie',
  rive: 'Rive',
  iframe: 'Iframe',
  video: 'Video',
  three: 'Three.js',
};

/** Embed (or video) spec inferred from a URL; `null` if not recognized. */
export function specFromUrl(
  url: string,
): { kind: 'video'; src: string } | { kind: 'embed'; spec: EmbedSpec } | null {
  const u = url.trim();
  const provider = detectEmbedProvider(u);
  if (!provider || !/^https?:\/\//i.test(u)) return null;
  if (provider === 'video') return { kind: 'video', src: u };
  if (provider === 'youtube') {
    if (!youtubeId(u)) return null;
    const start = youtubeStart(u);
    const params: Record<string, MediaParamValue> = start ? { start } : {};
    return {
      kind: 'embed',
      spec: { provider, url: u, ...(Object.keys(params).length ? { params } : {}) },
    };
  }
  if (provider === 'iframe') return { kind: 'embed', spec: { provider, url: u } };
  if (provider === 'three') return null;
  return { kind: 'embed', spec: { provider, src: u } };
}
