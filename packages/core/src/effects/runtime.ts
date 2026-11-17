/**
 * Runtime dos efeitos (WebGL para shaders, canvas 2D para partículas). CONTRATO (stub).
 *
 * `mockupEffectsRuntime` é uma fábrica AUTOCONTIDA: o corpo não referencia nada do módulo (só
 * tipos, que somem na compilação), para que `effectsRuntimeSource()` (via `toString`) seja
 * embutido no código exportado (HTML e React) e rode igual ao editor. Globais do navegador são
 * acessados por `globalThis`.
 */
import type { EffectSpec, MediaParamValue } from '../types.js';
import { getEffect, resolveEffectParams, type EffectCategory } from './catalog.js';

export interface EffectMountSpec {
  kind: string;
  category: EffectCategory;
  params: Record<string, MediaParamValue>;
  /** Fragment shader (categoria `shader`). */
  fragment?: string;
}

export interface EffectHandle {
  /** Troca os parâmetros (sem recriar o contexto). */
  setParams(params: Record<string, MediaParamValue>): void;
  /** Ajusta o tamanho do canvas (px CSS) e a densidade (padrão 1). */
  resize(width: number, height: number, dpr?: number): void;
  /** Desenha o quadro no tempo `t` (s; já multiplicado pela velocidade do efeito internamente). */
  draw(t: number): void;
  destroy(): void;
  /** `false` quando o WebGL/canvas não está disponível ou o shader não compilou. */
  readonly ok: boolean;
  readonly error?: string;
}

export interface EffectPlayer {
  stop(): void;
  handle: EffectHandle;
}

export interface EffectsRuntime {
  /** Monta o efeito num `<canvas>` (sem laço: quem chama decide quando desenhar). */
  mount(canvas: unknown, spec: EffectMountSpec): EffectHandle;
  /**
   * Monta e anima com `requestAnimationFrame`, acompanhando o tamanho do canvas
   * (`ResizeObserver`) e respeitando `prefers-reduced-motion` (desenha só o quadro 0).
   */
  play(canvas: unknown, spec: EffectMountSpec): EffectPlayer;
}

export function mockupEffectsRuntime(): EffectsRuntime {
  const mount = (_canvas: unknown, _spec: EffectMountSpec): EffectHandle => ({
    setParams() {},
    resize() {},
    draw() {},
    destroy() {},
    ok: false,
    error: 'runtime não implementado',
  });
  return {
    mount,
    play(canvas, spec) {
      const handle = mount(canvas, spec);
      return { handle, stop: () => handle.destroy() };
    },
  };
}

/** Código JS (expressão) que avalia para o `EffectsRuntime`: `(function mockupEffectsRuntime(){...})()`. */
export function effectsRuntimeSource(): string {
  return `(${mockupEffectsRuntime.toString()})()`;
}

/** Spec de montagem (definição do catálogo + parâmetros resolvidos). */
export function effectMountSpec(spec: EffectSpec): EffectMountSpec {
  const def = getEffect(spec.kind);
  return {
    kind: spec.kind,
    category: def?.category ?? 'shader',
    params: resolveEffectParams(spec.kind, spec.params),
    ...(def?.fragment ? { fragment: def.fragment } : {}),
  };
}
