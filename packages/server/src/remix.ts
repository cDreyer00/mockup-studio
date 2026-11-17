/**
 * Remix: side-by-side variations of a node. The local kinds (`color-scale`, `font-pairs`, `spacing`,
 * `layout`) are planned by core (`planRemix`) and applied in a single undo entry; `ai`
 * asks the assistant to create the variations in one turn (all the turn's ops become one group).
 */
import { randomUUID } from 'node:crypto';
import {
  findNode,
  planRemix,
  type ClientMessage,
  type Document,
  type RemixKind,
  type RemixResult,
} from '@mockup/core';
import { listSystemFonts } from './fonts.js';
import type { AssistantServiceApi, RemixOptions, RemixServiceApi } from './services.js';
import type { DocumentStore } from './store.js';

export interface RemixServiceOptions {
  assistant?: AssistantServiceApi;
  /** Fonts installed on the system (default: `listSystemFonts`, cached). Injectable in tests. */
  systemFonts?: () => Promise<{ family: string }[]>;
}

export const REMIX_MAX_COUNT = 10;
/** Number of `ai` variations when `count` is not given. */
export const AI_REMIX_DEFAULT_COUNT = 3;

const KIND_LABEL: Record<RemixKind, string> = {
  'color-scale': 'color scale',
  'font-pairs': 'font pairs',
  spacing: 'spacing',
  layout: 'layout',
  ai: 'with AI',
};

const KINDS = Object.keys(KIND_LABEL);

function checkCount(count: number | undefined): number | undefined {
  if (count === undefined) return undefined;
  if (!Number.isInteger(count) || count < 1 || count > REMIX_MAX_COUNT)
    throw new Error(
      `Invalid count (${String(count)}): use an integer from 1 to ${REMIX_MAX_COUNT}.`,
    );
  return count;
}

export class RemixService implements RemixServiceApi {
  constructor(
    readonly store: DocumentStore,
    readonly opts: RemixServiceOptions = {},
  ) {}

  /** WS `remix` message (origin: editor). */
  async handle(msg: ClientMessage): Promise<unknown> {
    if (msg.type !== 'remix') throw new Error(`Message not handled by remix: "${msg.type}".`);
    return this.run(msg.docId, msg.nodeId, msg.kind, {
      count: msg.count,
      prompt: msg.prompt,
      source: 'editor',
    });
  }

  async run(
    docId: string,
    nodeId: string,
    kind: RemixKind,
    opts: RemixOptions = {},
  ): Promise<RemixResult> {
    if (!KINDS.includes(kind))
      throw new Error(`Invalid remix kind: "${String(kind)}". Use ${KINDS.join(', ')}.`);
    const count = checkCount(opts.count);
    const source = opts.source ?? 'editor';
    if (kind === 'ai') return this.runAi(docId, nodeId, count, opts, source);

    const doc = this.store.get(docId);
    const plan = planRemix(doc, nodeId, kind, {
      ...(count !== undefined ? { count } : {}),
      ...(kind === 'font-pairs' ? { fonts: await this.localFonts(doc) } : {}),
    });
    this.store.applyOps(docId, plan.ops, {
      source,
      label: `Remix: ${KIND_LABEL[kind]}`,
      group: opts.group,
    });
    this.store.setSelection(docId, plan.frameIds, source);
    return { frameIds: plan.frameIds, labels: plan.labels };
  }

  /**
   * Families available locally: the document's (embedded or registered) and those installed on the
   * system. `undefined` (no filter) when it cannot be determined.
   */
  private async localFonts(doc: Document): Promise<string[] | undefined> {
    let system: { family: string }[] = [];
    try {
      system = await (this.opts.systemFonts ?? listSystemFonts)();
    } catch {
      // listing unavailable: use only the document's
    }
    const families = new Set([...doc.fonts, ...system].map((f) => f.family));
    return families.size > 0 ? [...families] : undefined;
  }

  private async runAi(
    docId: string,
    nodeId: string,
    count: number | undefined,
    opts: RemixOptions,
    source: 'editor' | 'mcp',
  ): Promise<RemixResult> {
    const assistant = this.opts.assistant;
    if (!assistant)
      throw new Error('The AI assistant is not available in this daemon: AI remix needs it.');
    const prompt = opts.prompt?.trim();
    if (!prompt)
      throw new Error(
        'AI remix requires "prompt": describe how the variations should differ. E.g. "bolder versions, with more contrast".',
      );
    if (nodeId.includes('/'))
      throw new Error(
        `Node "${nodeId}" is inside a component instance and cannot be remixed. Pick a real node.`,
      );
    const path = findNode(this.store.get(docId), nodeId);
    if (!path)
      throw new Error(
        `Node not found: "${nodeId}". Use get_basic_info or get_tree_summary to see the ids.`,
      );
    const frame = path.ancestors[0] ?? path.node;
    const pageId = path.page.id;
    const before = new Set(path.page.frames.map((f) => f.id));
    const n = count ?? AI_REMIX_DEFAULT_COUNT;

    const instructions = [
      `AI REMIX: create ${n} variation(s) of the root frame that contains node ${nodeId} (frame ${frame.id} "${frame.name}"), side by side to its right, as the user requested.`,
      'For each variation i (from 1 to ' + n + '):',
      `1. Duplicate frame ${frame.id} with duplicate_nodes (the copy includes all descendants).`,
      '2. Position the copy with set_position, on the same row (same y) as the original frame, to the right of ALL the page frames that overlap that row (use get_basic_info to see positions and sizes), with 80 px between copies.',
      `3. Rename the copy to "${frame.name} — variation i" (rename_nodes).`,
      '4. Change the copy as requested; each variation must be clearly different from the others.',
      '5. Check with get_screenshot and fix if needed.',
      'Do not change or move the original frame or the other frames. Finish with one short sentence per variation.',
    ].join('\n');

    // Own group (or the caller's): the variations are the frames created by THIS
    // group's ops, not any new frame on the page (the user may create frames during the turn).
    const ownGroup = !opts.group;
    const group = opts.group ?? `remix:${randomUUID()}`;
    let message;
    try {
      message = await assistant.runTurn(docId, prompt, {
        selection: [nodeId],
        instructions,
        group,
      });
    } finally {
      if (ownGroup) {
        this.store.closeGroup(docId, group);
        this.store.finishWorking(docId, []);
      }
    }

    const createdIds = this.store.groupCreatedIds(docId, group);
    const page = this.store.get(docId).pages.find((p) => p.id === pageId);
    const created = (page?.frames ?? []).filter((f) => !before.has(f.id) && createdIds.has(f.id));
    const frameIds = created.map((f) => f.id);
    if (frameIds.length === 0 && (message.status === 'error' || message.status === 'cancelled'))
      throw new Error(
        message.error ??
          (message.status === 'cancelled'
            ? 'The assistant turn was canceled before creating the variations.'
            : 'The assistant turn failed before creating the variations.'),
      );
    if (frameIds.length > 0) this.store.setSelection(docId, frameIds, source);
    return { frameIds, labels: created.map((f) => f.name), turnId: message.turnId };
  }
}
