/** Toolbar: file, tools, undo/redo, document, zoom and connection. */
import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import {
  ChevronDown,
  Circle,
  Clapperboard,
  Frame,
  Hand,
  Home,
  Hexagon,
  Image as ImageIcon,
  MonitorPlay,
  MousePointer2,
  PenTool,
  Pause,
  Play,
  Redo2,
  Slash,
  Square,
  Type,
  Undo2,
} from 'lucide-react';
import { PREVIEW_STATES, presentationSlides } from '@mockup/core';
import type { PreviewState } from '@mockup/core';
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
import { displayedPage } from '../presentation/presentationStore';
import { startPresentation } from '../presentation/startPresentation';
import { selectActiveInfo, useDoc } from '../state/docStore';
import type { ConnectionStatus } from '../state/docStore';
import { ui, useUi } from '../state/uiStore';
import type { Tool } from '../state/uiStore';
import { ImportUrlButton } from '../snapshot/ImportUrlButton';
import { IconButton } from '../ui/controls';
import './toolbar.css';

const ICON = 16;

const TOOLS: { tool: Tool; title: string; key: string; icon: ReactNode }[] = [
  { tool: 'select', title: 'Move', key: 'V', icon: <MousePointer2 size={ICON} /> },
  { tool: 'hand', title: 'Hand', key: 'H', icon: <Hand size={ICON} /> },
  { tool: 'frame', title: 'Frame', key: 'F', icon: <Frame size={ICON} /> },
  { tool: 'rect', title: 'Container', key: 'R', icon: <Square size={ICON} /> },
  { tool: 'text', title: 'Text', key: 'T', icon: <Type size={ICON} /> },
  { tool: 'image', title: 'Image', key: 'Ctrl+Shift+K', icon: <ImageIcon size={ICON} /> },
  { tool: 'pen', title: 'Pen', key: 'P', icon: <PenTool size={ICON} /> },
  { tool: 'ellipse', title: 'Ellipse', key: 'O', icon: <Circle size={ICON} /> },
  { tool: 'line', title: 'Line', key: 'L', icon: <Slash size={ICON} /> },
  { tool: 'polygon', title: 'Polygon', key: '', icon: <Hexagon size={ICON} /> },
];

const STATUS_TEXT: Record<ConnectionStatus, string> = {
  online: 'Connected',
  connecting: 'Connecting…',
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

/* ---------------- file ---------------- */

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
    { label: 'Home', testId: 'file-home', onSelect: () => ui.setHome(true) },
    { label: 'New…', testId: 'file-new', separator: true, onSelect: () => void newDocument() },
    { label: 'Open…', testId: 'file-open', onSelect: () => void openDocument() },
    ...recent.slice(0, 8).map<DropItem>((path, i) => ({
      label: fileNameOf(path) || path,
      testId: `file-recent-${i}`,
      separator: i === 0,
      onSelect: () => void openDocument(path),
    })),
    {
      label: 'Save',
      testId: 'file-save',
      shortcut: 'Ctrl+S',
      disabled: !activeDocId,
      separator: true,
      onSelect: () => void actions.save(),
    },
    {
      label: 'Save as…',
      testId: 'file-save-as',
      shortcut: 'Ctrl+Shift+S',
      disabled: !activeDocId,
      onSelect: () => void saveDocumentAs(),
    },
    {
      label: 'Close document',
      testId: 'file-close',
      disabled: !activeDocId,
      onSelect: () => void closeActiveDocument(),
    },
  ];
  return (
    <Dropdown
      testId="menu-file"
      title="File"
      items={items}
      onOpen={() => void daemon.recent().then(setRecent, () => setRecent([]))}
      trigger={
        <>
          <span>File</span>
          <ChevronDown size={12} />
        </>
      }
    />
  );
}

/* ---------------- document (center) ---------------- */

function DocumentTitle() {
  const info = useDoc(selectActiveInfo);
  const documents = useDoc((s) => s.documents);
  if (!info) return <div className="tb-doc tb-doc-empty">No document</div>;
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
        <span className="tb-dirty" data-testid="dirty-indicator" title="Unsaved changes" />
      )}
    </div>
  );
}

/* ---------------- state preview ---------------- */

const PREVIEW_LABELS: Record<PreviewState, string> = {
  hover: 'hover',
  focus: 'focus',
  active: 'active',
  'focus-visible': 'focus-visible',
  'focus-within': 'focus-within',
  disabled: 'disabled',
  dark: 'dark',
};

/** State preview selector: applies hover/focus/dark... to all nodes on the canvas. */
function PreviewStateSelect() {
  const state = useUi((s) => s.previewState);
  return (
    <label
      className={`tb-preview${state ? ' on' : ''}`}
      title="State preview: applies the variants (hover:, focus:, dark:...) to the whole canvas"
    >
      <span>Preview</span>
      <select
        className="tb-doc-select"
        data-testid="preview-state"
        value={state ?? ''}
        onChange={(e) => ui.setPreviewState((e.target.value || null) as PreviewState | null)}
      >
        <option value="">None</option>
        {PREVIEW_STATES.map((s) => (
          <option key={s} value={s}>
            {PREVIEW_LABELS[s]}
          </option>
        ))}
      </select>
    </label>
  );
}

