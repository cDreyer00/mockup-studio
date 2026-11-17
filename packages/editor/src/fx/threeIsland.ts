/**
 * Ilha Three.js: o código do usuário roda num `<iframe sandbox="allow-scripts" srcdoc>` SEM
 * `allow-same-origin` (origem opaca): nunca toca na origem do editor nem no daemon.
 *
 * Protocolo `postMessage` (cada lado valida `event.source`):
 *   filho -> pai: { type: 'ready' }                  script do THREE carregou
 *                 { type: 'error', message }         erro do código do usuário / do WebGL
 *                 { type: 'drawn', t }               quadro desenhado no tempo t
 *   pai -> filho: { type: 'init', params, w, h, dpr, t, playing }   (re)cria renderer e roda o código
 *                 { type: 'time', t }                tempo manual: desenha update(t)+render
 *                 { type: 'play', playing, t }       liga/desliga o laço próprio (a partir de t)
 *                 { type: 'resize', w, h, dpr }
 */

export type ThreeToParent =
  { type: 'ready' } | { type: 'error'; message: string } | { type: 'drawn'; t: number };

export type ThreeToChild =
  | {
      type: 'init';
      params: Record<string, unknown>;
      w: number;
      h: number;
      dpr: number;
      t: number;
      playing: boolean;
    }
  | { type: 'time'; t: number }
  | { type: 'play'; playing: boolean; t: number }
  | { type: 'resize'; w: number; h: number; dpr: number };

/** Texto seguro dentro de `<script>`: sem `</script>` nem `<!--`. */
const inScript = (value: unknown): string =>
  JSON.stringify(value)
    .replace(/</g, '\u003c')
    .replace(new RegExp('\u2028', 'g'), '\u2028')
    .replace(new RegExp('\u2029', 'g'), '\u2029');

// Script do filho (JS clássico, sem template literals para não conflitar com o gerador).
const CHILD_SCRIPT = `
(function () {
  var canvas = document.getElementById('c');
  var parentWin = window.parent;
  var post = function (m) { parentWin.postMessage(m, '*'); };
  var renderer = null, result = null, params = {};
  var w = 1, h = 1, base = 0, since = 0, playing = false, raf = 0, failed = false;

  function fail(e) {
    if (failed) return;
    failed = true;
    playing = false;
    post({ type: 'error', message: String(e && e.message ? e.message : e) });
  }
  window.addEventListener('error', function (ev) { fail(ev.error || ev.message); });
  window.addEventListener('unhandledrejection', function (ev) { fail(ev.reason); });

  function draw(t) {
    if (!renderer || !result || failed) return;
    try {
      if (typeof result.update === 'function') result.update(t);
      if (result.scene && result.camera) renderer.render(result.scene, result.camera);
    } catch (e) { fail(e); }
  }
  function now() { return base + (performance.now() - since) / 1000; }
  function loop() {
    raf = 0;
    if (!playing || failed) return;
    draw(now());
    raf = requestAnimationFrame(loop);
  }
  function setPlaying(p, t) {
    base = t; since = performance.now(); playing = p;
    if (p && !raf) raf = requestAnimationFrame(loop);
  }
  function size(nw, nh, dpr) {
    w = Math.max(1, nw); h = Math.max(1, nh);
    if (!renderer) return;
    renderer.setPixelRatio(Math.min(2, dpr || 1));
    renderer.setSize(w, h, false);
    var cam = result && result.camera;
    if (cam && cam.isPerspectiveCamera) { cam.aspect = w / h; cam.updateProjectionMatrix(); }
  }
  function init(m) {
    failed = false; playing = false;
    if (renderer) { try { renderer.dispose(); } catch (e) {} renderer = null; }
    result = null; params = m.params || {};
    try {
      renderer = new THREE.WebGLRenderer({ canvas: canvas, alpha: true, antialias: true, preserveDrawingBuffer: true });
      renderer.setPixelRatio(Math.min(2, m.dpr || 1));
      renderer.setSize(Math.max(1, m.w), Math.max(1, m.h), false);
      w = Math.max(1, m.w); h = Math.max(1, m.h);
      var fn = new Function('THREE', 'renderer', 'canvas', 'width', 'height', 'params', CODE);
      result = fn(THREE, renderer, canvas, w, h, params) || {};
    } catch (e) { fail(e); return; }
    draw(m.t);
    post({ type: 'drawn', t: m.t });
    setPlaying(!!m.playing, m.t);
  }

  window.addEventListener('message', function (ev) {
    if (ev.source !== parentWin) return;
    var m = ev.data;
    if (!m || typeof m !== 'object') return;
    if (m.type === 'init') init(m);
    else if (m.type === 'time') { setPlaying(false, m.t); draw(m.t); post({ type: 'drawn', t: m.t }); }
    else if (m.type === 'play') setPlaying(!!m.playing, m.t);
    else if (m.type === 'resize') size(m.w, m.h, m.dpr);
  });

  if (typeof THREE === 'undefined') fail('Three.js não carregou');
  else post({ type: 'ready' });
})();
`;

/** Documento (srcdoc) da ilha para um `code`; `origin` é a origem do editor (servidor do three.iife.js). */
export function threeSrcdoc(code: string, origin: string): string {
  const script = CHILD_SCRIPT.replace('CODE);', () => `${inScript(code)});`);
  return (
    '<!doctype html><html><head><meta charset="utf-8">' +
    '<style>html,body{margin:0;height:100%;overflow:hidden;background:transparent}' +
    'canvas{display:block;width:100%;height:100%}</style></head><body><canvas id="c"></canvas>' +
    `<script src="${origin}/vendor/three.iife.js"></script>` +
    `<script>${script}</script></body></html>`
  );
}
