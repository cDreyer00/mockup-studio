import { useEffect } from 'react';
import { Canvas } from './canvas/Canvas';
import { LeftPanel } from './assets/LeftPanel';
import { HomeScreen } from './home/HomeScreen';
import { PropertiesPanel } from './properties/PropertiesPanel';
import { useDesktop } from './desktop/useDesktop';
import { useShortcuts } from './shortcuts/useShortcuts';
import { selectActiveInfo, useDoc } from './state/docStore';
import { ui, useUi } from './state/uiStore';
import { Toolbar } from './toolbar/Toolbar';
import { OverlayHost } from './ui/overlays';

/** Nome do arquivo (sem pasta) para o título da janela. */
function fileName(path: string | null | undefined): string | null {
  if (!path) return null;
  return path.split(/[/\\]/).pop() ?? path;
}

export function App() {
  const status = useDoc((s) => s.status);
  const hasDoc = useDoc((s) => !!s.doc);
  const info = useDoc(selectActiveInfo);
  const activeDocId = useDoc((s) => s.activeDocId);
  const homeOpen = useUi((s) => s.homeOpen);
  useShortcuts();
  useDesktop();

  useEffect(() => {
    const name = fileName(info?.path) ?? info?.name;
    document.title = name ? `${info?.dirty ? '● ' : ''}${name} — Mockup Studio` : 'Mockup Studio';
  }, [info?.path, info?.name, info?.dirty]);

  // Ao trocar/abrir o documento ativo, a tela inicial sai da frente.
  useEffect(() => {
    if (activeDocId) ui.setHome(false);
  }, [activeDocId]);

  const showHome = status === 'online' && (homeOpen || !hasDoc);

  return (
    <div className="app">
      <Toolbar />
      <div className="main">
        <LeftPanel />
        {showHome ? (
          <HomeScreen />
        ) : hasDoc ? (
          <Canvas />
        ) : (
          <div className="canvas-empty">
            {status === 'offline'
              ? 'Daemon não encontrado — rode `npm run dev`'
              : status === 'connecting'
                ? 'Conectando ao daemon…'
                : 'Nenhum documento aberto. Use Arquivo › Abrir ou Novo, `mockup open <arquivo>` ou o MCP.'}
          </div>
        )}
        <PropertiesPanel />
      </div>
      <OverlayHost />
    </div>
  );
}
