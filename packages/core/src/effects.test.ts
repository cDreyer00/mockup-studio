import vm from 'node:vm';
import { describe, expect, it } from 'vitest';
import { createDocument, createNode } from './document.js';
import {
  EFFECTS,
  effectFallbackCss,
  effectKinds,
  effectParamsProblems,
  getEffect,
  presetParams,
  resolveEffectParams,
} from './effects/catalog.js';
import { effectMountSpec, effectsRuntimeSource } from './effects/runtime.js';
import type { EffectsRuntime } from './effects/runtime.js';
import { exportHtml } from './export/html.js';
import { exportReact } from './export/react.js';
import { exportSvg } from './export/svg.js';
import { exportTailwind } from './export/tailwind.js';
import { createEffectNode, createEmbedNode, createVideoNode } from './media.js';
import type { Document, Node } from './types.js';

const KINDS = ['mesh-gradient', 'grain', 'halftone', 'waves', 'liquid-metal', 'glass', 'particles'];

/** Document with a single frame (fr_test0001, "Screen") containing `children`. */
function docWith(children: Node[]): Document {
  const doc = createDocument('Test', { id: 'doc_test' });
  doc.pages[0].frames.push(
    createNode({
      tag: 'div',
      type: 'frame',
      id: 'fr_test0001',
      name: 'Screen',
      style: { width: '400px', height: '300px' },
      children,
    }),
  );
  return doc;
}

/* ---------------- catalog ---------------- */

describe('effects catalog', () => {
  it('has the 6 shaders and the particles', () => {
    expect(effectKinds().sort()).toEqual([...KINDS].sort());
    const shaders = EFFECTS.filter((e) => e.category === 'shader').map((e) => e.kind);
    expect(shaders.sort()).toEqual(KINDS.filter((k) => k !== 'particles').sort());
    expect(getEffect('particles')!.category).toBe('particles');
  });

  it('unique kinds, in kebab-case, and getEffect returns the definition', () => {
    const kinds = EFFECTS.map((e) => e.kind);
    expect(new Set(kinds).size).toBe(kinds.length);
    for (const e of EFFECTS) {
      expect(e.kind).toMatch(/^[a-z][a-z0-9-]*$/);
      expect(getEffect(e.kind)).toBe(e);
      expect(e.label).not.toBe('');
      expect(e.description).not.toBe('');
    }
    expect(getEffect('does-not-exist')).toBeUndefined();
  });

  it('shaders have a GLSL fragment with main and u_resolution; particles do not', () => {
    for (const e of EFFECTS) {
      if (e.category === 'shader') {
        expect(e.fragment, e.kind).toContain('void main()');
        expect(e.fragment, e.kind).toContain('u_resolution');
        expect(e.fragment, e.kind).toContain('u_time');
        expect(e.fragment, e.kind).toContain('gl_FragColor');
      } else {
        expect(e.fragment, e.kind).toBeUndefined();
      }
    }
  });

  it('unique param names per effect, each declaring its uniform in the shader', () => {
    for (const e of EFFECTS) {
      const names = e.params.map((p) => p.name);
      expect(new Set(names).size, e.kind).toBe(names.length);
      for (const p of e.params) {
        expect(p.name).toMatch(/^[a-zA-Z][a-zA-Z0-9]*$/);
        expect(p.description).not.toBe('');
        if (e.fragment && p.name !== 'speed') {
          expect(e.fragment, `${e.kind}.${p.name}`).toContain(`u_${p.name}`);
        }
      }
    }
  });

  it('defaults pass effectParamsProblems and respect the type and range', () => {
    for (const e of EFFECTS) {
      const defaults = Object.fromEntries(e.params.map((p) => [p.name, p.default]));
      expect(effectParamsProblems(e.kind, defaults), e.kind).toEqual([]);
      for (const p of e.params) {
        if (p.type === 'number') {
          expect(typeof p.default).toBe('number');
          expect(p.min, `${e.kind}.${p.name}`).toBeDefined();
          expect(p.max, `${e.kind}.${p.name}`).toBeDefined();
          expect(p.min!).toBeLessThan(p.max!);
          expect(p.default as number).toBeGreaterThanOrEqual(p.min!);
          expect(p.default as number).toBeLessThanOrEqual(p.max!);
        }
        if (p.type === 'select') {
          expect(p.options!.length).toBeGreaterThan(1);
          expect(p.options).toContain(p.default);
        }
        if (p.type === 'boolean') expect(typeof p.default).toBe('boolean');
        if (p.type === 'color') expect(typeof p.default).toBe('string');
      }
    }
  });

  it('every effect has presets with unique names and valid, resolvable params', () => {
    for (const e of EFFECTS) {
      expect(e.presets.length, e.kind).toBeGreaterThan(0);
      const names = e.presets.map((p) => p.name);
      expect(new Set(names).size, e.kind).toBe(names.length);
      for (const p of e.presets) {
        expect(p.name).toMatch(/^[a-z][a-z0-9-]*$/);
        expect(effectParamsProblems(e.kind, p.params), `${e.kind}/${p.name}`).toEqual([]);
        const full = presetParams(e.kind, p.name)!;
        expect(Object.keys(full).sort()).toEqual(e.params.map((x) => x.name).sort());
        expect(effectParamsProblems(e.kind, full)).toEqual([]);
      }
    }
  });

  it('presetParams: undefined for a missing kind or preset', () => {
    expect(presetParams('does-not-exist', 'aurora')).toBeUndefined();
    expect(presetParams('mesh-gradient', 'does-not-exist')).toBeUndefined();
    expect(presetParams('mesh-gradient', 'sunset')!.color1).toBe('#ff5e62');
    expect(presetParams('mesh-gradient', 'sunset')!.speed).toBe(1);
  });
});

