import { useEffect, useState } from 'react';
import type { CSSProperties } from 'react';
import { youtubeEmbedUrl, youtubeId, youtubeStart } from '@mockup/core';
import { useFxClock } from './clock';
import { fxBegin } from './ready';
import { FX_INNER, fxRootStyle } from './types';
import type { FxViewProps } from './types';

const THUMB_TIMEOUT_MS = 5000;

const placeholder: CSSProperties = {
  ...FX_INNER,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  background: '#15171c',
  color: '#8b909a',
  font: '600 14px system-ui, sans-serif',
};

/** Play button drawn in CSS (red rounded rectangle with a triangle). */
function PlayButton() {
  return (
    <span
      aria-hidden
      style={{
        position: 'absolute',
        left: '50%',
        top: '50%',
        width: 68,
        height: 48,
        marginLeft: -34,
        marginTop: -24,
        borderRadius: 14,
        background: 'rgba(230,30,30,.92)',
        pointerEvents: 'none',
      }}
    >
      <span
        style={{
          position: 'absolute',
          left: 26,
          top: 14,
          borderStyle: 'solid',
          borderWidth: '10px 0 10px 18px',
          borderColor: 'transparent transparent transparent #fff',
        }}
      />
    </span>
  );
}

/** `youtube` embed: iframe in the editor; thumbnail + play button on the render page (no live network). */
export function YouTubeView({ node, style }: FxViewProps) {
  const e = node.embed;
  const id = e?.url ? youtubeId(e.url) : null;
  const manual = useFxClock((s) => s.manual);
  const [thumbFailed, setThumbFailed] = useState(false);
  const thumb = id ? `https://i.ytimg.com/vi/${id}/hqdefault.jpg` : '';
  const renderMode = manual !== null;

  useEffect(() => {
    setThumbFailed(false);
    if (!renderMode || !id) return;
    // Safeguard: ready within 5 s, even if the image never responds.
    const done = fxBegin(THUMB_TIMEOUT_MS);
    const img = new Image();
    const timer = setTimeout(() => {
      setThumbFailed(true);
      done();
    }, THUMB_TIMEOUT_MS - 200);
    img.onload = () => {
      clearTimeout(timer);
      done();
    };
    img.onerror = () => {
      clearTimeout(timer);
      setThumbFailed(true);
      done();
    };
    img.src = thumb;
    return () => {
      clearTimeout(timer);
      img.onload = img.onerror = null;
      done();
    };
  }, [renderMode, id, thumb]);

  let content;
  if (!id) {
    content = <div style={placeholder}>YouTube</div>;
  } else if (renderMode) {
    content = thumbFailed ? (
      <div style={placeholder}>YouTube</div>
    ) : (
      <>
        <img src={thumb} alt="" draggable={false} style={{ ...FX_INNER, objectFit: 'cover' }} />
        <PlayButton />
      </>
    );
  } else {
    const p = e?.params;
    const src = youtubeEmbedUrl(id, {
      start: e?.url ? youtubeStart(e.url) : undefined,
      autoplay: p?.autoplay === true,
      loop: p?.loop === true,
      muted: p?.muted === true,
      controls: p?.controls !== false,
    });
    content = (
      <iframe
        src={src}
        title="YouTube"
        loading="lazy"
        referrerPolicy="strict-origin-when-cross-origin"
        allow="autoplay; encrypted-media; picture-in-picture; fullscreen"
        style={FX_INNER}
      />
    );
  }

  return (
    <div
      data-node-id={node.id}
      style={{ ...fxRootStyle(style), position: style.position ?? 'relative' }}
    >
      {content}
    </div>
  );
}
