/** Botão "Efeitos" da barra e o popover com a galeria de presets (miniaturas geradas pelo runtime). */
import { useEffect, useRef, useState } from 'react';
import { Sparkles } from 'lucide-react';
import { EFFECTS } from '@mockup/core';
import type { EffectCategory, EffectDef } from '@mockup/core';
import { insertEffect } from './insertFlow';
import { effectThumbnail } from './thumbnails';
import './effects.css';

const CATEGORY_LABELS: Record<EffectCategory, string> = {
  shader: 'Shaders',
  particles: 'Partículas',
};

function Thumb({ kind, preset }: { kind: string; preset: string }) {
  const [url, setUrl] = useState<string | null | undefined>(undefined);
  useEffect(() => {
    let alive = true;
    void effectThumbnail(kind, preset).then((u) => alive && setUrl(u));
    return () => {
      alive = false;
    };
  }, [kind, preset]);
  return (
    <span className="fx-thumb">
      {url ? <img src={url} alt="" draggable={false} /> : <span className="fx-thumb-empty" />}
    </span>
  );
}

function PresetCard({
  def,
  preset,
  label,
  onInsert,
}: {
  def: EffectDef;
  preset: string;
  label: string;
  onInsert: (kind: string, preset: string, asLayer: boolean) => void;
}) {
  return (
    <button
      type="button"
      className="fx-card"
      data-testid={`effect-preset-${def.kind}-${preset}`}
      title={`${def.label} · ${label}\nClique: fundo do frame. Alt+clique ou botão direito: camada.`}
      onClick={(e) => onInsert(def.kind, preset, e.altKey)}
      onContextMenu={(e) => {
        e.preventDefault();
        onInsert(def.kind, preset, true);
      }}
    >
      <Thumb kind={def.kind} preset={preset} />
      <span className="fx-card-label">{label}</span>
    </button>
  );
}

export function EffectsPanel({ onClose }: { onClose: () => void }) {
  const groups = (Object.keys(CATEGORY_LABELS) as EffectCategory[])
    .map((category) => ({ category, defs: EFFECTS.filter((d) => d.category === category) }))
    .filter((g) => g.defs.length);
  const onInsert = (kind: string, preset: string, asLayer: boolean) => {
    onClose();
    void insertEffect(kind, preset || undefined, { asLayer });
  };
  return (
    <div className="fx-panel" data-testid="effects-panel" role="dialog" aria-label="Efeitos">
      <p className="fx-hint">
        Clique para usar como fundo do frame selecionado. Alt+clique ou botão direito insere como
        camada.
      </p>
      {groups.length === 0 && <div className="fx-empty">Nenhum efeito disponível.</div>}
      {groups.map((g) => (
        <section key={g.category} className="fx-group">
          <h3>{CATEGORY_LABELS[g.category]}</h3>
          {g.defs.map((def) => (
            <div key={def.kind} className="fx-kind">
              <div className="fx-kind-title" title={def.description}>
                {def.label}
              </div>
              <div className="fx-grid">
                {(def.presets.length
                  ? def.presets
                  : [{ name: '', label: 'Padrão', params: {} }]
                ).map((p) => (
                  <PresetCard
                    key={p.name}
                    def={def}
                    preset={p.name}
                    label={p.label}
                    onInsert={onInsert}
                  />
                ))}
              </div>
            </div>
          ))}
        </section>
      ))}
    </div>
  );
}

export function EffectsButton() {
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
    return () => {
      window.removeEventListener('pointerdown', onDown, true);
      window.removeEventListener('keydown', onKey, true);
    };
  }, [open]);
  return (
    <div className="tb-dd" ref={ref}>
      <button
        type="button"
        className={`tb-dd-trigger${open ? ' open' : ''}`}
        data-testid="effects-button"
        title="Efeitos"
        aria-label="Efeitos"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <Sparkles size={16} />
      </button>
      {open && <EffectsPanel onClose={() => setOpen(false)} />}
    </div>
  );
}
