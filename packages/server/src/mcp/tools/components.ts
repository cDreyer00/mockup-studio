/**
 * Components over MCP (see `docs/COMPONENTS.md`): document library, kits, instances with
 * props/slots/overrides, and main component editing. Domain logic (expansion, ops, planners) lives in
 * core; this file holds validation with actionable messages, the HTML (with Tailwind) of slots and of
 * the main component, and the summary returned to the agent.
 */
import { z } from 'zod';
import {
  applyOps,
  createComponentOps,
  detachInstanceOps,
  expandNodeTree,
  findComponent,
  findComponentNode,
  findInstanceNode,
  getComponent,
  getTreeSummary,
  htmlToNodes,
  importKitOps,
  inferProps,
  instanceNodeFor,
  isVirtualId,
  listInstances,
  mergeOverride,
  nodesToHtml,
  placeholderNames,
  pushOverridesToMainOps,
  resetInstanceOps,
  slotNames,
  walk,
  type ComponentDef,
  type ComponentVariant,
  type Document,
  type Node,
  type NodeOverride,
  type Op,
  type PropDef,
  type PropInput,
} from '@mockup/core';
import {
  applyTailwindToNodes,
  detectTailwind,
  getTailwindEngine,
  type TailwindReport,
} from '@mockup/core/tailwind';
import { resolveRead } from '../../component-view.js';
import { KitError, listKits, loadKit, type LoadedKit } from '../../kits.js';
import { READ, ToolError, WRITE, DESTRUCTIVE, docIdField, type ToolContext } from '../context.js';
import { reportLines } from './tailwind.js';

const propValueSchema = z.union([z.string(), z.number(), z.boolean()]);

const propDefSchema = z.object({
  name: z.string().describe('Prop name (letters, digits and _), e.g. "label".'),
  type: z
    .enum(['string', 'number', 'boolean', 'enum', 'color', 'slot'])
    .describe('Prop type: string, number, boolean, enum, color or slot.'),
  default: propValueSchema.optional().describe('Default value (slots have none), e.g. "Submit".'),
  options: z.array(z.string()).optional().describe('Enum options, e.g. ["sm", "md", "lg"].'),
  description: z.string().optional().describe('Short description of the prop.'),
});

const bindSchema = z
  .object({
    nodeId: z
      .string()
      .describe('Id of the node (inside the component node) whose value becomes the prop.'),
    target: z
      .string()
      .describe(
        'What becomes {{prop}}: "text", "attr:<name>" (e.g. "attr:href") or "style:<prop>".',
      ),
  })
  .describe(
    'Binds the prop to a node value: the current value becomes the default and the node uses {{name}}.',
  );

const nodeOverrideSchema = z.object({
  style: z.record(z.string(), z.string()).optional().describe('CSS styles to merge.'),
  unsetStyle: z
    .array(z.string())
    .optional()
    .describe('CSS properties removed from the main component.'),
  text: z.string().optional().describe('Node text.'),
  attrs: z.record(z.string(), z.string()).optional().describe('HTML attributes to merge.'),
  hidden: z.boolean().optional().describe('Hides the node.'),
});

const variantSchema = z.object({
  when: z
    .record(z.string(), propValueSchema)
    .describe('Props that must match, e.g. { "variant": "outline" }.'),
  overrides: z
    .record(z.string(), nodeOverrideSchema)
    .describe('Overrides by main component node id; key "" = root. Applied in order.'),
});

const fmtProp = (p: PropDef): string => {
  const t = p.type === 'enum' ? `enum(${(p.options ?? []).join('|')})` : p.type;
  const d = p.default !== undefined && p.default !== '' ? `=${JSON.stringify(p.default)}` : '';
  return `${p.name}:${t}${d}`;
};

const propsLine = (def: { props: PropDef[] }): string =>
  def.props.length ? def.props.map(fmtProp).join(', ') : '(no props)';

const MAX_HTML_CHARS = 6000;

/** "3 instance(s)" on the pages, plus those nested inside other components (e.g. button in the Card footer). */
function instanceCount(doc: Document, componentId: string): string {
  const all = listInstances(doc, componentId);
  const nested = all.filter((i) => i.ownerComponentId).length;
  return `${all.length - nested} instance(s)${nested ? ` (+${nested} inside other components)` : ''}`;
}

/** HTML (with Tailwind, if any) → nodes without applying anything to the document. */
async function htmlToNodesTw(
  doc: Document,
  html: string,
  tailwind: 'auto' | 'on' | 'off' | undefined,
): Promise<{ nodes: Node[]; tailwind: boolean; report?: TailwindReport }> {
  const mode = tailwind ?? 'auto';
  let engine = undefined as Awaited<ReturnType<typeof getTailwindEngine>> | undefined;
  let use = mode === 'on';
  if (mode === 'auto' && /\bclass\s*=/i.test(html)) {
    engine = await getTailwindEngine(doc);
    use = detectTailwind(html, engine, '').tailwind;
  }
  if (!use) return { nodes: htmlToNodes(html), tailwind: false };
  const nodes = htmlToNodes(html, { keepClasses: true });
  engine ??= await getTailwindEngine(doc);
  const shadcn = '--color-border' in doc.tokens && '--color-primary' in doc.tokens;
  const report = applyTailwindToNodes(nodes, engine, {
    ...(shadcn ? { defaultBorderColor: 'var(--color-border)' } : {}),
  });
  return { nodes, tailwind: true, report };
}

