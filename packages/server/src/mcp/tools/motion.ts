import { z } from 'zod';
import {
  MAX_ANIMATIONS_PER_NODE,
  MOTION_PRESETS,
  NAMED_EASINGS,
  SLIDE_TRANSITIONS,
  animationDefaults,
  expandDocument,
  findNode,
  formatMotionTimeline,
  frameMotionTimeline,
  getFrameOf,
  normalizeAnimation,
  getSlideTransition,
  normalizeTransition,
  resolveTransition,
  type AnimationKind,
  type AnimationPreset,
  type Document,
  type MotionPreviewState,
  type Node,
  type NodeAnimation,
  type SlideTransition,
} from '@mockup/core';
import { NO_EDITOR_MESSAGE } from '../../editors.js';
import { READ, ToolError, WRITE, docIdField, type ToolContext } from '../context.js';

/* ---------- schema ---------- */

const kindField = z
  .enum(['in', 'out', 'emphasis'])
  .describe(
    '"in" (entrance: hidden until it plays), "out" (exit: hidden after) or "emphasis" (plays and returns). Default: the first kind of the preset (list_motion_presets).',
  );
const presetField = z
  .string()
  .describe('Preset name, e.g. "fade-up", "pop", "float", "custom" (see list_motion_presets).');
const durationField = z
  .number()
  .describe("One iteration in MILLISECONDS, e.g. 600 (default: the preset's).");
const delayField = z
  .number()
  .describe('Wait in MILLISECONDS after the start of its build, e.g. 200 (default 0).');
const easingField = z
  .string()
  .describe(
    'Named easing ("smooth-out", "spring", "back-out", "bounce"...; see list_motion_presets) or a CSS easing like "cubic-bezier(.2,.8,.2,1)".',
  );
const buildField = z
  .number()
  .int()
  .describe(
    'Click order: 0 (default) plays when the slide/frame appears; 1, 2... play on the 1st, 2nd... click of a presentation. 0 to 99.',
  );
const iterationsField = z
  .union([z.number().int(), z.literal('infinite')])
  .describe('Number of plays, e.g. 3, or "infinite" (loops default to infinite).');
const alternateField = z.boolean().describe('true alternates the direction on every other play.');
const splitField = z
  .enum(['children', 'words', 'chars'])
  .describe(
    'Animate each child, word or character of the node instead of the node itself ("words"/"chars" need a text node).',
  );
const staggerField = z
  .number()
  .describe(
    'MILLISECONDS between split targets (needs split; default 80 children, 60 words, 30 chars).',
  );
const keyframesField = z
  .array(z.record(z.string(), z.union([z.string(), z.number()])))
  .describe(
    'preset "custom" only: keyframes with kebab-case CSS and optional offset 0..1 and easing, e.g. [{ "opacity": 0, "transform": "scale(0.8)" }, { "opacity": 1, "transform": "none" }].',
  );
const paramsField = z
  .record(z.string(), z.union([z.number(), z.string()]))
  .describe(
    'Preset params, e.g. { "distance": 60 } (names, defaults and ranges: list_motion_presets).',
  );

/** The animation fields, all optional, for `animate` and the items of `set_animations`. */
const animationFields = {
  kind: kindField.optional(),
  duration: durationField.optional(),
  delay: delayField.optional(),
  easing: easingField.optional(),
  build: buildField.optional(),
  iterations: iterationsField.optional(),
  alternate: alternateField.optional(),
  split: splitField.optional(),
  stagger: staggerField.optional(),
  params: paramsField.optional(),
  keyframes: keyframesField.optional(),
};

/** Nullable optional field that keeps its description (`null` clears it in `update_animation`). */
const clearable = (f: z.ZodType): z.ZodType =>
  f
    .nullable()
    .optional()
    .describe(`${f.description ?? ''} null clears it.`);

