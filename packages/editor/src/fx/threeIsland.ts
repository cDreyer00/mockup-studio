/**
 * Three.js island: the user's code runs in an `<iframe sandbox="allow-scripts" srcdoc>` WITHOUT
 * `allow-same-origin` (opaque origin): it never touches the editor's origin or the daemon.
 *
 * `postMessage` protocol (each side validates `event.source`):
 *   child -> parent: { type: 'ready' }                  THREE script loaded
 *                 { type: 'error', message }         error from the user's code / WebGL
 *                 { type: 'drawn', t }               frame drawn at time t
 *   parent -> child: { type: 'init', params, w, h, dpr, t, playing }   (re)creates the renderer and runs the code
 *                 { type: 'time', t }                manual time: draws update(t)+render
 *                 { type: 'play', playing, t }       turns the own loop on/off (starting from t)
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

/** Safe JSON inside `<script>`: no `</script>`, `<!--` or U+2028/U+2029 line separators. */
export const inScript = (value: unknown): string =>
  JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');

// Child script (classic JS, no template literals so it does not conflict with the generator).
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

  if (typeof THREE === 'undefined') fail('Three.js failed to load');
  else post({ type: 'ready' });
})();
`;

/** Island document (srcdoc) for a `code`; `origin` is the editor's origin (server of three.iife.js). */
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