describe('resolveEffectParams', () => {
  it('no params returns all defaults', () => {
    const p = resolveEffectParams('mesh-gradient');
    expect(p).toMatchObject({ color1: '#0d1b4c', speed: 1, distortion: 0.5, grain: 0.15 });
    expect(Object.keys(p)).toHaveLength(getEffect('mesh-gradient')!.params.length);
  });

  it('keeps valid values and fills the rest with defaults', () => {
    const p = resolveEffectParams('mesh-gradient', { speed: 2.5, color1: '#fff' });
    expect(p.speed).toBe(2.5);
    expect(p.color1).toBe('#fff');
    expect(p.color2).toBe('#00c2a8');
  });

  it('clamps numbers to min/max', () => {
    expect(resolveEffectParams('mesh-gradient', { speed: 99 }).speed).toBe(4);
    expect(resolveEffectParams('mesh-gradient', { speed: -5 }).speed).toBe(0);
  });

  it('wrong-type value falls back to the default; unknown param is dropped', () => {
    const p = resolveEffectParams('mesh-gradient', {
      speed: 'fast',
      color1: 'reddish',
      color2: 42,
      nonexistent: 1,
    });
    expect(p.speed).toBe(1);
    expect(p.color1).toBe('#0d1b4c');
    expect(p.color2).toBe('#00c2a8');
    expect('nonexistent' in p).toBe(false);
  });

  it('non-finite number (NaN/Infinity) falls back to the default', () => {
    expect(resolveEffectParams('mesh-gradient', { speed: NaN }).speed).toBe(1);
    expect(resolveEffectParams('mesh-gradient', { speed: Infinity }).speed).toBe(1);
  });

  it('does not inherit prototype properties', () => {
    const p = resolveEffectParams('mesh-gradient', JSON.parse('{"__proto__": 5}'));
    expect(p.speed).toBe(1);
    expect(Object.getPrototypeOf(p)).toBe(Object.prototype);
  });

  it('select only accepts a listed option', () => {
    const shape = getEffect('halftone')!.params.find((p) => p.type === 'select')!;
    expect(resolveEffectParams('halftone', { [shape.name]: 'xyz' })[shape.name]).toBe(
      shape.default,
    );
    const other = shape.options!.find((o) => o !== shape.default)!;
    expect(resolveEffectParams('halftone', { [shape.name]: other })[shape.name]).toBe(other);
  });

  it('unknown kind returns a copy of the params', () => {
    const input = { a: 1 };
    const out = resolveEffectParams('does-not-exist', input);
    expect(out).toEqual({ a: 1 });
    expect(out).not.toBe(input);
  });
});

