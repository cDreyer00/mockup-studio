import { useEffect, useRef } from 'react';
import { resolveSrc } from '../canvas/render-utils';
import { useFxClock } from './clock';
import { fxBegin, fxOnce, fxRenderInfo } from './ready';
import { FX_INNER, fxRootStyle } from './types';
import type { FxViewProps } from './types';

const SEEK_TIMEOUT_MS = 5000;

/** `video` node on the canvas. */
export function VideoView({ node, style, docId }: FxViewProps) {
  const spec = node.video;
  const ref = useRef<HTMLVideoElement>(null);
  const posterDone = useRef<(() => void) | null>(null);
  const manual = useFxClock((s) => s.manual);
  const playing = useFxClock((s) => s.playing);
  const src = spec?.src ? resolveSrc(docId, spec.src) : undefined;
  const poster = spec?.poster ? resolveSrc(docId, spec.poster) : undefined;
  const fit = style.objectFit ?? 'cover';
  // Render page without an explicit time and with a poster: shows the poster (without downloading the video).
  const posterOnly = manual !== null && !fxRenderInfo.explicitTime && !!poster;

  // Editor: plays/pauses according to the clock and `autoplay`.
  useEffect(() => {
    const v = ref.current;
    if (!v || manual !== null || posterOnly) return;
    if (playing && spec?.autoplay) void v.play().catch(() => {});
    else v.pause();
  }, [manual, playing, spec?.autoplay, posterOnly, src]);

  // Render page: positions the frame and waits for the seek.
  useEffect(() => {
    const v = ref.current;
    if (!v || manual === null || posterOnly || !src) return;
    const done = fxBegin();
    let cancelled = false;
    void (async () => {
      try {
        if (v.readyState < 1) await fxOnce(v, ['loadedmetadata', 'error'], SEEK_TIMEOUT_MS);
        if (cancelled || v.readyState < 1) return;
        let t = fxRenderInfo.explicitTime ? manual : (spec?.time ?? manual);
        if (Number.isFinite(v.duration) && v.duration > 0) {
          t = spec?.loop ? t % v.duration : Math.min(t, v.duration);
        }
        if (Math.abs(v.currentTime - t) > 0.001) {
          const seeked = fxOnce(v, ['seeked', 'error'], SEEK_TIMEOUT_MS);
          v.currentTime = t;
          await seeked;
        }
        const rvfc = (
          v as HTMLVideoElement & {
            requestVideoFrameCallback?: (cb: () => void) => number;
          }
        ).requestVideoFrameCallback;
        if (rvfc && !cancelled) {
          await new Promise<void>((r) => {
            const timer = setTimeout(r, 1000);
            rvfc.call(v, () => {
              clearTimeout(timer);
              r();
            });
          });
        }
      } finally {
        done();
      }
    })();
    return () => {
      cancelled = true;
      done();
    };
  }, [manual, posterOnly, src, spec?.time, spec?.loop]);

  // Poster of a video in manual time: the image must load before capturing.
  useEffect(() => {
    if (!posterOnly) return;
    const done = fxBegin(SEEK_TIMEOUT_MS);
    posterDone.current = done;
    return () => {
      posterDone.current = null;
      done();
    };
  }, [posterOnly, poster]);

  return (
    <div data-node-id={node.id} style={fxRootStyle(style)}>
      {posterOnly ? (
        <img
          src={poster}
          alt=""
          draggable={false}
          style={{ ...FX_INNER, objectFit: fit }}
          onLoad={() => posterDone.current?.()}
          onError={() => posterDone.current?.()}
        />
      ) : (
        <video
          ref={ref}
          src={src}
          poster={poster}
          muted
          loop={!!spec?.loop}
          playsInline
          controls={!!spec?.controls}
          preload={manual !== null ? 'auto' : 'metadata'}
          style={{ ...FX_INNER, objectFit: fit }}
        />
      )}
    </div>
  );
}