/* ---------------- zoom ---------------- */

function ZoomMenu() {
  const z = useUi((s) => s.viewport.z);
  const items: DropItem[] = [
    { label: 'Zoom in', testId: 'zoom-in', shortcut: '+', onSelect: () => canvasApi.zoomIn() },
    { label: 'Zoom out', testId: 'zoom-out', shortcut: '−', onSelect: () => canvasApi.zoomOut() },
    {
      label: 'Zoom 100%',
      testId: 'zoom-100',
      shortcut: 'Shift+0',
      separator: true,
      onSelect: () => canvasApi.zoomTo(1),
    },
    {
      label: 'Zoom to fit',
      testId: 'zoom-fit',
      shortcut: 'Shift+1',
      onSelect: () => canvasApi.fitAll(),
    },
    {
      label: 'Zoom to selection',
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

/* ---------------- media and animations ---------------- */

function MediaMenu() {
  const items: DropItem[] = [
    { label: 'Insert video…', testId: 'media-video', onSelect: () => void pickAndInsertVideo() },
    {
      label: 'Insert Lottie/Rive from file…',
      testId: 'media-lottie-rive',
      onSelect: () => void pickAndInsertLottieRive(),
    },
    { label: 'Embed from URL…', testId: 'media-embed-url', onSelect: mediaDialogs.openEmbedUrl },
    {
      label: 'Three.js island',
      testId: 'media-three',
      separator: true,
      onSelect: () => void insertThreeIsland(),
    },
  ];
  return (
    <Dropdown
      testId="media-button"
      title="Media"
      items={items}
      trigger={<Clapperboard size={ICON} />}
    />
  );
}

function PlayToggle() {
  const playing = useFxClock((s) => s.playing);
  const title = playing ? 'Pause animations' : 'Play animations';
  return (
    <IconButton
      title={`${title} (Shift+Space)`}
      active={!playing}
      data-testid="fx-play-toggle"
      data-playing={playing}
      onClick={() => fxClock.toggle()}
    >
      {playing ? <Pause size={ICON} /> : <Play size={ICON} />}
    </IconButton>
  );
}

/** Presentation: plays the visible frames of the displayed page as slides. */
function PresentButton() {
  const pageId = useUi((s) => s.pageId);
  const componentEdit = useUi((s) => s.componentEdit);
  const slideCount = useDoc(
    (s) => presentationSlides(displayedPage(s.doc, pageId, componentEdit)).length,
  );
  const disabled = slideCount === 0;
  return (
    <button
      type="button"
      className="tb-present"
      data-testid="present-button"
      title={
        disabled
          ? 'Nothing to present: this page has no visible frames'
          : 'Present (F5 from the first frame, Shift+F5 from the selected frame)'
      }
      aria-label="Present"
      disabled={disabled}
      onClick={() => startPresentation('selection')}
    >
      <MonitorPlay size={ICON} />
      <span>Present</span>
    </button>
  );
}

/* ---------------- bar ---------------- */

export function Toolbar() {
  const tool = useUi((s) => s.tool);
  const canUndo = useDoc((s) => s.history.canUndo);
  const canRedo = useDoc((s) => s.history.canRedo);
  const status = useDoc((s) => s.status);
  const homeOpen = useUi((s) => s.homeOpen);

  return (
    <header className="toolbar" data-testid="toolbar">
      <div className="tb-brand">
        <Logo />
        <span>Mockup Studio</span>
      </div>
      <FileMenu />
      <IconButton
        title="Home (files)"
        active={homeOpen}
        data-testid="home-button"
        onClick={() => ui.setHome(!homeOpen)}
      >
        <Home size={ICON} />
      </IconButton>
      <span className="tb-sep" />
      <div className="tb-group" role="toolbar" aria-label="Tools">
        {TOOLS.map((t) => (
          <IconButton
            key={t.tool}
            title={t.key ? `${t.title} (${t.key})` : t.title}
            active={tool === t.tool}
            data-testid={`tool-${t.tool}`}
            onClick={() => ui.setTool(t.tool)}
          >
            {t.icon}
          </IconButton>
        ))}
      </div>
      <span className="tb-sep" />
      <div className="tb-group" role="toolbar" aria-label="Effects and media">
        <EffectsButton />
        <MediaMenu />
        <PlayToggle />
      </div>
      <span className="tb-sep" />
      <IconButton
        title="Undo (Ctrl+Z)"
        disabled={!canUndo}
        data-testid="undo"
        onClick={() => void actions.undo()}
      >
        <Undo2 size={ICON} />
      </IconButton>
      <IconButton
        title="Redo (Ctrl+Shift+Z)"
        disabled={!canRedo}
        data-testid="redo"
        onClick={() => void actions.redo()}
      >
        <Redo2 size={ICON} />
      </IconButton>
      <ImportUrlButton />
      <div className="tb-center">
        <DocumentTitle />
      </div>
      <PresentButton />
      <PreviewStateSelect />
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