/** For `update_animation`: `null` clears a field. */
const updateFields = {
  preset: presetField.optional(),
  kind: clearable(kindField),
  duration: clearable(durationField),
  delay: clearable(delayField),
  easing: clearable(easingField),
  build: clearable(buildField),
  iterations: clearable(iterationsField),
  alternate: clearable(alternateField),
  split: clearable(splitField),
  stagger: clearable(staggerField),
  params: z
    .record(z.string(), z.union([z.number(), z.string(), z.null()]))
    .optional()
    .describe(
      'Preset params to MERGE into the existing ones, e.g. { "distance": 60 }; a null value resets that param to its default.',
    ),
  keyframes: clearable(keyframesField),
};

const animationItem = z
  .looseObject({ preset: presetField })
  .describe(
    'One animation: { preset, kind?, duration?, delay?, easing?, build?, iterations?, alternate?, split?, stagger?, params?, keyframes? } (same fields as animate). Times in ms.',
  );

/* ---------- helpers ---------- */

const sec = (ms: number): string => `${(ms / 1000).toFixed(2).replace(/\.?0+$/, '')} s`;

/** Core validation errors (already readable) as a `ToolError`. */
function guard<T>(fn: () => T): T {
  try {
    return fn();
  } catch (e) {
    if (e instanceof ToolError) throw e;
    throw new ToolError(e instanceof Error ? e.message : String(e));
  }
}

/** Drops `undefined` fields. */
function defined(o: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));
}

function describeAnimation(a: NodeAnimation): string {
  const d = animationDefaults(a);
  const parts = [
    `${a.kind} ${a.preset}`,
    `${d.duration}ms ${d.easing}`,
    `build ${d.build}`,
    `delay ${d.delay}ms`,
  ];
  if (d.iterations !== 1) parts.push(`×${d.iterations}`);
  if (a.alternate) parts.push('alternate');
  if (a.split) parts.push(`split ${a.split} ${d.stagger}ms apart`);
  return parts.join(', ');
}

function listAnimations(node: Node): string {
  const list = node.animations ?? [];
  if (!list.length) return `${node.id} has no animations.`;
  return list.map((a, i) => `  [${i}] ${describeAnimation(a)}`).join('\n');
}

const sameBuild = (a: NodeAnimation, b: NodeAnimation): boolean =>
  (a.build ?? 0) === (b.build ?? 0);

const MAX_TIMELINE_LINES = 40;
const MAX_TIMELINES = 3;

/** Timelines (deduplicated by frame, truncated) of the frames that contain the nodes. */
function timelinesOf(doc: Document, nodeIds: string[]): string {
  const expanded = expandDocument(doc);
  const frames = new Map<string, Node>();
  for (const id of nodeIds) {
    const frame = getFrameOf(expanded, id);
    if (frame) frames.set(frame.id, frame);
  }
  const out: string[] = [];
  let shown = 0;
  for (const frame of frames.values()) {
    if (shown >= MAX_TIMELINES) {
      out.push(`(${frames.size - shown} more frame(s): use get_timeline(frameId).)`);
      break;
    }
    const lines = formatMotionTimeline(frameMotionTimeline(frame), frame.name).split('\n');
    if (lines.length > MAX_TIMELINE_LINES)
      out.push(
        ...lines.slice(0, MAX_TIMELINE_LINES),
        `… ${lines.length - MAX_TIMELINE_LINES} more line(s): use get_timeline(frameId).`,
      );
    else out.push(...lines);
    shown++;
  }
  return out.join('\n');
}

const CHECK_HINT =
  'Check it: get_screenshot with times (filmstrip), e.g. times [0, 0.3, 0.6, 1], or preview_motion to play it on the canvas.';

function presetLine(p: AnimationPreset): string {
  const flags = p.gpu ? '' : ' [paint]';
  const params = p.params.length
    ? ` params: ${p.params
        .map((d) => {
          const range =
            d.type === 'number' && (d.min !== undefined || d.max !== undefined)
              ? ` ${d.min ?? ''}..${d.max ?? ''}`
              : '';
          return `${d.name}=${d.default}${d.unit && d.unit !== 'x' ? d.unit : ''}${range}`;
        })
        .join(', ')}.`
    : '';
  const loop = p.iterations === 'infinite' ? ' loops;' : '';
  return `- ${p.name}${flags} — ${p.description} ${p.duration}ms ${p.easing};${loop}${params}`;
}

