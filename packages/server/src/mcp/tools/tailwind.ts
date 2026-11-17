/**
 * Native Tailwind in MCP: `write_html` with classes, `import_component` (shadcn/ui, Tailwind UI),
 * `set_classes`/`get_classes`/`suggest_classes`, `get_tailwind_config` and `set_css_base`. The engine
 * (`@mockup/core/tailwind`) is the same as the editor's: classes become the node's `style`/`states` and the
 * written classes stay in `node.classes` (round-trip hint for export).
 */
import { z } from 'zod';
import {
  BREAKPOINT_PX,
  BREAKPOINTS,
  PSEUDO_STATES,
  fixedWidthPx,
  htmlToNodes,
  normalizeStateKey,
  normalizeStyles,
  tailwindThemeCss,
  toKebabCase,
  type Node,
  type NodePath,
  type Op,
} from '@mockup/core';
import {
  SHADCN_COLOR_NAMES,
  applyTailwindToNodes,
  detectTailwind,
  getTailwindEngine,
  nodesWithClasses,
  planSetClasses,
  planShadcnTokens,
  usesShadcnColor,
  type TailwindEngine,
  type TailwindReport,
} from '@mockup/core/tailwind';
import { READ, ToolError, WRITE, docIdField, type ToolContext } from '../context.js';
import { lostRepeaters, restoreRepeaters } from '../repeaterHtml.js';

const MAX_LISTED = 10;

/** Ops that insert `nodes` into `target` according to the mode (the same logic as `write_html` without Tailwind). */
export function htmlInsertOps(
  target: NodePath,
  mode: 'append' | 'replace' | 'replace-children',
  nodes: Node[],
): { ops: Op[]; summaryParent: string } {
  const targetId = target.node.id;
  const ops: Op[] = [];
  let summaryParent = targetId;
  if (mode === 'replace') {
    const parent = target.parent;
    if (!parent) {
      if (nodes.length !== 1) {
        throw new ToolError(
          'mode "replace" on a root frame requires a single top-level element; wrap the content in a <div> or use mode "replace-children".',
        );
      }
      const nn = nodes[0]!;
      const old = target.node;
      nn.type = 'frame';
      if (old.position) nn.position = { ...old.position };
      for (const k of ['width', 'height'] as const) {
        if (!nn.style[k] && old.style[k]) nn.style[k] = old.style[k]!;
      }
      const generic = nn.tag.charAt(0).toUpperCase() + nn.tag.slice(1);
      if (nn.name === generic) nn.name = old.name;
    }
    ops.push({ type: 'deleteNodes', nodeIds: [targetId] });
    nodes.forEach((node, i) => {
      ops.push(
        parent
          ? { type: 'createNode', parentId: parent.id, node, index: target.index + i }
          : {
              type: 'createNode',
              parentId: null,
              pageId: target.page.id,
              node,
              index: target.index + i,
            },
      );
    });
    summaryParent = parent?.id ?? '';
  } else {
    if (mode === 'replace-children' && target.node.children.length) {
      ops.push({ type: 'deleteNodes', nodeIds: target.node.children.map((c) => c.id) });
    }
    for (const node of nodes) ops.push({ type: 'createNode', parentId: targetId, node });
  }
  return { ops, summaryParent };
}

/** Short report summary: unknown and unsupported classes (with the reason), up to `MAX_LISTED`. */
export function reportLines(report: TailwindReport): string[] {
  const lines: string[] = [];
  if (report.unknown.length) {
    const shown = report.unknown.slice(0, MAX_LISTED).join(', ');
    const more = report.unknown.length - MAX_LISTED;
    lines.push(
      `Unknown classes (no effect on the style; kept in node.classes): ${shown}${more > 0 ? ` and ${more} more` : ''}.`,
    );
  }
  if (report.unsupported.length) {
    const shown = report.unsupported
      .slice(0, MAX_LISTED)
      .map((u) => `${u.cls} (${u.reason})`)
      .join('; ');
    const more = report.unsupported.length - MAX_LISTED;
    lines.push(
      `Classes with no equivalent in the model (kept only in node.classes and in the exported code): ${shown}${more > 0 ? `; and ${more} more` : ''}.`,
    );
  }
  return lines;
}

