/** Assets panel of the active document + global library (CDN). */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { DragEvent, ReactNode } from 'react';
import {
  ChevronDown,
  ChevronRight,
  Copy,
  Download,
  FileText,
  Library,
  Plus,
  Search,
  Sparkles,
  Trash2,
  Type as FontIcon,
  Upload,
} from 'lucide-react';
import { api, ApiError, assetViewUrl } from '../client/api';
import type { AssetInfo, LibraryAsset } from '../client/api';
import { revealNodes } from '../layers/reveal';
import { selectActiveInfo, useDoc } from '../state/docStore';
import { ui } from '../state/uiStore';
import { prompt } from '../ui/overlays';
import { filterAssets, formatBytes, optimizeSummary } from './assetsLogic';
import { ASSET_DRAG_TYPE, insertAsset, listenAssetDrops } from './insert';
import './assets.css';

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

async function confirmDialog(
  title: string,
  message: ReactNode,
  confirmLabel: string,
): Promise<boolean> {
  return (await prompt({ title, message, fields: [], confirmLabel })) !== null;
}

function Thumb({ docId, asset }: { docId: string; asset: AssetInfo }) {
  if (asset.kind === 'image') {
    return (
      <img
        className="asset-thumb-img"
        src={assetViewUrl(docId, asset.path)}
        alt={asset.name}
        loading="lazy"
        draggable={false}
      />
    );
  }
  const Icon = asset.kind === 'font' ? FontIcon : FileText;
  return (
    <span className="asset-thumb-icon" data-kind={asset.kind}>
      <Icon size={22} />
      <span>{asset.ext.replace(/^\./, '').toUpperCase()}</span>
    </span>
  );
}

function AssetItem({
  docId,
  asset,
  onChanged,
  onAssets,
}: {
  docId: string;
  asset: AssetInfo;
  onChanged: () => void;
  onAssets: AssetActions;
}) {
  const unused = asset.uses === 0;
  return (
    <div
      className={`asset-item${unused ? ' unused' : ''}`}
      data-testid={`asset-item-${asset.path}`}
      draggable={asset.kind === 'image'}
      onDragStart={(e) => {
        e.dataTransfer.setData(ASSET_DRAG_TYPE, asset.path);
        e.dataTransfer.effectAllowed = 'copy';
      }}
      title={`${asset.path}\n${formatBytes(asset.size)}${
        asset.width && asset.height ? ` · ${asset.width}×${asset.height}` : ''
      }`}
    >
      <div className="asset-thumb">
        <Thumb docId={docId} asset={asset} />
        <button
          type="button"
          className={`asset-uses${unused ? ' none' : ''}`}
          data-testid="asset-uses"
          title={unused ? 'Unused' : 'Select the nodes that use it'}
          disabled={unused}
          onClick={() => {
            if (!revealNodes(asset.nodeIds))
              ui.toast('The nodes that use this asset are not in the document.');
          }}
        >
          {unused ? 'unused' : `${asset.uses} ${asset.uses === 1 ? 'use' : 'uses'}`}
        </button>
      </div>
      <div className="asset-name">{asset.name}</div>
      <div className="asset-meta">
        {formatBytes(asset.size)}
        {asset.width && asset.height ? ` · ${asset.width}×${asset.height}` : ''}
      </div>
      <div className="asset-actions">
        {asset.kind === 'image' && (
          <button
            type="button"
            className="asset-btn"
            data-testid="asset-insert"
            title="Insert into canvas"
            onClick={() => void insertAsset(asset).then(onChanged)}
          >
            <Plus size={13} />
          </button>
        )}
        <button
          type="button"
          className="asset-btn"
          data-testid="asset-copy-link"
          title="Copy link (CDN)"
          onClick={() => void onAssets.copyLink(asset)}
        >
          <Copy size={13} />
        </button>
        <button
          type="button"
          className="asset-btn"
          data-testid="asset-to-library"
          title="Send to library"
          onClick={() => void onAssets.toLibrary(asset)}
        >
          <Library size={13} />
        </button>
        <button
          type="button"
          className="asset-btn danger"
          data-testid="asset-delete"
          title="Remove"
          onClick={() => void onAssets.remove(asset)}
        >
          <Trash2 size={13} />
        </button>
      </div>
    </div>
  );
}

