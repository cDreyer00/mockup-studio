import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
  createNodeFromTag,
  findInstanceNode,
  findNode,
  getComponent,
  breakpointsOf,
  PSEUDO_STATES,
  fixedWidthPx,
  getComputedLike,
  getDocumentSummary,
  getTreeSummary,
  hasStates,
  newPageId,
  nodesToHtml,
  parseStateKey,
  resolveStateStyle,
  summarizeNode,
  walk,
  type Document,
  type Node,
  type NodePath,
  type Op,
} from '@mockup/core';
import { resolveRead } from '../component-view.js';
import type { DocumentStore } from '../store.js';
import {
  DESTRUCTIVE,
  READ,
  ToolError,
  WRITE,
  docIdField,
  type McpServerOptions,
  type RichResult,
  type ToolConfig,
  type ToolContext,
} from './context.js';
import { formatToolInputError, notFoundToolMessage } from './errors.js';
import { GUIDES, GUIDE_INFO, GUIDE_TOPICS } from './guides.js';
import { registerComponentTools } from './tools/components.js';
import { markRepeaters } from './repeaterHtml.js';
import { registerEffectTools } from './tools/effects.js';
import { registerEmbedTools } from './tools/embeds.js';
import { registerExportTools } from './tools/export.js';
import { registerFontTools } from './tools/fonts.js';
import { registerGridTools } from './tools/grid.js';
import { registerImageTools } from './tools/images.js';
import { registerMotionTools } from './tools/motion.js';
import { registerPresentationTools } from './tools/presentation.js';
import { registerRemixTools } from './tools/remix.js';
import { registerRenderTools } from './tools/render.js';
import { registerScriptTools } from './tools/scripts.js';
import {
  parseStateOrThrow,
  planStateStyles,
  registerTailwindTools,
  writeHtml,
} from './tools/tailwind.js';
import { registerTokenTools } from './tools/tokens.js';
import { registerSnapshotTools } from './tools/snapshot.js';
import { registerAssetsTools } from './tools/assets.js';
import { registerDataTools } from './tools/data.js';
import { registerFilesTools } from './tools/files.js';
import { registerVectorTools } from './tools/vector.js';

export type { McpServerOptions } from './context.js';

const nodeIdsField = z
  .array(z.string())
  .min(1)
  .describe('Node ids (see get_tree_summary), e.g. ["el_ab12cd34", "tx_9f8e7d6c"].');
const stylesField = z
  .record(z.string(), z.string())
  .describe(
    'CSS properties in kebab-case, e.g. { "display": "flex", "gap": "16px", "background": "#0f172a" }.',
  );

/** Instructions sent to the MCP client on handshake (the CLI stdio proxy forwards them). */
export const SERVER_INSTRUCTIONS = [
  'Mockup Studio is a canvas design editor: documents with pages, frames (artboards) and real HTML/CSS nodes.',
  "Start with get_guide('getting-started') (6-step workflow) and get_basic_info.",
  "For HTML with Tailwind classes (shadcn/ui, Tailwind UI): write_html/import_component, set_classes, get_screenshot(state) and get_guide('tailwind').",
  "Reusable components (shadcn-like: Button, Card, Navbar...): insert_component, list_components and get_guide('components').",
  "Define the design system (set_tokens, create_theme; get_guide('tokens')) before designing, and prefer write_html (HTML + CSS at once) over many create_node calls.",
  "Animations, click builds and slide transitions: animate, set_slide_transition, get_timeline, get_screenshot(times) and get_guide('motion').",
  'Always check the result with get_screenshot and fix it (update_styles, set_text, undo) before moving on.',
  'docId is optional (the active document is used), except in close_document.',
  'When you finish a set of edits, call finish_working.',
  "Problems (render unavailable, port in use...): get_guide('troubleshooting').",
].join('\n');

/**
 * Replaces the SDK's raw validation error (`MCP error -32602: Input validation error: ... [ {zod issues} ]`)
 * with a per-field message in English plus an example of a correct call, returned as `isError`.
 *
 * `validateToolInput` and `createToolError` are instance methods of `McpServer` (invoked via `this`
 * by the `tools/call` handler) but are not part of the typed public API, hence the cast. The original
 * runs first: only if it fails with a validation error do we reformat (and, if our revalidation finds
 * everything fine, we rethrow the original error). The SDK's catch converts the `ToolError` to `isError`.
 */
function interceptInputErrors(
  server: McpServer,
  examples: Map<string, Record<string, unknown>>,
): void {
  type Internals = {
    validateToolInput: (
      tool: { inputSchema?: z.ZodType },
      args: unknown,
      name: string,
    ) => Promise<unknown>;
    createToolError: (message: string) => unknown;
    _registeredTools: Record<string, unknown>;
  };
  const internals = server as unknown as Internals;
  const original = internals.validateToolInput.bind(server);
  internals.validateToolInput = async (tool, args, name) => {
    try {
      return await original(tool, args, name);
    } catch (e) {
      if (!tool.inputSchema) throw e;
      const parsed = await z.safeParseAsync(tool.inputSchema, args ?? {});
      if (parsed.success) throw e;
      throw new ToolError(
        formatToolInputError(name, parsed.error.issues, args, examples.get(name)),
      );
    }
  };
  const originalToolError = internals.createToolError.bind(server);
  internals.createToolError = (message) => {
    const m = /^(?:MCP error -?\d+: )?Tool (\S+) not found$/.exec(message);
    return originalToolError(
      m ? notFoundToolMessage(m[1]!, Object.keys(internals._registeredTools)) : message,
    );
  };
}

function pxOf(v: string | undefined): number {
  const n = v ? parseFloat(v) : NaN;
  return Number.isFinite(n) ? n : 0;
}

/**
 * Document with the effective style of the states: breakpoints by the root frame width (like the
 * render) and, with `state`, the key's pseudo-class and `dark`. With no states in the document it
 * returns the document itself.
 */
