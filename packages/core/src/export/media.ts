/**
 * Nós de mídia (effect, video, embed) nos exportadores: elementos HTML, scripts do HTML/Tailwind
 * e arquivos extras do React. Não importa `common.ts` nem `html.ts` (evita ciclos): quem chama
 * entrega a resolução de URLs.
 */
import { dropUnsafeStyles } from '../styles.js';
import { effectFallbackCss } from '../effects/catalog.js';
import { effectMountSpec, effectsRuntimeSource } from '../effects/runtime.js';
import { youtubeEmbedUrl, youtubeId, youtubeStart } from '../media.js';
import type { EmbedSpec, MediaParamValue, Node } from '../types.js';

/** Versão major.minor do Three.js carregado do CDN no HTML (a instalada no monorepo). */
export const THREE_CDN_VERSION = '0.187';
export const THREE_CDN_URL = `https://cdn.jsdelivr.net/npm/three@${THREE_CDN_VERSION}/build/three.module.js`;
export const LOTTIE_CDN_URL =
  'https://cdn.jsdelivr.net/npm/lottie-web@5/build/player/lottie_light.min.js';
export const RIVE_CDN_URL = 'https://unpkg.com/@rive-app/canvas@2';

export const EMBED_LABELS: Record<EmbedSpec['provider'], string> = {
  lottie: 'Lottie',
  rive: 'Rive',
  youtube: 'YouTube',
  three: 'Three.js',
  iframe: 'Iframe',
};

/* ---------------- Atributos ---------------- */

/** `[nome, valor]` (aspas duplas), `[nome, true]` (booleano) ou `[nome, valor, "'"]` (aspas simples). */
export type MediaAttr = [string, string | true] | [string, string, "'"];

const escDouble = (s: string): string =>
  s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

const escSingle = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/'/g, '&#39;');

/** Atributos prontos para a tag (XHTML: booleanos viram `nome="nome"`). */
export function renderMediaAttrs(attrs: MediaAttr[], xhtml = false): string[] {
  return attrs.map(([k, v, q]) => {
    if (v === true) return xhtml ? `${k}="${k}"` : k;
    return q === "'" ? `${k}='${escSingle(v)}'` : `${k}="${escDouble(v)}"`;
  });
}

/** Resolve uma referência (`assets/` ou URL) para a URL exportada; `null` descarta o atributo. */
export type MediaUrl = (ref: string, kind: 'file' | 'poster') => string | null;

export interface MediaElement {
  tag: string;
  attrs: MediaAttr[];
}

/** Escritas de scripts e arquivos que o markup `live` exige. */
export interface MediaCollector {
  /** kind → fragment shader (ou `undefined` para partículas). */
  effects: Map<string, string | undefined>;
  lottie: boolean;
  rive: boolean;
  three: { code: string; params: Record<string, MediaParamValue> }[];
}

export function newMediaCollector(): MediaCollector {
  return { effects: new Map(), lottie: false, rive: false, three: [] };
}

export function paramBool(
  params: Record<string, MediaParamValue> | undefined,
  name: string,
  def: boolean,
): boolean {
  const v = params?.[name];
  if (typeof v === 'boolean') return v;
  if (v === 'true') return true;
  if (v === 'false') return false;
  return def;
}

function paramStr(
  params: Record<string, MediaParamValue> | undefined,
  name: string,
): string | undefined {
  const v = params?.[name];
  return typeof v === 'string' && v !== '' ? v : undefined;
}

