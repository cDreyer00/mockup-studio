import { useEffect } from 'react';
import { Canvas } from './canvas/Canvas';
import { RightDock } from './dock/RightDock';
import { useDesktop } from './desktop/useDesktop';
import { HomeScreen } from './home/HomeScreen';
import { useShortcuts } from './shortcuts/useShortcuts';
import { selectActiveInfo, useDoc } from './state/docStore';
import { ui, useUi } from './state/uiStore';
import { PresentationView } from './presentation/PresentationView';
import { LeftDock } from './tokens/LeftDock';
import { Toolbar } from './toolbar/Toolbar';
import { OverlayHost } from './ui/overlays';

/** File name (without folder) for the window title. */
function fileName(path: string | null | undefined): string | null {
  if (!path) return null;
  return path.split(/[/\\]/).pop() ?? path;
}

export function App() {
  const status = useDoc((s) => s.status);
  const hasDoc = useDoc((s) => !!s.doc);
  const info = useDoc(selectActiveInfo);
  const rightTab = useUi((s) => s.rightTab);
  const activeDocId = useDoc((s) => s.activeDocId);
  const homeOpen = useUi((s) => s.homeOpen);
  useShortcuts();
  useDesktop();

  useEffect(() => {
    const name = fileName(info?.path) ?? info?.name;
    document.title = name ? `${info?.dirty ? '● ' : ''}${name} — Mockup Studio` : 'Mockup Studio';
  }, [info?.path, info?.name, info?.dirty]);

  // When the active document changes or opens, the home screen gets out of the way.
  useEffect(() => {
    if (activeDocId) ui.setHome(false);
  }, [activeDocId]);

  const showHome = status === 'online' && (homeOpen || !hasDoc);

  return (
    <div className="app">
      <Toolbar />
      <div className={`main${rightTab === 'design' ? '' : ' right-wide'}`}>
        <LeftDock />
        {showHome ? (
          <HomeScreen />
        ) : hasDoc ? (
          <Canvas />
        ) : (
          <div className="canvas-empty">
            {status === 'offline'
              ? 'Daemon not found — run `npm run dev`'
              : status === 'connecting'
                ? 'Connecting to the daemon…'
                : 'No document open. Use File › Open or New, `mockup open <file>` or the MCP.'}
          </div>
        )}
        <RightDock />
      </div>
      <OverlayHost />
      <PresentationView />
    </div>
  );
}