function withResolvedStates(doc: Document, state?: string): { doc: Document; dark: boolean } {
  const key = state ? parseStateOrThrow(state) : undefined;
  const parts = key ? (parseStateKey(key) ?? {}) : {};
  let any = false;
  walk(doc, (n) => {
    if (hasStates(n)) any = true;
  });
  if (!any) return { doc, dark: !!parts.dark };
  const clone = structuredClone(doc);
  const breakpoints = breakpointsOf(doc);
  for (const page of clone.pages) {
    for (const frame of page.frames) {
      const width = fixedWidthPx(frame.style['width']);
      const frameWidth = parts.breakpoint
        ? Math.max(width ?? 0, breakpoints[parts.breakpoint])
        : width;
      walk(frame, (n) => {
        n.style = resolveStateStyle(n, {
          frameWidth,
          breakpoints,
          dark: parts.dark,
          pseudo: parts.pseudo ?? null,
        });
      });
    }
  }
  return { doc: clone, dark: !!parts.dark };
}

export function createMcpServer(store: DocumentStore, opts: McpServerOptions = {}): McpServer {
  const server = new McpServer(
    { name: 'mockup-studio', version: '0.1.0' },
    { instructions: SERVER_INSTRUCTIONS },
  );
  const examples = new Map<string, Record<string, unknown>>();
  interceptInputErrors(server, examples);

  /* ---------- helpers ---------- */

  function tool<S extends z.ZodRawShape>(
    name: string,
    cfg: ToolConfig<S>,
    handler: (args: z.infer<z.ZodObject<S>>) => Promise<string | RichResult> | string | RichResult,
  ): void {
    const cb = async (args: unknown) => {
      try {
        const r = await handler(args as z.infer<z.ZodObject<S>>);
        if (typeof r === 'string') return { content: [{ type: 'text' as const, text: r }] };
        return {
          content: [
            ...(r.images ?? []).map((i) => ({
              type: 'image' as const,
              data: i.data,
              mimeType: i.mimeType,
            })),
            { type: 'text' as const, text: r.text },
          ],
        };
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return { isError: true, content: [{ type: 'text' as const, text: `Error: ${msg}` }] };
      }
    };
    const { example, ...sdkCfg } = cfg;
    examples.set(name, example);
    server.registerTool(name, sdkCfg, cb as never);
  }

  const nodeNotFound = (id: string) =>
    new ToolError(
      `Node not found: "${id}". Use get_tree_summary to list valid ids (e.g. "fr_ab12cd34"; inside instances: "in_ab12cd34/el_ab12cd34"; nodes of a main component: get_component).`,
    );
  /** Node for writing: real (instances not expanded), or virtual id / main component node. */
  const requireNode = (doc: Document, id: string): NodePath => {
    const p = findNode(doc, id) ?? resolveRead(doc, id)?.path;
    if (!p) throw nodeNotFound(id);
    return p;
  };
  /** Node for reading: from the expanded document (instances become concrete HTML). */
  const readNode = (doc: Document, id: string) => {
    const r = resolveRead(doc, id);
    if (!r) throw nodeNotFound(id);
    return { path: r.path, doc: r.doc };
  };
  const requirePage = (doc: Document, pageId: string) => {
    const p = doc.pages.find((x) => x.id === pageId);
    if (!p) {
      throw new ToolError(`Page not found: "${pageId}". Use get_basic_info to see the pages.`);
    }
    return p;
  };
  const requireNodes = (doc: Document, ids: string[]) => ids.map((id) => requireNode(doc, id));

  /** Summary (depth 2) of the affected nodes; missing ids fall back to the fallbacks (parent/frame). */
  function summaryOf(doc: Document, ids: string[], fallbackIds: string[] = []): string {
    const parts: string[] = [];
    const seen = new Set<string>();
    const add = (id: string): boolean => {
      if (seen.has(id)) return true;
      const p = resolveRead(doc, id);
      if (!p) return false;
      seen.add(id);
      parts.push(getTreeSummary(p.path.node, 2, { doc }));
      return true;
    };
    for (const id of ids) add(id);
    if (parts.length === 0) {
      for (const id of fallbackIds) if (add(id)) break;
    }
    return parts.length ? parts.join('\n') : getDocumentSummary(doc, 1);
  }

  function fallbackFor(doc: Document, ids: string[]): string[] {
    const out: string[] = [];
    for (const id of ids) {
      const p = resolveRead(doc, id)?.path;
      if (p) out.push(p.parent?.id ?? p.node.id);
    }
    return out;
  }

  const group = (): string | undefined => {
    if (!opts.turn) return undefined;
    const t = opts.turn();
    if (t === null)
      throw new ToolError(
        'The assistant turn that opened this session has already ended or was canceled: no changes were made.',
      );
    return t?.group;
  };
  const apply = (docId: string, ops: Op[], label?: string) =>
    store.applyOps(docId, ops, { source: 'mcp', label, group: group() });

  const selectedOrFirstFrame = (docId: string, doc: Document): string => {
    const sel = store.getSelection(docId).find((id) => findNode(doc, id));
    if (sel) return sel;
    const frame = doc.pages[0]?.frames[0];
    if (!frame)
      throw new ToolError(
        'The document has no frames. Use create_frame(name, width, height) first.',
      );
    return frame.id;
  };

  const sizeOf = (n: Node): string =>
    `${n.style['width'] ?? 'auto'}x${n.style['height'] ?? 'auto'}`.replace(/px/g, '');

  /* ---------- reading ---------- */

  tool(
    'get_basic_info',
    {
      title: 'Basic info',
      description:
        'Document overview: file, pages, frames (id, name, size, position), open documents and selection. Call first to discover frame ids.',
      example: {},
      inputSchema: { docId: docIdField },
      annotations: READ,
    },
    ({ docId }) => {
      // No document is the normal state at the start of a session (the instructions say to call this
      // tool first): reply with the next step instead of an error.
      if (!docId && store.list().length === 0)
        return [
          'No document open yet.',
          'Next step: create_document(path, name) to start a new one (e.g. "C:/projects/app/design/screens") or open_document(path) to open an existing .mockup.json file.',
        ].join('\n');
      const id = store.resolveDocId(docId);
      const doc = store.get(id);
      const info = store.getInfo(id);
      const lines = [
        `File: ${info.name} (${info.path ?? 'no path'}) | id: ${info.docId} | modified: ${info.dirty ? 'yes' : 'no'} | revision: ${info.revision}`,
        'Pages:',
      ];
      for (const page of doc.pages) {
        lines.push(`- ${page.name} (${page.id}) — ${page.frames.length} frame(s)`);
        for (const f of page.frames) {
          const pos = f.position ? ` @ ${f.position.x},${f.position.y}` : '';
          lines.push(`    * ${f.name} (${f.id}) ${sizeOf(f)}${pos}`);
        }
      }
      lines.push(
        `Open documents: ${store
          .list()
          .map((d) => `${d.name} (${d.docId})${d.docId === store.activeDocId ? ' [active]' : ''}`)
          .join(', ')}`,
      );
      const sel = store.getSelection(id);
      lines.push(`Selection: ${sel.length ? sel.join(', ') : '(empty)'}`);
      lines.push('Use get_tree_summary to see the structure and write_html to create content.');
      return lines.join('\n');
    },
  );

  tool(
    'list_documents',
    {
      title: 'List open documents',
      description:
        'Lists the documents open in the daemon (id, name, path, revision); the active one is marked with *.',
      example: {},
      inputSchema: {},
      annotations: READ,
    },
    () => {
      const list = store.list();
      if (!list.length)
        return 'No document open. Use open_document(path) or create_document(path, name).';
      return list
        .map(
          (d) =>
            `${d.docId === store.activeDocId ? '* ' : '- '}${d.name} | id: ${d.docId} | ${d.path ?? 'no path'} | rev ${d.revision}${d.dirty ? ' | modified' : ''}`,
        )
        .join('\n');
    },
  );

  tool(
    'open_document',
    {
      title: 'Open document',
      description:
        'Opens an existing .mockup.json file and makes it the active document. Returns the id and a summary.',
      example: { path: 'C:/projects/site.mockup.json' },
      inputSchema: {
        path: z
          .string()
          .describe('Absolute path of the file, e.g. "C:/projects/site.mockup.json".'),
      },
      annotations: WRITE,
    },
    async ({ path }) => {
      const r = await store.open(path);
      return `Document opened: ${r.name} (id ${r.docId}).\n${getDocumentSummary(r.doc, 1)}`;
    },
  );

  tool(
    'create_document',
    {
      title: 'Create document',
      description:
        'Creates a new, empty document (no frames: create them with create_frame) at path, appending .mockup.json if missing, and makes it active. Returns the document id.',
      example: { path: 'C:/projects/site', name: 'Landing page' },
      inputSchema: {
        path: z
          .string()
          .describe(
            'Absolute path of the new file, e.g. "C:/projects/site" (the .mockup.json extension is appended).',
          ),
        name: z.string().describe('Document name, e.g. "Landing page".'),
      },
      annotations: WRITE,
    },
    async ({ path, name }) => {
      const r = await store.create(path, name);
      return `Document created: ${r.name} (id ${r.docId}) at ${r.path}.\nNext step: create_frame(name, width, height).`;
    },
  );

  tool(
    'save_document',
    {
      title: 'Save document',
      description:
        'Forces a write to disk; autosave already happens after changes. Returns the saved path.',
      example: {},
      inputSchema: { docId: docIdField },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    async ({ docId }) => `Saved to ${await store.save(docId)}.`,
  );

  tool(
    'close_document',
    {
      title: 'Close document',
      description: 'Closes an open document, saving pending changes first.',
      example: { docId: 'doc_ab12cd34' },
      inputSchema: {
        docId: z
          .string()
          .describe('Id of the document to close (see list_documents), e.g. "doc_ab12cd34".'),
      },
      annotations: WRITE,
    },
    async ({ docId }) => {
      await store.close(docId);
      return `Document ${docId} closed.`;
    },
  );

  tool(
    'get_selection',
    {
      title: 'Current selection',
      description:
        'Returns a summary of the nodes currently selected in the editor (useful when the user says "this button").',
      example: {},
      inputSchema: { docId: docIdField },
      annotations: READ,
    },
    ({ docId }) => {
      const id = store.resolveDocId(docId);
      const doc = store.get(id);
      const sel = store.getSelection(id);
      if (!sel.length) return 'No node selected.';
      return sel
        .map((n) => {
          const p = resolveRead(doc, n)?.path;
          return p ? summarizeNode(p.node, doc) : `${n} (no longer exists)`;
        })
        .join('\n');
    },
  );

  tool(
    'set_selection',
    {
      title: 'Set selection',
      description:
        'Selects nodes in the editor (the user sees the selection). An empty list clears the selection.',
      example: { nodeIds: ['el_ab12cd34'] },
      inputSchema: {
        nodeIds: z
          .array(z.string())
          .describe('Ids of the nodes to select, e.g. ["el_ab12cd34"]; [] clears the selection.'),
        docId: docIdField,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    ({ nodeIds, docId }) => {
      const id = store.resolveDocId(docId);
      requireNodes(store.get(id), nodeIds);
      store.setSelection(id, nodeIds, 'mcp');
      return `Selection set: ${nodeIds.length ? nodeIds.join(', ') : '(empty)'}.`;
    },
  );

  tool(
    'get_node_info',
    {
      title: 'Node details',
      description:
        'Details of a node: type, name, tag, page, parent, ancestors, attributes, own styles, text, position and flags.',
      example: { nodeId: 'el_ab12cd34' },
      inputSchema: {
        nodeId: z.string().describe('Node id, e.g. "el_ab12cd34".'),
        docId: docIdField,
      },
      annotations: READ,
    },
    ({ nodeId, docId }) => {
      const stored = store.get(store.resolveDocId(docId));
      const { path: p } = readNode(stored, nodeId);
      const n = p.node;
      const kv = (o: Record<string, string>) =>
        Object.keys(o).length
          ? Object.entries(o)
              .map(([k, v]) => `${k}: ${v}`)
              .join('; ')
          : '(none)';
      const lines = [
        `${n.id} | type: ${n.type} | name: ${n.name} | tag: ${n.tag}`,
        `page: ${p.page.name} (${p.page.id})`,
        `parent: ${p.parent ? `${p.parent.name} (${p.parent.id})` : '(page root)'} | index: ${p.index}`,
        `ancestors: ${p.ancestors.length ? p.ancestors.map((a) => `${a.name} (${a.id})`).join(' > ') : '(none)'}`,
        `attrs: ${kv(n.attrs)}`,
        `style: ${kv(n.style)}`,
      ];
      if (n.classes) lines.push(`classes: ${n.classes}`);
      if (n.states && Object.keys(n.states).length)
        lines.push(
          `states: ${Object.entries(n.states)
            .map(([k, v]) => `${k} { ${kv(v)} }`)
            .join(' | ')}`,
        );
      if (n.position) lines.push(`position: ${n.position.x}, ${n.position.y}`);
      if (n.text !== undefined) lines.push(`text: ${JSON.stringify(n.text)}`);
      if (n.src) lines.push(`src: ${n.src.length > 120 ? `${n.src.slice(0, 120)}…` : n.src}`);
      if (n.effect) lines.push(`effect: ${JSON.stringify(n.effect)}`);
      if (n.video) lines.push(`video: ${JSON.stringify(n.video)}`);
      if (n.embed)
        lines.push(
          `embed: ${JSON.stringify(n.embed.code ? { ...n.embed, code: `(${n.embed.code.length} characters)` } : n.embed)}`,
        );
      lines.push(
        `children: ${n.children.length}${n.locked ? ' | locked' : ''}${n.hidden ? ' | hidden' : ''}`,
      );
      const inst = findInstanceNode(stored, nodeId);
      if (inst) {
        const def = getComponent(stored, inst.componentId);
        const props = Object.entries(inst.props ?? {})
          .map(([k, v]) => `${k}=${String(v)}`)
          .join(', ');
        lines.push(
          `instance of ${def ? `${def.name} (${def.id})` : `${inst.componentId} (missing)`} | props: ${props || '(default)'} | overrides: ${Object.keys(inst.overrides ?? {}).join(', ') || '(none)'}`,
          'The data above comes from the expanded tree; edit with set_instance_props / set_instance_override (get_guide("components")).',
        );
      } else if (nodeId.includes('/')) {
        lines.push(
          'Inner node of an instance: update_styles/set_text on this id become an instance override; to change all instances, edit the main component (get_component).',
        );
      } else if (p.page.id.startsWith('pg__')) {
        lines.push(
          'Node in a main component tree: update_styles/set_text on this id edit the main component and all its instances.',
        );
      }
      return lines.join('\n');
    },
  );

  tool(
    'get_children',
    {
      title: 'Node children',
      description: 'One summary line per direct child of the node, in order.',
      example: { nodeId: 'fr_ab12cd34' },
      inputSchema: {
        nodeId: z.string().describe('Parent node id, e.g. "fr_ab12cd34".'),
        docId: docIdField,
      },
      annotations: READ,
    },
    ({ nodeId, docId }) => {
      const stored = store.get(store.resolveDocId(docId));
      const node = readNode(stored, nodeId).path.node;
      if (!node.children.length) return `${node.id} has no children.`;
      return node.children.map((c) => summarizeNode(c, stored)).join('\n');
    },
  );

  tool(
    'get_tree_summary',
    {
      title: 'Tree summary',
      description:
        'Compact tree structure, one line per node. Without nodeId it summarizes the whole document; with nodeId, the subtree. Use it to discover ids and check the result.',
      example: { nodeId: 'fr_ab12cd34', depth: 2 },
      inputSchema: {
        nodeId: z
          .string()
          .optional()
          .describe('Id of the summary root node, e.g. "fr_ab12cd34" (default: whole document).'),
        depth: z
          .number()
          .int()
          .min(0)
          .max(10)
          .optional()
          .describe('Levels shown, 0 to 10, e.g. 3 (default 2); the rest becomes a count.'),
        docId: docIdField,
      },
      annotations: READ,
    },
    ({ nodeId, depth, docId }) => {
      const doc = store.get(store.resolveDocId(docId));
      const d = depth ?? 2;
      if (!nodeId) return getDocumentSummary(doc, d);
      return getTreeSummary(readNode(doc, nodeId).path.node, d, { doc });
    },
  );

  tool(
    'get_styles',
    {
      title: 'Effective styles',
      description:
        'Effective styles (inherited, var() resolved, calc()/color-mix() evaluated) of nodes, as "prop: value". Applies breakpoint states by the frame width; state (hover, dark...) shows that state. theme resolves tokens as if the node had data-theme with that theme.',
      example: { nodeIds: ['el_ab12cd34'] },
      inputSchema: {
        nodeIds: nodeIdsField,
        theme: z
          .string()
          .optional()
          .describe('Theme name (see get_tokens) used to resolve tokens, e.g. "dark".'),
        state: z
          .string()
          .optional()
          .describe(
            `State to show: ${PSEUDO_STATES.join(', ')}, dark or breakpoint, combinable (e.g. "hover", "dark:hover", "md"). Default: base style.`,
          ),
        docId: docIdField,
      },
      annotations: READ,
    },
    ({ nodeIds, theme: themeArg, state, docId }) => {
      const stored = store.get(store.resolveDocId(docId));
      // virtual ids and main component ids live in the expanded / temporary document
      const reads = nodeIds.map((id) => readNode(stored, id).doc);
      const resolved = new Map<Document, { doc: Document; dark: boolean }>();
      const resolve = (d: Document) => {
        let r = resolved.get(d);
        if (!r) {
          r = withResolvedStates(d, state);
          resolved.set(d, r);
        }
        return r;
      };
      const dark = resolve(reads[0]!).dark;
      const theme =
        themeArg ?? (dark && stored.themes?.some((t) => t.name === 'dark') ? 'dark' : undefined);
      if (theme && !stored.themes?.some((t) => t.name === theme))
        throw new ToolError(
          `Theme "${theme}" does not exist. Create it with create_theme or see get_tokens.`,
        );
      return nodeIds
        .map((id, i) => {
          const styles = getComputedLike(resolve(reads[i]!).doc, id, { theme });
          const body = Object.entries(styles)
            .map(([k, v]) => `  ${k}: ${v}`)
            .join('\n');
          return `${id}:\n${body || '  (no styles)'}`;
        })
        .join('\n');
    },
  );

  tool(
    'get_html',
    {
      title: 'Export node as HTML',
      description:
        'HTML of a node. mode "inline" (default) uses inline style; "classes" returns the html plus a <style> block. For delivery code prefer get_code.',
      example: { nodeId: 'fr_ab12cd34', mode: 'classes' },
      inputSchema: {
        nodeId: z.string().describe('Node id, e.g. "fr_ab12cd34".'),
        mode: z
          .enum(['inline', 'classes'])
          .optional()
          .describe(
            '"inline" (style on each node, default) or "classes" (classes + <style> block).',
          ),
        docId: docIdField,
      },
      annotations: READ,
    },
    ({ nodeId, mode, docId }) => {
      // instance: expanded HTML (props, variants and overrides applied); repeaters marked
      // with data-mockup-repeat so write_html can recreate them with their data
      const { path } = readNode(store.get(store.resolveDocId(docId)), nodeId);
      const out = nodesToHtml([markRepeaters(path.node)], { mode: mode ?? 'inline' });
      return out.css && (mode ?? 'inline') === 'classes'
        ? `${out.html}\n<style>\n${out.css}\n</style>`
        : out.html;
    },
  );

  tool(
    'get_guide',
    {
      title: 'Usage guide',
      description: `Short markdown guide, to read before acting. Topics: ${GUIDE_TOPICS.join(', ')}. Start with getting-started.`,
      example: { topic: 'getting-started' },
      inputSchema: {
        topic: z
          .enum(GUIDE_TOPICS)
          .describe(`Guide topic: ${GUIDE_TOPICS.join(', ')}. E.g. "getting-started".`),
      },
      annotations: READ,
    },
    ({ topic }) => GUIDES[topic],
  );

  /* ---------- writing ---------- */

  tool(
    'create_frame',
    {
      title: 'Create frame',
      description:
        'Creates a root frame (artboard/breakpoint) with a white background. Without x/y it is placed 100px to the right of the last frame. Returns the frame id and summary.',
      example: { name: 'Desktop', width: 1440, height: 900 },
      inputSchema: {
        name: z.string().describe('Frame name, e.g. "Desktop", "Tablet", "Mobile".'),
        width: z.number().positive().describe('Width in px, e.g. 1440.'),
        height: z.number().positive().describe('Height in px, e.g. 900.'),
        pageId: z.string().optional().describe('Page id, e.g. "pg_ab12cd34" (default: first).'),
        x: z
          .number()
          .optional()
          .describe(
            'X position on the canvas in px, e.g. 1540 (default: right of the last frame).',
          ),
        y: z
          .number()
          .optional()
          .describe(
            'Y position on the canvas in px, e.g. 0 (default: aligned with the last frame).',
          ),
        styles: stylesField.optional(),
        docId: docIdField,
      },
      annotations: WRITE,
    },
    ({ name, width, height, pageId, x, y, styles, docId }) => {
      const id = store.resolveDocId(docId);
      const doc = store.get(id);
      const page = pageId ? requirePage(doc, pageId) : doc.pages[0]!;
      const targetPageId = page.id;
      const last = page.frames[page.frames.length - 1];
      const px = x ?? (last ? (last.position?.x ?? 0) + pxOf(last.style['width']) + 100 : 0);
      const py = y ?? (last ? (last.position?.y ?? 0) : 0);
      const frame = createNodeFromTag('div', {
        isRoot: true,
        name,
        styles: {
          width: `${width}px`,
          height: `${height}px`,
          background: '#ffffff',
          ...(styles ?? {}),
        },
        position: { x: px, y: py },
      });
      const r = apply(
        id,
        [{ type: 'createNode', parentId: null, pageId: targetPageId, node: frame }],
        'create_frame',
      );
      return `Frame created: ${frame.id} "${name}" ${width}x${height} at ${px},${py}.\n${summaryOf(r.doc, [frame.id])}`;
    },
  );

  tool(
    'write_html',
    {
      title: 'Write HTML',
      description:
        'Creates nodes from HTML + CSS (the preferred way to build screens). HTML with Tailwind classes is detected and compiled (tailwind auto/on/off). mode: append (default), replace-children or replace. Without parentId it uses the selection or the first frame.',
      example: {
        parentId: 'fr_ab12cd34',
        html: '<section class="hero"><h1>Hello</h1><p>Text</p></section>',
        css: '.hero{display:flex;flex-direction:column;gap:16px;padding:48px}',
      },
      inputSchema: {
        html: z
          .string()
          .describe(
            'HTML markup to insert, e.g. "<section class=\\"hero\\"><h1>Hello</h1></section>".',
          ),
        mode: z
          .enum(['append', 'replace', 'replace-children'])
          .optional()
          .describe(
            '"append" (default, at the end of the children), "replace-children" or "replace".',
          ),
        parentId: z
          .string()
          .optional()
          .describe(
            'Target node id, e.g. "fr_ab12cd34" (the parent; or the node being replaced in mode replace). Default: selection or first frame.',
          ),
        css: z
          .string()
          .optional()
          .describe(
            'CSS with the selectors used in the HTML, e.g. ".hero{display:flex}". The literal "tailwind" is equivalent to tailwind: "on" (it is not CSS).',
          ),
        tailwind: z
          .enum(['auto', 'on', 'off'])
          .optional()
          .describe(
            'Tailwind classes: "auto" (default) detects from the HTML, "on" forces it, "off" treats class as plain CSS. When compiling, the document base CSS becomes the Tailwind one.',
          ),
        docId: docIdField,
      },
      annotations: DESTRUCTIVE,
    },
    ({ html, mode, parentId, css, tailwind, docId }) =>
      writeHtml(ctx, { html, mode, parentId, css, tailwind, docId }),
  );

  tool(
    'create_node',
    {
      title: 'Create node',
      description:
        'Creates a single child node (for several elements prefer write_html). Returns the node id and the parent summary.',
      example: {
        parentId: 'fr_ab12cd34',
        tag: 'button',
        text: 'Submit',
        styles: { padding: '12px 24px' },
      },
      inputSchema: {
        parentId: z.string().describe('Parent id, e.g. "fr_ab12cd34".'),
        tag: z.string().describe('HTML tag, e.g. "div", "h1", "p", "button", "img".'),
        styles: stylesField.optional(),
        text: z.string().optional().describe('Node text, e.g. "Submit".'),
        index: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe('Position among the children, e.g. 0 (default: end).'),
        name: z.string().optional().describe('Layer name, e.g. "CTA button".'),
        docId: docIdField,
      },
      annotations: WRITE,
    },
    ({ parentId, tag, styles, text, index, name, docId }) => {
      const id = store.resolveDocId(docId);
      requireNode(store.get(id), parentId);
      const node = createNodeFromTag(tag, { name, styles, text });
      const r = apply(id, [{ type: 'createNode', parentId, node, index }], 'create_node');
      return `Node created: ${node.id} <${tag}> in ${parentId}.\n${summaryOf(r.doc, [parentId])}`;
    },
  );

  tool(
    'update_styles',
    {
      title: 'Update styles',
      description:
        'Sets and/or removes CSS properties on several nodes. Provide styles and/or unset; a "" value in styles also removes. With state (hover, dark, md...) it writes to the node state (merging), like editing with the state preview. Returns the summary.',
      example: { nodeIds: ['el_ab12cd34'], styles: { gap: '24px' }, unset: ['margin'] },
      inputSchema: {
        nodeIds: nodeIdsField,
        styles: stylesField
          .optional()
          .describe(
            'CSS properties to set, e.g. { "gap": "24px", "color": "#0f172a" }; a "" value removes the property.',
          ),
        unset: z
          .array(z.string())
          .optional()
          .describe('CSS properties to remove, e.g. ["margin", "box-shadow"].'),
        state: z
          .string()
          .optional()
          .describe(
            'Writes to the state instead of the base style: hover, focus, focus-visible, focus-within, active, disabled, dark, sm...2xl or a combination (e.g. "hover", "md:hover").',
          ),
        docId: docIdField,
      },
      annotations: WRITE,
    },
    ({ nodeIds, styles, unset, state, docId }) => {
      const id = store.resolveDocId(docId);
      requireNodes(store.get(id), nodeIds);
      if (!styles && !unset?.length) {
        throw new ToolError('Provide styles and/or unset. E.g. styles { "color": "#333" }.');
      }
      if (state) {
        const doc = store.get(id);
        const key = parseStateOrThrow(state);
        const r = apply(
          id,
          planStateStyles(
            nodeIds.map((n) => requireNode(doc, n).node),
            key,
            styles,
            unset,
          ),
          'update_styles',
        );
        return `Styles of state "${key}" updated on ${nodeIds.length} node(s).
${summaryOf(r.doc, nodeIds)}`;
      }
      const r = apply(
        id,
        [
          {
            type: 'updateStyles',
            nodeIds,
            styles,
            unset,
          },
        ],
        'update_styles',
      );
      return `Styles updated on ${nodeIds.length} node(s).\n${summaryOf(r.doc, nodeIds)}`;
    },
  );

  tool(
    'set_text',
    {
      title: 'Set text',
      description:
        'Changes the text of nodes. Use content (the same text on all) OR contents (one per node, in nodeIds order).',
      example: { nodeIds: ['tx_a1b2c3d4'], content: 'Hello, world' },
      inputSchema: {
        nodeIds: nodeIdsField,
        content: z
          .string()
          .optional()
          .describe('Single text applied to all nodes, e.g. "Buy now".'),
        contents: z
          .array(z.string())
          .optional()
          .describe('One text per node, in nodeIds order, e.g. ["Hello", "World"].'),
        docId: docIdField,
      },
      annotations: WRITE,
    },
    ({ nodeIds, content, contents, docId }) => {
      const id = store.resolveDocId(docId);
      requireNodes(store.get(id), nodeIds);
      let texts: string[];
      if (contents) {
        if (contents.length !== nodeIds.length) {
          throw new ToolError(
            `contents has ${contents.length} item(s) and nodeIds ${nodeIds.length}; they must have the same length.`,
          );
        }
        texts = contents;
      } else if (content !== undefined) {
        texts = nodeIds.map(() => content);
      } else {
        throw new ToolError('Provide content or contents. E.g. content "Hello".');
      }
      const r = apply(
        id,
        [{ type: 'setText', changes: nodeIds.map((nodeId, i) => ({ nodeId, text: texts[i]! })) }],
        'set_text',
      );
      return `Text updated on ${nodeIds.length} node(s).\n${summaryOf(r.doc, nodeIds)}`;
    },
  );

  tool(
    'set_attrs',
    {
      title: 'Set attributes',
      description:
        'Sets and/or removes HTML attributes (href, alt, title...) on several nodes. Provide attrs and/or unset. On an svg node the attributes go to the root <svg> (e.g. height, width, viewBox, fill).',
      example: { nodeIds: ['el_ab12cd34'], attrs: { href: '/contact' } },
      inputSchema: {
        nodeIds: nodeIdsField,
        attrs: z
          .record(z.string(), z.string())
          .optional()
          .describe('HTML attributes to set, e.g. { "href": "/contact", "alt": "Logo" }.'),
        unset: z.array(z.string()).optional().describe('Attributes to remove, e.g. ["title"].'),
        docId: docIdField,
      },
      annotations: WRITE,
    },
    ({ nodeIds, attrs, unset, docId }) => {
      const id = store.resolveDocId(docId);
      requireNodes(store.get(id), nodeIds);
      if (!attrs && !unset?.length)
        throw new ToolError('Provide attrs and/or unset. E.g. attrs { "alt": "Logo" }.');
      const r = apply(
        id,
        [{ type: 'setAttrs', changes: nodeIds.map((nodeId) => ({ nodeId, set: attrs, unset })) }],
        'set_attrs',
      );
      return `Attributes updated on ${nodeIds.length} node(s).\n${summaryOf(r.doc, nodeIds)}`;
    },
  );

  tool(
    'set_tag',
    {
      title: 'Change HTML tag',
      description:
        'Changes the HTML tag of nodes (e.g. div to section). Blocked tags (script, style, iframe...) and invalid changes are rejected.',
      example: { nodeIds: ['el_ab12cd34'], tag: 'section' },
      inputSchema: {
        nodeIds: nodeIdsField,
        tag: z.string().describe('New HTML tag, e.g. "section", "h2", "button".'),
        docId: docIdField,
      },
      annotations: WRITE,
    },
    ({ nodeIds, tag, docId }) => {
      const id = store.resolveDocId(docId);
      requireNodes(store.get(id), nodeIds);
      const r = apply(
        id,
        [{ type: 'setTag', changes: nodeIds.map((nodeId) => ({ nodeId, tag })) }],
        'set_tag',
      );
      return `Tag changed on ${nodeIds.length} node(s).
${summaryOf(r.doc, nodeIds)}`;
    },
  );

  tool(
    'rename_nodes',
    {
      title: 'Rename nodes',
      description:
        'Renames layers; names is paired with nodeIds (same length). The names appear in the editor and in exported files.',
      example: { nodeIds: ['fr_ab12cd34'], names: ['Tablet'] },
      inputSchema: {
        nodeIds: nodeIdsField,
        names: z.array(z.string()).describe('New names, in nodeIds order, e.g. ["Header"].'),
        docId: docIdField,
      },
      annotations: WRITE,
    },
    ({ nodeIds, names, docId }) => {
      const id = store.resolveDocId(docId);
      requireNodes(store.get(id), nodeIds);
      if (names.length !== nodeIds.length) {
        throw new ToolError(
          `names has ${names.length} item(s) and nodeIds ${nodeIds.length}; they must have the same length.`,
        );
      }
      const r = apply(
        id,
        [
          {
            type: 'renameNodes',
            changes: nodeIds.map((nodeId, i) => ({ nodeId, name: names[i]! })),
          },
        ],
        'rename_nodes',
      );
      return `${nodeIds.length} node(s) renamed.\n${summaryOf(r.doc, nodeIds)}`;
    },
  );

  tool(
    'move_nodes',
    {
      title: 'Move nodes',
      description:
        'Moves nodes to another parent and/or index. Without parentId it only reorders; parentId null moves to the page root (becomes a frame).',
      example: { nodeIds: ['el_ab12cd34'], parentId: 'fr_ab12cd34', index: 0 },
      inputSchema: {
        nodeIds: nodeIdsField,
        parentId: z
          .string()
          .nullable()
          .optional()
          .describe(
            'New parent id, e.g. "el_ab12cd34" (default: keep the current one). null = page root (becomes a frame).',
          ),
        pageId: z
          .string()
          .optional()
          .describe(
            'Destination page id when parentId is null, e.g. "pg_ab12cd34" (default: page of the first node).',
          ),
        index: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe('Index in the destination parent, e.g. 0 (default: end).'),
        docId: docIdField,
      },
      annotations: WRITE,
    },
    ({ nodeIds, parentId, pageId, index, docId }) => {
      const id = store.resolveDocId(docId);
      const doc = store.get(id);
      const paths = requireNodes(doc, nodeIds);
      if (parentId === null) {
        const page = requirePage(doc, pageId ?? paths[0]!.page.id);
        const ops: Op[] = [{ type: 'moveNodes', nodeIds, parentId: null, pageId: page.id, index }];
        const moving = new Set(nodeIds);
        const others = page.frames.filter((f) => !moving.has(f.id));
        const last = others[others.length - 1];
        let nextX = last ? (last.position?.x ?? 0) + pxOf(last.style['width']) + 100 : 0;
        const y = last?.position?.y ?? 0;
        const changes: { nodeId: string; position: { x: number; y: number } }[] = [];
        for (const p of paths) {
          if (p.node.position) continue;
          changes.push({ nodeId: p.node.id, position: { x: nextX, y } });
          nextX += pxOf(p.node.style['width']) + 100;
        }
        if (changes.length) ops.push({ type: 'setPosition', changes });
        const r = apply(id, ops, 'move_nodes');
        return `${nodeIds.length} node(s) moved to the root of page ${page.id}.\n${summaryOf(r.doc, nodeIds)}`;
      }
      if (parentId) requireNode(doc, parentId);
      const r = apply(id, [{ type: 'moveNodes', nodeIds, parentId, index }], 'move_nodes');
      const target = parentId ? [parentId] : fallbackFor(doc, nodeIds);
      return `${nodeIds.length} node(s) moved.\n${summaryOf(r.doc, target, nodeIds)}`;
    },
  );

  tool(
    'duplicate_nodes',
    {
      title: 'Duplicate nodes',
      description:
        'Duplicates nodes with their descendants. Returns the map of old ids to new ones. To create breakpoints, duplicate the frame.',
      example: { nodeIds: ['fr_ab12cd34'] },
      inputSchema: { nodeIds: nodeIdsField, docId: docIdField },
      annotations: WRITE,
    },
    ({ nodeIds, docId }) => {
      const id = store.resolveDocId(docId);
      requireNodes(store.get(id), nodeIds);
      const r = apply(id, [{ type: 'duplicateNodes', nodeIds }], 'duplicate_nodes');
      const op = r.appliedOps.find((o) => o.type === 'duplicateNodes');
      const fromOp = op && op.type === 'duplicateNodes' ? op.idMap : undefined;
      const fromResult = r.results[0]?.['idMap'] as Record<string, string> | undefined;
      const idMap = fromOp ?? fromResult ?? {};
      const pairs = nodeIds.filter((o) => idMap[o]).map((o) => `${o} -> ${idMap[o]}`);
      const newIds = nodeIds.map((o) => idMap[o]).filter((x): x is string => !!x);
      return `Duplicated: ${pairs.join(', ') || '(map unavailable)'}.\n${summaryOf(r.doc, newIds)}`;
    },
  );

  tool(
    'delete_nodes',
    {
      title: 'Delete nodes',
      description: 'Removes nodes and their descendants (reversible with undo).',
      example: { nodeIds: ['el_ab12cd34'] },
      inputSchema: { nodeIds: nodeIdsField, docId: docIdField },
      annotations: DESTRUCTIVE,
    },
    ({ nodeIds, docId }) => {
      const id = store.resolveDocId(docId);
      const doc = store.get(id);
      requireNodes(doc, nodeIds);
      const parents = fallbackFor(doc, nodeIds).filter((p) => !nodeIds.includes(p));
      const r = apply(id, [{ type: 'deleteNodes', nodeIds }], 'delete_nodes');
      store.setSelection(
        id,
        store.getSelection(id).filter((s) => !nodeIds.includes(s)),
        'mcp',
      );
      return `${nodeIds.length} node(s) removed.\n${summaryOf(r.doc, parents)}`;
    },
  );

  tool(
    'set_position',
    {
      title: 'Set position',
      description:
        'Sets x/y on the canvas for a root frame or a child with position absolute. Use it to lay out frames side by side.',
      example: { nodeId: 'fr_ab12cd34', x: 1540, y: 0 },
      inputSchema: {
        nodeId: z.string().describe('Id of the frame or absolute child, e.g. "fr_ab12cd34".'),
        x: z.number().describe('X position in px, e.g. 1540.'),
        y: z.number().describe('Y position in px, e.g. 0.'),
        docId: docIdField,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    ({ nodeId, x, y, docId }) => {
      const id = store.resolveDocId(docId);
      requireNode(store.get(id), nodeId);
      const r = apply(
        id,
        [{ type: 'setPosition', changes: [{ nodeId, position: { x, y } }] }],
        'set_position',
      );
      return `Position of ${nodeId} = ${x},${y}.\n${summaryOf(r.doc, [nodeId])}`;
    },
  );

  tool(
    'create_page',
    {
      title: 'Create page',
      description: 'Creates a new page (a set of frames) in the document. Returns the page id.',
      example: { name: 'Mobile' },
      inputSchema: {
        name: z.string().describe('Page name, e.g. "Mobile".'),
        docId: docIdField,
      },
      annotations: WRITE,
    },
    ({ name, docId }) => {
      const id = store.resolveDocId(docId);
      const pageId = newPageId();
      const r = apply(id, [{ type: 'createPage', pageId, name }], 'create_page');
      return `Page created: ${pageId} "${name}".\n${getDocumentSummary(r.doc, 1)}`;
    },
  );

  tool(
    'rename_page',
    {
      title: 'Rename page',
      description: 'Renames an existing page (ids in get_basic_info).',
      example: { pageId: 'pg_ab12cd34', name: 'Mobile' },
      inputSchema: {
        pageId: z.string().describe('Page id (see get_basic_info), e.g. "pg_ab12cd34".'),
        name: z.string().describe('New page name, e.g. "Mobile".'),
        docId: docIdField,
      },
      annotations: WRITE,
    },
    ({ pageId, name, docId }) => {
      const id = store.resolveDocId(docId);
      requirePage(store.get(id), pageId);
      const r = apply(id, [{ type: 'renamePage', pageId, name }], 'rename_page');
      return `Page ${pageId} renamed to "${name}".\n${getDocumentSummary(r.doc, 1)}`;
    },
  );

  tool(
    'delete_page',
    {
      title: 'Delete page',
      description:
        'Removes a page and its frames (reversible with undo). The last page cannot be deleted.',
      example: { pageId: 'pg_ab12cd34' },
      inputSchema: {
        pageId: z.string().describe('Page id (see get_basic_info), e.g. "pg_ab12cd34".'),
        docId: docIdField,
      },
      annotations: DESTRUCTIVE,
    },
    ({ pageId, docId }) => {
      const id = store.resolveDocId(docId);
      requirePage(store.get(id), pageId);
      const r = apply(id, [{ type: 'deletePage', pageId }], 'delete_page');
      return `Page ${pageId} removed.\n${getDocumentSummary(r.doc, 1)}`;
    },
  );

  tool(
    'set_node_flags',
    {
      title: 'Hide/lock nodes',
      description:
        'Hides/shows (hidden) and/or locks/unlocks (locked) nodes in the editor. Provide at least one of the two.',
      example: { nodeIds: ['el_ab12cd34'], hidden: true },
      inputSchema: {
        nodeIds: nodeIdsField,
        hidden: z.boolean().optional().describe('true hides the node; false shows it.'),
        locked: z
          .boolean()
          .optional()
          .describe('true locks the node in the editor; false unlocks it.'),
        docId: docIdField,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    ({ nodeIds, hidden, locked, docId }) => {
      const id = store.resolveDocId(docId);
      requireNodes(store.get(id), nodeIds);
      if (hidden === undefined && locked === undefined) {
        throw new ToolError('Provide hidden and/or locked. E.g. hidden true.');
      }
      const r = apply(
        id,
        [{ type: 'setNodeFlags', changes: nodeIds.map((nodeId) => ({ nodeId, hidden, locked })) }],
        'set_node_flags',
      );
      return `Flags updated on ${nodeIds.length} node(s).\n${summaryOf(r.doc, nodeIds)}`;
    },
  );

  for (const kind of ['undo', 'redo'] as const) {
    tool(
      kind,
      {
        title: kind === 'undo' ? 'Undo' : 'Redo',
        description:
          kind === 'undo'
            ? 'Undoes the last change to the document (including those made by the user). Returns the summary.'
            : 'Redoes the last undone change. Returns the summary.',
        example: {},
        inputSchema: { docId: docIdField },
        annotations: WRITE,
      },
      ({ docId }) => {
        if (opts.turn?.() !== undefined)
          throw new ToolError(
            `During an assistant turn ${kind === 'undo' ? 'undo would revert the whole turn (all its ops form a single group)' : 'redo is not available'}. Fix it with the editing tools (update_styles, set_text, delete_nodes...).`,
          );
        const id = store.resolveDocId(docId);
        const r = kind === 'undo' ? store.undo(id, 'mcp') : store.redo(id, 'mcp');
        if (!r) return kind === 'undo' ? 'Nothing to undo.' : 'Nothing to redo.';
        return `${kind === 'undo' ? 'Undone' : 'Redone'}. Revision ${r.revision}.\n${getDocumentSummary(r.doc, 1)}`;
      },
    );
  }

  tool(
    'finish_working',
    {
      title: 'Finished editing',
      description:
        'Call when you finish editing (after checking with get_screenshot): clears the "AI" indicator on nodes in the editor. Without nodeIds it applies to the whole document.',
      example: {},
      inputSchema: {
        nodeIds: z
          .array(z.string())
          .optional()
          .describe('Ids of the finished nodes, e.g. ["fr_ab12cd34"] (default: all).'),
        docId: docIdField,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    ({ nodeIds, docId }) => {
      const id = store.resolveDocId(docId);
      store.finishWorking(id, nodeIds ?? []);
      return nodeIds?.length
        ? `Editing finished on ${nodeIds.length} node(s).`
        : 'Editing finished on the document.';
    },
  );

  /* ---------- render, export, images, icons and fonts ---------- */

  const ctx: ToolContext = {
    server,
    store,
    opts,
    tool,
    requireNode,
    readNode,
    summaryOf,
    apply,
    group,
    selectedOrFirstFrame,
  };
  registerRenderTools(ctx);
  registerExportTools(ctx);
  registerImageTools(ctx);
  registerFontTools(ctx);
  registerTokenTools(ctx);
  registerTailwindTools(ctx);
  registerComponentTools(ctx);
  registerScriptTools(ctx);
  registerRemixTools(ctx);
  registerPresentationTools(ctx);
  registerSnapshotTools(ctx);
  registerAssetsTools(ctx);
  registerDataTools(ctx);
  registerFilesTools(ctx);
  registerVectorTools(ctx);
  registerGridTools(ctx);
  registerEffectTools(ctx);
  registerMotionTools(ctx);
  registerEmbedTools(ctx);

  /* ---------- resources ---------- */

  for (const topic of GUIDE_TOPICS) {
    server.registerResource(
      `guide-${topic}`,
      `guide://${topic}`,
      {
        title: GUIDE_INFO[topic].title,
        description: GUIDE_INFO[topic].description,
        mimeType: 'text/markdown',
      },
      async (uri) => ({
        contents: [{ uri: uri.href, mimeType: 'text/markdown', text: GUIDES[topic] }],
      }),
    );
  }

  return server;
}