export function registerMotionTools(ctx: ToolContext): void {
  const { tool, store, opts, readNode, apply } = ctx;

  /** Current animations of a node (expanded view, so instance virtual ids work). */
  const currentOf = (doc: Document, nodeId: string): NodeAnimation[] =>
    readNode(doc, nodeId).path.node.animations ?? [];

  const uniq = (ids: string[]): string[] => [...new Set(ids)];

  tool(
    'list_motion_presets',
    {
      title: 'List motion presets',
      description:
        'Lists the animation presets (entrance/exit and emphasis/loops) with defaults and params, the named easings and the slide transitions. Use before animate / set_slide_transition. Times are in milliseconds.',
      example: { kind: 'in' },
      inputSchema: {
        kind: z
          .enum(['in', 'out', 'emphasis'])
          .optional()
          .describe('Only presets usable as this kind: "in", "out" or "emphasis" (default: all).'),
      },
      annotations: READ,
    },
    ({ kind }) => {
      const lines: string[] = [
        'Durations, delays and staggers are in MILLISECONDS. [paint] = not GPU-only (clip-path repaints); the rest run on the GPU (transform/opacity/filter).',
      ];
      const entrance = MOTION_PRESETS.filter((p) => p.name !== 'custom' && p.kinds.includes('in'));
      const emphasis = MOTION_PRESETS.filter(
        (p) => p.name !== 'custom' && !p.kinds.includes('in') && p.kinds.includes('emphasis'),
      );
      if (!kind || kind === 'in' || kind === 'out') {
        lines.push(
          '',
          `Entrance / exit presets (kind "in" or "out"; exits default to 75% of the duration${kind ? `; filter: ${kind}` : ''}):`,
          ...entrance.map(presetLine),
        );
      }
      if (!kind || kind === 'emphasis') {
        lines.push(
          '',
          'Emphasis / loop presets (kind "emphasis"; loops repeat forever unless iterations is set):',
          ...emphasis.map(presetLine),
        );
      }
      lines.push(
        '',
        '- custom — your own keyframes (kinds in/out/emphasis; "keyframes" required, Web Animations format with kebab-case CSS).',
      );
      lines.push('', 'Easings (name or any CSS easing):');
      const groups = new Map<string, string[]>();
      for (const e of NAMED_EASINGS) {
        const g = groups.get(e.group) ?? [];
        g.push(e.name);
        groups.set(e.group, g);
      }
      for (const [g, names] of groups) lines.push(`- ${g}: ${names.join(', ')}`);
      lines.push(
        '',
        'Slide transitions (set_slide_transition; * = takes a direction left/right/up/down):',
      );
      for (const t of SLIDE_TRANSITIONS)
        lines.push(
          `- ${t.name}${t.directional ? '*' : ''} — ${t.description} ${t.duration}ms ${t.easing}.`,
        );
      lines.push(
        '',
        'Next: animate(nodeIds, preset, ...) then get_timeline and get_screenshot with times.',
      );
      return lines.join('\n');
    },
  );

  tool(
    'animate',
    {
      title: 'Animate nodes',
      description:
        'Adds one animation (entrance, exit, emphasis or loop) to each node in ONE undo step. cascade staggers the delay across the nodes; replace (default) swaps an existing animation of the same kind and build. Times in ms. Returns the timeline.',
      example: {
        nodeIds: ['el_ab12cd34', 'el_cd34ef56'],
        preset: 'fade-up',
        duration: 600,
        cascade: 80,
      },
      inputSchema: {
        nodeIds: z
          .array(z.string())
          .min(1)
          .max(200)
          .describe(
            'Nodes to animate, e.g. ["el_ab12cd34", "el_cd34ef56"] (instance inner ids work).',
          ),
        preset: presetField,
        ...animationFields,
        cascade: z
          .number()
          .min(0)
          .optional()
          .describe(
            'MILLISECONDS added to the delay of each successive node in nodeIds, e.g. 80 to stagger 5 cards (node i waits delay + i x cascade).',
          ),
        replace: z
          .boolean()
          .optional()
          .describe(
            'true (default): replaces an existing animation of the same kind and build on the node; false appends.',
          ),
        docId: docIdField,
      },
      annotations: WRITE,
    },
    ({ nodeIds, cascade, replace, docId, ...fields }) => {
      const id = store.resolveDocId(docId);
      const doc = store.get(id);
      const ids = uniq(nodeIds);
      const changes: { nodeId: string; animations: NodeAnimation[] }[] = [];
      const added = new Map<string, NodeAnimation>();
      ids.forEach((nodeId, i) => {
        const existing = currentOf(doc, nodeId);
        const base = defined(fields);
        const delay = ((base['delay'] as number | undefined) ?? 0) + i * (cascade ?? 0);
        const anim = guard(() =>
          normalizeAnimation({ ...base, ...(delay ? { delay } : {}) }, `animate ${nodeId}`),
        );
        const matches = (a: NodeAnimation): boolean => a.kind === anim.kind && sameBuild(a, anim);
        const at = replace === false ? -1 : existing.findIndex(matches);
        const list =
          at >= 0
            ? existing.flatMap((a, j) => (j === at ? [anim] : matches(a) ? [] : [a]))
            : [...existing, anim];
        if (list.length > MAX_ANIMATIONS_PER_NODE)
          throw new ToolError(
            `${nodeId} would have ${list.length} animations (maximum ${MAX_ANIMATIONS_PER_NODE}). Remove some with remove_animations.`,
          );
        changes.push({ nodeId, animations: list });
        added.set(nodeId, anim);
      });
      const r = apply(id, [{ type: 'setMotion', changes }], 'animate');
      const lines = [`Animated ${ids.length} node(s) (one undo step):`];
      for (const nodeId of ids) {
        const node = readNode(r.doc, nodeId).path.node;
        lines.push(`- ${nodeId} "${node.name}": ${describeAnimation(added.get(nodeId)!)}`);
      }
      lines.push('', timelinesOf(r.doc, ids), '', CHECK_HINT);
      return lines.join('\n');
    },
  );

  tool(
    'update_animation',
    {
      title: 'Update an animation',
      description:
        'Edits one animation of a node by its index (see get_timeline: [index]). Only the given fields change; null clears a field (back to the preset default); params are merged. One undo step.',
      example: { nodeId: 'el_ab12cd34', index: 0, duration: 900, easing: 'spring' },
      inputSchema: {
        nodeId: z.string().describe('Node id, e.g. "el_ab12cd34".'),
        index: z
          .number()
          .int()
          .min(0)
          .describe(
            "Index of the animation in the node's list, e.g. 0 (get_timeline shows [index]).",
          ),
        ...updateFields,
        docId: docIdField,
      },
      annotations: WRITE,
    },
    ({ nodeId, index, docId, ...fields }) => {
      const id = store.resolveDocId(docId);
      const doc = store.get(id);
      const node = readNode(doc, nodeId).path.node;
      const list = node.animations ?? [];
      const current = list[index];
      if (!current)
        throw new ToolError(
          `${nodeId} "${node.name}" has no animation at index ${index}. ${
            list.length
              ? `Its animations:\n${listAnimations(node)}`
              : 'It has no animations (use animate).'
          }`,
        );
      const merged: Record<string, unknown> = { ...current };
      const presetChanged = fields.preset !== undefined && fields.preset !== current.preset;
      for (const [k, v] of Object.entries(fields)) {
        if (v === undefined || k === 'params') continue;
        if (v === null) delete merged[k];
        else merged[k] = v;
      }
      if (presetChanged) {
        // params and keyframes belong to the old preset
        delete merged['params'];
        if (fields.keyframes === undefined) delete merged['keyframes'];
      }
      if (fields.split === null && fields.stagger === undefined) delete merged['stagger'];
      if (fields.params) {
        const params: Record<string, number | string> = {
          ...(merged['params'] as object | undefined),
        };
        for (const [k, v] of Object.entries(fields.params)) {
          if (v === null) delete params[k];
          else params[k] = v;
        }
        if (Object.keys(params).length) merged['params'] = params;
        else delete merged['params'];
      }
      const next = guard(() => normalizeAnimation(merged, `animation ${index} of ${nodeId}`));
      const animations = list.map((a, i) => (i === index ? next : a));
      const r = apply(
        id,
        [{ type: 'setMotion', changes: [{ nodeId, animations }] }],
        'update_animation',
      );
      return [
        `Updated animation [${index}] of ${nodeId} "${node.name}": ${describeAnimation(next)}.`,
        '',
        timelinesOf(r.doc, [nodeId]),
        '',
        CHECK_HINT,
      ].join('\n');
    },
  );

  tool(
    'remove_animations',
    {
      title: 'Remove animations',
      description:
        'Removes animations from nodes: all of them, or only those matching index, kind, build and/or preset (all given filters must match). Nothing to remove is not an error. One undo step.',
      example: { nodeIds: ['el_ab12cd34'], kind: 'emphasis' },
      inputSchema: {
        nodeIds: z
          .array(z.string())
          .min(1)
          .max(200)
          .describe('Nodes to clean, e.g. ["el_ab12cd34"].'),
        index: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe('Only the animation at this index, e.g. 0.'),
        kind: z
          .enum(['in', 'out', 'emphasis'])
          .optional()
          .describe('Only animations of this kind.'),
        build: z
          .number()
          .int()
          .min(0)
          .max(99)
          .optional()
          .describe('Only animations of this build, e.g. 1.'),
        preset: z.string().optional().describe('Only animations of this preset, e.g. "float".'),
        docId: docIdField,
      },
      annotations: WRITE,
    },
    ({ nodeIds, index, kind, build, preset, docId }) => {
      const id = store.resolveDocId(docId);
      const doc = store.get(id);
      const ids = uniq(nodeIds);
      const changes: { nodeId: string; animations: NodeAnimation[] | null }[] = [];
      const lines: string[] = [];
      let total = 0;
      for (const nodeId of ids) {
        const list = currentOf(doc, nodeId);
        const keep = list.filter(
          (a, i) =>
            !(
              (index === undefined || i === index) &&
              (kind === undefined || a.kind === (kind as AnimationKind)) &&
              (build === undefined || (a.build ?? 0) === build) &&
              (preset === undefined || a.preset === preset)
            ),
        );
        const removed = list.length - keep.length;
        if (!removed) continue;
        total += removed;
        changes.push({ nodeId, animations: keep.length ? keep : null });
        lines.push(`- ${nodeId}: removed ${removed}, ${keep.length} left.`);
      }
      if (!changes.length) return 'Nothing to remove: no animation matches on those nodes.';
      const r = apply(id, [{ type: 'setMotion', changes }], 'remove_animations');
      return [
        `Removed ${total} animation(s) from ${changes.length} node(s):`,
        ...lines,
        '',
        timelinesOf(
          r.doc,
          changes.map((c) => c.nodeId),
        ),
      ].join('\n');
    },
  );

  tool(
    'set_animations',
    {
      title: 'Set all animations of a node',
      description:
        'Replaces the WHOLE animation list of a node (up to 20; [] clears it): compose a full sequence (entrance + builds + loop) in one call and one undo step. Same fields as animate; times in ms.',
      example: {
        nodeId: 'el_ab12cd34',
        animations: [
          { preset: 'fade-up', duration: 600 },
          { kind: 'emphasis', preset: 'float', build: 1 },
        ],
      },
      inputSchema: {
        nodeId: z.string().describe('Node id, e.g. "el_ab12cd34".'),
        animations: z
          .array(animationItem)
          .max(MAX_ANIMATIONS_PER_NODE)
          .describe('The new list, in order; [] removes all animations.'),
        docId: docIdField,
      },
      annotations: WRITE,
    },
    ({ nodeId, animations, docId }) => {
      const id = store.resolveDocId(docId);
      const doc = store.get(id);
      const node = readNode(doc, nodeId).path.node;
      const list = animations.map((a, i) =>
        guard(() => normalizeAnimation(a, `animations #${i + 1} of ${nodeId}`)),
      );
      const r = apply(
        id,
        [{ type: 'setMotion', changes: [{ nodeId, animations: list.length ? list : null }] }],
        'set_animations',
      );
      if (!list.length) return `Removed all animations from ${nodeId} "${node.name}".`;
      return [
        `${nodeId} "${node.name}" now has ${list.length} animation(s):`,
        ...list.map((a, i) => `  [${i}] ${describeAnimation(a)}`),
        '',
        timelinesOf(r.doc, [nodeId]),
        '',
        CHECK_HINT,
      ].join('\n');
    },
  );

  tool(
    'set_slide_transition',
    {
      title: 'Set slide transitions',
      description:
        'Sets how root frames (slides) enter in a presentation: push, cover, fade, zoom, cube, magic (matches layers by name)... Pass frameIds or pageId (all its frames); preset null removes it. Times in ms. One undo step.',
      example: { frameIds: ['fr_ab12cd34'], preset: 'push', direction: 'left' },
      inputSchema: {
        frameIds: z
          .array(z.string())
          .optional()
          .describe('Root frames (slides), e.g. ["fr_ab12cd34"].'),
        pageId: z
          .string()
          .optional()
          .describe('Page id, e.g. "pg_ab12cd34": applies to all its root frames.'),
        preset: z
          .string()
          .nullable()
          .describe(
            'Transition name (fade, dip, push, cover, reveal, wipe, zoom, blur, flip, cube, magic; see list_motion_presets) or null to remove it.',
          ),
        duration: z.number().optional().describe("MILLISECONDS, e.g. 500 (default: the preset's)."),
        easing: easingField.optional(),
        direction: z
          .enum(['left', 'right', 'up', 'down'])
          .optional()
          .describe(
            'Directional presets only (push, cover, reveal, wipe, flip, cube); default left.',
          ),
        docId: docIdField,
      },
      annotations: WRITE,
    },
    ({ frameIds, pageId, preset, duration, easing, direction, docId }) => {
      if (!frameIds?.length && !pageId)
        throw new ToolError(
          'Pass frameIds (root frames) or pageId (all root frames of a page). E.g. { pageId: "pg_ab12cd34", preset: "push" }.',
        );
      const id = store.resolveDocId(docId);
      const doc = store.get(id);
      const frames: Node[] = [];
      if (pageId) {
        const page = doc.pages.find((p) => p.id === pageId);
        if (!page)
          throw new ToolError(`Page not found: "${pageId}". Use get_basic_info to see the pages.`);
        frames.push(...page.frames);
      }
      for (const fid of frameIds ?? []) {
        const root = doc.pages.flatMap((p) => p.frames).find((f) => f.id === fid);
        if (!root) {
          const p = findNode(doc, fid);
          if (p)
            throw new ToolError(
              `"${fid}" is not a root frame; slide transitions belong to root frames. Its root frame is "${getFrameOf(doc, fid)!.id}".`,
            );
          throw new ToolError(`Frame not found: "${fid}". Use get_basic_info to see the frames.`);
        }
        frames.push(root);
      }
      const targets = [...new Map(frames.map((f) => [f.id, f])).values()];
      if (!targets.length) throw new ToolError('The page has no frames.');
      let transition: SlideTransition | null = null;
      if (preset !== null)
        transition = guard(() =>
          normalizeTransition(defined({ preset, duration, easing, direction }), 'slide transition'),
        );
      apply(
        id,
        [
          {
            type: 'setMotion',
            changes: targets.map((f) => ({ nodeId: f.id, transition })),
          },
        ],
        'set_slide_transition',
      );
      const names = targets.map((f) => `"${f.name}" (${f.id})`).join(', ');
      if (!transition)
        return `Removed the slide transition from ${targets.length} frame(s): ${names}.`;
      const r = resolveTransition(transition)!;
      const dir = getSlideTransition(r.preset)?.directional ? ` ${r.direction}` : '';
      const resolved = `${r.preset}${dir} ${r.duration}ms ${r.easing}`;
      return [
        `Slide transition "${resolved}" set on ${targets.length} frame(s): ${names}.`,
        'It plays when the slide enters in a presentation (going back plays it in reverse). Try it with start_presentation and presentation_goto.',
      ].join('\n');
    },
  );

  tool(
    'get_timeline',
    {
      title: 'Motion timeline of a frame',
      description:
        'Shows the animations of a frame (root frame or any node in it): builds (click order), start/end on the linear timeline, durations, easings, loops, slide transition and warnings. Times in the output are seconds.',
      example: { frameId: 'fr_ab12cd34' },
      inputSchema: {
        frameId: z
          .string()
          .optional()
          .describe(
            'Root frame or any node inside it, e.g. "fr_ab12cd34" (default: the selection\'s frame, or the first frame).',
          ),
        docId: docIdField,
      },
      annotations: READ,
    },
    ({ frameId, docId }) => {
      const id = store.resolveDocId(docId);
      const doc = store.get(id);
      const target = frameId ?? ctx.selectedOrFirstFrame(id, doc);
      const read = readNode(doc, target);
      const frame = getFrameOf(read.doc, target);
      if (!frame) throw new ToolError(`Node not found: "${target}".`);
      const tl = frameMotionTimeline(frame);
      const lines = [formatMotionTimeline(tl, frame.name)];
      if (!tl.items.length)
        lines.push('No animations yet: use animate(nodeIds, preset) to add some.');
      lines.push(
        '',
        'See it: get_screenshot with time (s on this linear timeline), build (state after a click build) or times (filmstrip in one image); preview_motion plays it on the canvas; start_presentation runs the click builds and slide transitions.',
      );
      return lines.join('\n');
    },
  );

  tool(
    'preview_motion',
    {
      title: 'Preview motion on the canvas',
      description:
        'Plays, scrubs (seek) or stops the animation preview of a frame on the canvas of the connected editor window, so the user sees it. time is in SECONDS on the linear timeline. Needs an open editor window.',
      example: { frameId: 'fr_ab12cd34', action: 'play', time: 0 },
      inputSchema: {
        frameId: z
          .string()
          .optional()
          .describe(
            'Root frame or any node inside it, e.g. "fr_ab12cd34" (default: the selection\'s frame or the first).',
          ),
        action: z
          .enum(['play', 'seek', 'stop'])
          .optional()
          .describe(
            '"play" (default) from time, "seek" (paused at time) or "stop" (back to the design state).',
          ),
        time: z
          .number()
          .min(0)
          .optional()
          .describe("Position in SECONDS on the frame's linear timeline, e.g. 1.2 (default 0)."),
        docId: docIdField,
      },
      // plays again on every call
      annotations: WRITE,
    },
    async ({ frameId, action, time, docId }) => {
      const id = store.resolveDocId(docId);
      const doc = store.get(id);
      let frameName: string | undefined;
      if (frameId) {
        const read = readNode(doc, frameId);
        frameName = getFrameOf(read.doc, frameId)?.name;
      }
      const editors = opts.services?.editors;
      if (!editors || editors.count() === 0) throw new ToolError(NO_EDITOR_MESSAGE);
      if (docId && store.getActive()?.id !== id) store.setActive(id);
      const act = action ?? 'play';
      let state: MotionPreviewState;
      try {
        state = await editors.command({
          type: 'motion:preview',
          docId: id,
          ...(frameId ? { frameId } : {}),
          action: act,
          ...(time !== undefined && act !== 'stop' ? { time: Math.round(time * 1000) } : {}),
        });
      } catch (e) {
        throw new ToolError(e instanceof Error ? e.message : String(e));
      }
      if (state.mode === 'rest' || act === 'stop')
        return 'Preview stopped: the canvas shows the design state.';
      const name =
        (state.frameId ? getFrameOf(expandDocument(doc), state.frameId)?.name : undefined) ??
        frameName ??
        state.frameId ??
        'the frame';
      const at = sec(state.time);
      const tl = `timeline ${sec(state.duration)}`;
      return state.mode === 'play'
        ? `Previewing "${name}" on the canvas: playing from ${at} (${tl}).`
        : `Previewing "${name}" on the canvas: paused at ${at} (${tl}).`;
    },
  );
}
