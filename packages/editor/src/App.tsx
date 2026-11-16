import { useCallback, useEffect, useState } from 'react';
import { Canvas } from './Canvas';
import { useDaemon } from './ws';

const STATUS_LABEL = {
  connecting: 'Conectando…',
  online: 'Conectado',
  offline: 'Offline',
} as const;

export function App() {
  const { status, documents, activeDocId, doc, selection, send } = useDaemon();
  const [pageId, setPageId] = useState<string | null>(null);
  const [zoom, setZoom] = useState(1);

  // Página exibida: a escolhida, se ainda existir; senão a primeira.
  const page = doc?.pages.find((p) => p.id === pageId) ?? doc?.pages[0] ?? null;
  const active = documents.find((d) => d.docId === activeDocId);

  // Ao trocar de documento, volta para a primeira página.
  useEffect(() => setPageId(null), [activeDocId]);

  const onSelect = useCallback(
    (nodeIds: string[]) => {
      if (activeDocId) send({ type: 'selection:set', docId: activeDocId, nodeIds });
    },
    [activeDocId, send],
  );

  return (
    <div className="app">
      <header className="topbar">
        <span className="brand">Mockup Studio</span>
        <span className="doc">
          {doc?.name ?? '—'}
          {active?.dirty && (
            <span className="dirty" title="Alterações não salvas">
              ●
            </span>
          )}
        </span>
        <span className="status">
          <span className={`dot ${status}`} />
          {STATUS_LABEL[status]}
        </span>
        <span className="zoom">{Math.round(zoom * 100)}%</span>
      </header>
      <div className="main">
        <aside className="sidebar">
          <h3>Documentos</h3>
          {documents.map((d) => (
            <button
              key={d.docId}
              className={d.docId === activeDocId ? 'active' : ''}
              onClick={() => send({ type: 'active:set', docId: d.docId })}
            >
              {d.name}
              {d.dirty ? ' ●' : ''}
            </button>
          ))}
          <h3>Páginas</h3>
          {doc?.pages.map((p) => (
            <button
              key={p.id}
              className={p.id === page?.id ? 'active' : ''}
              onClick={() => setPageId(p.id)}
            >
              {p.name}
            </button>
          ))}
        </aside>
        {doc && page ? (
          <Canvas
            doc={doc}
            page={page}
            selection={selection}
            onSelect={onSelect}
            onZoomChange={setZoom}
          />
        ) : (
          <div className="canvas-empty">
            {status === 'offline'
              ? 'Daemon não encontrado em 127.0.0.1:4747 — rode `npm run dev`'
              : status === 'connecting'
                ? 'Conectando ao daemon…'
                : 'Nenhum documento aberto. Use `mockup open <arquivo>` ou o MCP (`open_document`)'}
          </div>
        )}
      </div>
    </div>
  );
}
