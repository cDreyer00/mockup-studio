import { IframeView } from './IframeView';
import { LottieView } from './LottieView';
import { RiveView } from './RiveView';
import { ThreeNodeView } from './ThreeView';
import { YouTubeView } from './YouTubeView';
import { FX_INNER, fxRootStyle } from './types';
import type { FxViewProps } from './types';

/** `embed` node: dispatches to the provider's view. */
export function EmbedView(props: FxViewProps) {
  switch (props.node.embed?.provider) {
    case 'lottie':
      return <LottieView {...props} />;
    case 'rive':
      return <RiveView {...props} />;
    case 'youtube':
      return <YouTubeView {...props} />;
    case 'three':
      return <ThreeNodeView {...props} />;
    case 'iframe':
      return <IframeView {...props} />;
    default:
      return (
        <div data-node-id={props.node.id} style={fxRootStyle(props.style)}>
          <div style={FX_INNER} />
        </div>
      );
  }
}
