import { Component, memo, useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import type { Node } from '@mockup/core';
import { useDoc } from '../state/docStore';
import { useUi } from '../state/uiStore';
import { frameSize } from '../model/tree';
import { NodeView } from './NodeView';

/** Window in which the "AI" badge stays visible after the agent's last op on the frame. */
export const AGENT_BADGE_MS = 4000;

/** Isolates render failures of a frame; retries when the frame changes. */
class FrameBoundary extends Component<
  { frame: Node; fallback: (error: Error) => ReactNode; children: ReactNode },
  { error: Error | null; frame: Node }
> {
  override state: { error: Error | null; frame: Node } = { error: null, frame: this.props.frame };

  static getDerivedStateFromError(error: unknown): { error: Error } {
    return { error: error instanceof Error ? error : new Error(String(error)) };
  }

  static getDerivedStateFromProps(
    props: { frame: Node },
    state: { error: Error | null; frame: Node },
  ): { error: Error | null; frame: Node } | null {
    return props.frame !== state.frame ? { error: null, frame: props.frame } : null;
  }

  override render(): ReactNode {
    return this.state.error ? this.props.fallback(this.state.error) : this.props.children;
  }
}

/** Pulsing dot + "AI" while the agent touched the frame less than 4 s ago. */
function AgentBadge({ frameId }: { frameId: string }) {
  const at = useDoc((s) => s.agentActivity[frameId]);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (at === undefined) return;
    const left = AGENT_BADGE_MS - (Date.now() - at);
    setNow(Date.now());
    if (left <= 0) return;
    const t = setTimeout(() => setNow(Date.now()), left + 20);
    return () => clearTimeout(t);
  }, [at]);
  if (at === undefined || now - at >= AGENT_BADGE_MS) return null;
  return (
    <span className="cv-agent-badge" data-testid={`agent-badge-${frameId}`}>
      <i className="cv-agent-dot" />
      AI
    </span>
  );
}

/** Frame name above it (inverse zoom scale via `--z`); click selects, drag moves. */
function FrameLabel({ frame }: { frame: Node }) {
  const preview = useUi((s) => s.preview[frame.id]);
  const pos = preview?.position ?? frame.position;
  return (
    <div
      className="cv-frame-label"
      data-frame-label={frame.id}
      data-testid={`frame-label-${frame.id}`}
      style={{ left: pos?.x ?? 0, top: pos?.y ?? 0 }}
    >
      <span className="cv-frame-name">{frame.name}</span>
      <AgentBadge frameId={frame.id} />
    </div>
  );
}

/** Root frame: label + node positioned on the canvas. */
export const FrameView = memo(function FrameView({ frame }: { frame: Node }) {
  if (frame.hidden) return null;
  const { w, h } = frameSize(frame);
  const x = frame.position?.x ?? 0;
  const y = frame.position?.y ?? 0;
  return (
    <>
      <FrameLabel frame={frame} />
      <FrameBoundary
        frame={frame}
        fallback={(error) => (
          <div
            className="cv-frame-error"
            style={{ left: x, top: y, width: w, height: h }}
            data-node-id={frame.id}
          >
            Failed to render this frame: {error.message}
          </div>
        )}
      >
        <NodeView node={frame} root />
      </FrameBoundary>
    </>
  );
});
