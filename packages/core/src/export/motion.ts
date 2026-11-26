/**
 * Node animations in exported code: real CSS `@keyframes` + `animation` declarations.
 *
 * - Each animated element gets `data-mk="<n>"` (unique per element, in document order); the rules
 *   target `[data-mk="<n>"]`, so they work the same in classes, inline and Tailwind exports.
 * - `@keyframes` are named from a short hash of their content (`mk-3f9a1c`), deduplicated, and get
 *   the `-b<build>` suffix when the build is > 0 (the click runtime finds them by name).
 * - A text split into words/characters becomes inline-block `span[data-motion-seg]` per segment
 *   (the same structure the editor renders), each with `--mi` = its index so the stagger is a
 *   `calc()` on `animation-delay`.
 * - ALL the animation rules live in `@media (prefers-reduced-motion: no-preference)`: reduced-motion
 *   users get the final design (an exit never hides content). Only the layout of split text
 *   (inline-block spans) stays outside, so lines wrap the same either way.
 * - `Node.slideTransition` is presentation only and is not exported.
 * - Builds > 0 start paused; `BUILD_RUNTIME` plays the next build on click / ArrowRight / Space /
 *   PageDown (ArrowLeft / PageUp rewinds the previous one).
 */
import { compileNodeMotion, keyframesCss, textSplitOf, splitText } from '../motion/index.js';
import type { CompiledMotion } from '../motion/index.js';
import { cssValueProblem, isValidCssPropertyName } from '../styles.js';
import type { AnimationKeyframe, Node } from '../types.js';

export const MOTION_ATTR = 'data-mk';
export const MOTION_MEDIA = '@media (prefers-reduced-motion: no-preference)';

/** Layout of split text: outside the reduced-motion wrapper. */
export const SPLIT_LAYOUT_CSS =
  '[data-motion-seg] {\n  display: inline-block;\n}\n[data-motion-word] {\n  display: inline-block;\n  white-space: nowrap;\n}';

/** Does the subtree have any node animation? */
export function hasMotion(node: Node): boolean {
  return (node.animations?.length ?? 0) > 0 || node.children.some(hasMotion);
}

/** Part of a split text: a segment (`index` = animated segment number), a word wrapper or plain text. */
export type SplitPart =
  | { type: 'text'; text: string }
  | { type: 'seg'; text: string; index: number }
  | { type: 'word'; segs: { text: string; index: number }[] };

/** Structure of a split text (the same as the editor's `splitTextChildren`). */
export function splitParts(text: string, mode: 'words' | 'chars'): SplitPart[] {
  const out: SplitPart[] = [];
  let index = 0;
  let word: { text: string; index: number }[] = [];
  const flush = (): void => {
    if (word.length > 0) out.push({ type: 'word', segs: word });
    word = [];
  };
  for (const s of splitText(text, mode)) {
    if (s.space) {
      flush();
      out.push({ type: 'text', text: s.text });
    } else if (mode === 'words') out.push({ type: 'seg', text: s.text, index: index++ });
    else word.push({ text: s.text, index: index++ });
  }
  flush();
  return out;
}

interface ElementEntry {
  c: CompiledMotion;
  seq: number;
}