interface AssetActions {
  copyLink(a: AssetInfo): Promise<void>;
  remove(a: AssetInfo): Promise<void>;
  toLibrary(a: AssetInfo): Promise<void>;
}

function LibrarySection({
  docId,
  assets,
  refreshKey,
  onImported,
}: {
  docId: string;
  assets: AssetInfo[];
  refreshKey: number;
  onImported: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [items, setItems] = useState<LibraryAsset[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    const t = setTimeout(() => {
      api.library.list(query).then(
        (list) => {
          if (cancelled) return;
          setItems(list);
          setError(null);
        },
        (e) => !cancelled && setError(errorText(e)),
      );
    }, 200);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [open, query, refreshKey]);

  const importOne = async (a: LibraryAsset) => {
    try {
      await api.library.import(a.hash, docId);
      ui.toast(`"${a.name}" imported into the document.`);
      onImported();
    } catch (e) {
      ui.toast(errorText(e), 'error');
    }
  };
  const removeOne = async (a: LibraryAsset) => {
    if (
      !(await confirmDialog(
        'Remove from library',
        `Remove "${a.name}" from the library?`,
        'Remove',
      ))
    )
      return;
    try {
      await api.library.remove(a.hash);
      setItems((l) => l.filter((x) => x.hash !== a.hash));
    } catch (e) {
      ui.toast(errorText(e), 'error');
    }
  };
  const inDoc = new Set(assets.map((a) => a.hash));

  return (
    <section className="assets-library" data-testid="assets-library">
      <button
        type="button"
        className="assets-library-toggle"
        data-testid="assets-library-toggle"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        <span>Library</span>
      </button>
      {open && (
        <div className="assets-library-body">
          <input
            className="assets-search"
            data-testid="library-search"
            placeholder="Search the library"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          {error && <div className="assets-error">{error}</div>}
          {!error && items.length === 0 && (
            <div className="assets-empty">Library is empty. Send an asset from the document.</div>
          )}
          <div className="assets-grid">
            {items.map((a) => (
              <div className="asset-item" key={a.hash} data-testid={`library-item-${a.hash}`}>
                <div className="asset-thumb">
                  {a.mime.startsWith('image/') ? (
                    <img className="asset-thumb-img" src={a.url} alt={a.name} loading="lazy" />
                  ) : (
                    <span className="asset-thumb-icon">
                      <FileText size={22} />
                    </span>
                  )}
                </div>
                <div className="asset-name">{a.name}</div>
                <div className="asset-meta">
                  {formatBytes(a.size)}
                  {inDoc.has(a.hash) ? ' · in document' : ''}
                </div>
                <div className="asset-actions">
                  <button
                    type="button"
                    className="asset-btn"
                    data-testid="library-import"
                    title="Import into document"
                    onClick={() => void importOne(a)}
                  >
                    <Download size={13} />
                  </button>
                  <button
                    type="button"
                    className="asset-btn danger"
                    data-testid="library-delete"
                    title="Remove from library"
                    onClick={() => void removeOne(a)}
                  >
                    <Trash2 size={13} />
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </section>
  );
}

export function AssetsPanel() {
  const docId = useDoc((s) => s.activeDocId);
  const info = useDoc(selectActiveInfo);
  const doc = useDoc((s) => s.doc);
  const hasPath = !!info?.path;
  const [assets, setAssets] = useState<AssetInfo[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [unusedOnly, setUnusedOnly] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [libKey, setLibKey] = useState(0);
  const fileInput = useRef<HTMLInputElement>(null);
  const assetsRef = useRef(assets);
  assetsRef.current = assets;

  const reload = useCallback(async () => {
    if (!docId || !hasPath) {
      setAssets([]);
      return;
    }
    try {
      setAssets(await api.assets.list(docId));
      setError(null);
    } catch (e) {
      setError(errorText(e));
    }
  }, [docId, hasPath]);

  // Reloads when switching documents and (debounced) when the document changes.
  useEffect(() => {
    const t = setTimeout(() => void reload(), 300);
    return () => clearTimeout(t);
  }, [reload, doc]);

  // Dropping an asset on the canvas inserts an `img` node.
  useEffect(() => listenAssetDrops((path) => assetsRef.current.find((a) => a.path === path)), []);

  const visible = useMemo(
    () => filterAssets(assets, { query, unusedOnly }),
    [assets, query, unusedOnly],
  );
  const unusedCount = useMemo(() => assets.filter((a) => a.uses === 0).length, [assets]);

  const upload = async (files: File[]) => {
    if (!docId || !files.length) return;
    let ok = 0;
    for (const f of files) {
      try {
        await api.assets.upload(docId, f, f.name);
        ok++;
      } catch (e) {
        ui.toast(`${f.name}: ${errorText(e)}`, 'error');
      }
    }
    if (ok) ui.toast(ok === 1 ? 'File uploaded.' : `${ok} files uploaded.`);
    await reload();
  };

  const actions: AssetActions = {
    async copyLink(a) {
      if (!docId) return;
      try {
        const { url } = await api.assets.link(docId, a.path);
        try {
          await navigator.clipboard.writeText(url);
          ui.toast(`Link copied: ${url}`);
        } catch {
          ui.toast(`Could not copy automatically. Link: ${url}`);
        }
      } catch (e) {
        ui.toast(errorText(e), 'error');
      }
    },
    async remove(a) {
      if (!docId) return;
      const inUse = a.uses > 0;
      const ok = await confirmDialog(
        'Remove asset',
        inUse
          ? `"${a.path}" is used by ${a.uses} ${a.uses === 1 ? 'node' : 'nodes'}. Remove anyway? The nodes will have a broken image.`
          : `Remove "${a.path}" from the document?`,
        'Remove',
      );
      if (!ok) return;
      try {
        try {
          await api.assets.remove(docId, a.path, inUse);
        } catch (e) {
          if (!(e instanceof ApiError && e.status === 409)) throw e;
          if (
            !(await confirmDialog(
              'Asset in use',
              `"${a.path}" is in use. Remove anyway?`,
              'Remove',
            ))
          )
            return;
          await api.assets.remove(docId, a.path, true);
        }
        ui.toast(`"${a.name}" removed.`);
      } catch (e) {
        ui.toast(errorText(e), 'error');
      }
      await reload();
    },
    async toLibrary(a) {
      if (!docId) return;
      try {
        const res = await fetch(assetViewUrl(docId, a.path));
        if (!res.ok) throw new Error(`Could not read "${a.name}" (${res.status}).`);
        await api.library.upload(await res.blob(), a.name);
        ui.toast(`"${a.name}" sent to the library.`);
        setLibKey((k) => k + 1);
      } catch (e) {
        ui.toast(errorText(e), 'error');
      }
    },
  };

  const removeUnused = async () => {
    if (!docId) return;
    try {
      const dry = await api.assets.removeUnused(docId, true);
      if (!dry.removed.length) {
        ui.toast('There are no unused assets.');
        return;
      }
      const ok = await confirmDialog(
        'Remove unused',
        <div>
          <p>
            {dry.removed.length}{' '}
            {dry.removed.length === 1 ? 'file will be removed' : 'files will be removed'}:
          </p>
          <ul className="assets-confirm-list" data-testid="assets-remove-list">
            {dry.removed.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        </div>,
        'Remove',
      );
      if (!ok) return;
      const res = await api.assets.removeUnused(docId, false);
      ui.toast(
        `${res.removed.length} ${res.removed.length === 1 ? 'file removed' : 'files removed'}.`,
      );
    } catch (e) {
      ui.toast(errorText(e), 'error');
    }
    await reload();
  };

  const optimize = async () => {
    if (!docId) return;
    const r = await prompt({
      title: 'Optimize images',
      message:
        'Converts the images to WebP. Enter the maximum width or leave blank to keep the size.',
      fields: [{ name: 'maxWidth', label: 'Max width (px, optional)', placeholder: '1600' }],
      confirmLabel: 'Optimize',
    });
    if (!r) return;
    const maxWidth = Number.parseInt(r.maxWidth ?? '', 10);
    try {
      const res = await api.assets.optimize(docId, {
        format: 'webp',
        ...(Number.isFinite(maxWidth) && maxWidth > 0 ? { maxWidth } : {}),
      });
      ui.toast(optimizeSummary(res.results, res.skipped.length));
    } catch (e) {
      ui.toast(errorText(e), 'error');
    }
    await reload();
  };

  const onDragOver = (e: DragEvent) => {
    if (!e.dataTransfer?.types.includes('Files')) return;
    e.preventDefault();
    setDragOver(true);
  };

  if (!docId) {
    return (
      <div className="assets-panel" data-testid="assets-panel">
        <div className="assets-empty">Open a document to see the assets.</div>
      </div>
    );
  }
  if (!hasPath) {
    return (
      <div className="assets-panel" data-testid="assets-panel">
        <div className="assets-empty" data-testid="assets-unsaved">
          Save the document to manage assets
        </div>
      </div>
    );
  }

  return (
    <div className="assets-panel" data-testid="assets-panel">
      <div className="assets-toolbar">
        <div className="assets-search-wrap">
          <Search size={12} />
          <input
            className="assets-search"
            data-testid="assets-search"
            placeholder="Search assets"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        <div className="assets-buttons">
          <button
            type="button"
            className="btn"
            data-testid="assets-upload"
            onClick={() => fileInput.current?.click()}
          >
            <Upload size={12} /> Upload
          </button>
          <button
            type="button"
            className="btn"
            data-testid="assets-optimize"
            disabled={!assets.some((a) => a.kind === 'image')}
            onClick={() => void optimize()}
          >
            <Sparkles size={12} /> Optimize
          </button>
          <input
            ref={fileInput}
            type="file"
            multiple
            hidden
            data-testid="assets-file-input"
            onChange={(e) => {
              const files = [...(e.target.files ?? [])];
              e.target.value = '';
              void upload(files);
            }}
          />
        </div>
        <div className="assets-filters">
          <label className="assets-check">
            <input
              type="checkbox"
              data-testid="assets-unused-filter"
              checked={unusedOnly}
              onChange={(e) => setUnusedOnly(e.target.checked)}
            />
            Unused ({unusedCount})
          </label>
          <button
            type="button"
            className="assets-link"
            data-testid="assets-remove-unused"
            disabled={unusedCount === 0}
            onClick={() => void removeUnused()}
          >
            Remove unused
          </button>
        </div>
      </div>
      <div
        className={`assets-dropzone${dragOver ? ' drag-over' : ''}`}
        data-testid="assets-dropzone"
        onDragOver={onDragOver}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          setDragOver(false);
          if (!e.dataTransfer.files.length) return;
          e.preventDefault();
          void upload([...e.dataTransfer.files]);
        }}
      >
        {error && <div className="assets-error">{error}</div>}
        {!error && visible.length === 0 && (
          <div className="assets-empty">
            {assets.length === 0
              ? 'No assets yet. Drag files here or use Upload.'
              : 'No assets match the filter.'}
          </div>
        )}
        <div className="assets-grid">
          {visible.map((a) => (
            <AssetItem
              key={a.path}
              docId={docId}
              asset={a}
              onChanged={() => void reload()}
              onAssets={actions}
            />
          ))}
        </div>
      </div>
      <LibrarySection
        docId={docId}
        assets={assets}
        refreshKey={libKey}
        onImported={() => void reload()}
      />
    </div>
  );
}
