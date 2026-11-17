/** Barra de ferramentas: arquivo, ferramentas, desfazer/refazer, documento, zoom e conexão. */
import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import {
  ChevronDown,
  Clapperboard,
  Frame,
  Hand,
  Image as ImageIcon,
  MousePointer2,
  Pause,
  Play,
  Redo2,
  Square,
  Type,
  Undo2,
} from 'lucide-react';
import { actions } from '../actions';
import { daemon } from '../client/daemon';
import {
  closeActiveDocument,
  fileNameOf,
  newDocument,
  openDocument,
  saveDocumentAs,
} from '../desktop/fileFlows';
import { canvasApi } from '../canvas/canvasApi';
import { EffectsButton } from '../effects/EffectsPanel';
import { MediaDialogsHost } from '../effects/MediaDialogs';
import {
  insertThreeIsland,
  pickAndInsertLottieRive,
  pickAndInsertVideo,
} from '../effects/mediaFlows';
import { mediaDialogs } from '../effects/mediaStore';
import { fxClock, useFxClock } from '../fx/clock';
import { selectActiveInfo, useDoc } from '../state/docStore';
import type { ConnectionStatus } from '../state/docStore';
import { ui, useUi } from '../state/uiStore';
import type { Tool } from '../state/uiStore';
import { IconButton } from '../ui/controls';
import './toolbar.css';

const ICON = 16;

const TOOLS: { tool: Tool; title: string; key: string; icon: ReactNode }[] = [
  { tool: 'select', title: 'Mover', key: 'V', icon: <MousePointer2 size={ICON} /> },
  { tool: 'hand', title: 'Mão', key: 'H', icon: <Hand size={ICON} /> },
  { tool: 'frame', title: 'Frame', key: 'F', icon: <Frame size={ICON} /> },
  { tool: 'rect', title: 'Container', key: 'R', icon: <Square size={ICON} /> },
  { tool: 'text', title: 'Texto', key: 'T', icon: <Type size={ICON} /> },
  { tool: 'image', title: 'Imagem', key: 'Ctrl+Shift+K', icon: <ImageIcon size={ICON} /> },
];

const STATUS_TEXT: Record<ConnectionStatus, string> = {
  online: 'Conectado',
  connecting: 'Conectando…',
  offline: 'Offline',
};

function reportError(e: unknown): void {
  ui.toast(e instanceof Error ? e.message : String(e), 'error');
}

/* ---------------- dropdown ---------------- */

interface DropItem {
  label: string;
  testId: string;
  shortcut?: string;
  disabled?: boolean;
  separator?: boolean;
  onSelect: () => void;
}

