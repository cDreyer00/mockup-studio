import { useEffect } from 'react';
import { Canvas } from './canvas/Canvas';
import { LayersPanel } from './layers/LayersPanel';
import { PropertiesPanel } from './properties/PropertiesPanel';
import { useDesktop } from './desktop/useDesktop';
import { useShortcuts } from './shortcuts/useShortcuts';
import { selectActiveInfo, useDoc } from './state/docStore';
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
  useShortcuts();
  useDesktop();

  useEffect(() => {
    const name = fileName(info?.path) ?? info?.name;
    document.title = name ? `${info?.dirty ? '● ' : ''}${name} — Mockup Studio` : 'Mockup Studio';
  }, [info?.path, info?.name, info?.dirty]);

  return (
    <div className="app">
      <Toolbar />
      <div className="main">
        <LayersPanel />
        {hasDoc ? (
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