const httpUrl = (u: string | undefined): string | null =>
  u && /^https?:\/\/[^\s"'<>`\\]+$/i.test(u) ? u : null;

/** URL de embed (sem cookies) de um nó YouTube, com `start`/`autoplay`/`loop`/`muted`/`controls` dos params. */
export function youtubeSrc(embed: EmbedSpec): string | null {
  const id = embed.url ? youtubeId(embed.url) : null;
  if (!id || !embed.url) return null;
  const p = embed.params;
  const startParam = typeof p?.start === 'number' ? p.start : undefined;
  return youtubeEmbedUrl(id, {
    start: youtubeStart(embed.url) ?? startParam,
    autoplay: paramBool(p, 'autoplay', false),
    loop: paramBool(p, 'loop', false),
    muted: paramBool(p, 'muted', false),
    controls: paramBool(p, 'controls', true),
  });
}

export const YOUTUBE_ALLOW = 'autoplay; encrypted-media; picture-in-picture';
export const IFRAME_SANDBOX = 'allow-scripts allow-same-origin allow-popups';

/** Fragmento de `style` extra de nós de mídia: fundo de fallback dos efeitos e `border:0` em iframes. */
export function mediaStyleDefaults(node: Node): Record<string, string> {
  if (node.type === 'effect' && node.effect)
    return dropUnsafeStyles(effectFallbackCss(node.effect));
  if (
    node.type === 'embed' &&
    (node.embed?.provider === 'iframe' || node.embed?.provider === 'youtube')
  )
    return { border: '0' };
  return {};
}

export interface MediaElementOptions {
  url: MediaUrl;
  /**
   * `live`: markup do export (canvas + scripts; registra o que precisa em `collector`).
   * `static`: markup inerte (`data-mockup-*`), sem scripts: get_html e foreignObject do SVG.
   */
  mode: 'live' | 'static';
  collector?: MediaCollector;
  /**
   * Só em `static`: embeds viram `<div data-mockup-embed>` com src/url/código/parâmetros em
   * atributos `data-*`, para o parser de HTML reconstruir o nó (get_html → write_html).
   */
  roundtrip?: boolean;
}

/** Elemento HTML de um nó effect/video/embed; `null` se o nó não tem a especificação ou ela não serve. */
export function mediaElement(node: Node, o: MediaElementOptions): MediaElement | null {
  const live = o.mode === 'live';
  const c = o.collector ?? newMediaCollector();

  if (node.type === 'effect' && node.effect) {
    if (!live) {
      return {
        tag: 'div',
        attrs: [
          ['data-mockup-effect', node.effect.kind],
          ['data-params', JSON.stringify(node.effect.params), "'"],
        ],
      };
    }
    const { fragment, ...mount } = effectMountSpec(node.effect);
    c.effects.set(mount.kind, fragment);
    return {
      tag: 'canvas',
      attrs: [['data-mockup-effect', JSON.stringify(mount), "'"]],
    };
  }

  if (node.type === 'video' && node.video) {
    const v = node.video;
    const src = o.url(v.src, 'file');
    if (!src) return null;
    const attrs: MediaAttr[] = [['src', src]];
    const poster = v.poster ? o.url(v.poster, 'poster') : null;
    if (poster) attrs.push(['poster', poster]);
    if (v.autoplay) attrs.push(['autoplay', true]);
    if (v.loop) attrs.push(['loop', true]);
    if (v.muted) attrs.push(['muted', true]);
    if (v.controls) attrs.push(['controls', true]);
    attrs.push(['playsinline', true]);
    return { tag: 'video', attrs };
  }

  if (node.type === 'embed' && node.embed && !live && o.roundtrip) {
    const e = node.embed;
    const attrs: MediaAttr[] = [['data-mockup-embed', e.provider]];
    if (e.src) {
      const src = o.url(e.src, 'file');
      if (!src) return null;
      attrs.push(['data-src', src]);
    }
    if (e.url) {
      const url = httpUrl(e.url);
      if (!url) return null;
      attrs.push(['data-url', url]);
    }
    if (typeof e.code === 'string') attrs.push(['data-code', e.code]);
    if (e.params && Object.keys(e.params).length)
      attrs.push(['data-params', JSON.stringify(e.params), "'"]);
    return { tag: 'div', attrs };
  }

  if (node.type === 'embed' && node.embed) {
    const e = node.embed;
    switch (e.provider) {
      case 'youtube': {
        const src = youtubeSrc(e);
        if (!src) return null;
        return {
          tag: 'iframe',
          attrs: [
            ['src', src],
            ['title', 'YouTube'],
            ['allow', YOUTUBE_ALLOW],
            ['allowfullscreen', true],
            ['loading', 'lazy'],
          ],
        };
      }
      case 'iframe': {
        const src = httpUrl(e.url);
        if (!src) return null;
        return {
          tag: 'iframe',
          attrs: [
            ['src', src],
            ['sandbox', IFRAME_SANDBOX],
            ['loading', 'lazy'],
          ],
        };
      }
      case 'lottie':
      case 'rive': {
        const src = e.src ? o.url(e.src, 'file') : null;
        if (!src) return null;
        const attrs: MediaAttr[] = [
          ['data-mockup-embed', e.provider],
          ['data-src', src],
        ];
        if (!live) return { tag: 'div', attrs };
        attrs.push(['data-autoplay', String(paramBool(e.params, 'autoplay', true))]);
        if (e.provider === 'lottie') {
          c.lottie = true;
          attrs.push(['data-loop', String(paramBool(e.params, 'loop', true))]);
          return { tag: 'div', attrs };
        }
        c.rive = true;
        const artboard = paramStr(e.params, 'artboard');
        const machine = paramStr(e.params, 'stateMachine');
        if (artboard) attrs.push(['data-artboard', artboard]);
        if (machine) attrs.push(['data-state-machine', machine]);
        return { tag: 'canvas', attrs };
      }
      case 'three': {
        if (typeof e.code !== 'string') return null;
        if (!live) return { tag: 'div', attrs: [['data-mockup-embed', 'three']] };
        c.three.push({ code: e.code, params: e.params ?? {} });
        return {
          tag: 'canvas',
          attrs: [
            ['data-mockup-embed', 'three'],
            ['data-island', String(c.three.length - 1)],
          ],
        };
      }
    }
  }
  return null;
}

/* ---------------- Scripts do HTML / Tailwind ---------------- */

/** Impede que o conteúdo de um `<script>` o feche (`</` → `<\/`) ou abra comentário (`<!--`). */
export function escapeScript(s: string): string {
  return s.replace(/<\//g, '<\\/').replace(/<!--/g, '<\\!--');
}

const CDN_NOTE =
  '// Lottie, Rive e Three.js neste HTML usam bibliotecas de CDN (o export React usa os pacotes npm).';

/**
 * Laço de uma ilha Three.js (compartilhado entre o HTML e o arquivo `three-*.js` do React).
 * Cria o WebGLRenderer, anima com requestAnimationFrame, acompanha o tamanho e devolve o cleanup.
 */
const THREE_RUNNER = `function runIsland(THREE, make, canvas, params) {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
  const measure = () => ({
    width: Math.max(1, canvas.clientWidth || canvas.width),
    height: Math.max(1, canvas.clientHeight || canvas.height),
  });
  const size = measure();
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setSize(size.width, size.height, false);
  const island = make(THREE, renderer, canvas, size.width, size.height, params);
  const t0 = performance.now();
  let raf = 0;
  const frame = () => {
    raf = requestAnimationFrame(frame);
    if (island.update) island.update((performance.now() - t0) / 1000);
    renderer.render(island.scene, island.camera);
  };
  frame();
  const observer = new ResizeObserver(() => {
    const s = measure();
    renderer.setSize(s.width, s.height, false);
    if (island.camera.isPerspectiveCamera) {
      island.camera.aspect = s.width / s.height;
      island.camera.updateProjectionMatrix();
    }
  });
  observer.observe(canvas);
  return () => {
    cancelAnimationFrame(raf);
    observer.disconnect();
    renderer.dispose();
  };
}`;

const makeSource = (code: string): string =>
  `function make(THREE, renderer, canvas, width, height, params) {\n${code.replace(/\n?$/, '\n')}}`;

/** `<script>`s (CDN, auto-montagem) dos recursos usados; string vazia se não há nenhum. */
export function mediaScripts(c: MediaCollector): string {
  const out: string[] = [];

  if (c.effects.size > 0) {
    const fragments: Record<string, string> = {};
    for (const [kind, f] of c.effects) if (f) fragments[kind] = f;
    out.push(
      escapeScript(
        [
          '<script>',
          '// Efeitos: runtime do Mockup Studio (WebGL/canvas 2D) + montagem de todos os <canvas data-mockup-effect>.',
          '(function () {',
          `const R = ${effectsRuntimeSource()};`,
          `const FRAGMENTS = ${JSON.stringify(fragments)};`,
          "document.querySelectorAll('canvas[data-mockup-effect]').forEach(function (canvas) {",
          "  var spec = JSON.parse(canvas.getAttribute('data-mockup-effect') || '{}');",
          '  if (FRAGMENTS[spec.kind]) spec.fragment = FRAGMENTS[spec.kind];',
          '  R.play(canvas, spec);',
          '});',
          '})();',
          '</script>',
        ].join('\n'),
      ),
    );
  }

  if (c.lottie) {
    out.push(
      [
        `<script src="${LOTTIE_CDN_URL}"></script>`,
        '<script>',
        CDN_NOTE,
        `document.querySelectorAll('[data-mockup-embed="lottie"]').forEach(function (el) {`,
        '  lottie.loadAnimation({',
        '    container: el,',
        "    path: el.getAttribute('data-src'),",
        "    loop: el.getAttribute('data-loop') !== 'false',",
        "    autoplay: el.getAttribute('data-autoplay') !== 'false',",
        "    renderer: 'svg',",
        '  });',
        '});',
        '</script>',
      ].join('\n'),
    );
  }

  if (c.rive) {
    out.push(
      [
        `<script src="${RIVE_CDN_URL}"></script>`,
        '<script>',
        CDN_NOTE,
        `document.querySelectorAll('canvas[data-mockup-embed="rive"]').forEach(function (canvas) {`,
        '  var options = {',
        "    src: canvas.getAttribute('data-src'),",
        '    canvas: canvas,',
        "    autoplay: canvas.getAttribute('data-autoplay') !== 'false',",
        '    onLoad: function () { instance.resizeDrawingSurfaceToCanvas(); },',
        '  };',
        "  var artboard = canvas.getAttribute('data-artboard');",
        '  if (artboard) options.artboard = artboard;',
        "  var machine = canvas.getAttribute('data-state-machine');",
        '  if (machine) options.stateMachines = machine;',
        '  var instance = new rive.Rive(options);',
        '});',
        '</script>',
      ].join('\n'),
    );
  }

  if (c.three.length > 0) {
    const islands = c.three.map(
      (t) =>
        `  { params: ${JSON.stringify(t.params)}, make: (THREE, renderer, canvas, width, height, params) => {\n${t.code.replace(/\n?$/, '\n')}} },`,
    );
    out.push(
      escapeScript(
        [
          '<script type="module">',
          CDN_NOTE,
          `import * as THREE from '${THREE_CDN_URL}';`,
          'const ISLANDS = [',
          ...islands,
          '];',
          THREE_RUNNER,
          'document.querySelectorAll(\'canvas[data-mockup-embed="three"]\').forEach((canvas) => {',
          "  const island = ISLANDS[Number(canvas.getAttribute('data-island'))];",
          '  if (island) runIsland(THREE, island.make, canvas, island.params);',
          '});',
          '</script>',
        ].join('\n'),
      ),
    );
  }

  return out.join('\n');
}

/* ---------------- Arquivos extras do React ---------------- */

const EFFECTS_DTS = `export type EffectParamValue = string | number | boolean;

/** Especificação de montagem de um efeito (o fragment shader vem de FRAGMENTS pelo \`kind\`). */
export interface EffectMount {
  kind: string;
  category: 'shader' | 'particles';
  params: Record<string, EffectParamValue>;
  /** Opções dos parâmetros \`select\` (o shader recebe o índice da opção). */
  selects?: Record<string, string[]>;
}

export interface EffectStop {
  stop(): void;
}

/** Fragment shaders dos efeitos usados, por \`kind\`. */
export const FRAGMENTS: Record<string, string>;

/** Monta e anima o efeito no canvas; chame \`stop()\` para desmontar. */
export function playEffect(canvas: HTMLCanvasElement, spec: EffectMount): EffectStop;
`;

/** `mockup-effects.js` + `.d.ts`: runtime dos efeitos e fragments dos `kind`s usados. */
export function reactEffectsFiles(
  fragments: Map<string, string | undefined>,
): { name: string; code: string }[] {
  const map: Record<string, string> = {};
  for (const [kind, f] of fragments) if (f) map[kind] = f;
  const js = [
    '// Runtime dos efeitos do Mockup Studio (WebGL/canvas 2D). Gerado: não edite à mão.',
    `const runtime = ${effectsRuntimeSource()};`,
    '',
    `export const FRAGMENTS = ${JSON.stringify(map, null, 2)};`,
    '',
    'export function playEffect(canvas, spec) {',
    '  const fragment = FRAGMENTS[spec.kind];',
    '  return runtime.play(canvas, fragment ? { ...spec, fragment } : spec);',
    '}',
    '',
  ].join('\n');
  return [
    { name: 'mockup-effects.js', code: js },
    { name: 'mockup-effects.d.ts', code: EFFECTS_DTS },
  ];
}

const THREE_DTS = `export type ThreeParams = Record<string, string | number | boolean>;

/** Monta a cena Three.js no canvas e devolve a função que a desmonta. */
export function setup(canvas: HTMLCanvasElement, params: ThreeParams): () => void;
`;

/** `three-<slug>.js` + `.d.ts` de uma ilha Three.js (o TSX nunca importa `three` direto). */
export function reactThreeFiles(slug: string, code: string): { name: string; code: string }[] {
  const js = [
    '// Ilha Three.js do Mockup Studio. Código do nó em `make`; o resto cria o renderer e o laço.',
    "import * as THREE from 'three';",
    '',
    THREE_RUNNER,
    '',
    makeSource(code),
    '',
    'export function setup(canvas, params) {',
    '  return runIsland(THREE, make, canvas, params);',
    '}',
    '',
  ].join('\n');
  return [
    { name: `${slug}.js`, code: js },
    { name: `${slug}.d.ts`, code: THREE_DTS },
  ];
}