/** Name of the shadcn color the class uses (`hover:bg-primary/90` → `primary`). */
function shadcnColorOf(cls: string): string | null {
  const utility = cls
    .slice(cls.lastIndexOf(':') + 1)
    .replace(/^[!-]/, '')
    .replace(/\/\S+$/, '')
    .replace(/!$/, '');
  let best: string | null = null;
  for (const n of SHADCN_COLOR_NAMES) {
    if (utility.endsWith(`-${n}`) && (!best || n.length > best.length)) best = n;
  }
  return best;
}

export interface WriteHtmlArgs {
  html: string;
  mode?: 'append' | 'replace' | 'replace-children';
  parentId?: string;
  css?: string;
  tailwind?: 'auto' | 'on' | 'off';
  /** `import_component` only: create the shadcn preset tokens (default `none` in write_html). */
  tokens?: 'auto' | 'shadcn' | 'none';
  docId?: string;
  label?: string;
}

/** Inserts HTML (with or without Tailwind); the core of `write_html` and `import_component`. */
export async function writeHtml(ctx: ToolContext, a: WriteHtmlArgs): Promise<string> {
  const { store, requireNode, apply, summaryOf, selectedOrFirstFrame } = ctx;
  const id = store.resolveDocId(a.docId);
  const doc = store.get(id);
  const mode = a.mode ?? 'append';
  let tw = a.tailwind ?? 'auto';
  let css = a.css;
  if (css !== undefined && css.trim().toLowerCase() === 'tailwind') {
    if (tw === 'off')
      throw new ToolError(
        'css: "tailwind" turns Tailwind on, but tailwind: "off" turns it off. Remove one.',
      );
    tw = 'on';
    css = undefined;
  }
  const targetId = a.parentId ?? selectedOrFirstFrame(id, doc);
  const target = requireNode(doc, targetId);
  const label = a.label ?? 'write_html';
  const empty = () =>
    new ToolError('The HTML produced no nodes. E.g. "<div><h1>Title</h1></div>".');

  let engine: TailwindEngine | undefined;
  let useTailwind = tw === 'on';
  if (tw === 'auto' && /\bclass\s*=/i.test(a.html)) {
    engine = await getTailwindEngine(doc);
    useTailwind = detectTailwind(a.html, engine, css ?? '').tailwind;
  }

  // Repeaters marked by get_html (data-mockup-repeat) come back with the original data.
  const lostWarning = (ops: Op[], restored: string[]): string => {
    const deleted = ops.flatMap((o) => (o.type === 'deleteNodes' ? o.nodeIds : []));
    const lost = lostRepeaters(doc, deleted, restored);
    return lost.length
      ? `Warning: repeater(s) replaced without the data-mockup-repeat mark lost their data: ${lost.map((l) => `${l.id} (${l.count} items)`).join(', ')}. Use undo and keep the data-mockup-repeat attribute that get_html returns, or bind the data again with bind_data.`
      : '';
  };

  if (!useTailwind) {
    const { nodes, restored } = restoreRepeaters(htmlToNodes(a.html, { css }), doc);
    if (!nodes.length) throw empty();
    const { ops, summaryParent } = htmlInsertOps(target, mode, nodes);
    const warn = lostWarning(ops, restored);
    const r = apply(id, ops, label);
    const created = nodes.map((n) => n.id);
    return `HTML applied (${mode}). Nodes created: ${created.join(', ')}.${warn ? `\n${warn}` : ''}\n${summaryParent ? summaryOf(r.doc, [summaryParent]) : summaryOf(r.doc, created)}`;
  }

  const { nodes, restored } = restoreRepeaters(
    htmlToNodes(a.html, { css, keepClasses: true }),
    doc,
  );
  if (!nodes.length) throw empty();
  const extra: Op[] = [];
  const notes: string[] = [];

  // shadcn preset tokens (same call, same undo) and the engine recompiled with them.
  let tokens = doc.tokens;
  let themes = doc.themes;
  const tokensMode = a.tokens ?? 'none';
  if (tokensMode !== 'none') {
    const used = new Set<string>();
    for (const n of nodesWithClasses(nodes)) {
      for (const c of n.classes!.split(/\s+/)) {
        if (!c || !usesShadcnColor(c)) continue;
        const name = shadcnColorOf(c);
        if (name) used.add(name);
      }
    }
    const missing = [...used].some((n) => !(`--color-${n}` in doc.tokens));
    if (tokensMode === 'shadcn' || missing) {
      const plan = planShadcnTokens(doc);
      if (plan.created.length) {
        extra.push(...plan.ops);
        tokens = { ...doc.tokens };
        for (const op of plan.ops) {
          if (op.type === 'setTokens') Object.assign(tokens, op.set);
          if (op.type === 'setThemes') themes = op.themes;
        }
        notes.push(
          `shadcn preset tokens created (${plan.created.length}, plus the "dark" theme): ${plan.created.slice(0, 6).join(', ')}${plan.created.length > 6 ? ', …' : ''}. See get_tokens.`,
        );
      }
    }
  }
  const newTokens = tokens !== doc.tokens;
  if (!engine || newTokens) engine = await getTailwindEngine({ tokens, themes });
  const shadcn = '--color-border' in tokens && '--color-primary' in tokens;
  const report = applyTailwindToNodes(nodes, engine, {
    ...(shadcn ? { defaultBorderColor: 'var(--color-border)' } : {}),
  });

  const ops: Op[] = [];
  if (doc.cssBase !== 'tailwind') {
    ops.push({ type: 'setCssBase', base: 'tailwind' });
    notes.push(
      'Document base CSS switched to the Tailwind preflight (set_css_base). To go back to the default: set_css_base("default") (or undo reverts everything in this call).',
    );
  }
  ops.push(...extra);
  const { ops: insert, summaryParent } = htmlInsertOps(target, mode, nodes);
  ops.push(...insert);
  const warn = lostWarning(insert, restored);
  const r = apply(id, ops, label);
  const created = nodes.map((n) => n.id);
  const lines = [
    `HTML with Tailwind applied (${mode}). Nodes created: ${created.join(', ')}.`,
    ...(warn ? [warn] : []),
    `${report.nodes} node(s) with Tailwind classes compiled to style; the classes are kept in node.classes.`,
    ...notes,
    ...reportLines(report),
    summaryParent ? summaryOf(r.doc, [summaryParent]) : summaryOf(r.doc, created),
    'Check with get_screenshot (use state for hover/dark; md: only applies to frames 768px wide or more).',
  ];
  return lines.join('\n');
}

