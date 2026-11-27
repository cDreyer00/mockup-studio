import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { parse } from '../csstree.js';
import { createDocument, createNode } from '../document.js';
import { documentBaseCss } from '../base.js';
import type { Document, Node, NodeAnimation } from '../types.js';
import { exportHtml } from './html.js';
import { buildRuntimeFunction, buildRuntimeScript } from './motion.js';
import { exportReact } from './react.js';
import { exportSvg } from './svg.js';
import { exportTailwind } from './tailwind.js';

/** `createNode` does not take animations: they are assigned afterwards. */
const el = (init: Partial<Node> & { tag: string }): Node => {
  const node = createNode(init);
  if (init.animations) node.animations = init.animations;
  return node;
};

function animated(): Document {
  const doc = createDocument('Motion', { id: 'doc_motion' });
  const title = el({
    tag: 'h1',
    id: 'el_title001',
    name: 'Title',
    text: 'Hello big world',
    style: { 'font-size': '32px' },
    animations: [{ kind: 'in', preset: 'fade-up', split: 'chars' }],
  });
  const badge = el({
    tag: 'div',
    id: 'el_badge001',
    name: 'Badge',
    style: { width: '40px', height: '40px' },
    animations: [
      { kind: 'in', preset: 'fade-up' },
      { kind: 'emphasis', preset: 'float' },
    ],
  });
  const items = ['One', 'Two', 'Three'].map((t, i) =>
    el({ tag: 'li', id: `el_item00${i}`, name: 'Item', text: t, style: { padding: '4px' } }),
  );
  const list = el({
    tag: 'ul',
    id: 'el_list0001',
    name: 'List',
    children: items,
    animations: [
      { kind: 'in', preset: 'fade-up', split: 'children', stagger: 100, build: 1 },
      { kind: 'out', preset: 'fade', build: 2 },
    ],
  });
  const custom = el({
    tag: 'div',
    id: 'el_custom01',
    name: 'Custom',
    style: { width: '10px', height: '10px' },
    animations: [
      {
        kind: 'emphasis',
        preset: 'custom',
        duration: 800,
        keyframes: [{ transform: 'scale(1)' }, { transform: 'scale(1.2)' }],
      },
    ],
  });
  doc.pages[0].frames.push(
    el({
      tag: 'div',
      type: 'frame',
      id: 'fr_motion001',
      name: 'Screen',
      style: { width: '400px', height: '300px' },
      children: [title, badge, list, custom],
    }),
  );
  return doc;
}

function plain(anims?: NodeAnimation[]): Document {
  const doc = createDocument('Plain', { id: 'doc_plain' });
  doc.pages[0].frames.push(
    el({
      tag: 'div',
      type: 'frame',
      id: 'fr_plain0001',
      name: 'Screen',
      style: { width: '400px', height: '300px' },
      children: [el({ tag: 'p', id: 'el_p000001', name: 'P', text: 'Hi', animations: anims })],
    }),
  );
  return doc;
}

