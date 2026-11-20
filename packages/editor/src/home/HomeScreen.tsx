/** Home screen: recent, favorites, virtual folders, tags and a grid of file cards. */
import { useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import {
  ChevronDown,
  ChevronRight,
  Clock,
  FilePlus,
  FileText,
  Files,
  Folder,
  FolderPlus,
  Search,
  Star,
  Tag,
} from 'lucide-react';
import { api, thumbnailUrl } from '../client/api';
import type { DeleteFileResult, FileEntry } from '../client/api';
import { daemon } from '../client/daemon';
import { getDesktop } from '../desktop/bridge';
import { newDocument } from '../desktop/fileFlows';
import { useDoc } from '../state/docStore';
import type { DocState } from '../state/docStore';
import { ui } from '../state/uiStore';
import { openContextMenu, prompt } from '../ui/overlays';
import {
  DEFAULT_FILTER,
  arrangeFiles,
  buildFilesQuery,
  buildFolderTree,
  folderLabel,
  parseTags,
  sameFilter,
} from './homeLogic';
import type { FolderNode, HomeFilter } from './homeLogic';
import { useFilesList } from './filesList';
import { useThumbnail } from './thumbnails';
import './home.css';

const FILE_DRAG_TYPE = 'application/x-mockup-file';
const NO_FILES: FileEntry[] = [];
const NO_STRINGS: string[] = [];

/**
 * What reloads the list: each (re)connection to the daemon and, of the open documents, what matters
 * to it (open/close, path, saved). Edits that only bump the revision do not reload it.
 */
function documentsSignature(s: DocState): string {
  const docs = s.documents.map((d) => `${d.docId}|${d.path ?? ''}|${d.dirty ? 1 : 0}`).join(';');
  return `${s.connectionEpoch}#${docs}`;
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

async function guard(fn: () => Promise<unknown>): Promise<boolean> {
  try {
    await fn();
    return true;
  } catch (e) {
    ui.toast(errorText(e), 'error');
    return false;
  }
}

/** Body of the "Delete file" confirmation: what goes, what stays and where it goes. */
function DeleteMessage({ plan }: { plan: DeleteFileResult }) {
  const fileName = plan.path.split(/[\\/]/).pop() ?? plan.name;
  const few = (list: string[]) =>
    list.length > 5
      ? `${list.slice(0, 5).join(', ')} and ${list.length - 5} more`
      : list.join(', ');
  return (
    <div className="home-delete-message" data-testid="home-delete-message">
      <p>
        Delete <strong>{fileName}</strong>?
      </p>
      {plan.assets.length > 0 && (
        <p>
          {plan.assets.length} {plan.assets.length === 1 ? 'asset' : 'assets'} used only by this
          document will be removed too: {few(plan.assets)}.
        </p>
      )}
      {plan.keptAssets.length > 0 && (
        <p>
          {plan.keptAssets.length} {plan.keptAssets.length === 1 ? 'asset stays' : 'assets stay'} in
          assets/ because another document in the folder may use{' '}
          {plan.keptAssets.length === 1 ? 'it' : 'them'}.
        </p>
      )}
      {plan.open && <p>The document is open: it will be closed first.</p>}
      <p>
        {plan.mode === 'trash'
          ? `The files will be moved to the ${plan.trashName}.`
          : 'The files will be deleted permanently. This cannot be undone.'}
      </p>
    </div>
  );
}

/* ---------------- card ---------------- */

function FileCard({
  file,
  onOpen,
  onMenu,
  onFavorite,
  onDelete,
}: {
  file: FileEntry;
  onOpen: () => void;
  onMenu: (x: number, y: number) => void;
  onFavorite: () => void;
  onDelete: () => void;
}) {
  const thumbRef = useRef<HTMLDivElement>(null);
  const thumb = useThumbnail(file.missing ? null : thumbnailUrl(file.path, file.mtime), thumbRef);
  return (
    <div
      className={`file-card${file.missing ? ' missing' : ''}`}
      data-testid="file-card"
      data-path={file.path}
      role="button"
      tabIndex={0}
      draggable
      title={file.path}
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.key === 'Enter') onOpen();
        else if (e.key === 'Delete' && !file.missing) {
          // the card has focus: Delete asks to delete the file (not the canvas selection)
          e.preventDefault();
          e.stopPropagation();
          onDelete();
        }
      }}
      onDragStart={(e) => {
        e.dataTransfer.setData(FILE_DRAG_TYPE, file.path);
        e.dataTransfer.effectAllowed = 'move';
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        onMenu(e.clientX, e.clientY);
      }}
    >
      <div className="file-thumb" ref={thumbRef}>
        {thumb.failed || file.missing ? (
          <div className="file-thumb-fallback" data-testid="file-thumb-fallback">
            <FileText size={28} />
            <strong>{file.name}</strong>
            <span>
              {file.missing
                ? 'File not found'
                : `${file.frames} ${file.frames === 1 ? 'frame' : 'frames'}`}
            </span>
          </div>
        ) : thumb.src ? (
          <img src={thumb.src} alt={file.name} draggable={false} />
        ) : null}
        <button
          type="button"
          className={`file-favorite${file.favorite ? ' on' : ''}`}
          data-testid="file-favorite"
          aria-pressed={file.favorite}
          title={file.favorite ? 'Remove from favorites' : 'Add to favorites'}
          onClick={(e) => {
            e.stopPropagation();
            onFavorite();
          }}
        >
          <Star size={14} fill={file.favorite ? 'currentColor' : 'none'} />
        </button>
        {file.open && <span className="file-open-badge">open</span>}
      </div>
      <div className="file-info">
        <div className="file-name">{file.name}</div>
        <div className="file-folder">
          {folderLabel(file.folder)} · {file.pages} {file.pages === 1 ? 'page' : 'pages'}
        </div>
        {file.match && file.match.field === 'content' && (
          <div className="file-snippet">{file.match.snippet}</div>
        )}
        {file.tags.length > 0 && (
          <div className="file-tags">
            {file.tags.map((t) => (
              <span key={t} className="file-tag">
                {t}
              </span>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/* ---------------- folder tree ---------------- */

function FolderItem({
  node,
  depth,
  filter,
  onSelect,
  onMenu,
  onDropFile,
}: {
  node: FolderNode;
  depth: number;
  filter: HomeFilter;
  onSelect: (f: HomeFilter) => void;
  onMenu: (node: FolderNode, x: number, y: number) => void;
  onDropFile: (filePath: string, folder: string | null) => void;
}) {
  const [open, setOpen] = useState(true);
  const [over, setOver] = useState(false);
  const active = sameFilter(filter, { kind: 'folder', path: node.path });
  return (
    <div>
      <div
        className={`home-nav-item folder${active ? ' active' : ''}${over ? ' drop' : ''}`}
        data-testid={`home-folder-${node.path}`}
        style={{ paddingLeft: 8 + depth * 14 }}
        onClick={() => onSelect({ kind: 'folder', path: node.path })}
        onContextMenu={(e) => {
          e.preventDefault();
          onMenu(node, e.clientX, e.clientY);
        }}
        onDragOver={(e) => {
          if (!e.dataTransfer.types.includes(FILE_DRAG_TYPE)) return;
          e.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          setOver(false);
          const p = e.dataTransfer.getData(FILE_DRAG_TYPE);
          if (!p) return;
          e.preventDefault();
          onDropFile(p, node.path);
        }}
      >
        <span
          className={`home-chevron${node.children.length ? '' : ' empty'}`}
          onClick={(e) => {
            e.stopPropagation();
            setOpen(!open);
          }}
        >
          {node.children.length > 0 &&
            (open ? <ChevronDown size={12} /> : <ChevronRight size={12} />)}
        </span>
        <Folder size={13} />
        <span className="home-nav-label">{node.name}</span>
      </div>
      {open &&
        node.children.map((c) => (
          <FolderItem
            key={c.path}
            node={c}
            depth={depth + 1}
            filter={filter}
            onSelect={onSelect}
            onMenu={onMenu}
            onDropFile={onDropFile}
          />
        ))}
    </div>
  );
}

/* ---------------- screen ---------------- */

export function HomeScreen() {
  const [filter, setFilter] = useState<HomeFilter>(DEFAULT_FILTER);
  const [search, setSearch] = useState('');
  const signature = useDoc(documentsSignature);
  const query = useMemo(() => buildFilesQuery(filter, search), [filter, search]);
  const { data, error, reload } = useFilesList(query, search, signature);
  const allFiles = data?.files ?? NO_FILES;
  const folders = data?.folders ?? NO_STRINGS;
  const tags = data?.tags ?? NO_STRINGS;

  const files = useMemo(() => arrangeFiles(allFiles, filter, search), [allFiles, filter, search]);
  const tree = useMemo(() => buildFolderTree(folders), [folders]);

  const open = async (f: FileEntry) => {
    try {
      if (f.open && f.docId) await daemon.setActive(f.docId);
      else await daemon.openDoc(f.path);
      ui.setHome(false);
    } catch (e) {
      ui.toast(errorText(e), 'error');
    }
  };

  const patchMeta = async (f: FileEntry, patch: Parameters<typeof api.files.meta>[1]) => {
    if (await guard(() => api.files.meta(f.path, patch))) reload();
  };

  const editTags = async (f: FileEntry) => {
    const r = await prompt({
      title: 'Edit tags',
      message: 'Separate tags with commas.',
      fields: [
        { name: 'tags', label: 'Tags', value: f.tags.join(', '), placeholder: 'client, landing' },
      ],
      confirmLabel: 'Save',
    });
    if (r) await patchMeta(f, { tags: parseTags(r.tags ?? '') });
  };

  const moveToFolder = async (f: FileEntry) => {
    const r = await prompt({
      title: 'Move to folder',
      message: 'Use "/" for nested folders. Leave blank to remove from the folder.',
      fields: [
        {
          name: 'folder',
          label: 'Folder',
          value: f.folder ?? '',
          placeholder: folders[0] ?? 'Clients/Acme',
        },
      ],
      confirmLabel: 'Move',
    });
    if (!r) return;
    const folder = r.folder?.trim().replace(/^\/+|\/+$/g, '') ?? '';
    await patchMeta(f, { folder: folder || null });
  };

  const forget = async (f: FileEntry) => {
    if (await guard(() => api.files.forget(f.path))) {
      ui.toast(
        f.open
          ? `"${f.name}" closed and removed from the index. The file was not deleted.`
          : `"${f.name}" removed from the index. The file was not deleted.`,
      );
      reload();
    }
  };

  const deleteFile = async (f: FileEntry) => {
    let plan: DeleteFileResult;
    try {
      plan = await api.files.delete(f.path, true);
    } catch (e) {
      ui.toast(errorText(e), 'error');
      return;
    }
    const ok = await prompt({
      title: 'Delete file',
      message: <DeleteMessage plan={plan} />,
      fields: [],
      confirmLabel: plan.mode === 'trash' ? `Move to ${plan.trashName}` : 'Delete permanently',
      danger: true,
    });
    if (!ok) return;
    try {
      const r = await api.files.delete(f.path);
      const done =
        r.mode === 'trash' ? `"${f.name}" moved to the ${r.trashName}` : `"${f.name}" deleted`;
      if (r.failedAssets.length)
        ui.toast(`${done}, but ${r.failedAssets.length} asset(s) could not be removed.`, 'error');
      else ui.toast(done);
    } catch (e) {
      ui.toast(errorText(e), 'error');
    }
    reload();
  };

  const cardMenu = (f: FileEntry, x: number, y: number) =>
    openContextMenu(x, y, [
      { label: 'Open', onSelect: () => void open(f) },
      {
        label: f.favorite ? 'Remove from favorites' : 'Add to favorites',
        onSelect: () => void patchMeta(f, { favorite: !f.favorite }),
      },
      { label: 'Edit tags…', onSelect: () => void editTags(f) },
      { label: 'Move to folder…', onSelect: () => void moveToFolder(f) },
      {
        label: 'Remove from index',
        danger: true,
        separator: true,
        onSelect: () => void forget(f),
      },
      {
        label: 'Delete file…',
        danger: true,
        disabled: f.missing === true,
        onSelect: () => void deleteFile(f),
      },
    ]);

  const createFolder = async (parent?: string) => {
    const r = await prompt({
      title: parent ? `New subfolder in ${parent}` : 'New folder',
      fields: [{ name: 'name', label: 'Name', placeholder: 'Clients' }],
      confirmLabel: 'Create',
    });
    const name = r?.name?.trim().replace(/\//g, '-');
    if (!name) return;
    if (await guard(() => api.files.folders('create', parent ? `${parent}/${name}` : name)))
      reload();
  };

  const renameFolder = async (node: FolderNode) => {
    const r = await prompt({
      title: 'Rename folder',
      fields: [{ name: 'name', label: 'Name', value: node.name }],
      confirmLabel: 'Rename',
    });
    const name = r?.name?.trim().replace(/\//g, '-');
    if (!name || name === node.name) return;
    const cut = node.path.lastIndexOf('/');
    const to = cut < 0 ? name : `${node.path.slice(0, cut)}/${name}`;
    if (await guard(() => api.files.folders('rename', node.path, to))) {
      if (filter.kind === 'folder' && filter.path === node.path)
        setFilter({ kind: 'folder', path: to });
      reload();
    }
  };

  const deleteFolder = async (node: FolderNode) => {
    const r = await prompt({
      title: 'Delete folder',
      message: `Delete "${node.path}"? Its files will move to the parent folder.`,
      fields: [],
      confirmLabel: 'Delete',
    });
    if (!r) return;
    if (await guard(() => api.files.folders('delete', node.path))) {
      if (filter.kind === 'folder' && filter.path === node.path) setFilter(DEFAULT_FILTER);
      reload();
    }
  };

  const folderMenu = (node: FolderNode, x: number, y: number) =>
    openContextMenu(x, y, [
      { label: 'New subfolder…', onSelect: () => void createFolder(node.path) },
      { label: 'Rename…', onSelect: () => void renameFolder(node) },
      { label: 'Delete', danger: true, separator: true, onSelect: () => void deleteFolder(node) },
    ]);

  const moveFile = async (path: string, folder: string | null) => {
    if (await guard(() => api.files.meta(path, { folder }))) reload();
  };

  const addPath = async () => {
    let path: string | null | undefined;
    const desktop = getDesktop();
    if (desktop) path = await desktop.showOpenDialog();
    else {
      const r = await prompt({
        title: 'Add file or folder',
        message: 'Enter the path of a .mockup.json file or of a folder with documents.',
        fields: [{ name: 'path', label: 'Path', placeholder: 'C:\\projects' }],
        confirmLabel: 'Add',
      });
      path = r?.path?.trim();
    }
    if (!path) return;
    const target = path;
    try {
      const added = await api.files.add(target);
      ui.toast(
        added.length
          ? `${added.length} ${added.length === 1 ? 'file added' : 'files added'}.`
          : 'No .mockup.json documents found.',
      );
      reload();
    } catch (e) {
      ui.toast(errorText(e), 'error');
    }
  };

  const nav = (f: HomeFilter, label: string, icon: ReactNode, testId: string) => (
    <button
      key={testId}
      type="button"
      className={`home-nav-item${sameFilter(filter, f) ? ' active' : ''}`}
      data-testid={testId}
      onClick={() => setFilter(f)}
      onDragOver={(e) => {
        if (f.kind === 'all' && e.dataTransfer.types.includes(FILE_DRAG_TYPE)) e.preventDefault();
      }}
      onDrop={(e) => {
        const p = e.dataTransfer.getData(FILE_DRAG_TYPE);
        if (f.kind === 'all' && p) {
          e.preventDefault();
          void moveFile(p, null);
        }
      }}
    >
      {icon}
      <span className="home-nav-label">{label}</span>
    </button>
  );

  return (
    <div className="home-screen" data-testid="home-screen">
      <aside className="home-sidebar">
        {nav({ kind: 'recent' }, 'Recent', <Clock size={13} />, 'home-nav-recent')}
        {nav({ kind: 'favorites' }, 'Favorites', <Star size={13} />, 'home-nav-favorites')}
        {nav({ kind: 'all' }, 'All', <Files size={13} />, 'home-nav-all')}
        <div className="home-section-title">
          <span>Folders</span>
          <button
            type="button"
            className="home-icon-btn"
            data-testid="home-folder-new"
            title="New folder"
            onClick={() => void createFolder()}
          >
            <FolderPlus size={13} />
          </button>
        </div>
        {data && tree.length === 0 && <div className="home-hint">No folders yet.</div>}
        {tree.map((n) => (
          <FolderItem
            key={n.path}
            node={n}
            depth={0}
            filter={filter}
            onSelect={setFilter}
            onMenu={folderMenu}
            onDropFile={(p, folder) => void moveFile(p, folder)}
          />
        ))}
        <div className="home-section-title">
          <span>Tags</span>
        </div>
        {data && tags.length === 0 && <div className="home-hint">No tags yet.</div>}
        {tags.map((t) => nav({ kind: 'tag', tag: t }, t, <Tag size={13} />, `home-tag-${t}`))}
      </aside>
      <main className="home-main">
        <div className="home-header">
          <div className="home-search">
            <Search size={14} />
            <input
              data-testid="home-search"
              placeholder="Search by name, tag or content"
              spellCheck={false}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
          <button
            type="button"
            className="btn"
            data-testid="home-add"
            onClick={() => void addPath()}
          >
            <FilePlus size={13} /> Add file or folder
          </button>
          <button
            type="button"
            className="btn primary"
            data-testid="home-new"
            onClick={() => void newDocument()}
          >
            New document
          </button>
        </div>
        {error && (
          <div className="home-error" data-testid="home-error" role="alert">
            <span>{error}</span>
            <button type="button" className="btn" data-testid="home-retry" onClick={reload}>
              Retry
            </button>
          </div>
        )}
        {!data && !error && (
          <div className="home-loading" data-testid="home-loading">
            Loading files…
          </div>
        )}
        {!error && data && files.length === 0 && (
          <div className="home-empty" data-testid="home-empty">
            {search.trim()
              ? 'No files match your search.'
              : filter.kind === 'recent'
                ? 'No recent files. Create a document or add files.'
                : 'No files here.'}
          </div>
        )}
        <div className="home-grid" data-testid="home-grid">
          {files.map((f) => (
            <FileCard
              key={f.path}
              file={f}
              onOpen={() => void open(f)}
              onMenu={(x, y) => cardMenu(f, x, y)}
              onFavorite={() => void patchMeta(f, { favorite: !f.favorite })}
              onDelete={() => void deleteFile(f)}
            />
          ))}
        </div>
      </main>
    </div>
  );
}
