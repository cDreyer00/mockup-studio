/** Interpretação de URLs coladas no diálogo de embed. Lógica pura. */
import { detectEmbedProvider, youtubeId, youtubeStart } from '@mockup/core';
import type { EmbedSpec, MediaParamValue } from '@mockup/core';

/** Nome do provedor detectado, para exibir ao digitar. */
export const PROVIDER_LABELS: Record<string, string> = {
  youtube: 'YouTube',
  lottie: 'Lottie',
  rive: 'Rive',
  iframe: 'Iframe',
  video: 'Vídeo',
  three: 'Three.js',
};

/** Especificação de embed (ou vídeo) inferida de uma URL; `null` se não reconhecida. */
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