describe('effectParamsProblems', () => {
  it('unknown effect', () => {
    const p = effectParamsProblems('does-not-exist', {});
    expect(p).toHaveLength(1);
    expect(p[0]).toContain('unknown effect');
    expect(p[0]).toContain('mesh-gradient');
  });

  it('unknown param, wrong type and out of range', () => {
    expect(effectParamsProblems('mesh-gradient', { xyz: 1 })[0]).toContain('unknown param');
    expect(effectParamsProblems('mesh-gradient', { speed: 'a' })[0]).toContain('must be a number');
    expect(effectParamsProblems('mesh-gradient', { speed: 9 })[0]).toContain('out of range');
    expect(effectParamsProblems('mesh-gradient', { color1: 'blue' })[0]).toContain('a CSS color');
    expect(effectParamsProblems('mesh-gradient', { color1: 1 })[0]).toContain('a CSS color');
    expect(effectParamsProblems('particles', { links: 'yes' })[0]).toContain('a boolean');
  });

  it('invalid select option', () => {
    const sel = getEffect('halftone')!.params.find((p) => p.type === 'select')!;
    expect(effectParamsProblems('halftone', { [sel.name]: 'zzz' })[0]).toContain('invalid option');
    expect(effectParamsProblems('halftone', { [sel.name]: 3 })[0]).toContain('string');
  });

  it('accepts color formats #rgb, #rrggbbaa, rgb(), rgba() and transparent', () => {
    for (const c of [
      '#fff',
      '#ffff',
      '#ffffff',
      '#ffffff80',
      'rgb(1, 2, 3)',
      'rgba(1,2,3,.5)',
      'transparent',
    ])
      expect(effectParamsProblems('particles', { color: c }), c).toEqual([]);
    for (const c of ['#ff', '#fffff', 'red', 'rgb(1,2)', 'url(x)', 'rgb(1,2,3);x'])
      expect(effectParamsProblems('particles', { color: c }), c).toHaveLength(1);
  });

  it('aggregates several problems', () => {
    expect(effectParamsProblems('mesh-gradient', { speed: 'a', foo: 1, grain: 5 })).toHaveLength(3);
  });
});

describe('effectFallbackCss', () => {
  it('each kind produces a non-empty, deterministic background', () => {
    for (const k of KINDS) {
      const css = effectFallbackCss({ kind: k, params: {} });
      expect(css.background, k).toBeTruthy();
      expect(effectFallbackCss({ kind: k, params: {} })).toEqual(css);
    }
  });

  it('uses the params colors and the catalog for the rest', () => {
    const mesh = effectFallbackCss({ kind: 'mesh-gradient', params: { color1: '#123456' } });
    expect(mesh.background).toContain('radial-gradient');
    expect(mesh.background).toContain('#123456');
    expect(mesh.background).toContain('#00c2a8');
    expect(
      effectFallbackCss({ kind: 'grain', params: { color1: '#111111', color2: '#222222' } })
        .background,
    ).toBe('linear-gradient(160deg, #111111, #222222)');
  });

  it('unknown kind falls back to the default background', () => {
    expect(effectFallbackCss({ kind: 'does-not-exist', params: {} })).toEqual({
      background: '#1e1b4b',
    });
  });

  it('invalid value does not leak into the CSS', () => {
    const css = effectFallbackCss({
      kind: 'mesh-gradient',
      params: { color1: 'red;} body{display:none' },
    });
    expect(css.background).not.toContain('display');
    expect(css.background).toContain('#0d1b4c');
  });
});

/* ---------------- runtime ---------------- */

