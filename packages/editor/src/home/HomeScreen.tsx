/** Tela inicial: recentes, favoritos, pastas virtuais, tags e grade de cartões dos arquivos. */
import { useCallback, useEffect, useMemo, useState } from 'react';
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
import type { FileEntry, FilesResult } from '../client/api';
import { daemon } from '../client/daemon';
import { getDesktop } from '../desktop/bridge';
import { newDocument } from '../desktop/fileFlows';
import { useDoc } from '../state/docStore';
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
import './home.css';

const FILE_DRAG_TYPE = 'application/x-mockup-file';
const EMPTY: FilesResult = { files: [], folders: [], tags: [] };

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

/* ---------------- cartão ---------------- */

function FileCard({
  file,
  onOpen,
  onMenu,
  onFavorite,
}: {
  file: FileEntry;
  onOpen: () => void;
  onMenu: (x: number, y: number) => void;
  onFavorite: () => void;
}) {
  const [thumbFailed, setThumbFailed] = useState(false);
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
      <div className="file-thumb">
        {thumbFailed || file.missing ? (
          <div className="file-thumb-fallback" data-testid="file-thumb-fallback">
            <FileText size={28} />
            <strong>{file.name}</strong>
            <span>
              {file.missing
                ? 'Arquivo não encontrado'
                : `${file.frames} ${file.frames === 1 ? 'frame' : 'frames'}`}
            </span>
          </div>
        ) : (
          <img
            src={thumbnailUrl(file.path, file.mtime)}
            alt={file.name}
            loading="lazy"
            draggable={false}
            onError={() => setThumbFailed(true)}
          />
        )}
        <button
          type="button"
          className={`file-favorite${file.favorite ? ' on' : ''}`}
          data-testid="file-favorite"
          aria-pressed={file.favorite}
          title={file.favorite ? 'Remover dos favoritos' : 'Favoritar'}
          onClick={(e) => {
            e.stopPropagation();
            onFavorite();
          }}
        >
          <Star size={14} fill={file.favorite ? 'currentColor' : 'none'} />
        </button>
        {file.open && <span className="file-open-badge">aberto</span>}
      </div>
      <div className="file-info">
        <div className="file-name">{file.name}</div>
        <div className="file-folder">
          {folderLabel(file.folder)} · {file.pages} {file.pages === 1 ? 'página' : 'páginas'}
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

/* ---------------- árvore de pastas ---------------- */

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

/* ---------------- tela ---------------- */

export function HomeScreen() {
  const [filter, setFilter] = useState<HomeFilter>(DEFAULT_FILTER);
  const [search, setSearch] = useState('');
  const [data, setData] = useState<FilesResult>(EMPTY);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [version, setVersion] = useState(0);
  const documents = useDoc((s) => s.documents);

  const reload = useCallback(() => setVersion((v) => v + 1), []);

  useEffect(() => {
    let cancelled = false;
    const t = setTimeout(() => {
      api.files.list(buildFilesQuery(filter, search)).then(
        (r) => {
          if (cancelled) return;
          setData(r);
          setError(null);
          setLoaded(true);
        },
        (e) => {
          if (cancelled) return;
          setError(errorText(e));
          setLoaded(true);
        },
      );
    }, 120);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [filter, search, version, documents]);

  const files = useMemo(
    () => arrangeFiles(data.files, filter, search),
    [data.files, filter, search],
  );
  const tree = useMemo(() => buildFolderTree(data.folders), [data.folders]);

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
      title: 'Editar tags',
      message: 'Separe as tags por vírgula.',
      fields: [
        { name: 'tags', label: 'Tags', value: f.tags.join(', '), placeholder: 'cliente, landing' },
      ],
      confirmLabel: 'Salvar',
    });
    if (r) await patchMeta(f, { tags: parseTags(r.tags ?? '') });
  };

  const moveToFolder = async (f: FileEntry) => {
    const r = await prompt({
      title: 'Mover para pasta',
      message: 'Use "/" para pastas aninhadas. Deixe em branco para tirar da pasta.',
      fields: [
        {
          name: 'folder',
          label: 'Pasta',
          value: f.folder ?? '',
          placeholder: data.folders[0] ?? 'Clientes/Acme',
        },
      ],
      confirmLabel: 'Mover',
    });
    if (!r) return;
    const folder = r.folder?.trim().replace(/^\/+|\/+$/g, '') ?? '';
    await patchMeta(f, { folder: folder || null });
  };

  const forget = async (f: FileEntry) => {
    if (await guard(() => api.files.forget(f.path))) {
      ui.toast(`"${f.name}" removido do índice. O arquivo não foi apagado.`);
      reload();
    }
  };

  const cardMenu = (f: FileEntry, x: number, y: number) =>
    openContextMenu(x, y, [
      { label: 'Abrir', onSelect: () => void open(f) },
      {
        label: f.favorite ? 'Remover dos favoritos' : 'Favoritar',
        onSelect: () => void patchMeta(f, { favorite: !f.favorite }),
      },
      { label: 'Editar tags…', onSelect: () => void editTags(f) },
      { label: 'Mover para pasta…', onSelect: () => void moveToFolder(f) },
      {
        label: 'Remover do índice',
        danger: true,
        separator: true,
        onSelect: () => void forget(f),
      },
    ]);

  const createFolder = async (parent?: string) => {
    const r = await prompt({
      title: parent ? `Nova subpasta em ${parent}` : 'Nova pasta',
      fields: [{ name: 'name', label: 'Nome', placeholder: 'Clientes' }],
      confirmLabel: 'Criar',
    });
    const name = r?.name?.trim().replace(/\//g, '-');
    if (!name) return;
    if (await guard(() => api.files.folders('create', parent ? `${parent}/${name}` : name)))
      reload();
  };

  const renameFolder = async (node: FolderNode) => {
    const r = await prompt({
      title: 'Renomear pasta',
      fields: [{ name: 'name', label: 'Nome', value: node.name }],
      confirmLabel: 'Renomear',
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
      title: 'Excluir pasta',
      message: `Excluir "${node.path}"? Os arquivos dela vão para a pasta-mãe.`,
      fields: [],
      confirmLabel: 'Excluir',
    });
    if (!r) return;
    if (await guard(() => api.files.folders('delete', node.path))) {
      if (filter.kind === 'folder' && filter.path === node.path) setFilter(DEFAULT_FILTER);
      reload();
    }
  };

  const folderMenu = (node: FolderNode, x: number, y: number) =>
    openContextMenu(x, y, [
      { label: 'Nova subpasta…', onSelect: () => void createFolder(node.path) },
      { label: 'Renomear…', onSelect: () => void renameFolder(node) },
      { label: 'Excluir', danger: true, separator: true, onSelect: () => void deleteFolder(node) },
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
        title: 'Adicionar arquivo ou pasta',
        message: 'Informe o caminho de um .mockup.json ou de uma pasta com documentos.',
        fields: [{ name: 'path', label: 'Caminho', placeholder: 'C:\\projetos' }],
        confirmLabel: 'Adicionar',
      });
      path = r?.path?.trim();
    }
    if (!path) return;
    const target = path;
    try {
      const added = await api.files.add(target);
      ui.toast(
        added.length
          ? `${added.length} ${added.length === 1 ? 'arquivo adicionado' : 'arquivos adicionados'}.`
          : 'Nenhum documento .mockup.json encontrado.',
      );
      reload();
    } catch (e) {
      ui.toast(errorText(e), 'error');
    }
  };

  const nav = (f: HomeFilter, label: string, icon: ReactNode, testId: string) => (
    <button
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
        {nav({ kind: 'recent' }, 'Recentes', <Clock size={13} />, 'home-nav-recent')}
        {nav({ kind: 'favorites' }, 'Favoritos', <Star size={13} />, 'home-nav-favorites')}
        {nav({ kind: 'all' }, 'Todos', <Files size={13} />, 'home-nav-all')}
        <div className="home-section-title">
          <span>Pastas</span>
          <button
            type="button"
            className="home-icon-btn"
            data-testid="home-folder-new"
            title="Nova pasta"
            onClick={() => void createFolder()}
          >
            <FolderPlus size={13} />
          </button>
        </div>
        {tree.length === 0 && <div className="home-hint">Nenhuma pasta ainda.</div>}
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
        {data.tags.length === 0 && <div className="home-hint">Nenhuma tag ainda.</div>}
        {data.tags.map((t) => nav({ kind: 'tag', tag: t }, t, <Tag size={13} />, `home-tag-${t}`))}
      </aside>
      <main className="home-main">
        <div className="home-header">
          <div className="home-search">
            <Search size={14} />
            <input
              data-testid="home-search"
              placeholder="Buscar por nome, tag ou conteúdo"
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
            <FilePlus size={13} /> Adicionar arquivo ou pasta
          </button>
          <button
            type="button"
            className="btn primary"
            data-testid="home-new"
            onClick={() => void newDocument()}
          >
            Novo documento
          </button>
        </div>
        {error && <div className="home-error">{error}</div>}
        {!error && loaded && files.length === 0 && (
          <div className="home-empty" data-testid="home-empty">
            {search.trim()
              ? 'Nenhum arquivo corresponde à busca.'
              : filter.kind === 'recent'
                ? 'Nenhum arquivo recente. Crie um documento ou adicione arquivos.'
                : 'Nenhum arquivo aqui.'}
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
            />
          ))}
        </div>
      </main>
    </div>
  );
}
