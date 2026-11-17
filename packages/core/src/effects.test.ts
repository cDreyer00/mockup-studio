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

/** Documento com um único frame (fr_test0001, "Tela") contendo `children`. */
function docWith(children: Node[]): Document {
  const doc = createDocument('Teste', { id: 'doc_test' });
  doc.pages[0].frames.push(
    createNode({
      tag: 'div',
      type: 'frame',
      id: 'fr_test0001',
      name: 'Tela',
      style: { width: '400px', height: '300px' },
      children,
    }),
  );
  return doc;
}

/* ---------------- catálogo ---------------- */

describe('catálogo de efeitos', () => {
  it('tem os 6 shaders e as partículas', () => {
    expect(effectKinds().sort()).toEqual([...KINDS].sort());
    const shaders = EFFECTS.filter((e) => e.category === 'shader').map((e) => e.kind);
    expect(shaders.sort()).toEqual(KINDS.filter((k) => k !== 'particles').sort());
    expect(getEffect('particles')!.category).toBe('particles');
  });

  it('kinds únicos, em kebab-case, e getEffect devolve a definição', () => {
    const kinds = EFFECTS.map((e) => e.kind);
    expect(new Set(kinds).size).toBe(kinds.length);
    for (const e of EFFECTS) {
      expect(e.kind).toMatch(/^[a-z][a-z0-9-]*$/);
      expect(getEffect(e.kind)).toBe(e);
      expect(e.label).not.toBe('');
      expect(e.description).not.toBe('');
    }
    expect(getEffect('nao-existe')).toBeUndefined();
  });

  it('shaders têm fragment GLSL com main e u_resolution; partículas não têm', () => {
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

  it('nomes de parâmetros únicos por efeito e cada um declara seu uniform no shader', () => {
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

  it('defaults passam em effectParamsProblems e respeitam o tipo e a faixa', () => {
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

  it('todo efeito tem presets com nome único, params válidos e que resolvem', () => {
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

  it('presetParams: undefined para kind ou preset inexistente', () => {
    expect(presetParams('nao-existe', 'aurora')).toBeUndefined();
    expect(presetParams('mesh-gradient', 'nao-existe')).toBeUndefined();
    expect(presetParams('mesh-gradient', 'sunset')!.color1).toBe('#ff5e62');
    expect(presetParams('mesh-gradient', 'sunset')!.speed).toBe(1);
  });
});

describe('resolveEffectParams', () => {
  it('sem params devolve todos os defaults', () => {
    const p = resolveEffectParams('mesh-gradient');
    expect(p).toMatchObject({ color1: '#0d1b4c', speed: 1, distortion: 0.5, grain: 0.15 });
    expect(Object.keys(p)).toHaveLength(getEffect('mesh-gradient')!.params.length);
  });

  it('mantém valores válidos e completa o resto com defaults', () => {
    const p = resolveEffectParams('mesh-gradient', { speed: 2.5, color1: '#fff' });
    expect(p.speed).toBe(2.5);
    expect(p.color1).toBe('#fff');
    expect(p.color2).toBe('#00c2a8');
  });

  it('limita números a min/max', () => {
    expect(resolveEffectParams('mesh-gradient', { speed: 99 }).speed).toBe(4);
    expect(resolveEffectParams('mesh-gradient', { speed: -5 }).speed).toBe(0);
  });

  it('valor de tipo errado volta ao default; parâmetro desconhecido é descartado', () => {
    const p = resolveEffectParams('mesh-gradient', {
      speed: 'rápido',
      color1: 'vermelho',
      color2: 42,
      inexistente: 1,
    });
    expect(p.speed).toBe(1);
    expect(p.color1).toBe('#0d1b4c');
    expect(p.color2).toBe('#00c2a8');
    expect('inexistente' in p).toBe(false);
  });

  it('número não finito (NaN/Infinity) volta ao default', () => {
    expect(resolveEffectParams('mesh-gradient', { speed: NaN }).speed).toBe(1);
    expect(resolveEffectParams('mesh-gradient', { speed: Infinity }).speed).toBe(1);
  });

  it('não herda propriedades do protótipo', () => {
    const p = resolveEffectParams('mesh-gradient', JSON.parse('{"__proto__": 5}'));
    expect(p.speed).toBe(1);
    expect(Object.getPrototypeOf(p)).toBe(Object.prototype);
  });

  it('select só aceita opção listada', () => {
    const shape = getEffect('halftone')!.params.find((p) => p.type === 'select')!;
    expect(resolveEffectParams('halftone', { [shape.name]: 'xyz' })[shape.name]).toBe(
      shape.default,
    );
    const outra = shape.options!.find((o) => o !== shape.default)!;
    expect(resolveEffectParams('halftone', { [shape.name]: outra })[shape.name]).toBe(outra);
  });

  it('kind desconhecido devolve cópia dos params', () => {
    const input = { a: 1 };
    const out = resolveEffectParams('nao-existe', input);
    expect(out).toEqual({ a: 1 });
    expect(out).not.toBe(input);
  });
});

describe('effectParamsProblems', () => {
  it('efeito inexistente', () => {
    const p = effectParamsProblems('nao-existe', {});
    expect(p).toHaveLength(1);
    expect(p[0]).toContain('efeito inexistente');
    expect(p[0]).toContain('mesh-gradient');
  });

  it('parâmetro desconhecido, tipo errado e fora da faixa', () => {
    expect(effectParamsProblems('mesh-gradient', { xyz: 1 })[0]).toContain(
      'parâmetro desconhecido',
    );
    expect(effectParamsProblems('mesh-gradient', { speed: 'a' })[0]).toContain('deve ser número');
    expect(effectParamsProblems('mesh-gradient', { speed: 9 })[0]).toContain('fora da faixa');
    expect(effectParamsProblems('mesh-gradient', { color1: 'azul' })[0]).toContain('cor CSS');
    expect(effectParamsProblems('mesh-gradient', { color1: 1 })[0]).toContain('cor CSS');
    expect(effectParamsProblems('particles', { links: 'sim' })[0]).toContain('booleano');
  });

  it('opção inválida de select', () => {
    const sel = getEffect('halftone')!.params.find((p) => p.type === 'select')!;
    expect(effectParamsProblems('halftone', { [sel.name]: 'zzz' })[0]).toContain('opção inválida');
    expect(effectParamsProblems('halftone', { [sel.name]: 3 })[0]).toContain('texto');
  });

  it('aceita formatos de cor #rgb, #rrggbbaa, rgb(), rgba() e transparent', () => {
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

  it('agrega vários problemas', () => {
    expect(effectParamsProblems('mesh-gradient', { speed: 'a', foo: 1, grain: 5 })).toHaveLength(3);
  });
});

describe('effectFallbackCss', () => {
  it('cada kind gera um background não vazio e determinístico', () => {
    for (const k of KINDS) {
      const css = effectFallbackCss({ kind: k, params: {} });
      expect(css.background, k).toBeTruthy();
      expect(effectFallbackCss({ kind: k, params: {} })).toEqual(css);
    }
  });

  it('usa as cores dos params e o catálogo para o resto', () => {
    const mesh = effectFallbackCss({ kind: 'mesh-gradient', params: { color1: '#123456' } });
    expect(mesh.background).toContain('radial-gradient');
    expect(mesh.background).toContain('#123456');
    expect(mesh.background).toContain('#00c2a8');
    expect(
      effectFallbackCss({ kind: 'grain', params: { color1: '#111111', color2: '#222222' } })
        .background,
    ).toBe('linear-gradient(160deg, #111111, #222222)');
  });

  it('kind desconhecido cai no fundo padrão', () => {
    expect(effectFallbackCss({ kind: 'nao-existe', params: {} })).toEqual({
      background: '#1e1b4b',
    });
  });

  it('valor inválido não vaza para o CSS', () => {
    const css = effectFallbackCss({
      kind: 'mesh-gradient',
      params: { color1: 'red;} body{display:none' },
    });
    expect(css.background).not.toContain('display');
    expect(css.background).toContain('#0d1b4c');
  });
});

/* ---------------- runtime ---------------- */

describe('runtime dos efeitos', () => {
  const source = effectsRuntimeSource();

  it('é uma expressão JS que faz parse com new Function', () => {
    expect(() => new Function(`return ${source}`)).not.toThrow();
    const rt = new Function(`return ${source}`)() as EffectsRuntime;
    expect(typeof rt.mount).toBe('function');
    expect(typeof rt.play).toBe('function');
  });

  it('é autocontido: roda num contexto vazio, sem imports nem identificadores do módulo', () => {
    const rt = vm.runInNewContext(source, Object.create(null)) as EffectsRuntime;
    expect(typeof rt.mount).toBe('function');
    expect(source).not.toMatch(/\brequire\(|\bimport\s*\(|\bimport\s+[\w{*]/);
    expect(source).not.toContain('EFFECTS');
    expect(source).not.toContain('getEffect');
  });

  it('é determinístico entre chamadas', () => {
    expect(effectsRuntimeSource()).toBe(source);
  });

  it('mount sem canvas válido devolve handle com ok=false', () => {
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

  it('shader sem WebGL: ok=false com mensagem; com fragment ausente também', () => {
    const rt = vm.runInNewContext(source, {}) as EffectsRuntime;
    const semGl = { getContext: () => null, width: 1, height: 1 };
    const h = rt.mount(semGl, effectMountSpec({ kind: 'grain', params: {} }));
    expect(h.ok).toBe(false);
    expect(h.error).toContain('WebGL');
  });

  it('partículas desenham num contexto 2d de mentira e destroy para o desenho', () => {
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
    const antes = calls.length;
    h.draw(2);
    expect(calls.length).toBe(antes);
  });

  it('effectMountSpec: resolve params, inclui fragment dos shaders e selects', () => {
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

    const desconhecido = effectMountSpec({ kind: 'nao-existe', params: { a: 1 } });
    expect(desconhecido.category).toBe('shader');
    expect(desconhecido.fragment).toBeUndefined();
    expect(desconhecido.params).toEqual({ a: 1 });
  });
});

/* ---------------- exportação ---------------- */

const BG = { position: 'absolute', inset: '0', 'z-index': '-1' };

describe('exportHtml com mídia', () => {
  it('effect: canvas com spec JSON, fundo de fallback e um único script de runtime', () => {
    const html = exportHtml(
      docWith([createEffectNode('mesh-gradient', { speed: 2 }, { styles: BG })]),
    );
    const m = /<canvas class="efeito" data-mockup-effect='([^']+)'><\/canvas>/.exec(html);
    expect(m).not.toBeNull();
    const spec = JSON.parse(m![1]!);
    expect(spec.kind).toBe('mesh-gradient');
    expect(spec.category).toBe('shader');
    expect(spec.params.speed).toBe(2);
    expect(spec.params.color2).toBe('#00c2a8');
    expect(spec.fragment).toBeUndefined();
    // fallback CSS visível sem JS + estilos do usuário
    expect(html).toMatch(/\.efeito \{[^}]*radial-gradient[^}]*position: absolute/s);
    expect(html).toMatch(/\.efeito \{[^}]*z-index: -1/s);
    // fragment shader e runtime vão uma única vez no script
    expect(html.match(/<script>/g)).toHaveLength(1);
    expect(html).toContain('mockupEffectsRuntime');
    expect(html).toContain('canvas[data-mockup-effect]');
    expect(html).toContain('gl_FragColor');
    expect(html).not.toContain('</script>\n</script>');
  });

  it('vários efeitos do mesmo kind compartilham UM fragment; partículas não levam fragment', () => {
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

  it('sem nós de mídia não há script', () => {
    const html = exportHtml(docWith([createNode({ tag: 'p', text: 'oi' })]));
    expect(html).not.toContain('<script');
  });

  it('fragment: true mantém os scripts logo após o markup', () => {
    const html = exportHtml(docWith([createEffectNode('glass')]), { fragment: true });
    expect(html).not.toContain('<!doctype');
    expect(html.indexOf('<canvas')).toBeLessThan(html.indexOf('<script>'));
  });

  it('modo inline coloca o fallback no style do canvas', () => {
    const html = exportHtml(docWith([createEffectNode('grain')]), { mode: 'inline' });
    expect(html).toMatch(/<canvas data-mockup-effect='[^']+' style="background: linear-gradient\(/);
  });

  it('video: tag video com src em assets/, poster, autoplay, loop, muted e playsinline', () => {
    const html = exportHtml(
      docWith([
        createVideoNode({
          src: 'clip.mp4',
          poster: 'capa.png',
          autoplay: true,
          loop: true,
          muted: true,
          controls: true,
        }),
      ]),
    );
    expect(html).toContain(
      '<video src="assets/clip.mp4" poster="assets/capa.png" autoplay loop muted controls playsinline></video>',
    );
  });

  it('video sem flags não leva autoplay/loop/muted/controls; URL http(s) é mantida', () => {
    const html = exportHtml(docWith([createVideoNode({ src: 'https://cdn.example.com/a.mp4' })]));
    expect(html).toContain('<video src="https://cdn.example.com/a.mp4" playsinline></video>');
    expect(html).not.toMatch(/autoplay|loop|muted|controls|poster/);
  });
  it('video com src perigoso (documento sem validação) nunca vira um esquema executável', () => {
    const node = createVideoNode({ src: 'a.mp4' });
    node.video = { src: 'javascript:alert(1)' };
    const html = exportHtml(docWith([node]));
    // o prefixo assets/ transforma o valor num caminho relativo inofensivo
    expect(html).not.toMatch(/src="javascript:/i);
    expect(html).toContain('<video src="assets/javascript:alert(1)"');
  });

  it('youtube: iframe nocookie com start, autoplay e mute', () => {
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

  it('iframe: sandbox e apenas URL http(s)', () => {
    const html = exportHtml(
      docWith([createEmbedNode({ provider: 'iframe', url: 'https://example.com/a?x=1&y=2' })]),
    );
    expect(html).toContain('src="https://example.com/a?x=1&amp;y=2"');
    expect(html).toContain('sandbox="allow-scripts allow-same-origin allow-popups"');

    const ruim = createEmbedNode({ provider: 'iframe', url: 'https://example.com' });
    ruim.embed = { provider: 'iframe', url: 'javascript:alert(1)' };
    const h2 = exportHtml(docWith([ruim]));
    expect(h2).not.toContain('javascript:');
    expect(h2).not.toContain('<iframe');
  });

  it('lottie: div com data-src e script de CDN com lottie.loadAnimation', () => {
    const html = exportHtml(
      docWith([createEmbedNode({ provider: 'lottie', src: 'anim.json', params: { loop: false } })]),
    );
    expect(html).toContain(
      '<div data-mockup-embed="lottie" data-src="assets/anim.json" data-autoplay="true" data-loop="false"></div>',
    );
    expect(html).toContain('lottie-web');
    expect(html).toContain('lottie.loadAnimation');
  });

  it('rive: canvas com data-src, artboard e state machine, e script de CDN', () => {
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

  it('three: canvas com data-island, código embutido e script de módulo do CDN', () => {
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

  it('three: código com </script> não fecha o script (escape)', () => {
    const html = exportHtml(
      docWith([createEmbedNode({ provider: 'three', code: 'const x = "</script><b>";' })]),
    );
    expect(html).not.toContain('"</script><b>"');
    expect(html).toContain('<\\/script>');
  });

  it('numera as ilhas three em ordem', () => {
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

describe('exportTailwind com mídia', () => {
  it('effect: canvas com classes Tailwind (fundo de fallback arbitrário) e script', () => {
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

  it('video e iframes mantêm atributos; border-0 vira classe', () => {
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

  it('lottie/rive/three: marcações e scripts', () => {
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

describe('exportSvg com mídia (sem layout: foreignObject)', () => {
  it('effect vira div estático com data-mockup-effect, data-params e fallback; sem script', () => {
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

  it('video e embeds viram markup inerte', () => {
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

describe('exportReact com mídia', () => {
  it('efeito live: <MockupEffect> com spec tipada, runtime em mockup-effects.js e fallback', () => {
    const fx = createEffectNode('mesh-gradient', { speed: 2 }, { styles: BG });
    const r = exportReact(docWith([fx]), { nodeId: 'fr_test0001' });
    expect(r.code).toContain("import { useEffect, useRef, type CSSProperties } from 'react';");
    expect(r.code).toContain("import { playEffect, type EffectMount } from './mockup-effects.js';");
    expect(r.code).toMatch(/const \w+Effect: EffectMount = \{/);
    expect(r.code).toContain('"kind": "mesh-gradient"');
    expect(r.code).toContain('"speed": 2');
    expect(r.code).toMatch(/<MockupEffect\s+spec=\{\w+Effect\}/);
    expect(r.code).toContain('function MockupEffect(');
    // fundo de fallback do catálogo continua no elemento (visível antes do WebGL)
    expect(r.code).toContain('radial-gradient');
    const names = (r.files ?? []).map((f) => f.name);
    expect(names).toEqual(['mockup-effects.js', 'mockup-effects.d.ts']);
    const js = r.files![0].code;
    // runtime com os fragments de todo o catálogo (arquivo único compartilhado)
    expect(js).toContain('export function playEffect');
    for (const k of KINDS.filter((k) => k !== 'particles')) expect(js).toContain(`"${k}"`);
    expect(() => new Function(js.replace(/^export /gm, ''))).not.toThrow();
  });

  it('efeito static: <img> com a imagem de effectImages, sem runtime', () => {
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

  it('modo inline: efeito com style do fallback', () => {
    const { code } = exportReact(docWith([createEffectNode('grain')]), {
      nodeId: 'fr_test0001',
      styles: 'inline',
    });
    expect(code).toContain('<MockupEffect');
    expect(code).toContain('linear-gradient(160deg');
  });

  it('vídeo e YouTube viram <video> e <iframe> com props JSX', () => {
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

  it('Lottie e Rive usam lottie-web e @rive-app/canvas', () => {
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

  it('ilha Three.js: arquivo <slug>-three-1.js com o código e <ThreeIsland>', () => {
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
    expect(r.code).toContain("import { setup as setupThree1 } from './tela-three-1.js';");
    expect(r.code).toMatch(/const \w+Params: ThreeParams = \{\n {2}"color": "#ff0000"\n\};/);
    expect(r.code).toMatch(/<ThreeIsland setup=\{setupThree1\} params=\{\w+Params\}/);
    expect(r.code).not.toContain("from 'three'");
    const names = (r.files ?? []).map((f) => f.name);
    expect(names).toEqual(['tela-three-1.js', 'tela-three-1.d.ts']);
    expect(r.files![0].code).toContain("import * as THREE from 'three';");
    expect(r.files![0].code).toContain('const scene = new THREE.Scene();');
  });

  it('ilhas Three.js de raízes com o mesmo nome ganham arquivos distintos pelo componentName', () => {
    const doc = docWith([createEmbedNode({ provider: 'three', code: 'return { a: 1 };' })]);
    const a = exportReact(doc, { nodeId: 'fr_test0001', componentName: 'Tela' });
    const b = exportReact(doc, { nodeId: 'fr_test0001', componentName: 'Tela2' });
    expect((a.files ?? []).map((f) => f.name)).toEqual(['tela-three-1.js', 'tela-three-1.d.ts']);
    expect((b.files ?? []).map((f) => f.name)).toEqual(['tela2-three-1.js', 'tela2-three-1.d.ts']);
    expect(b.code).toContain("from './tela2-three-1.js';");
  });

  it('dois embeds three com o mesmo nome no mesmo componente geram arquivos distintos', () => {
    const r = exportReact(
      docWith([
        createEmbedNode({ provider: 'three', code: 'return 1;' }, { name: 'Cena' }),
        createEmbedNode({ provider: 'three', code: 'return 2;' }, { name: 'Cena' }),
      ]),
      { nodeId: 'fr_test0001' },
    );
    const js = (r.files ?? []).map((f) => f.name).filter((n) => n.endsWith('.js'));
    expect(js).toEqual(['tela-three-1.js', 'tela-three-2.js']);
    expect(r.code).toContain("from './tela-three-1.js';");
    expect(r.code).toContain("from './tela-three-2.js';");
  });

  it('sem mídia o cabeçalho não muda', () => {
    const { code, files } = exportReact(docWith([]), { nodeId: 'fr_test0001' });
    expect(code).not.toContain('useEffect');
    expect(files).toBeUndefined();
  });
});