describe('effects runtime', () => {
  const source = effectsRuntimeSource();

  it('is a JS expression that parses with new Function', () => {
    expect(() => new Function(`return ${source}`)).not.toThrow();
    const rt = new Function(`return ${source}`)() as EffectsRuntime;
    expect(typeof rt.mount).toBe('function');
    expect(typeof rt.play).toBe('function');
  });

  it('is self-contained: runs in an empty context, with no imports or module identifiers', () => {
    const rt = vm.runInNewContext(source, Object.create(null)) as EffectsRuntime;
    expect(typeof rt.mount).toBe('function');
    expect(source).not.toMatch(/\brequire\(|\bimport\s*\(|\bimport\s+[\w{*]/);
    expect(source).not.toContain('EFFECTS');
    expect(source).not.toContain('getEffect');
  });

  it('is deterministic across calls', () => {
    expect(effectsRuntimeSource()).toBe(source);
  });

  it('mount without a valid canvas returns a handle with ok=false', () => {
    const rt = vm.runInNewContext(source, {}) as EffectsRuntime;
    const h = rt.mount(null, effectMountSpec({ kind: 'grain', params: {} }));
    expect(h.ok).toBe(false);
    expect(h.error).toBeTruthy();
    expect(() => {
      h.draw(0);
      h.resize(10, 10);
      h.destroy();
    }).not.toThrow();
  });

  it('shader without WebGL: ok=false with a message; a missing fragment too', () => {
    const rt = vm.runInNewContext(source, {}) as EffectsRuntime;
    const noGl = { getContext: () => null, width: 1, height: 1 };
    const h = rt.mount(noGl, effectMountSpec({ kind: 'grain', params: {} }));
    expect(h.ok).toBe(false);
    expect(h.error).toContain('WebGL');
  });

  it('particles draw on a fake 2d context and destroy stops drawing', () => {
    const rt = vm.runInNewContext(source, {}) as EffectsRuntime;
    const calls: string[] = [];
    const ctx = new Proxy(
      {},
      {
        get: (_t, prop) => (prop === 'canvas' ? undefined : () => calls.push(String(prop))),
        set: () => true,
      },
    );
    const canvas = { getContext: () => ctx, width: 1, height: 1 };
    const h = rt.mount(canvas, effectMountSpec({ kind: 'particles', params: { count: 10 } }));
    expect(h.ok).toBe(true);
    h.resize(200, 100, 2);
    expect(canvas.width).toBe(400);
    expect(canvas.height).toBe(200);
    h.draw(1);
    expect(calls.filter((c) => c === 'arc')).toHaveLength(10);
    h.destroy();
    const before = calls.length;
    h.draw(2);
    expect(calls.length).toBe(before);
  });

  it('effectMountSpec: resolves params, includes shader fragments and selects', () => {
    const mesh = effectMountSpec({ kind: 'mesh-gradient', params: { speed: 99 } });
    expect(mesh.category).toBe('shader');
    expect(mesh.params.speed).toBe(4);
    expect(mesh.fragment).toBe(getEffect('mesh-gradient')!.fragment);
    expect(mesh.selects).toBeUndefined();

    const part = effectMountSpec({ kind: 'particles', params: {} });
    expect(part.category).toBe('particles');
    expect(part.fragment).toBeUndefined();
    expect(part.selects!.direction).toEqual(expect.arrayContaining(['up', 'down']));

    const halftone = effectMountSpec({ kind: 'halftone', params: {} });
    expect(halftone.selects).toBeDefined();

    const unknown = effectMountSpec({ kind: 'does-not-exist', params: { a: 1 } });
    expect(unknown.category).toBe('shader');
    expect(unknown.fragment).toBeUndefined();
    expect(unknown.params).toEqual({ a: 1 });
  });
});

/* ---------------- export ---------------- */

const BG = { position: 'absolute', inset: '0', 'z-index': '-1' };

describe('exportHtml with media', () => {
  it('effect: canvas with JSON spec, fallback background and a single runtime script', () => {
    const html = exportHtml(
      docWith([createEffectNode('mesh-gradient', { speed: 2 }, { styles: BG })]),
    );
    const m = /<canvas class="effect" data-mockup-effect='([^']+)'><\/canvas>/.exec(html);
    expect(m).not.toBeNull();
    const spec = JSON.parse(m![1]!);
    expect(spec.kind).toBe('mesh-gradient');
    expect(spec.category).toBe('shader');
    expect(spec.params.speed).toBe(2);
    expect(spec.params.color2).toBe('#00c2a8');
    expect(spec.fragment).toBeUndefined();
    // CSS fallback visible without JS + user styles
    expect(html).toMatch(/\.effect \{[^}]*radial-gradient[^}]*position: absolute/s);
    expect(html).toMatch(/\.effect \{[^}]*z-index: -1/s);
    // fragment shader and runtime go once in the script
    expect(html.match(/<script>/g)).toHaveLength(1);
    expect(html).toContain('mockupEffectsRuntime');
    expect(html).toContain('canvas[data-mockup-effect]');
    expect(html).toContain('gl_FragColor');
    expect(html).not.toContain('</script>\n</script>');
  });

  it('several effects of the same kind share ONE fragment; particles carry no fragment', () => {
    const html = exportHtml(
      docWith([
        createEffectNode('grain'),
        createEffectNode('grain', { speed: 2 }),
        createEffectNode('particles'),
      ]),
    );
    expect(html.match(/<canvas class=/g)).toHaveLength(3);
    const frags = /const FRAGMENTS = (\{.*\});/.exec(html);
    expect(frags).not.toBeNull();
    expect(Object.keys(JSON.parse(frags![1]!))).toEqual(['grain']);
  });

  it('no media nodes means no script', () => {
    const html = exportHtml(docWith([createNode({ tag: 'p', text: 'hi' })]));
    expect(html).not.toContain('<script');
  });

  it('fragment: true keeps the scripts right after the markup', () => {
    const html = exportHtml(docWith([createEffectNode('glass')]), { fragment: true });
    expect(html).not.toContain('<!doctype');
    expect(html.indexOf('<canvas')).toBeLessThan(html.indexOf('<script>'));
  });

  it('inline mode puts the fallback in the canvas style', () => {
    const html = exportHtml(docWith([createEffectNode('grain')]), { mode: 'inline' });
    expect(html).toMatch(/<canvas data-mockup-effect='[^']+' style="background: linear-gradient\(/);
  });

  it('video: video tag with src in assets/, poster, autoplay, loop, muted and playsinline', () => {
    const html = exportHtml(
      docWith([
        createVideoNode({
          src: 'clip.mp4',
          poster: 'cover.png',
          autoplay: true,
          loop: true,
          muted: true,
          controls: true,
        }),
      ]),
    );
    expect(html).toContain(
      '<video src="assets/clip.mp4" poster="assets/cover.png" autoplay loop muted controls playsinline></video>',
    );
  });

  it('video without flags has no autoplay/loop/muted/controls; http(s) URL is kept', () => {
    const html = exportHtml(docWith([createVideoNode({ src: 'https://cdn.example.com/a.mp4' })]));
    expect(html).toContain('<video src="https://cdn.example.com/a.mp4" playsinline></video>');
    expect(html).not.toMatch(/autoplay|loop|muted|controls|poster/);
  });
  it('video with a dangerous src (unvalidated document) never becomes an executable scheme', () => {
    const node = createVideoNode({ src: 'a.mp4' });
    node.video = { src: 'javascript:alert(1)' };
    const html = exportHtml(docWith([node]));
    // the assets/ prefix turns the value into a harmless relative path
    expect(html).not.toMatch(/src="javascript:/i);
    expect(html).toContain('<video src="assets/javascript:alert(1)"');
  });

  it('youtube: nocookie iframe with start, autoplay and mute', () => {
    const html = exportHtml(
      docWith([
        createEmbedNode({
          provider: 'youtube',
          url: 'https://youtu.be/dQw4w9WgXcQ?t=30',
          params: { autoplay: true, loop: true },
        }),
      ]),
    );
    expect(html).toContain('<iframe');
    expect(html).toContain('src="https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ?');
    expect(html).toContain('start=30');
    expect(html).toContain('autoplay=1');
    expect(html).toContain('mute=1');
    expect(html).toContain('playlist=dQw4w9WgXcQ');
    expect(html).toContain('allowfullscreen');
    expect(html).toContain('loading="lazy"');
    expect(html).toMatch(/\.youtube \{\s*border: 0;/);
    expect(html).not.toContain('<script');
  });

  it('iframe: sandbox and http(s) URL only', () => {
    const html = exportHtml(
      docWith([createEmbedNode({ provider: 'iframe', url: 'https://example.com/a?x=1&y=2' })]),
    );
    expect(html).toContain('src="https://example.com/a?x=1&amp;y=2"');
    expect(html).toContain('sandbox="allow-scripts allow-same-origin allow-popups"');

    const bad = createEmbedNode({ provider: 'iframe', url: 'https://example.com' });
    bad.embed = { provider: 'iframe', url: 'javascript:alert(1)' };
    const h2 = exportHtml(docWith([bad]));
    expect(h2).not.toContain('javascript:');
    expect(h2).not.toContain('<iframe');
  });

  it('lottie: div with data-src and CDN script with lottie.loadAnimation', () => {
    const html = exportHtml(
      docWith([createEmbedNode({ provider: 'lottie', src: 'anim.json', params: { loop: false } })]),
    );
    expect(html).toContain(
      '<div data-mockup-embed="lottie" data-src="assets/anim.json" data-autoplay="true" data-loop="false"></div>',
    );
    expect(html).toContain('lottie-web');
    expect(html).toContain('lottie.loadAnimation');
  });

  it('rive: canvas with data-src, artboard and state machine, and CDN script', () => {
    const html = exportHtml(
      docWith([
        createEmbedNode({
          provider: 'rive',
          src: 'anim.riv',
          params: { artboard: 'Main', stateMachine: 'SM' },
        }),
      ]),
    );
    expect(html).toContain('data-mockup-embed="rive"');
    expect(html).toContain('data-src="assets/anim.riv"');
    expect(html).toContain('data-artboard="Main"');
    expect(html).toContain('data-state-machine="SM"');
    expect(html).toContain('@rive-app/canvas');
  });

  it('three: canvas with data-island, inlined code and CDN module script', () => {
    const html = exportHtml(
      docWith([
        createEmbedNode({
          provider: 'three',
          code: 'return { scene: new THREE.Scene(), camera: new THREE.PerspectiveCamera() };',
          params: { color: '#fff' },
        }),
      ]),
    );
    expect(html).toContain('<canvas data-mockup-embed="three" data-island="0"></canvas>');
    expect(html).toContain('three@');
    expect(html).toContain('new THREE.Scene()');
    expect(html).toContain('type="module"');
  });

  it('three: code containing </script> does not close the script (escaping)', () => {
    const html = exportHtml(
      docWith([createEmbedNode({ provider: 'three', code: 'const x = "</script><b>";' })]),
    );
    expect(html).not.toContain('"</script><b>"');
    expect(html).toContain('<\\/script>');
  });

  it('numbers the three islands in order', () => {
    const html = exportHtml(
      docWith([
        createEmbedNode({ provider: 'three', code: 'return 1;' }),
        createEmbedNode({ provider: 'three', code: 'return 2;' }),
      ]),
    );
    expect(html).toContain('data-island="0"');
    expect(html).toContain('data-island="1"');
  });
});

describe('exportTailwind with media', () => {
  it('effect: canvas with Tailwind classes (arbitrary fallback background) and script', () => {
    const html = exportTailwind(docWith([createEffectNode('grain', {}, { styles: BG })]), {
      fragment: true,
    });
    expect(html).toMatch(
      /<canvas class="[^"]*bg-\[linear-gradient\(160deg[^"]*absolute[^"]*inset-0/,
    );
    expect(html).toContain("data-mockup-effect='");
    expect(html).toContain('canvas[data-mockup-effect]');
    expect(html.match(/<script>/g)).toHaveLength(1);
  });

  it('video and iframes keep attributes; border-0 becomes a class', () => {
    const html = exportTailwind(
      docWith([
        createVideoNode({ src: 'a.mp4', poster: 'p.png', autoplay: true, loop: true, muted: true }),
        createEmbedNode({ provider: 'youtube', url: 'https://youtu.be/dQw4w9WgXcQ' }),
        createEmbedNode({ provider: 'iframe', url: 'https://example.com' }),
      ]),
      { fragment: true },
    );
    expect(html).toContain(
      '<video src="assets/a.mp4" poster="assets/p.png" autoplay loop muted playsinline></video>',
    );
    expect(html).toContain(
      '<iframe class="border-0" src="https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ?',
    );
    expect(html).toContain('<iframe class="border-0" src="https://example.com"');
    expect(html).toContain('sandbox="allow-scripts allow-same-origin allow-popups"');
  });

  it('lottie/rive/three: markup and scripts', () => {
    const html = exportTailwind(
      docWith([
        createEmbedNode({ provider: 'lottie', src: 'a.json' }),
        createEmbedNode({ provider: 'rive', src: 'a.riv' }),
        createEmbedNode({ provider: 'three', code: 'return {};' }),
      ]),
      { fragment: true },
    );
    expect(html).toContain('<div data-mockup-embed="lottie" data-src="assets/a.json"');
    expect(html).toContain('<canvas data-mockup-embed="rive" data-src="assets/a.riv"');
    expect(html).toContain('<canvas data-mockup-embed="three" data-island="0"></canvas>');
    expect(html).toContain('lottie.loadAnimation');
  });
});

describe('exportSvg with media (no layout: foreignObject)', () => {
  it('effect becomes a static div with data-mockup-effect, data-params and fallback; no script', () => {
    const svg = exportSvg(docWith([createEffectNode('mesh-gradient', { speed: 2 })]), {
      nodeId: 'fr_test0001',
    });
    expect(svg).toContain('<foreignObject');
    expect(svg).toContain('data-mockup-effect="mesh-gradient"');
    expect(svg).toContain(`data-params='{"speed":2}'`);
    expect(svg).toContain('radial-gradient');
    expect(svg).not.toContain('<script');
    expect(svg).not.toContain('<canvas');
  });

  it('video and embeds become inert markup', () => {
    const svg = exportSvg(
      docWith([
        createVideoNode({ src: 'a.mp4', poster: 'p.png', autoplay: true }),
        createEmbedNode({ provider: 'youtube', url: 'https://youtu.be/dQw4w9WgXcQ' }),
        createEmbedNode({ provider: 'lottie', src: 'a.json', params: { loop: false } }),
        createEmbedNode({ provider: 'rive', src: 'a.riv' }),
        createEmbedNode({ provider: 'three', code: 'return {};' }),
      ]),
      { nodeId: 'fr_test0001' },
    );
    expect(svg).toContain('<video src="assets/a.mp4" poster="assets/p.png" autoplay="autoplay"');
    expect(svg).toContain('<iframe src="https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ');
    expect(svg).toContain('<div data-mockup-embed="lottie" data-src="assets/a.json"></div>');
    expect(svg).toContain('<div data-mockup-embed="rive" data-src="assets/a.riv"></div>');
    expect(svg).toContain('<div data-mockup-embed="three"></div>');
    expect(svg).not.toContain('return {}');
    expect(svg).not.toContain('<script');
  });
});

describe('exportReact with media', () => {
  it('live effect: <MockupEffect> with typed spec, runtime in mockup-effects.js and fallback', () => {
    const fx = createEffectNode('mesh-gradient', { speed: 2 }, { styles: BG });
    const r = exportReact(docWith([fx]), { nodeId: 'fr_test0001' });
    expect(r.code).toContain("import { useEffect, useRef, type CSSProperties } from 'react';");
    expect(r.code).toContain("import { playEffect, type EffectMount } from './mockup-effects.js';");
    expect(r.code).toMatch(/const \w+Effect: EffectMount = \{/);
    expect(r.code).toContain('"kind": "mesh-gradient"');
    expect(r.code).toContain('"speed": 2');
    expect(r.code).toMatch(/<MockupEffect\s+spec=\{\w+Effect\}/);
    expect(r.code).toContain('function MockupEffect(');
    // catalog fallback background stays on the element (visible before WebGL)
    expect(r.code).toContain('radial-gradient');
    const names = (r.files ?? []).map((f) => f.name);
    expect(names).toEqual(['mockup-effects.js', 'mockup-effects.d.ts']);
    const js = r.files![0].code;
    // runtime with the fragments of the whole catalog (single shared file)
    expect(js).toContain('export function playEffect');
    for (const k of KINDS.filter((k) => k !== 'particles')) expect(js).toContain(`"${k}"`);
    expect(() => new Function(js.replace(/^export /gm, ''))).not.toThrow();
  });

  it('static effect: <img> with the effectImages image, no runtime', () => {
    const fx = createEffectNode('grain', {}, { styles: BG });
    const r = exportReact(docWith([fx]), {
      nodeId: 'fr_test0001',
      effectImages: { [fx.id]: `effects/${fx.id}.png` },
    });
    expect(r.code).toMatch(new RegExp(`<img\\s+src="assets/effects/${fx.id}\\.png"\\s+alt=""`));
    expect(r.code).not.toContain('MockupEffect');
    expect(r.code).not.toContain('useEffect');
    expect(r.files).toBeUndefined();
  });

  it('inline mode: effect with fallback style', () => {
    const { code } = exportReact(docWith([createEffectNode('grain')]), {
      nodeId: 'fr_test0001',
      styles: 'inline',
    });
    expect(code).toContain('<MockupEffect');
    expect(code).toContain('linear-gradient(160deg');
  });

  it('video and YouTube become <video> and <iframe> with JSX props', () => {
    const { code, files } = exportReact(
      docWith([
        createVideoNode({
          src: 'videos/a.mp4',
          poster: 'p.png',
          autoplay: true,
          loop: true,
          muted: true,
        }),
        createEmbedNode({ provider: 'youtube', url: 'https://youtu.be/dQw4w9WgXcQ?t=30' }),
        createEmbedNode({ provider: 'iframe', url: 'https://example.com/' }),
      ]),
      { nodeId: 'fr_test0001' },
    );
    expect(code).toMatch(
      /<video src="assets\/videos\/a\.mp4" poster="assets\/p\.png" autoPlay loop muted playsInline/,
    );
    expect(code).toContain('<iframe');
    expect(code).toContain("src={'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ?start=30");
    expect(code).toContain('allowFullScreen');
    expect(code).toContain('sandbox="allow-scripts allow-same-origin allow-popups"');
    expect(code).not.toContain('useEffect');
    expect(files).toBeUndefined();
  });

  it('Lottie and Rive use lottie-web and @rive-app/canvas', () => {
    const { code } = exportReact(
      docWith([
        createEmbedNode({ provider: 'lottie', src: 'lottie/a.json', params: { loop: false } }),
        createEmbedNode({ provider: 'rive', src: 'rive/a.riv', params: { stateMachine: 'Main' } }),
      ]),
      { nodeId: 'fr_test0001' },
    );
    expect(code).toContain("import lottie from 'lottie-web';");
    expect(code).toContain("import { Rive } from '@rive-app/canvas';");
    expect(code).toMatch(/<MockupLottie src="assets\/lottie\/a\.json" loop=\{false\}/);
    expect(code).toMatch(/<MockupRive src="assets\/rive\/a\.riv" stateMachine="Main"/);
    expect(code).toContain('function MockupLottie(');
    expect(code).toContain('function MockupRive(');
    expect(code).not.toContain('mockup-effects');
  });

  it('Three.js island: <slug>-three-1.js file with the code and <ThreeIsland>', () => {
    const r = exportReact(
      docWith([
        createEmbedNode({
          provider: 'three',
          code: 'const scene = new THREE.Scene();\nreturn { scene, camera: new THREE.PerspectiveCamera() };',
          params: { color: '#ff0000' },
        }),
      ]),
      { nodeId: 'fr_test0001' },
    );
    expect(r.code).toContain("import { setup as setupThree1 } from './screen-three-1.js';");
    expect(r.code).toMatch(/const \w+Params: ThreeParams = \{\n {2}"color": "#ff0000"\n\};/);
    expect(r.code).toMatch(/<ThreeIsland setup=\{setupThree1\} params=\{\w+Params\}/);
    expect(r.code).not.toContain("from 'three'");
    const names = (r.files ?? []).map((f) => f.name);
    expect(names).toEqual(['screen-three-1.js', 'screen-three-1.d.ts']);
    expect(r.files![0].code).toContain("import * as THREE from 'three';");
    expect(r.files![0].code).toContain('const scene = new THREE.Scene();');
  });

  it('Three.js islands from roots with the same name get distinct files by componentName', () => {
    const doc = docWith([createEmbedNode({ provider: 'three', code: 'return { a: 1 };' })]);
    const a = exportReact(doc, { nodeId: 'fr_test0001', componentName: 'Screen' });
    const b = exportReact(doc, { nodeId: 'fr_test0001', componentName: 'Screen2' });
    expect((a.files ?? []).map((f) => f.name)).toEqual([
      'screen-three-1.js',
      'screen-three-1.d.ts',
    ]);
    expect((b.files ?? []).map((f) => f.name)).toEqual([
      'screen2-three-1.js',
      'screen2-three-1.d.ts',
    ]);
    expect(b.code).toContain("from './screen2-three-1.js';");
  });

  it('two three embeds with the same name in the same component produce distinct files', () => {
    const r = exportReact(
      docWith([
        createEmbedNode({ provider: 'three', code: 'return 1;' }, { name: 'Scene' }),
        createEmbedNode({ provider: 'three', code: 'return 2;' }, { name: 'Scene' }),
      ]),
      { nodeId: 'fr_test0001' },
    );
    const js = (r.files ?? []).map((f) => f.name).filter((n) => n.endsWith('.js'));
    expect(js).toEqual(['screen-three-1.js', 'screen-three-2.js']);
    expect(r.code).toContain("from './screen-three-1.js';");
    expect(r.code).toContain("from './screen-three-2.js';");
  });

  it('without media the header does not change', () => {
    const { code, files } = exportReact(docWith([]), { nodeId: 'fr_test0001' });
    expect(code).not.toContain('useEffect');
    expect(files).toBeUndefined();
  });
});

describe('Lottie embedded in the HTML (file://)', () => {
  const lottie = (extra = '') =>
    JSON.stringify({ v: '5.7.0', fr: 30, layers: [], nm: `</script><b>${extra}\u2028x\u2029` });
  const doc = () => docWith([createEmbedNode({ provider: 'lottie', src: 'lottie/a.json' })]);

  it('with readAsset it inlines the escaped JSON and the runtime uses animationData', () => {
    const html = exportHtml(doc(), {
      readAsset: (ref) => (ref === 'lottie/a.json' ? lottie() : undefined),
    });
    expect(html).toContain('data-lottie-data="0"');
    const m = /<script type="application\/json" id="mockup-lottie-0">([\s\S]*?)<\/script>/.exec(
      html,
    );
    expect(m).not.toBeNull();
    expect(m![1]).not.toMatch(/[<\u2028\u2029]/);
    expect((JSON.parse(m![1]!) as { nm: string }).nm).toBe('</script><b>\u2028x\u2029');
    expect(html).toContain('config.animationData = JSON.parse(data.textContent)');
  });

  it('the same JSON in two nodes is inlined once', () => {
    const d = docWith([
      createEmbedNode({ provider: 'lottie', src: 'a.json' }),
      createEmbedNode({ provider: 'lottie', src: 'b.json' }),
    ]);
    const html = exportHtml(d, { readAsset: () => lottie() });
    expect(html.match(/id="mockup-lottie-/g)).toHaveLength(1);
    expect(html.match(/data-lottie-data="0"/g)).toHaveLength(2);
  });

  it('above 512 KB, without readAsset, invalid JSON or .lottie: keeps data-src without inlining', () => {
    const big = JSON.stringify({ pad: 'x'.repeat(512 * 1024 + 10) });
    for (const html of [
      exportHtml(doc(), { readAsset: () => big }),
      exportHtml(doc(), { readAsset: () => '{not json' }),
      exportHtml(doc(), { readAsset: () => undefined }),
      exportHtml(doc()),
      exportHtml(docWith([createEmbedNode({ provider: 'lottie', src: 'a.lottie' })]), {
        readAsset: () => lottie(),
      }),
    ]) {
      expect(html).not.toContain('mockup-lottie-0"');
      expect(html).not.toContain('data-lottie-data="');
      expect(html).toContain('data-src="assets/');
    }
  });

  it('exportTailwind also inlines', () => {
    const html = exportTailwind(doc(), { fragment: true, readAsset: () => lottie() });
    expect(html).toContain('id="mockup-lottie-0"');
  });
});