function fnv(s: string, seed: number): string {
  let h = seed >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

/** Keeps only valid properties and safe values (the keyframes may come from the user). */
function safeKeyframes(keyframes: AnimationKeyframe[]): AnimationKeyframe[] {
  return keyframes.map((k) => {
    const out: AnimationKeyframe = {};
    for (const [p, v] of Object.entries(k)) {
      if (v === undefined) continue;
      if (p === 'offset') out.offset = v as number;
      else if (p === 'easing') {
        if (typeof v === 'string' && cssValueProblem(v) === null) out.easing = v;
      } else if (isValidCssPropertyName(p) && cssValueProblem(String(v)) === null) {
        (out as Record<string, unknown>)[p] = v;
      }
    }
    return out;
  });
}

const ms = (n: number): string => `${Number(n.toFixed(3))}ms`;

/**
 * Collects the animations of the nodes as they are rendered (call `register(node)` before rendering a
 * node), then produces the CSS, the attributes and the build runtime.
 */
export class MotionCollector {
  private keys = new Map<Node, number>();
  private registered = new Set<Node>();
  private elements = new Map<Node, ElementEntry[]>();
  /** Animations of split texts: per node, one group per animation (`index` in `node.animations`). */
  private segments = new Map<Node, CompiledMotion[][]>();
  private bodies = new Map<string, string>();
  private names = new Map<string, string>();
  private seq = 0;
  /** Some text uses the split spans. */
  usesSplit = false;
  /** Distinct builds > 0 (sorted). */
  builds = new Set<number>();

  private keyFor(node: Node): number {
    let k = this.keys.get(node);
    if (k === undefined) {
      k = this.keys.size + 1;
      this.keys.set(node, k);
    }
    return k;
  }

  /** Compiles the node's animations and assigns them to their target elements. Idempotent. */
  register(node: Node): void {
    if (this.registered.has(node)) return;
    this.registered.add(node);
    const list = compileNodeMotion(node);
    if (list.length === 0) return;
    const kids = node.children.filter((c) => !c.hidden);
    const groups = new Map<number, CompiledMotion[]>();
    for (const c of list) {
      if (c.build > 0) this.builds.add(c.build);
      if (c.target.type === 'segment') {
        let g = groups.get(c.index);
        if (!g) groups.set(c.index, (g = []));
        g.push(c);
        continue;
      }
      const el = c.target.type === 'self' ? node : kids[c.target.index];
      if (!el) continue;
      this.keyFor(el);
      let e = this.elements.get(el);
      if (!e) this.elements.set(el, (e = []));
      e.push({ c, seq: this.seq++ });
    }
    if (groups.size > 0) {
      this.keyFor(node);
      this.usesSplit = true;
      this.segments.set(node, [...groups.values()]);
    }
  }

  /** `data-mk` value of the element, if some animation targets it. */
  keyOf(node: Node): number | undefined {
    return this.keys.get(node);
  }

  /** Text split of the node when its animations split it (and the text exists). */
  splitOf(node: Node): 'words' | 'chars' | null {
    return this.segments.has(node) ? textSplitOf(node) : null;
  }

  get hasBuilds(): boolean {
    return this.builds.size > 0;
  }

  get isEmpty(): boolean {
    return this.keys.size === 0;
  }

  private keyframesName(c: CompiledMotion): string {
    const kfs = safeKeyframes(c.keyframes);
    const body = keyframesCss('NAME', kfs);
    const id = `${body}|${c.build}`;
    const known = this.names.get(id);
    if (known) return known;
    let h = fnv(body, 2166136261).slice(0, 6);
    for (let salt = 1; this.bodies.has(`mk-${h}${c.build > 0 ? `-b${c.build}` : ''}`); salt++) {
      h = fnv(body + salt, 2166136261).slice(0, 6);
    }
    const name = `mk-${h}${c.build > 0 ? `-b${c.build}` : ''}`;
    this.names.set(id, name);
    this.bodies.set(name, keyframesCss(name, kfs));
    return name;
  }

  private declarations(items: { c: CompiledMotion; delay: string }[]): string[] {
    const shorthand = items.map(({ c, delay }) => {
      const t = c.timing;
      const iter = Number.isFinite(t.iterations) ? String(t.iterations) : 'infinite';
      return [this.keyframesName(c), ms(t.duration), t.easing, delay, iter, t.direction, t.fill]
        .filter((x) => x !== '')
        .join(' ');
    });
    const out = [`animation: ${shorthand.join(', ')};`];
    if (items.some(({ c }) => c.build > 0)) {
      out.push(
        `animation-play-state: ${items.map(({ c }) => (c.build > 0 ? 'paused' : 'running')).join(', ')};`,
      );
    }
    return out;
  }

  /** Stylesheet: split-text layout, then the `@keyframes` and rules in the reduced-motion wrapper. */
  css(): string {
    if (this.isEmpty) return '';
    const rules: string[] = [];
    const sel = (node: Node): string => `[${MOTION_ATTR}="${this.keys.get(node)}"]`;
    const rule = (selector: string, decls: string[]): string =>
      `  ${selector} {\n${decls.map((d) => `    ${d}`).join('\n')}\n  }`;
    for (const [node] of [...this.keys].sort((a, b) => a[1] - b[1])) {
      const entries = this.elements.get(node);
      if (entries?.length) {
        const sorted = [...entries].sort(
          (a, b) => a.c.build - b.c.build || a.c.timing.delay - b.c.timing.delay || a.seq - b.seq,
        );
        rules.push(
          rule(
            sel(node),
            this.declarations(sorted.map(({ c }) => ({ c, delay: ms(c.timing.delay) }))),
          ),
        );
      }
      const groups = this.segments.get(node);
      if (groups) {
        const items = groups.map((g) => {
          const d0 = g[0].timing.delay;
          const stagger = g.length > 1 ? g[1].timing.delay - d0 : 0;
          const delay = stagger > 0 ? `calc(var(--mi) * ${ms(stagger)} + ${ms(d0)})` : ms(d0);
          return { c: g[0], delay };
        });
        rules.push(rule(`${sel(node)} [data-motion-seg]`, this.declarations(items)));
      }
    }
    const frames = [...this.bodies.values()].map((b) =>
      b
        .split('\n')
        .map((l) => `  ${l}`)
        .join('\n'),
    );
    const parts: string[] = [];
    if (this.usesSplit) parts.push(SPLIT_LAYOUT_CSS);
    parts.push(`${MOTION_MEDIA} {\n${[...frames, ...rules].join('\n')}\n}`);
    return parts.join('\n');
  }
}

/**
 * Minimal build runtime (no dependencies): builds > 0 start paused (`animation-play-state: paused`
 * and `@keyframes mk-xxxxxx-b<n>`); click / ArrowRight / Space / PageDown plays the next build,
 * ArrowLeft / PageUp rewinds the previous one. Without reduced-motion support nothing is found
 * (`document.getAnimations()` is empty) and the page simply shows the final design.
 */
export const BUILD_RUNTIME_BODY = [
  'var step = 0, list = null;',
  'function anims(b) {',
  '  return document.getAnimations().filter(function (a) {',
  "    return a.animationName && a.animationName.slice(-('-b' + b).length) === '-b' + b;",
  '  });',
  '}',
  'function builds() {',
  '  var seen = {};',
  '  document.getAnimations().forEach(function (a) {',
  '    var m = /-b(\\d+)$/.exec(a.animationName || "");',
  '    if (m) seen[m[1]] = 1;',
  '  });',
  '  return Object.keys(seen).map(Number).sort(function (x, y) { return x - y; });',
  '}',
  'function go(dir) {',
  '  list = list || builds();',
  '  if (dir > 0 && step < list.length) anims(list[step++]).forEach(function (a) { a.play(); });',
  '  else if (dir < 0 && step > 0) anims(list[--step]).forEach(function (a) { a.pause(); a.currentTime = 0; });',
  '}',
  'function onClick(e) {',
  "  if (!e.target.closest || !e.target.closest('a, button, input, select, textarea')) go(1);",
  '}',
  'function onKey(e) {',
  "  if (e.target.closest && e.target.closest('input, select, textarea')) return;",
  "  if (e.key === 'ArrowRight' || e.key === ' ' || e.key === 'PageDown') { e.preventDefault(); go(1); }",
  "  else if (e.key === 'ArrowLeft' || e.key === 'PageUp') { e.preventDefault(); go(-1); }",
  '}',
  "document.addEventListener('click', onClick);",
  "document.addEventListener('keydown', onKey);",
];

/** `<script>` with the build runtime (HTML exports). */
export function buildRuntimeScript(): string {
  return [
    '<script>',
    '// Builds: click / ArrowRight / Space / PageDown plays the next build (ArrowLeft / PageUp rewinds).',
    '(function () {',
    ...BUILD_RUNTIME_BODY.map((l) => `  ${l}`),
    '})();',
    '</script>',
  ].join('\n');
}

/** Module-level function for React exports: installs the handlers and returns the cleanup. */
export function buildRuntimeFunction(): string[] {
  return [
    '/** Builds: click / ArrowRight / Space / PageDown plays the next build (ArrowLeft / PageUp rewinds). */',
    'function installBuilds(): () => void {',
    '  let step = 0;',
    '  let list: number[] | null = null;',
    '  const anims = (b: number): Animation[] =>',
    '    document.getAnimations().filter((a) => (a as CSSAnimation).animationName?.endsWith(`-b${b}`));',
    '  const builds = (): number[] => {',
    '    const seen = new Set<number>();',
    '    for (const a of document.getAnimations()) {',
    '      const m = /-b(\\d+)$/.exec((a as CSSAnimation).animationName ?? "");',
    '      if (m) seen.add(Number(m[1]));',
    '    }',
    '    return [...seen].sort((x, y) => x - y);',
    '  };',
    '  const go = (dir: number): void => {',
    '    list = list ?? builds();',
    '    if (dir > 0 && step < list.length) anims(list[step++]).forEach((a) => a.play());',
    '    else if (dir < 0 && step > 0) {',
    '      anims(list[--step]).forEach((a) => {',
    '        a.pause();',
    '        a.currentTime = 0;',
    '      });',
    '    }',
    '  };',
    '  const onClick = (e: MouseEvent): void => {',
    "    if (!(e.target as Element).closest?.('a, button, input, select, textarea')) go(1);",
    '  };',
    '  const onKey = (e: KeyboardEvent): void => {',
    "    if ((e.target as Element).closest?.('input, select, textarea')) return;",
    "    if (e.key === 'ArrowRight' || e.key === ' ' || e.key === 'PageDown') {",
    '      e.preventDefault();',
    '      go(1);',
    "    } else if (e.key === 'ArrowLeft' || e.key === 'PageUp') {",
    '      e.preventDefault();',
    '      go(-1);',
    '    }',
    '  };',
    "  document.addEventListener('click', onClick);",
    "  document.addEventListener('keydown', onKey);",
    '  return () => {',
    "    document.removeEventListener('click', onClick);",
    "    document.removeEventListener('keydown', onKey);",
    '  };',
    '}',
  ];
}