const styleOf = (html: string): string =>
  [...html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map((m) => m[1]).join('\n');

function expectParses(css: string): void {
  const errors: unknown[] = [];
  parse(css, { onParseError: (e: unknown) => errors.push(e) });
  expect(errors).toEqual([]);
}

describe('motion export: html', () => {
  const html = exportHtml(animated());

  it('snapshot', () => {
    expect(html).toMatchSnapshot();
  });

  it('wraps every animation rule in prefers-reduced-motion: no-preference', () => {
    const css = styleOf(html);
    const at = css.indexOf('@media (prefers-reduced-motion: no-preference)');
    expect(at).toBeGreaterThan(-1);
    const outside = css.slice(0, at);
    expect(outside).not.toContain('@keyframes');
    expect(outside).not.toContain('animation:');
    expectParses(css);
  });

  it('emits identical keyframes once and suffixes builds', () => {
    const names = [...html.matchAll(/@keyframes (mk-[0-9a-f]{6}(?:-b\d+)?)/g)].map((m) => m[1]);
    expect(new Set(names).size).toBe(names.length);
    expect(names.some((n) => n.endsWith('-b1'))).toBe(true);
    expect(names.some((n) => n.endsWith('-b2'))).toBe(true);
    // the badge and the title share the fade-up keyframes only when equal; the custom one is its own
    expect(names.some((n) => !n.includes('-b'))).toBe(true);
    expect(html).toContain('animation-play-state: paused');
    expect(html).toContain('infinite');
  });

  it('identical keyframes on two nodes are emitted once', () => {
    const doc = plain([{ kind: 'in', preset: 'fade-up' }]);
    doc.pages[0].frames[0].children.push(
      el({
        tag: 'p',
        id: 'el_p000002',
        name: 'P2',
        text: 'Two',
        animations: [{ kind: 'in', preset: 'fade-up', delay: 200 }],
      }),
    );
    const out = exportHtml(doc);
    expect(out.match(/@keyframes mk-/g)).toHaveLength(1);
    expect(out.match(/\[data-mk="\d"\] \{/g)).toHaveLength(2);
  });

  it('split chars: data-motion-seg count = segments, words wrap their characters', () => {
    // "Hello big world": 13 characters in 3 words
    expect(html.match(/<span data-motion-seg/g)).toHaveLength(13);
    expect(html.match(/<span data-motion-word>/g)).toHaveLength(3);
    expect(html).toContain('<span data-motion-seg style="--mi: 0">H</span>');
    expect(html).toContain('calc(var(--mi) * 30ms');
  });

  it('children split gives each child its own delay', () => {
    const delays = [
      ...html.matchAll(/animation: mk-[0-9a-f]{6}-b1 \d+ms .*? (\d+)ms 1 normal backwards/g),
    ];
    expect(delays.map((m) => m[1])).toEqual(['0', '100', '200']);
  });

  it('runs the build runtime only with builds > 0', () => {
    expect(html).toContain('<script>');
    expect(html).toContain('getAnimations');
    const noBuild = exportHtml(plain([{ kind: 'in', preset: 'fade-up' }]));
    expect(noBuild).not.toContain('<script>');
    expect(noBuild).toContain('@keyframes mk-');
    expectParses(styleOf(noBuild));
  });

  it('documents without animations get no motion output', () => {
    const out = exportHtml(plain());
    expect(out).not.toContain('data-mk');
    expect(out).not.toContain('@keyframes');
    expect(out).not.toContain('prefers-reduced-motion');
  });

  it('fragment keeps style and script', () => {
    const frag = exportHtml(animated(), { fragment: true });
    expect(frag.startsWith('<style>')).toBe(true);
    expect(frag).toContain('<script>');
  });

  it('inline mode works too', () => {
    const inline = exportHtml(animated(), { mode: 'inline' });
    expect(inline).toContain('data-mk=');
    expectParses(styleOf(inline));
  });
});

describe('motion export: tailwind', () => {
  const out = exportTailwind(animated());
  it('snapshot', () => {
    expect(out).toMatchSnapshot();
  });
  it('includes the css, the spans and the runtime', () => {
    expect(out).toContain('@media (prefers-reduced-motion: no-preference)');
    expect(out).toContain('data-motion-seg');
    expect(out).toContain('getAnimations');
    expectParses(styleOf(out).replace(/@import[^;]*;/g, ''));
  });
  it('no script without builds', () => {
    const o = exportTailwind(plain([{ kind: 'in', preset: 'fade-up' }]));
    expect(o).not.toContain('getAnimations');
    expect(o).toContain('@keyframes mk-');
  });
  it('fragment carries a style', () => {
    expect(exportTailwind(animated(), { fragment: true }).startsWith('<style>')).toBe(true);
  });
});

const reactTypes = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../../node_modules/@types/react',
);

function compile(code: string): string[] {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mockup-react-motion-'));
  try {
    const file = path.join(dir, 'Component.tsx');
    fs.writeFileSync(file, code);
    const program = ts.createProgram([file], {
      strict: true,
      noUnusedLocals: true,
      noUnusedParameters: true,
      noEmit: true,
      jsx: ts.JsxEmit.ReactJSX,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      target: ts.ScriptTarget.ES2022,
      lib: ['lib.es2022.d.ts', 'lib.dom.d.ts'],
      verbatimModuleSyntax: true,
      skipLibCheck: true,
      types: [],
      baseUrl: dir,
      paths: {
        react: [path.join(reactTypes, 'index.d.ts')],
        'react/jsx-runtime': [path.join(reactTypes, 'jsx-runtime.d.ts')],
      },
    });
    return ts
      .getPreEmitDiagnostics(program)
      .map((d) => ts.flattenDiagnosticMessageText(d.messageText, '\n'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

describe('motion export: react', () => {
  for (const styles of ['tailwind', 'inline'] as const) {
    describe(styles, () => {
      const out = exportReact(animated(), { nodeId: 'fr_motion001', styles });
      it('snapshot', () => {
        expect(out).toMatchSnapshot();
      });
      it('css carries the keyframes, wrapped in reduced-motion', () => {
        expect(out.css).toContain('@media (prefers-reduced-motion: no-preference)');
        expectParses((out.css ?? '').replace(/@import[^;]*;/g, ''));
      });
      it('installs the build runtime in a useEffect and compiles', () => {
        expect(out.code).toContain('useEffect(() => installBuilds(), []);');
        expect(out.code).toContain('data-motion-seg=""');
        expect(compile(out.code)).toEqual([]);
      }, 30_000);
    });
  }
  it('no useEffect without builds', () => {
    const o = exportReact(plain([{ kind: 'in', preset: 'fade-up' }]), { nodeId: 'fr_plain0001' });
    expect(o.code).not.toContain('useEffect');
    expect(o.css).toContain('@keyframes mk-');
    expect(compile(o.code)).toEqual([]);
  }, 30_000);
  it('no motion without animations', () => {
    const o = exportReact(plain(), { nodeId: 'fr_plain0001' });
    expect(o.code).not.toContain('data-mk');
    expect(o.css).not.toContain('prefers-reduced-motion');
  });
});

describe('motion export: svg and base', () => {
  it('svg ignores animations', () => {
    const out = exportSvg(animated(), { nodeId: 'fr_motion001' });
    const svg = typeof out === 'string' ? out : JSON.stringify(out);
    expect(svg).not.toContain('data-mk');
    expect(svg).not.toContain('@keyframes mk-');
  });
  it('tailwind base ships the default keyframes', () => {
    const css = documentBaseCss(undefined, undefined, { preflight: true });
    for (const n of ['spin', 'ping', 'pulse', 'bounce']) expect(css).toContain(`@keyframes ${n}`);
    expect(documentBaseCss()).not.toContain('@keyframes');
    expectParses(css);
  });
});

describe('motion export: build runtime', () => {
  /** A document whose finished animations leave `getAnimations()`, as CSS animations do. */
  function fakePage() {
    const anim = (animationName: string) => ({
      animationName,
      state: 'paused' as 'paused' | 'running' | 'finished',
      currentTime: 0,
      play() {
        this.state = 'running';
      },
      pause() {
        this.state = 'paused';
      },
    });
    const anims = [anim('mk-aaaaaa-b2'), anim('mk-bbbbbb-b5')];
    const handlers = new Map<string, (e: unknown) => void>();
    const document = {
      getAnimations: () => anims.filter((a) => a.state !== 'finished'),
      addEventListener: (type: string, fn: (e: unknown) => void) => handlers.set(type, fn),
      removeEventListener: (type: string) => handlers.delete(type),
    };
    const press = (key: string) =>
      handlers.get('keydown')!({ key, target: {}, preventDefault() {} });
    const finish = () => {
      for (const a of anims) if (a.state === 'running') a.state = 'finished';
    };
    const states = () => anims.map((a) => a.state);
    return { document, press, finish, states };
  }

  const runtimes: [string, (document: unknown) => void][] = [
    [
      'html',
      (document) => {
        const body = buildRuntimeScript().replace(/<\/?script>/g, '');
        new Function('document', body)(document);
      },
    ],
    [
      'react',
      (document) => {
        const js = ts.transpileModule(buildRuntimeFunction().join('\n'), {
          compilerOptions: { target: ts.ScriptTarget.ES2022 },
        }).outputText;
        new Function('document', `${js}\ninstallBuilds();`)(document);
      },
    ],
  ];

  it.each(runtimes)('%s: rewinds builds that already finished, then replays them', (_, run) => {
    const page = fakePage();
    run(page.document);
    for (let i = 0; i < 2; i++) {
      page.press('ArrowRight');
      page.finish();
    }
    expect(page.states()).toEqual(['finished', 'finished']);
    page.press('ArrowLeft');
    expect(page.states()).toEqual(['finished', 'paused']);
    page.press('ArrowLeft');
    expect(page.states()).toEqual(['paused', 'paused']);
    page.press('ArrowRight');
    expect(page.states()).toEqual(['running', 'paused']);
  });
});

describe('motion export: instances', () => {
  it('react: an instance with its own animations is emitted expanded, with them', () => {
    const doc = plain();
    doc.components = [
      {
        id: 'cp_chip',
        name: 'Chip',
        props: [],
        variants: [],
        root: el({ tag: 'div', id: 'el_chip0001', name: 'Chip', style: { width: '40px' } }),
      },
    ];
    const instance = (id: string, animations?: NodeAnimation[]): Node => ({
      ...el({ tag: 'div', id, name: 'Chip', animations }),
      type: 'instance',
      componentId: 'cp_chip',
    });
    doc.pages[0].frames[0].children = [
      instance('in_plain001'),
      instance('in_moving01', [{ kind: 'in', preset: 'pop' }]),
    ];
    const out = exportReact(doc, { nodeId: 'fr_plain0001' });
    expect(out.code.match(/<Chip \/>/g)).toHaveLength(1);
    expect(out.code.match(/data-mk=/g)).toHaveLength(1);
    expect(out.css).toContain('animation: mk-');
    expect(compile(out.code)).toEqual([]);
    expect(exportHtml(doc)).toContain('animation: mk-');
  }, 30_000);
});