function variantsLine(v: ComponentVariant): string {
  const when = Object.entries(v.when)
    .map(([k, x]) => `${k}=${String(x)}`)
    .join(', ');
  const parts = Object.entries(v.overrides).map(([path, ov]) => {
    const keys = [
      ...Object.keys(ov.style ?? {}),
      ...(ov.text !== undefined ? ['text'] : []),
      ...(ov.hidden !== undefined ? ['hidden'] : []),
      ...Object.keys(ov.attrs ?? {}).map((a) => `attr:${a}`),
    ];
    return `${path === '' ? 'root' : path}{${keys.join(',')}}`;
  });
  return `when ${when}: ${parts.join(' ') || '(no overrides)'}`;
}

export function registerComponentTools(ctx: ToolContext): void {
  const { tool, store, requireNode, apply, summaryOf, selectedOrFirstFrame } = ctx;

  const componentNotFound = (doc: Document, ref: string): ToolError => {
    const names = (doc.components ?? []).map((c) => c.name);
    const kits = listKits().flatMap((k) => k.components.map((c) => `${k.name}/${c.name}`));
    return new ToolError(
      `Component "${ref}" not found. In the document: ${names.length ? names.join(', ') : '(none)'}. ` +
        `Use list_components to see the library and the kits${kits.length ? ` (ex.: insert_component("${kits[0]}"))` : ''}.`,
    );
  };
  const requireComponent = (doc: Document, ref: string): ComponentDef => {
    const def = findComponent(doc, ref);
    if (!def) throw componentNotFound(doc, ref);
    return def;
  };

  const kitOrThrow = (nameOrPath: string): LoadedKit => {
    try {
      return loadKit(nameOrPath);
    } catch (e) {
      if (e instanceof KitError) throw new ToolError(e.message);
      throw e;
    }
  };

  /** Instance (real or nested, by virtual id) or an error saying how to find one. */
  const requireInstance = (doc: Document, id: string): Node => {
    const real = findInstanceNode(doc, id);
    if (real) return real;
    const n = isVirtualId(id) ? resolveRead(doc, id)?.path.node : undefined;
    if (n?.componentId) return n;
    if (!resolveRead(doc, id) && !requireNodeSafe(doc, id)) {
      throw new ToolError(
        `Node not found: "${id}". Use get_tree_summary (instances appear as ◆Name) or insert_component to create one.`,
      );
    }
    throw new ToolError(
      `Node "${id}" is not a component instance. Instances appear as ◆Name in get_tree_summary; to create one use insert_component, to turn this node into a component use create_component.`,
    );
  };
  const requireNodeSafe = (doc: Document, id: string): boolean => {
    try {
      requireNode(doc, id);
      return true;
    } catch {
      return false;
    }
  };

  /* ---------- read ---------- */

  tool(
    'list_components',
    {
      title: 'List components',
      description:
        'Component library of the document (id, name, kit, props, instance count) and the available kits with their components. Insert with insert_component; import a kit with import_kit.',
      example: {},
      inputSchema: { docId: docIdField },
      annotations: READ,
    },
    ({ docId }) => {
      const doc = store.get(store.resolveDocId(docId));
      const lines: string[] = [];
      const list = doc.components ?? [];
      lines.push(`Document components (${list.length}):`);
      for (const c of list) {
        lines.push(
          `- ${c.id} "${c.name}"${c.kit ? ` [kit ${c.kit}]` : ''} — ${instanceCount(doc, c.id)} | props: ${propsLine(c)}`,
        );
        if (c.description) lines.push(`    ${c.description}`);
      }
      if (!list.length)
        lines.push(
          '(none) Create one with create_component(nodeId) or import a kit with import_kit("shadcn-like").',
        );
      const kits = listKits();
      lines.push(`Available kits (${kits.length}):`);
      for (const k of kits) {
        lines.push(`- ${k.name}:`);
        for (const c of k.components) {
          const slots = c.props.filter((p) => p.type === 'slot').map((p) => p.name);
          const props = c.props.filter((p) => p.type !== 'slot').map((p) => p.name);
          lines.push(
            `    ${k.name}/${c.name} (${props.join(', ') || 'no props'}${slots.length ? `; slots: ${slots.join(', ')}` : ''})${c.description ? ` — ${c.description}` : ''}`,
          );
        }
      }
      lines.push('Component details: get_component(name or "kit/Name").');
      return lines.join('\n');
    },
  );

  tool(
    'get_component',
    {
      title: 'Component details',
      description:
        'Props (types, defaults, options), slots, variants, main component tree with ids (edit them with update_styles/set_text) and HTML. Accepts id, name or "kit/Name" (also from a kit not yet imported).',
      example: { component: 'shadcn-like/Button' },
      inputSchema: {
        component: z
          .string()
          .describe('Id (cp_...), name ("Button") or "kit/Name" ("shadcn-like/Button").'),
        docId: docIdField,
      },
      annotations: READ,
    },
    ({ component, docId }) => {
      const doc = store.get(store.resolveDocId(docId));
      let def = findComponent(doc, component);
      let source = doc;
      let fromKit: string | undefined;
      if (!def) {
        const slash = component.lastIndexOf('/');
        const kits = listKits();
        const kitName = slash > 0 ? component.slice(0, slash) : undefined;
        const compName = (slash > 0 ? component.slice(slash + 1) : component).toLowerCase();
        for (const k of kits) {
          if (kitName && k.name.toLowerCase() !== kitName.toLowerCase()) continue;
          const hit = k.components.find(
            (c) => c.name.toLowerCase() === compName || c.id === component,
          );
          if (hit) {
            const kit = kitOrThrow(k.name);
            def = (kit.doc.components ?? []).find((c) => c.id === hit.id);
            source = kit.doc;
            fromKit = k.name;
            break;
          }
        }
      }
      if (!def) throw componentNotFound(doc, component);

      const lines: string[] = [];
      lines.push(
        `${def.id} "${def.name}"${def.kit || fromKit ? ` [kit ${def.kit ?? fromKit}]` : ''} — ${fromKit ? '0 instance(s)' : instanceCount(doc, def.id)}`,
      );
      if (fromKit)
        lines.push(
          `(not in the document yet; insert_component("${fromKit}/${def.name}") or import_kit("${fromKit}") imports it.)`,
        );
      if (def.description) lines.push(def.description);
      lines.push('Props:');
      for (const p of def.props) {
        const detail =
          p.type === 'enum'
            ? `enum, options: ${(p.options ?? []).join(' | ')}`
            : p.type === 'slot'
              ? 'slot (HTML in insert_component.slots)'
              : p.type;
        lines.push(
          `- ${p.name}: ${detail}${p.default !== undefined ? `, default ${JSON.stringify(p.default)}` : ''}${p.description ? ` — ${p.description}` : ''}`,
        );
      }
      if (!def.props.length) lines.push('(none)');
      if (def.variants.length) {
        lines.push('Variants:');
        for (const v of def.variants) lines.push(`- ${variantsLine(v)}`);
      }
      lines.push(
        'Main component tree (ids editable with update_styles, set_text...; changes affect all instances):',
        getTreeSummary(def.root, 5, { doc: source }),
      );
      const html = nodesToHtml([expandNodeTree(source, def.root)], { mode: 'inline' }).html;
      lines.push(
        'Main component HTML ({{prop}} = prop value):',
        html.length > MAX_HTML_CHARS ? `${html.slice(0, MAX_HTML_CHARS)}\n… (truncated)` : html,
      );
      return lines.join('\n');
    },
  );

  /* ---------- main component ---------- */

  tool(
    'create_component',
    {
      title: 'Create component',
      description:
        'Turns a node (not a frame) into a component: the node becomes the first instance. props declares the props; bind links a prop to the text, attribute or style of an inner node ({{name}}). data-slot creates slots.',
      example: {
        nodeId: 'el_ab12cd34',
        name: 'PrimaryButton',
        props: [{ name: 'label', type: 'string', bind: { nodeId: 'tx_9f8e7d6c', target: 'text' } }],
      },
      inputSchema: {
        nodeId: z
          .string()
          .describe('Id of the page node that becomes a component, e.g. "el_ab12cd34".'),
        name: z.string().optional().describe('Component name in PascalCase, e.g. "PrimaryButton".'),
        description: z.string().optional().describe('Description for agents and for the panel.'),
        props: z
          .array(propDefSchema.extend({ bind: bindSchema.optional() }))
          .optional()
          .describe(
            'Props, e.g. [{ "name": "label", "type": "string", "bind": { "nodeId": "tx_1", "target": "text" } }].',
          ),
        docId: docIdField,
      },
      annotations: WRITE,
    },
    ({ nodeId, name, description, props, docId }) => {
      const id = store.resolveDocId(docId);
      const doc = store.get(id);
      requireNode(doc, nodeId);
      const { ops, componentId, instanceId } = createComponentOps(doc, nodeId, {
        name,
        description,
        props: props as PropInput[] | undefined,
      });
      const r = apply(id, ops, 'create_component');
      const def = getComponent(r.doc, componentId)!;
      return `Component created: ${componentId} "${def.name}" (props: ${propsLine(def)}). The node became instance ${instanceId}.\n${summaryOf(r.doc, [instanceId])}\nEdit the main component with update_styles/set_text on the ids from get_component, or update_component_html.`;
    },
  );

  tool(
    'update_component',
    {
      title: 'Update component',
      description:
        'Changes name, description, props (the whole list replaces the current one) and variants (when + overrides by main component node id, "" = root). See get_component first. Propagates to instances.',
      example: {
        componentId: 'cp_ab12cd34',
        variants: [
          {
            when: { variant: 'outline' },
            overrides: { '': { style: { background: 'transparent' } } },
          },
        ],
      },
      inputSchema: {
        componentId: z
          .string()
          .describe('Id, name or "kit/Name" of the component, e.g. "cp_ab12cd34".'),
        name: z.string().optional().describe('New name, e.g. "PrimaryButton".'),
        description: z
          .string()
          .optional()
          .describe('New description ("" removes it), e.g. "Primary action button".'),
        props: z
          .array(propDefSchema)
          .optional()
          .describe(
            'Complete list of props (replaces the current one), e.g. [{ "name": "label", "type": "string", "default": "Ok" }].',
          ),
        variants: z
          .array(variantSchema)
          .optional()
          .describe('Complete list of variants (replaces the current one).'),
        docId: docIdField,
      },
      annotations: WRITE,
    },
    ({ componentId, name, description, props, variants, docId }) => {
      const id = store.resolveDocId(docId);
      const doc = store.get(id);
      const def = requireComponent(doc, componentId);
      if (name === undefined && description === undefined && !props && !variants)
        throw new ToolError(
          'Provide at least one of name, description, props or variants. E.g. name "PrimaryButton".',
        );
      const op: Op = {
        type: 'updateComponent',
        componentId: def.id,
        ...(name !== undefined ? { name } : {}),
        ...(description !== undefined
          ? { description: description === '' ? null : description }
          : {}),
        ...(props ? { props: props as PropDef[] } : {}),
        ...(variants ? { variants: variants as ComponentVariant[] } : {}),
      };
      const r = apply(id, [op], 'update_component');
      const next = getComponent(r.doc, def.id)!;
      return `Component ${def.id} updated: "${next.name}" | props: ${propsLine(next)} | ${next.variants.length} variant(s) | ${instanceCount(r.doc, def.id)}.`;
    },
  );

  tool(
    'update_component_html',
    {
      title: 'Replace the main component with HTML',
      description:
        'Replaces the main component tree with HTML (a single root element; Tailwind classes compiled as in write_html). Keep {{prop}} and data-slot="name"; new props/slots are created. Overrides on old ids stop applying.',
      example: {
        componentId: 'cp_ab12cd34',
        html: '<button style="padding:8px 16px;border-radius:6px;background:var(--color-primary)">{{label}}</button>',
      },
      inputSchema: {
        componentId: z
          .string()
          .describe('Id, name or "kit/Name" of the component, e.g. "cp_ab12cd34".'),
        html: z
          .string()
          .describe('Main component HTML, one root element, e.g. "<button>{{label}}</button>".'),
        tailwind: z
          .enum(['auto', 'on', 'off'])
          .optional()
          .describe(
            'Tailwind classes: "auto" (default) detects, "on" forces, "off" treats them as CSS.',
          ),
        docId: docIdField,
      },
      annotations: DESTRUCTIVE,
    },
    async ({ componentId, html, tailwind, docId }) => {
      const id = store.resolveDocId(docId);
      const doc = store.get(id);
      const def = requireComponent(doc, componentId);
      const { nodes, tailwind: usedTw, report } = await htmlToNodesTw(doc, html, tailwind);
      if (nodes.length !== 1)
        throw new ToolError(
          `The main component HTML needs a single root element (got ${nodes.length}); wrap everything in a <div>. E.g. "<button>{{label}}</button>".`,
        );
      const root = nodes[0]!;
      delete root.position;
      root.name = def.root.name;

      // props: `{{x}}` and `data-slot` in the HTML without a matching prop are created; warns about leftovers
      const inferred = inferProps(root);
      const have = new Set(def.props.map((p) => p.name));
      const added = inferred.filter((p) => !have.has(p.name));
      const props = [...def.props, ...added];
      const usedNames = new Set(inferred.map((p) => p.name));
      for (const v of def.variants) for (const k of Object.keys(v.when)) usedNames.add(k);
      walk(root, (n) => {
        for (const v of Object.values(n.props ?? {}))
          if (typeof v === 'string') for (const p of placeholderNames(v)) usedNames.add(p);
      });
      const unused = props.filter((p) => !usedNames.has(p.name)).map((p) => p.name);

      const ops: Op[] = [];
      if (usedTw && doc.cssBase !== 'tailwind') ops.push({ type: 'setCssBase', base: 'tailwind' });
      ops.push({
        type: 'updateComponent',
        componentId: def.id,
        root,
        ...(added.length ? { props } : {}),
      });
      const r = apply(id, ops, 'update_component_html');
      const lines = [
        `Main component of "${def.name}" (${def.id}) replaced; updated: ${instanceCount(r.doc, def.id)}. New root id: ${root.id}.`,
        ...(usedTw
          ? [
              `Tailwind classes compiled (${report?.nodes ?? 0} node(s)).`,
              ...(report ? reportLines(report) : []),
            ]
          : []),
      ];
      if (added.length)
        lines.push(
          `Props created from the HTML: ${added.map(fmtProp).join(', ')} (adjust with update_component).`,
        );
      if (unused.length)
        lines.push(
          `Warning: props unused in the HTML (and in variants): ${unused.join(', ')}. Use {{name}} or remove them with update_component.`,
        );
      lines.push(
        'The nodes have new ids: instance overrides on the old ids stop applying (reset_instance clears them).',
        summaryOf(r.doc, [root.id]),
      );
      return lines.join('\n');
    },
  );

  tool(
    'delete_component',
    {
      title: 'Delete component',
      description:
        'Removes the main component (reversible with undo). Refuses if instances exist, unless detach_instances is true (instances become plain nodes first).',
      example: { componentId: 'cp_ab12cd34', detach_instances: true },
      inputSchema: {
        componentId: z
          .string()
          .describe('Id, name or "kit/Name" of the component, e.g. "cp_ab12cd34".'),
        detach_instances: z
          .boolean()
          .optional()
          .describe(
            'true detaches the instances (they become plain nodes) before deleting. Default false.',
          ),
        docId: docIdField,
      },
      annotations: DESTRUCTIVE,
    },
    ({ componentId, detach_instances, docId }) => {
      const id = store.resolveDocId(docId);
      const doc = store.get(id);
      const def = requireComponent(doc, componentId);
      const instances = listInstances(doc, def.id);
      if (instances.length && !detach_instances)
        throw new ToolError(
          `Component "${def.name}" has ${instanceCount(doc, def.id)}. Use detach_instances: true to detach them (they become plain nodes) or delete/detach them first.`,
        );
      const ops: Op[] = [];
      const detached: string[] = [];
      for (const inst of instances) {
        ops.push(...detachInstanceOps(doc, inst.node.id));
        detached.push(inst.node.id);
      }
      ops.push({ type: 'deleteComponent', componentId: def.id });
      const r = apply(id, ops, 'delete_component');
      return `Component "${def.name}" (${def.id}) deleted${detached.length ? `; ${detached.length} instance(s) detached (${instanceCount(doc, def.id)})` : ''}.\n${getDocSummary(r.doc)}`;
    },
  );

  const getDocSummary = (doc: Document): string => summaryOf(doc, []);

  /* ---------- instances ---------- */

  tool(
    'insert_component',
    {
      title: 'Insert component',
      description:
        'Inserts an instance (id, name or "kit/Name"; a missing kit is imported in the same history entry). props sets values; slots takes HTML per slot ({ content: "<p>…</p>" }). Returns the instance id and the slot ids.',
      example: {
        component: 'shadcn-like/Button',
        parentId: 'fr_ab12cd34',
        props: { variant: 'outline', label: 'Save' },
      },
      inputSchema: {
        component: z
          .string()
          .describe('Id (cp_...), name or "kit/Name", e.g. "shadcn-like/Button".'),
        parentId: z
          .string()
          .optional()
          .describe(
            'Parent id (or slot container of another instance), e.g. "fr_ab12cd34" (default: selection or first frame).',
          ),
        props: z
          .record(z.string(), propValueSchema)
          .optional()
          .describe('Prop values, e.g. { "variant": "outline", "label": "Save" }.'),
        slots: z
          .record(z.string(), z.string())
          .optional()
          .describe(
            'HTML per slot (Tailwind classes accepted), e.g. { "content": "<p>Hello</p>" }.',
          ),
        index: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe('Position among the children, e.g. 0 (default: end).'),
        name: z.string().optional().describe('Layer name of the instance, e.g. "Save button".'),
        styles: z
          .record(z.string(), z.string())
          .optional()
          .describe('Styles of the instance root (width, margin...), e.g. { "width": "100%" }.'),
        docId: docIdField,
      },
      annotations: WRITE,
    },
    async ({ component, parentId, props, slots, index, name, styles, docId }) => {
      const id = store.resolveDocId(docId);
      const doc = store.get(id);
      const parent = parentId ?? selectedOrFirstFrame(id, doc);
      requireNode(doc, parent);

      // `kit/Name` not in the document: imports the kit in the same history entry
      let def = findComponent(doc, component);
      let work = doc;
      const ops: Op[] = [];
      let imported = '';
      if (!def) {
        const slash = component.lastIndexOf('/');
        if (slash <= 0) {
          const kits = listKits();
          const hit = kits
            .flatMap((k) => k.components.map((c) => ({ kit: k.name, name: c.name })))
            .find((c) => c.name.toLowerCase() === component.trim().toLowerCase());
          throw hit
            ? new ToolError(
                `Component "${component}" is not in the document. Use "${hit.kit}/${hit.name}" to import it from the kit.`,
              )
            : componentNotFound(doc, component);
        }
        const kit = kitOrThrow(component.slice(0, slash));
        const compName = component
          .slice(slash + 1)
          .trim()
          .toLowerCase();
        const kc = (kit.doc.components ?? []).find(
          (c) => c.name.toLowerCase() === compName || c.id === component.slice(slash + 1),
        );
        if (!kc)
          throw new ToolError(
            `Kit "${kit.name}" has no component "${component.slice(slash + 1)}". Components: ${(kit.doc.components ?? []).map((c) => c.name).join(', ')}.`,
          );
        // Only the missing components (by kit id): main components already in the document, edited
        // or renamed, stay as they are.
        const imp = importKitOps(doc, kit.doc, kit.name, { onlyMissing: true });
        ops.push(...imp.ops);
        work = applyOps(doc, imp.ops).doc;
        def = getComponent(work, kc.id);
        if (!def) throw componentNotFound(doc, component);
        const added = imp.components.filter((c) => c.status === 'added').length;
        if (added > 0 || imp.tokensAdded.length > 0) {
          imported = ` Kit "${kit.name}" imported (${added} component(s)${imp.tokensAdded.length ? `, ${imp.tokensAdded.length} token(s)` : ''}).`;
        }
      }

      // slots: HTML → nodes (Tailwind accepted, as in write_html)
      const slotNodes: Record<string, Node[]> = {};
      let usedTw = false;
      const valid = slotNames(def);
      for (const [slot, html] of Object.entries(slots ?? {})) {
        if (!valid.includes(slot))
          throw new ToolError(
            `Component "${def.name}" has no slot "${slot}"${valid.length ? ` (slots: ${valid.join(', ')})` : ' (it has no slots)'}.`,
          );
        const r = await htmlToNodesTw(work, html, undefined);
        usedTw ||= r.tailwind;
        slotNodes[slot] = r.nodes;
      }
      if (usedTw && work.cssBase !== 'tailwind') ops.push({ type: 'setCssBase', base: 'tailwind' });

      const node = instanceNodeFor(work, def.id, {
        props,
        slots: slotNodes,
        name,
        style: styles,
      });
      ops.push({ type: 'createNode', parentId: parent, node, index });
      const r = apply(id, ops, 'insert_component');
      const slotIds = node.children.map((c) => `${c.attrs['data-slot']}=${c.id}`).join(', ');
      return [
        `Instance created: ${node.id} of "${def.name}" in ${parent}.${imported}`,
        slotIds ? `Slots (use as parentId in write_html/insert_component): ${slotIds}.` : undefined,
        summaryOf(r.doc, [node.id]),
      ]
        .filter(Boolean)
        .join('\n');
    },
  );

  tool(
    'set_instance_props',
    {
      title: 'Set instance props',
      description:
        'Sets and/or removes props on one or more instances (unset restores the default). Values are validated by type (enum only accepts its options). Slots are not props: use write_html on the slot container.',
      example: { nodeIds: ['in_ab12cd34'], set: { variant: 'secondary', label: 'Cancel' } },
      inputSchema: {
        nodeIds: z.array(z.string()).min(1).describe('Instance ids, e.g. ["in_ab12cd34"].'),
        set: z
          .record(z.string(), propValueSchema)
          .optional()
          .describe('Props to set, e.g. { "variant": "secondary", "label": "Cancel" }.'),
        unset: z
          .array(z.string())
          .optional()
          .describe('Props to reset to default, e.g. ["label"].'),
        docId: docIdField,
      },
      annotations: WRITE,
    },
    ({ nodeIds, set, unset, docId }) => {
      const id = store.resolveDocId(docId);
      const doc = store.get(id);
      for (const n of nodeIds) requireInstance(doc, n);
      if (!set && !unset?.length)
        throw new ToolError('Provide set and/or unset. E.g. set { "variant": "outline" }.');
      const r = apply(
        id,
        [{ type: 'setInstanceProps', changes: nodeIds.map((nodeId) => ({ nodeId, set, unset })) }],
        'set_instance_props',
      );
      return `Props updated on ${nodeIds.length} instance(s).\n${summaryOf(r.doc, nodeIds)}`;
    },
  );

  tool(
    'set_instance_override',
    {
      title: 'Override an instance node',
      description:
        'Changes an inner node only in this instance (style, text, attributes, hidden), merging into the existing override. path = node id in the main component ("" = root; nested instance: "in_x/tx_y"). Equivalent to update_styles/set_text on the virtual id.',
      example: {
        nodeId: 'in_ab12cd34',
        path: 'tx_9f8e7d6c',
        style: { color: '#dc2626' },
        text: 'Delete',
      },
      inputSchema: {
        nodeId: z.string().describe('Instance id, e.g. "in_ab12cd34".'),
        path: z
          .string()
          .describe(
            'Node id in the main component, e.g. "tx_9f8e7d6c" ("" = root; nested: "in_ab12cd34/tx_9f8e7d6c"). See get_tree_summary of the instance.',
          ),
        style: z
          .record(z.string(), z.string())
          .optional()
          .describe('CSS styles to merge, e.g. { "color": "#dc2626" }.'),
        unset_style: z
          .array(z.string())
          .optional()
          .describe('CSS properties of the main component to remove, e.g. ["border"].'),
        text: z.string().optional().describe('Node text, e.g. "Delete".'),
        attrs: z
          .record(z.string(), z.string())
          .optional()
          .describe('HTML attributes to merge, e.g. { "href": "/home" }.'),
        hidden: z.boolean().optional().describe('true hides the node in this instance.'),
        docId: docIdField,
      },
      annotations: WRITE,
    },
    ({ nodeId, path, style, unset_style, text, attrs, hidden, docId }) => {
      const id = store.resolveDocId(docId);
      const doc = store.get(id);
      const inst = findInstanceNode(doc, nodeId);
      if (!inst) {
        requireInstance(doc, nodeId); // throws the appropriate error if it is not an instance
        throw new ToolError(
          `"${nodeId}" is a nested instance: edit it with update_styles/set_text/set_instance_props on this virtual id, or use set_instance_override on the outer instance (path "<nested id>/<node>").`,
        );
      }
      const target = path === '' ? nodeId : `${nodeId}/${path}`;
      if (!resolveRead(doc, target)) {
        const tree = resolveRead(doc, nodeId);
        throw new ToolError(
          `Path "${path}" does not exist in this instance. Use the id of a main component node (and "in_x/..." for nested instances):\n${tree ? getTreeSummary(tree.path.node, 4, { doc }) : ''}`,
        );
      }
      const ov: NodeOverride = {};
      if (style && Object.keys(style).length) ov.style = style;
      if (unset_style?.length) ov.unsetStyle = unset_style;
      if (text !== undefined) ov.text = text;
      if (attrs && Object.keys(attrs).length) ov.attrs = attrs;
      if (hidden !== undefined) ov.hidden = hidden;
      if (Object.keys(ov).length === 0)
        throw new ToolError(
          'Provide at least one of style, unset_style, text, attrs or hidden. E.g. style { "color": "#dc2626" }.',
        );
      const prev = inst.overrides?.[path];
      const merged = prev ? mergeOverride(prev, ov) : ov;
      const r = apply(
        id,
        [
          {
            type: 'setInstanceOverrides',
            changes: [{ nodeId, overrides: { ...(inst.overrides ?? {}), [path]: merged } }],
          },
        ],
        'set_instance_override',
      );
      return `Override applied to ${target}.\n${summaryOf(r.doc, [nodeId])}`;
    },
  );

  tool(
    'reset_instance',
    {
      title: 'Reset instances',
      description:
        'Removes all overrides from the instances (props and slots stay). To write the overrides to the main component instead of discarding them, use push_overrides_to_main.',
      example: { nodeIds: ['in_ab12cd34'] },
      inputSchema: {
        nodeIds: z.array(z.string()).min(1).describe('Instance ids, e.g. ["in_ab12cd34"].'),
        docId: docIdField,
      },
      annotations: DESTRUCTIVE,
    },
    ({ nodeIds, docId }) => {
      const id = store.resolveDocId(docId);
      const doc = store.get(id);
      for (const n of nodeIds) requireInstance(doc, n);
      const r = apply(
        id,
        nodeIds.flatMap((n) => resetInstanceOps(doc, n)),
        'reset_instance',
      );
      return `Overrides removed from ${nodeIds.length} instance(s).\n${summaryOf(r.doc, nodeIds)}`;
    },
  );

  tool(
    'detach_instance',
    {
      title: 'Detach instance',
      description:
        'Turns the instance into plain nodes (new ids), disconnecting it from the main component. Returns the new root id. Reversible with undo.',
      example: { nodeId: 'in_ab12cd34' },
      inputSchema: {
        nodeId: z.string().describe('Instance id, e.g. "in_ab12cd34".'),
        docId: docIdField,
      },
      annotations: DESTRUCTIVE,
    },
    ({ nodeId, docId }) => {
      const id = store.resolveDocId(docId);
      const doc = store.get(id);
      requireInstance(doc, nodeId);
      const ops = detachInstanceOps(doc, nodeId);
      const r = apply(id, ops, 'detach_instance');
      const rep = ops[0];
      const newId = rep && rep.type === 'replaceNode' ? rep.node.id : nodeId;
      return `Instance ${nodeId} detached. New id: ${newId}.\n${summaryOf(r.doc, [newId])}`;
    },
  );

  tool(
    'push_overrides_to_main',
    {
      title: 'Push overrides to the main component',
      description:
        'Writes the instance overrides to the main component (all instances take on that look) and clears the instance ones. Does nothing without overrides.',
      example: { nodeId: 'in_ab12cd34' },
      inputSchema: {
        nodeId: z.string().describe('Instance id, e.g. "in_ab12cd34".'),
        docId: docIdField,
      },
      annotations: DESTRUCTIVE,
    },
    ({ nodeId, docId }) => {
      const id = store.resolveDocId(docId);
      const doc = store.get(id);
      const inst = requireInstance(doc, nodeId);
      const ops = pushOverridesToMainOps(doc, nodeId);
      if (!ops.length) return `Instance ${nodeId} has no overrides: nothing to push.`;
      const r = apply(id, ops, 'push_overrides_to_main');
      const def = getComponent(r.doc, inst.componentId);
      const n = def ? instanceCount(r.doc, def.id) : '0 instance(s)';
      return `Overrides of ${nodeId} written to the main component "${def?.name ?? inst.componentId}" (affects ${n}).\n${summaryOf(r.doc, [nodeId])}`;
    },
  );

  tool(
    'go_to_main',
    {
      title: 'Go to the main component',
      description:
        'Selects the main component root in the editor (which enters main component editing) and returns its tree with ids. Accepts an instance, a virtual id ("in_x/...") or a component id.',
      example: { nodeId: 'in_ab12cd34' },
      inputSchema: {
        nodeId: z
          .string()
          .describe('Id of an instance, virtual id ("in_x/tx_y") or component (cp_...).'),
        docId: docIdField,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    ({ nodeId, docId }) => {
      const id = store.resolveDocId(docId);
      const doc = store.get(id);
      let def = getComponent(doc, nodeId);
      if (!def) {
        const read = resolveRead(doc, nodeId);
        const node = read?.path.node;
        if (node?.componentId) def = getComponent(doc, node.componentId);
        else if (read?.component) def = read.component;
        else if (isVirtualId(nodeId))
          def = findComponentNode(doc, nodeId.slice(nodeId.lastIndexOf('/') + 1))?.component;
      }
      if (!def) {
        if (!read0(doc, nodeId))
          throw new ToolError(
            `Node not found: "${nodeId}". Use get_tree_summary (instances appear as ◆Name) or list_components.`,
          );
        throw new ToolError(
          `"${nodeId}" is not an instance and is not part of a main component. Use list_components to see the components.`,
        );
      }
      store.setSelection(id, [def.root.id], 'mcp');
      return [
        `Main component "${def.name}" (${def.id}) selected: root ${def.root.id} (${instanceCount(doc, def.id)}).`,
        getTreeSummary(def.root, 5, { doc }),
        'Edit with update_styles/set_text/set_attrs on these ids (propagates to all instances), update_component_html or update_component.',
      ].join('\n');
    },
  );
  const read0 = (doc: Document, id: string): boolean => !!resolveRead(doc, id);

  /* ---------- kits ---------- */

  tool(
    'import_kit',
    {
      title: 'Import component kit',
      description:
        'Imports a kit (name, e.g. "shadcn-like", or absolute path of a .mockup.json) with the missing tokens. Idempotent: adds the missing components and lists the edited (diverged) ones without overwriting; overwrite: true replaces them with the kit versions. Kits are listed in list_components.',
      example: { name: 'shadcn-like' },
      inputSchema: {
        name: z.string().describe('Kit name ("shadcn-like") or absolute path of a .mockup.json.'),
        overwrite: z
          .boolean()
          .optional()
          .describe(
            'true replaces the kit components that differ from the kit (discarding edits made to them). Default false: only adds the missing ones.',
          ),
        docId: docIdField,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    ({ name, overwrite, docId }) => {
      const id = store.resolveDocId(docId);
      const doc = store.get(id);
      const kit = kitOrThrow(name);
      const imp = importKitOps(doc, kit.doc, kit.name, { onlyMissing: overwrite !== true });
      const list = imp.components.map((c) => `${c.name} (${c.status})`).join(', ');
      const diverged = imp.components.filter((c) => c.status === 'diverged');
      const notes = [
        diverged.length
          ? `Diverged from the kit (kept with your edits): ${diverged.map((c) => c.name).join(', ')}. To replace them with the kit versions: import_kit("${name}", overwrite: true).`
          : undefined,
        imp.skipped.length
          ? `Kept unchanged (same id, but from another source): ${imp.skipped.map((c) => `${c.name}${c.kit ? ` [kit ${c.kit}]` : ''}`).join(', ')}.`
          : undefined,
      ];
      if (imp.ops.length === 0) {
        return [
          diverged.length
            ? `Kit "${kit.name}": nothing to import (${list}).`
            : `Kit "${kit.name}" is already imported and up to date: ${list}.`,
          ...notes,
        ]
          .filter(Boolean)
          .join('\n');
      }
      apply(id, imp.ops, 'import_kit');
      return [
        `Kit "${kit.name}" imported: ${list}.`,
        imp.tokensAdded.length
          ? `Tokens created (${imp.tokensAdded.length}): ${imp.tokensAdded.slice(0, 8).join(', ')}${imp.tokensAdded.length > 8 ? ', …' : ''}.`
          : 'No new tokens (the document already had the ones used).',
        ...notes,
        'Insert with insert_component("kit/Name", parentId, props); details in get_component.',
      ]
        .filter(Boolean)
        .join('\n');
    },
  );
}
