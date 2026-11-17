/* eslint-disable @typescript-eslint/no-explicit-any -- o runtime acessa globais do navegador sem tipos DOM */
/**
 * Runtime dos efeitos (WebGL para shaders, canvas 2D para partículas).
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
  /** Opções dos parâmetros `select` (nome → opções), para o shader receber o índice da opção. */
  selects?: Record<string, string[]>;
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
  const g: any = globalThis;

  const parseColor = (value: unknown): number[] => {
    const str = String(value).trim().toLowerCase();
    if (str === 'transparent') return [0, 0, 0, 0];
    const hex = /^#([0-9a-f]{3,8})$/.exec(str);
    if (hex) {
      let h = hex[1];
      if (h.length === 3 || h.length === 4) {
        h = h
          .split('')
          .map((c) => c + c)
          .join('');
      }
      if (h.length === 6) h += 'ff';
      if (h.length === 8) return [0, 2, 4, 6].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
    }
    const fn = /^rgba?\(([^)]*)\)$/.exec(str);
    if (fn) {
      const parts = fn[1].split(/[\s,/]+/).filter(Boolean);
      if (parts.length >= 3) {
        const ch = (v: string, scale: number): number => {
          const x = v.endsWith('%') ? parseFloat(v) / 100 : parseFloat(v) / scale;
          return Math.max(0, Math.min(1, Number.isFinite(x) ? x : 0));
        };
        return [
          ch(parts[0], 255),
          ch(parts[1], 255),
          ch(parts[2], 255),
          parts.length > 3 ? ch(parts[3], 1) : 1,
        ];
      }
    }
    return [0, 0, 0, 1];
  };

  const toNumber = (v: unknown, fallback: number): number => {
    const n = typeof v === 'number' ? v : Number.NaN;
    return Number.isFinite(n) ? n : fallback;
  };

  const failed = (message: string): EffectHandle => ({
    setParams() {},
    resize() {},
    draw() {},
    destroy() {},
    ok: false,
    error: message,
  });

  // ---------- shaders (WebGL 1) ----------
  const mountShader = (cv: any, spec: EffectMountSpec): EffectHandle => {
    const selects = spec.selects || {};
    let params: Record<string, MediaParamValue> = { ...spec.params };
    let ok = false;
    let error: string | undefined;
    let destroyed = false;
    let gl: any = null;
    let prog: any = null;
    let buf: any = null;
    const locs: Record<string, any> = {};

    try {
      const opts = { premultipliedAlpha: true, antialias: false, preserveDrawingBuffer: true };
      gl = cv.getContext('webgl', opts) || cv.getContext('experimental-webgl', opts);
    } catch {
      gl = null;
    }

    const compile = (type: number, source: string): any => {
      const sh = gl.createShader(type);
      gl.shaderSource(sh, source);
      gl.compileShader(sh);
      if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
        const log = gl.getShaderInfoLog(sh) || 'erro desconhecido';
        gl.deleteShader(sh);
        throw new Error('Falha ao compilar o shader: ' + log);
      }
      return sh;
    };

    if (!gl) error = 'WebGL indisponível neste navegador.';
    else if (!spec.fragment) error = 'Efeito sem fragment shader.';
    else {
      try {
        const vs = compile(
          gl.VERTEX_SHADER,
          'attribute vec2 a_pos;void main(){gl_Position=vec4(a_pos,0.0,1.0);}',
        );
        const fs = compile(gl.FRAGMENT_SHADER, spec.fragment);
        prog = gl.createProgram();
        gl.attachShader(prog, vs);
        gl.attachShader(prog, fs);
        gl.bindAttribLocation(prog, 0, 'a_pos');
        gl.linkProgram(prog);
        gl.deleteShader(vs);
        gl.deleteShader(fs);
        if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
          throw new Error(
            'Falha ao ligar o programa: ' + (gl.getProgramInfoLog(prog) || 'erro desconhecido'),
          );
        }
        buf = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, buf);
        gl.bufferData(
          gl.ARRAY_BUFFER,
          new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]),
          gl.STATIC_DRAW,
        );
        ok = true;
      } catch (e: any) {
        error = String((e && e.message) || e);
        if (prog) gl.deleteProgram(prog);
        prog = null;
      }
    }

    const loc = (name: string): any => {
      if (!(name in locs)) locs[name] = gl.getUniformLocation(prog, name);
      return locs[name];
    };

    const handle: EffectHandle = {
      setParams(next) {
        params = { ...params, ...next };
      },
      resize(width, height, dpr = 1) {
        const w = Math.max(1, Math.round(width * dpr));
        const h = Math.max(1, Math.round(height * dpr));
        if (cv.width !== w) cv.width = w;
        if (cv.height !== h) cv.height = h;
      },
      draw(t) {
        if (!ok || destroyed) return;
        if (gl.isContextLost && gl.isContextLost()) return;
        const w = cv.width || 1;
        const h = cv.height || 1;
        gl.viewport(0, 0, w, h);
        gl.useProgram(prog);
        gl.bindBuffer(gl.ARRAY_BUFFER, buf);
        gl.enableVertexAttribArray(0);
        gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
        const rl = loc('u_resolution');
        if (rl) gl.uniform2f(rl, w, h);
        const sp = toNumber(params.speed, 1);
        const tl = loc('u_time');
        if (tl) gl.uniform1f(tl, t * sp);
        for (const name of Object.keys(params)) {
          const l = loc('u_' + name);
          if (!l) continue;
          const v = params[name];
          if (typeof v === 'number') gl.uniform1f(l, v);
          else if (typeof v === 'boolean') gl.uniform1f(l, v ? 1 : 0);
          else if (typeof v === 'string') {
            const opts = selects[name];
            if (opts) gl.uniform1f(l, Math.max(0, opts.indexOf(v)));
            else {
              const c = parseColor(v);
              gl.uniform4f(l, c[0], c[1], c[2], c[3]);
            }
          }
        }
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      },
      destroy() {
        if (destroyed) return;
        destroyed = true;
        if (gl && ok) {
          if (prog) gl.deleteProgram(prog);
          if (buf) gl.deleteBuffer(buf);
        }
      },
      get ok() {
        return ok;
      },
      get error() {
        return error;
      },
    };
    return handle;
  };

  // ---------- partículas (canvas 2D, determinísticas em (seed, i, t)) ----------
  const mountParticles = (cv: any, spec: EffectMountSpec): EffectHandle => {
    let ctx: any = null;
    try {
      ctx = cv.getContext('2d');
    } catch {
      ctx = null;
    }
    if (!ctx) return failed('Canvas 2D indisponível neste navegador.');
    let params: Record<string, MediaParamValue> = { ...spec.params };
    let dpr = 1;
    let destroyed = false;

    // hash determinístico em [0, 1)
    const hash = (seed: number, i: number, k: number): number => {
      const x = Math.sin(i * 127.1 + k * 311.7 + seed * 74.7 + 0.5) * 43758.5453;
      return x - Math.floor(x);
    };

    const handle: EffectHandle = {
      setParams(next) {
        params = { ...params, ...next };
      },
      resize(width, height, ratio = 1) {
        dpr = ratio;
        const w = Math.max(1, Math.round(width * ratio));
        const h = Math.max(1, Math.round(height * ratio));
        if (cv.width !== w) cv.width = w;
        if (cv.height !== h) cv.height = h;
      },
      draw(t) {
        if (destroyed) return;
        const W = cv.width || 1;
        const H = cv.height || 1;
        const p = params;
        const count = Math.max(0, Math.min(5000, Math.round(toNumber(p.count, 120))));
        const size = Math.max(0.1, toNumber(p.size, 2.5));
        const tt = t * toNumber(p.speed, 1);
        const twinkle = Math.max(0, Math.min(1, toNumber(p.twinkle, 0.5)));
        const seed = toNumber(p.seed, 1);
        const dir = String(p.direction || 'up');
        const links = p.links === true;
        const fg = String(p.color || '#ffffff');

        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.globalAlpha = 1;
        const bg = String(p.background === undefined ? '#000000' : p.background);
        if (parseColor(bg)[3] === 0) ctx.clearRect(0, 0, W, H);
        else {
          ctx.fillStyle = bg;
          ctx.fillRect(0, 0, W, H);
        }

        const xs: number[] = [];
        const ys: number[] = [];
        const as: number[] = [];
        ctx.fillStyle = fg;
        for (let i = 0; i < count; i++) {
          let dx = 0;
          let dy = 0;
          if (dir === 'up') dy = -1;
          else if (dir === 'down') dy = 1;
          else if (dir === 'left') dx = -1;
          else if (dir === 'right') dx = 1;
          else {
            const ang = hash(seed, i, 6) * Math.PI * 2;
            dx = Math.cos(ang);
            dy = Math.sin(ang);
          }
          const v = (0.35 + 0.65 * hash(seed, i, 3)) * 0.06;
          const phase = hash(seed, i, 5) * Math.PI * 2;
          const sway = 0.012 * Math.sin(tt * 0.7 * (0.5 + hash(seed, i, 7)) + phase);
          const ux = hash(seed, i, 1) + dx * v * tt - dy * sway;
          const uy = hash(seed, i, 2) + dy * v * tt + dx * sway;
          const x = ux - Math.floor(ux);
          const y = uy - Math.floor(uy);
          const edge = Math.min(1, Math.min(x, 1 - x, y, 1 - y) / 0.04);
          const tw =
            1 -
            twinkle +
            twinkle * (0.5 + 0.5 * Math.sin(tt * (1.2 + 2 * hash(seed, i, 9)) + phase));
          const a = (0.35 + 0.65 * hash(seed, i, 8)) * tw * edge;
          const px = x * W;
          const py = y * H;
          const r = size * dpr * (0.4 + 0.8 * hash(seed, i, 4));
          xs.push(px);
          ys.push(py);
          as.push(a);
          ctx.globalAlpha = a;
          ctx.beginPath();
          ctx.arc(px, py, r, 0, Math.PI * 2);
          ctx.fill();
        }

        if (links && count > 1) {
          const D = Math.max(40 * dpr, Math.min(W, H) * 0.15);
          const cols = Math.ceil(W / D) + 1;
          const grid = new Map<number, number[]>();
          for (let i = 0; i < count; i++) {
            const key = Math.floor(ys[i] / D) * cols + Math.floor(xs[i] / D);
            const cell = grid.get(key);
            if (cell) cell.push(i);
            else grid.set(key, [i]);
          }
          ctx.strokeStyle = fg;
          ctx.lineWidth = Math.max(1, dpr * 0.8);
          let drawn = 0;
          for (let i = 0; i < count && drawn < 4000; i++) {
            const cx = Math.floor(xs[i] / D);
            const cy = Math.floor(ys[i] / D);
            for (let oy = -1; oy <= 1; oy++) {
              for (let ox = -1; ox <= 1; ox++) {
                const cell = grid.get((cy + oy) * cols + (cx + ox));
                if (!cell) continue;
                for (const j of cell) {
                  if (j <= i) continue;
                  const ddx = xs[i] - xs[j];
                  const ddy = ys[i] - ys[j];
                  const d = Math.sqrt(ddx * ddx + ddy * ddy);
                  if (d >= D) continue;
                  ctx.globalAlpha = (1 - d / D) * 0.5 * Math.min(as[i], as[j]);
                  ctx.beginPath();
                  ctx.moveTo(xs[i], ys[i]);
                  ctx.lineTo(xs[j], ys[j]);
                  ctx.stroke();
                  drawn++;
                }
              }
            }
          }
        }
        ctx.globalAlpha = 1;
      },
      destroy() {
        destroyed = true;
      },
      get ok() {
        return true;
      },
      get error() {
        return undefined;
      },
    };
    return handle;
  };

  const mount = (canvas: unknown, spec: EffectMountSpec): EffectHandle => {
    const cv: any = canvas;
    if (!cv || typeof cv.getContext !== 'function') return failed('Canvas inválido.');
    return spec.category === 'particles' ? mountParticles(cv, spec) : mountShader(cv, spec);
  };

  const play = (canvas: unknown, spec: EffectMountSpec): EffectPlayer => {
    const cv: any = canvas;
    const handle = mount(canvas, spec);
    let raf = 0;
    let stopped = false;
    let observer: any = null;
    const reduced = !!(
      typeof g.matchMedia === 'function' && g.matchMedia('(prefers-reduced-motion: reduce)').matches
    );
    const animated = !reduced && toNumber(spec.params.speed, 1) !== 0;
    const now = (): number =>
      g.performance && g.performance.now ? g.performance.now() : Date.now();
    const start = now();

    const fit = (): void => {
      const ratio = Math.min(2, g.devicePixelRatio || 1);
      const w = cv.clientWidth || cv.width || 1;
      const h = cv.clientHeight || cv.height || 1;
      handle.resize(w, h, ratio);
    };
    const tick = (): void => {
      if (stopped) return;
      handle.draw((now() - start) / 1000);
      raf = g.requestAnimationFrame(tick);
    };

    fit();
    handle.draw(0);
    if (typeof g.ResizeObserver === 'function') {
      observer = new g.ResizeObserver(() => {
        if (stopped) return;
        fit();
        // redimensionar apaga o quadro: redesenha já (no modo animado o laço cobre o resto)
        if (!animated) handle.draw(0);
      });
      observer.observe(cv);
    }
    if (handle.ok && animated && typeof g.requestAnimationFrame === 'function') {
      raf = g.requestAnimationFrame(tick);
    }

    return {
      handle,
      stop() {
        if (stopped) return;
        stopped = true;
        if (raf && typeof g.cancelAnimationFrame === 'function') g.cancelAnimationFrame(raf);
        if (observer) observer.disconnect();
        handle.destroy();
      },
    };
  };

  return { mount, play };
}

/** Código JS (expressão) que avalia para o `EffectsRuntime`: `(function mockupEffectsRuntime(){...})()`. */
export function effectsRuntimeSource(): string {
  return `(${mockupEffectsRuntime.toString()})()`;
}

/** Spec de montagem (definição do catálogo + parâmetros resolvidos). */
export function effectMountSpec(spec: EffectSpec): EffectMountSpec {
  const def = getEffect(spec.kind);
  const selects: Record<string, string[]> = {};
  for (const p of def?.params ?? [])
    if (p.type === 'select' && p.options) selects[p.name] = p.options;
  return {
    kind: spec.kind,
    category: def?.category ?? 'shader',
    params: resolveEffectParams(spec.kind, spec.params),
    ...(def?.fragment ? { fragment: def.fragment } : {}),
    ...(Object.keys(selects).length ? { selects } : {}),
  };
}
