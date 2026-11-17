/** Painel de assets do documento ativo + biblioteca global (CDN). */
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
          title={unused ? 'Não usado' : 'Selecionar os nós que usam'}
          disabled={unused}
          onClick={() => {
            if (!revealNodes(asset.nodeIds))
              ui.toast('Os nós que usam este asset não estão no documento.');
          }}
        >
          {unused ? 'não usado' : `${asset.uses} ${asset.uses === 1 ? 'uso' : 'usos'}`}
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
            title="Inserir no canvas"
            onClick={() => void insertAsset(asset).then(onChanged)}
          >
            <Plus size={13} />
          </button>
        )}
        <button
          type="button"
          className="asset-btn"
          data-testid="asset-copy-link"
          title="Copiar link (CDN)"
          onClick={() => void onAssets.copyLink(asset)}
        >
          <Copy size={13} />
        </button>
        <button
          type="button"
          className="asset-btn"
          data-testid="asset-to-library"
          title="Enviar para a biblioteca"
          onClick={() => void onAssets.toLibrary(asset)}
        >
          <Library size={13} />
        </button>
        <button
          type="button"
          className="asset-btn danger"
          data-testid="asset-delete"
          title="Remover"
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
      ui.toast(`"${a.name}" importado para o documento.`);
      onImported();
    } catch (e) {
      ui.toast(errorText(e), 'error');
    }
  };
  const removeOne = async (a: LibraryAsset) => {
    if (
      !(await confirmDialog(
        'Remover da biblioteca',
        `Remover "${a.name}" da biblioteca?`,
        'Remover',
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
        <span>Biblioteca</span>
      </button>
      {open && (
        <div className="assets-library-body">
          <input
            className="assets-search"
            data-testid="library-search"
            placeholder="Buscar na biblioteca"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          {error && <div className="assets-error">{error}</div>}
          {!error && items.length === 0 && (
            <div className="assets-empty">Biblioteca vazia. Envie um asset do documento.</div>
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
                  {inDoc.has(a.hash) ? ' · no documento' : ''}
                </div>
                <div className="asset-actions">
                  <button
                    type="button"
                    className="asset-btn"
                    data-testid="library-import"
                    title="Importar para o documento"
                    onClick={() => void importOne(a)}
                  >
                    <Download size={13} />
                  </button>
                  <button
                    type="button"
                    className="asset-btn danger"
                    data-testid="library-delete"
                    title="Remover da biblioteca"
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

  // Recarrega ao trocar de documento e (com debounce) quando o documento muda.
  useEffect(() => {
    const t = setTimeout(() => void reload(), 300);
    return () => clearTimeout(t);
  }, [reload, doc]);

  // Soltar um asset sobre o canvas insere um nó `img`.
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
    if (ok) ui.toast(ok === 1 ? 'Arquivo enviado.' : `${ok} arquivos enviados.`);
    await reload();
  };

  const actions: AssetActions = {
    async copyLink(a) {
      if (!docId) return;
      try {
        const { url } = await api.assets.link(docId, a.path);
        try {
          await navigator.clipboard.writeText(url);
          ui.toast(`Link copiado: ${url}`);
        } catch {
          ui.toast(`Não foi possível copiar automaticamente. Link: ${url}`);
        }
      } catch (e) {
        ui.toast(errorText(e), 'error');
      }
    },
    async remove(a) {
      if (!docId) return;
      const inUse = a.uses > 0;
      const ok = await confirmDialog(
        'Remover asset',
        inUse
          ? `"${a.path}" é usado por ${a.uses} ${a.uses === 1 ? 'nó' : 'nós'}. Remover mesmo assim? Os nós ficarão com imagem quebrada.`
          : `Remover "${a.path}" do documento?`,
        'Remover',
      );
      if (!ok) return;
      try {
        try {
          await api.assets.remove(docId, a.path, inUse);
        } catch (e) {
          if (!(e instanceof ApiError && e.status === 409)) throw e;
          if (
            !(await confirmDialog(
              'Asset em uso',
              `"${a.path}" está em uso. Remover mesmo assim?`,
              'Remover',
            ))
          )
            return;
          await api.assets.remove(docId, a.path, true);
        }
        ui.toast(`"${a.name}" removido.`);
      } catch (e) {
        ui.toast(errorText(e), 'error');
      }
      await reload();
    },
    async toLibrary(a) {
      if (!docId) return;
      try {
        const res = await fetch(assetViewUrl(docId, a.path));
        if (!res.ok) throw new Error(`Não foi possível ler "${a.name}" (${res.status}).`);
        await api.library.upload(await res.blob(), a.name);
        ui.toast(`"${a.name}" enviado para a biblioteca.`);
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
        ui.toast('Não há assets sem uso.');
        return;
      }
      const ok = await confirmDialog(
        'Remover não usados',
        <div>
          <p>
            {dry.removed.length}{' '}
            {dry.removed.length === 1 ? 'arquivo será removido' : 'arquivos serão removidos'}:
          </p>
          <ul className="assets-confirm-list" data-testid="assets-remove-list">
            {dry.removed.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        </div>,
        'Remover',
      );
      if (!ok) return;
      const res = await api.assets.removeUnused(docId, false);
      ui.toast(
        `${res.removed.length} ${res.removed.length === 1 ? 'arquivo removido' : 'arquivos removidos'}.`,
      );
    } catch (e) {
      ui.toast(errorText(e), 'error');
    }
    await reload();
  };

  const optimize = async () => {
    if (!docId) return;
    const r = await prompt({
      title: 'Otimizar imagens',
      message:
        'Converte as imagens para WebP. Informe a largura máxima ou deixe em branco para manter o tamanho.',
      fields: [{ name: 'maxWidth', label: 'Largura máxima (px, opcional)', placeholder: '1600' }],
      confirmLabel: 'Otimizar',
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
        <div className="assets-empty">Abra um documento para ver os assets.</div>
      </div>
    );
  }
  if (!hasPath) {
    return (
      <div className="assets-panel" data-testid="assets-panel">
        <div className="assets-empty" data-testid="assets-unsaved">
          Salve o documento para gerenciar assets
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
            placeholder="Buscar assets"
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
            <Upload size={12} /> Enviar
          </button>
          <button
            type="button"
            className="btn"
            data-testid="assets-optimize"
            disabled={!assets.some((a) => a.kind === 'image')}
            onClick={() => void optimize()}
          >
            <Sparkles size={12} /> Otimizar
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
            Não usados ({unusedCount})
          </label>
          <button
            type="button"
            className="assets-link"
            data-testid="assets-remove-unused"
            disabled={unusedCount === 0}
            onClick={() => void removeUnused()}
          >
            Remover não usados
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
              ? 'Nenhum asset ainda. Arraste arquivos para cá ou use Enviar.'
              : 'Nenhum asset corresponde ao filtro.'}
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