function Dropdown({
  testId,
  trigger,
  items,
  onOpen,
  title,
  className,
}: {
  testId: string;
  trigger: ReactNode;
  items: DropItem[];
  onOpen?: () => void;
  title?: string;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as globalThis.Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    window.addEventListener('pointerdown', onDown, true);
    window.addEventListener('keydown', onKey, true);
    const onBlur = () => setOpen(false);
    window.addEventListener('blur', onBlur);
    return () => {
      window.removeEventListener('pointerdown', onDown, true);
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('blur', onBlur);
    };
  }, [open]);
  return (
    <div className="tb-dd" ref={ref}>
      <button
        type="button"
        className={`tb-dd-trigger${open ? ' open' : ''}${className ? ` ${className}` : ''}`}
        data-testid={testId}
        title={title}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => {
          if (!open) onOpen?.();
          setOpen(!open);
        }}
      >
        {trigger}
      </button>
      {open && (
        <div className="tb-dd-panel" role="menu">
          {items.map((item) => (
            <div key={item.testId}>
              {item.separator && <div className="tb-dd-sep" />}
              <button
                type="button"
                role="menuitem"
                className="tb-dd-item"
                data-testid={item.testId}
                disabled={item.disabled}
                onClick={() => {
                  setOpen(false);
                  item.onSelect();
                }}
              >
                <span className="tb-dd-label">{item.label}</span>
                {item.shortcut && <span className="tb-dd-shortcut">{item.shortcut}</span>}
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/* ---------------- arquivo ---------------- */

function Logo() {
  return (
    <svg className="tb-logo" width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
      <rect x="1.5" y="1.5" width="9" height="9" rx="2" fill="none" stroke="currentColor" />
      <rect x="7.5" y="7.5" width="9" height="9" rx="2" fill="var(--accent)" opacity="0.9" />
    </svg>
  );
}

function FileMenu() {
  const [recent, setRecent] = useState<string[]>([]);
  const activeDocId = useDoc((s) => s.activeDocId);
  const items: DropItem[] = [
    { label: 'Novo…', testId: 'file-new', onSelect: () => void newDocument() },
    { label: 'Abrir…', testId: 'file-open', onSelect: () => void openDocument() },
    ...recent.slice(0, 8).map<DropItem>((path, i) => ({
      label: fileNameOf(path) || path,
      testId: `file-recent-${i}`,
      separator: i === 0,
      onSelect: () => void openDocument(path),
    })),
    {
      label: 'Salvar',
      testId: 'file-save',
      shortcut: 'Ctrl+S',
      disabled: !activeDocId,
      separator: true,
      onSelect: () => void actions.save(),
    },
    {
      label: 'Salvar como…',
      testId: 'file-save-as',
      shortcut: 'Ctrl+Shift+S',
      disabled: !activeDocId,
      onSelect: () => void saveDocumentAs(),
    },
    {
      label: 'Fechar documento',
      testId: 'file-close',
      disabled: !activeDocId,
      onSelect: () => void closeActiveDocument(),
    },
  ];
  return (
    <Dropdown
      testId="menu-file"
      title="Arquivo"
      items={items}
      onOpen={() => void daemon.recent().then(setRecent, () => setRecent([]))}
      trigger={
        <>
          <span>Arquivo</span>
          <ChevronDown size={12} />
        </>
      }
    />
  );
}

/* ---------------- documento (centro) ---------------- */

function DocumentTitle() {
  const info = useDoc(selectActiveInfo);
  const documents = useDoc((s) => s.documents);
  if (!info) return <div className="tb-doc tb-doc-empty">Sem documento</div>;
  const file = fileNameOf(info.path);
  return (
    <div className="tb-doc" data-testid="doc-title">
      {documents.length > 1 ? (
        <select
          className="tb-doc-select"
          data-testid="doc-switcher"
          value={info.docId}
          onChange={(e) => void daemon.setActive(e.target.value).catch(reportError)}
        >
          {documents.map((d) => (
            <option key={d.docId} value={d.docId}>
              {d.dirty ? '• ' : ''}
              {d.name}
            </option>
          ))}
        </select>
      ) : (
        <span className="tb-doc-name">{info.name}</span>
      )}
      {file && file !== info.name && (
        <span className="tb-doc-file" title={info.path ?? undefined}>
          {file}
        </span>
      )}
      {info.dirty && (
        <span className="tb-dirty" data-testid="dirty-indicator" title="Alterações não salvas" />
      )}
    </div>
  );
}

/* ---------------- zoom ---------------- */

function ZoomMenu() {
  const z = useUi((s) => s.viewport.z);
  const items: DropItem[] = [
    { label: 'Aproximar', testId: 'zoom-in', shortcut: '+', onSelect: () => canvasApi.zoomIn() },
    { label: 'Afastar', testId: 'zoom-out', shortcut: '−', onSelect: () => canvasApi.zoomOut() },
    {
      label: 'Zoom 100%',
      testId: 'zoom-100',
      shortcut: 'Shift+0',
      separator: true,
      onSelect: () => canvasApi.zoomTo(1),
    },
    {
      label: 'Ajustar tudo',
      testId: 'zoom-fit',
      shortcut: 'Shift+1',
      onSelect: () => canvasApi.fitAll(),
    },
    {
      label: 'Zoom na seleção',
      testId: 'zoom-selection',
      shortcut: 'Shift+2',
      onSelect: () => canvasApi.fitNodes(),
    },
  ];
  return (
    <Dropdown
      testId="zoom-menu"
      title="Zoom"
      items={items}
      className="tb-zoom"
      trigger={
        <>
          <span>{Math.round(z * 100)}%</span>
          <ChevronDown size={12} />
        </>
      }
    />
  );
}

/* ---------------- mídia e animações ---------------- */

function MediaMenu() {
  const items: DropItem[] = [
    { label: 'Inserir vídeo…', testId: 'media-video', onSelect: () => void pickAndInsertVideo() },
    {
      label: 'Inserir Lottie/Rive de arquivo…',
      testId: 'media-lottie-rive',
      onSelect: () => void pickAndInsertLottieRive(),
    },
    { label: 'Embed por URL…', testId: 'media-embed-url', onSelect: mediaDialogs.openEmbedUrl },
    {
      label: 'Ilha Three.js',
      testId: 'media-three',
      separator: true,
      onSelect: () => void insertThreeIsland(),
    },
  ];
  return (
    <Dropdown
      testId="media-button"
      title="Mídia"
      items={items}
      trigger={<Clapperboard size={ICON} />}
    />
  );
}

function PlayToggle() {
  const playing = useFxClock((s) => s.playing);
  const title = playing ? 'Pausar animações' : 'Tocar animações';
  return (
    <IconButton
      title={`${title} (Shift+Espaço)`}
      active={!playing}
      data-testid="fx-play-toggle"
      data-playing={playing}
      onClick={() => fxClock.toggle()}
    >
      {playing ? <Pause size={ICON} /> : <Play size={ICON} />}
    </IconButton>
  );
}

/* ---------------- barra ---------------- */

export function Toolbar() {
  const tool = useUi((s) => s.tool);
  const canUndo = useDoc((s) => s.history.canUndo);
  const canRedo = useDoc((s) => s.history.canRedo);
  const status = useDoc((s) => s.status);

  return (
    <header className="toolbar" data-testid="toolbar">
      <div className="tb-brand">
        <Logo />
        <span>Mockup Studio</span>
      </div>
      <FileMenu />
      <span className="tb-sep" />
      <div className="tb-group" role="toolbar" aria-label="Ferramentas">
        {TOOLS.map((t) => (
          <IconButton
            key={t.tool}
            title={`${t.title} (${t.key})`}
            active={tool === t.tool}
            data-testid={`tool-${t.tool}`}
            onClick={() => ui.setTool(t.tool)}
          >
            {t.icon}
          </IconButton>
        ))}
      </div>
      <span className="tb-sep" />
      <div className="tb-group" role="toolbar" aria-label="Efeitos e mídia">
        <EffectsButton />
        <MediaMenu />
        <PlayToggle />
      </div>
      <span className="tb-sep" />
      <IconButton
        title="Desfazer (Ctrl+Z)"
        disabled={!canUndo}
        data-testid="undo"
        onClick={() => void actions.undo()}
      >
        <Undo2 size={ICON} />
      </IconButton>
      <IconButton
        title="Refazer (Ctrl+Shift+Z)"
        disabled={!canRedo}
        data-testid="redo"
        onClick={() => void actions.redo()}
      >
        <Redo2 size={ICON} />
      </IconButton>
      <div className="tb-center">
        <DocumentTitle />
      </div>
      <ZoomMenu />
      <span className="tb-sep" />
      <div className="tb-status" data-testid="connection-status" data-status={status}>
        <span className={`tb-dot ${status}`} />
        <span>{STATUS_TEXT[status]}</span>
      </div>
      <MediaDialogsHost />
    </header>
  );
}