/** Ops that write `styles`/`unset` to the `key` state of the nodes, merging with what already exists. */
export function planStateStyles(
  nodes: Node[],
  key: string,
  styles: Record<string, string> | undefined,
  unset: string[] | undefined,
): Op[] {
  const norm = normalizeStyles(styles ?? {});
  const changes = nodes.map((node) => {
    const states = { ...(node.states ?? {}) };
    const cur = { ...(states[key] ?? {}) };
    for (const [k, v] of Object.entries(norm)) {
      if (v === '') delete cur[k];
      else cur[k] = v;
    }
    for (const k of unset ?? []) delete cur[toKebabCase(k.trim())];
    if (Object.keys(cur).length > 0) states[key] = cur;
    else delete states[key];
    return { nodeId: node.id, states: Object.keys(states).length ? states : null };
  });
  return [{ type: 'setStates', changes }];
}

const fmtKv = (o: Record<string, string>): string =>
  Object.entries(o)
    .map(([k, v]) => `${k}: ${v}`)
    .join('; ');

export function registerTailwindTools(ctx: ToolContext): void {
  const { tool, store, requireNode, apply, summaryOf } = ctx;

  const engineOf = (docId?: string): Promise<TailwindEngine> => {
    if (!docId && store.list().length === 0) return getTailwindEngine({ tokens: {}, themes: [] });
    return getTailwindEngine(store.get(store.resolveDocId(docId)));
  };

  tool(
    'import_component',
    {
      title: 'Import Tailwind/shadcn component',
      description:
        'Pastes HTML of shadcn/ui or Tailwind UI components: the classes become style (and stay in node.classes), the hover:/focus:/dark: states become states. With tokens "auto" it creates the missing shadcn tokens (bg-primary...) in a single undo.',
      example: {
        parentId: 'fr_ab12cd34',
        html: '<button data-slot="button" class="bg-primary text-primary-foreground hover:bg-primary/90 h-9 px-4 py-2 rounded-md">Save</button>',
        tokens: 'auto',
      },
      inputSchema: {
        html: z
          .string()
          .describe(
            'Component HTML with the Tailwind classes, e.g.: "<button class=\\"h-9 px-4\\">Ok</button>".',
          ),
        parentId: z
          .string()
          .optional()
          .describe('Target node id, e.g. "fr_ab12cd34" (default: selection or first frame).'),
        mode: z
          .enum(['append', 'replace', 'replace-children'])
          .optional()
          .describe('"append" (default), "replace-children" or "replace" (as in write_html).'),
        tokens: z
          .enum(['auto', 'shadcn', 'none'])
          .optional()
          .describe(
            '"auto" (default): creates the missing shadcn tokens if the HTML uses colors like bg-primary; "shadcn": always creates them; "none": does not create.',
          ),
        docId: docIdField,
      },
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    ({ html, parentId, mode, tokens, docId }) =>
      writeHtml(ctx, {
        html,
        parentId,
        mode,
        docId,
        tailwind: 'on',
        tokens: tokens ?? 'auto',
        label: 'import_component',
      }),
  );

  tool(
    'set_classes',
    {
      title: 'Set Tailwind classes',
      description:
        'Applies Tailwind classes to nodes: they become style and states (hover:, dark:, md:) and stay in node.classes. mode: replace (default, the classes become the whole style), add or remove.',
      example: {
        nodeIds: ['el_ab12cd34'],
        classes: 'flex items-center gap-4 p-6 hover:bg-primary/90',
        mode: 'add',
      },
      inputSchema: {
        nodeIds: z.array(z.string()).min(1).describe('Node ids, e.g. ["el_ab12cd34"].'),
        classes: z
          .string()
          .describe('Tailwind classes separated by spaces, e.g. "rounded-xl border shadow-sm".'),
        mode: z
          .enum(['replace', 'add', 'remove'])
          .optional()
          .describe(
            '"replace" (default): the classes become the whole style; "add": adds them (replaces those of the same property); "remove": removes the classes.',
          ),
        docId: docIdField,
      },
      annotations: WRITE,
    },
    async ({ nodeIds, classes, mode, docId }) => {
      const id = store.resolveDocId(docId);
      const doc = store.get(id);
      const paths = nodeIds.map((n) => requireNode(doc, n));
      const engine = await getTailwindEngine(doc);
      const plan = planSetClasses(
        paths.map((p) => ({ node: p.node, root: !p.parent })),
        classes,
        engine,
        mode ?? 'replace',
      );
      if (plan.ops.length === 0)
        return `Nothing changed: the nodes already have these classes and styles.\n${summaryOf(doc, nodeIds)}`;
      const r = apply(id, plan.ops, 'set_classes');
      const lines = [`Classes (${mode ?? 'replace'}) applied to ${nodeIds.length} node(s):`];
      for (const nid of nodeIds) lines.push(`- ${nid}: ${plan.classes[nid] || '(none)'}`);
      lines.push(...reportLines(plan.report));
      if (doc.cssBase !== 'tailwind')
        lines.push(
          'The document base CSS is not the Tailwind one (preflight); use set_css_base("tailwind") so the render matches Tailwind.',
        );
      lines.push(summaryOf(r.doc, nodeIds));
      return lines.join('\n');
    },
  );

  tool(
    'get_classes',
    {
      title: 'Tailwind classes of nodes',
      description:
        'Shows each node as Tailwind: the written classes (node.classes), the idiomatic classes generated from the current style and states, and the rest (CSS with no equivalent class).',
      example: { nodeIds: ['el_ab12cd34'] },
      inputSchema: {
        nodeIds: z.array(z.string()).min(1).describe('Node ids, e.g. ["el_ab12cd34"].'),
        docId: docIdField,
      },
      annotations: READ,
    },
    async ({ nodeIds, docId }) => {
      const doc = store.get(store.resolveDocId(docId));
      const paths = nodeIds.map((n) => requireNode(doc, n));
      const engine = await getTailwindEngine(doc);
      return paths
        .map(({ node }) => {
          const r = engine.nodeClasses(node);
          return [
            `${node.id} "${node.name}":`,
            `  written: ${node.classes ?? '(none)'}`,
            `  current: ${r.classes.join(' ') || '(none)'}`,
            `  rest: ${Object.keys(r.rest).length ? fmtKv(r.rest) : '(nothing)'}`,
          ].join('\n');
        })
        .join('\n');
    },
  );

  tool(
    'suggest_classes',
    {
      title: 'Suggest Tailwind classes',
      description:
        'Tailwind class autocomplete (includes document tokens like bg-primary and variant prefixes like hover:bg-). Use it to find the exact name of a class.',
      example: { query: 'hover:bg-', limit: 10 },
      inputSchema: {
        query: z.string().describe('Start of the class, e.g. "bg-pri", "rounded-", "md:flex".'),
        limit: z
          .number()
          .int()
          .min(1)
          .max(100)
          .optional()
          .describe('Maximum suggestions, 1 to 100 (default 20).'),
        docId: docIdField,
      },
      annotations: READ,
    },
    async ({ query, limit, docId }) => {
      const engine = await engineOf(docId);
      const list = engine.suggest(query, limit ?? 20);
      return list.length ? list.join('\n') : `No class starts with "${query}".`;
    },
  );

  tool(
    'get_tailwind_config',
    {
      title: 'Document Tailwind config',
      description:
        'The @theme CSS generated from the tokens (the same as the export), the supported states/variants, the breakpoints in px and the current base CSS (default or tailwind).',
      example: {},
      inputSchema: { docId: docIdField },
      annotations: READ,
    },
    ({ docId }) => {
      const doc = store.get(store.resolveDocId(docId));
      const bps = BREAKPOINTS.map((b) => {
        const px = fixedWidthPx(doc.tokens[`--breakpoint-${b}`]) ?? BREAKPOINT_PX[b];
        return `${b}: ${px}px`;
      });
      const css = Object.keys(doc.tokens).length ? tailwindThemeCss(doc) : '';
      return [
        `cssBase: ${doc.cssBase ?? 'default'}`,
        `Breakpoints (apply when the root frame width is >= the value): ${bps.join(', ')}`,
        `Supported states: ${PSEUDO_STATES.join(', ')}, dark and breakpoints (sm md lg xl 2xl); combinations like md:hover and dark:hover.`,
        'Variants with no equivalent (kept only in the class): group-*, peer-*, aria-*, data-*, before:, after:, [&_svg]:.',
        '',
        '@theme generated from the tokens:',
        css || '(no tokens: only the default Tailwind theme)',
      ].join('\n');
    },
  );

  tool(
    'set_css_base',
    {
      title: 'Document base CSS',
      description:
        'Chooses the render base CSS: "tailwind" (Tailwind v4 preflight: border-box, borders and buttons reset) or "default". write_html turns tailwind on by itself when it receives Tailwind classes.',
      example: { base: 'tailwind' },
      inputSchema: {
        base: z.enum(['default', 'tailwind']).describe('"tailwind" or "default".'),
        docId: docIdField,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    ({ base, docId }) => {
      const id = store.resolveDocId(docId);
      const doc = store.get(id);
      if ((doc.cssBase ?? 'default') === base) return `The base CSS is already "${base}".`;
      apply(id, [{ type: 'setCssBase', base }], 'set_css_base');
      return `Base CSS set to "${base}".`;
    },
  );
}

/** State context (`pseudo`/`dark`) read from a key like `hover`, `dark:hover`. */
export function parseStateOrThrow(state: string): string {
  const key = normalizeStateKey(state);
  if (!key)
    throw new ToolError(
      `Invalid state: "${state}". Use ${PSEUDO_STATES.join(', ')}, dark or breakpoints (${BREAKPOINTS.join(', ')}), combinable with ":" (e.g. "md:hover", "dark").`,
    );
  return key;
}
