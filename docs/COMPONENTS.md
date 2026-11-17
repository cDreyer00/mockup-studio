# Components

Reusable document components: a **main component** (`ComponentDef`, in the `doc.components` library) and **instances** (`type: 'instance'`) scattered across the pages. Editing the main component propagates to all instances; each instance has its own **props**, **slots** and **overrides**. There is a default kit (`kits/shadcn-like.mockup.json`) that can be imported into any document.

Types in `packages/core/src/types.ts`; logic in `packages/core/src/components/`.

## Model

### ComponentDef

| Field         | Type                 | Description                                                                                         |
| ------------- | -------------------- | --------------------------------------------------------------------------------------------------- |
| `id`          | string               | `cp_xxxxxxxx` (kits use their own stable ids, e.g. `cp_sbutton1`).                                  |
| `name`        | string               | Name (PascalCase recommended: it becomes the React component name). Unique in the document.         |
| `description` | string (optional)    | Description for agents and for the panel.                                                           |
| `kit`         | string (optional)    | Source kit (`shadcn-like`). Reference `kit/Name` in the MCP (`shadcn-like/Button`).                 |
| `props`       | `PropDef[]`          | Props, in display order.                                                                            |
| `root`        | `Node`               | The main component's tree (never `type: 'frame'`; no `position`). Ids unique in the whole document. |
| `variants`    | `ComponentVariant[]` | Conditional overrides driven by the props (see Variants).                                           |

`doc.components` is absent when empty: old documents remain valid without migration.

### PropDef

| Field         | Type                                                               | Description                              |
| ------------- | ------------------------------------------------------------------ | ---------------------------------------- |
| `name`        | string                                                             | Identifier (`label`, `variant`, `open`). |
| `type`        | `'string' \| 'number' \| 'boolean' \| 'enum' \| 'color' \| 'slot'` | Type, defines the control in the panel.  |
| `default`     | `string \| number \| boolean` (optional)                           | Default value (slots have none).         |
| `options`     | `string[]` (optional)                                              | `enum` options.                          |
| `description` | string (optional)                                                  |                                          |

How each type acts on the tree:

- **string, number, color**: by **placeholder** `{{name}}` in `text`, `attrs` values, `style` and `states` values, `src` and (string) props of nested instances. E.g.: text `{{label}}`, style `background: {{color}}`. The value is converted to a string and substituted literally.
- **boolean and enum**: by **variants** (`when: { variant: 'outline' }`, `when: { disabled: true }`). They also work in placeholders.
- **slot**: the main component's container with the attribute `data-slot="<name>"` (and a `slot` prop with that name) is the point where the instance's content goes. The container's children in the main component are the default content.

### Variants

```ts
interface ComponentVariant {
  when: Record<string, PropValue>; // all props must match (compared via String())
  overrides: Record<string, NodeOverride>; // key '' = root of the main component
}
```

The matching variants are applied in list order (the last one wins). E.g.: the kit's Button has `variant` (enum `default | secondary | outline | ghost | destructive`) and one variant per option that swaps `background`, `color`, `border` and the `hover`.

`when` needs at least one condition: a variant with `when: {}` would always apply (those styles belong in the main component) and the React export would have no way to represent it. The ops (`addComponent`, `updateComponent`, in the schema and in the handler) reject with "variant without a condition: move the styles to the main component". When reading a file the empty variant is **discarded** (like unsafe style declarations), without rejecting the document; expansion also ignores it.

### Instance

A node of `type: 'instance'`:

| Field                                 | Description                                                                                                            |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `id`                                  | `in_xxxxxxxx`.                                                                                                         |
| `componentId`                         | Id of the main component.                                                                                              |
| `props`                               | Prop values (only those that differ from the default).                                                                 |
| `overrides`                           | `Record<path, NodeOverride>`: per-node overrides of the main component.                                                |
| `style`, `attrs`, `states`, `classes` | Override the main component's **root** (merged on top). `position`, `name`, `hidden`, `locked` belong to the instance. |
| `tag`                                 | Ignored on expansion (the main component root's tag applies); stored equal to the main component's.                    |
| `children`                            | Only **slot containers** (see Slots).                                                                                  |

### Slots

The content of each slot lives in the instance node's **real children**: one container per slot, `{ type: 'element', tag: 'div', name: 'Slot <name>', attrs: { 'data-slot': '<name>' } }`, whose children are the content. This way all existing ops (`createNode`, `moveNodes`, `deleteNodes`, `setText`...), the layers panel, `findNode` and selection work on slot content with no new code.

- Instances are created with one container for each `slot` prop (empty = uses the main component's default content).
- On expansion, the main component's `data-slot` container is rendered with the **id of the instance's container**, the main component's style merged with `overrides[id of the main component's container]` and, on top, the `style` of the instance's container; the children are those of the instance's container (or, if it is empty, the main component's default content).
- The instance only accepts children that are slot containers: `createNode`/`moveNodes` with the instance's `parentId` is rejected ("insert inside a slot").
- Inserting into a virtual slot container (expanded id from the main component) creates the instance's real container (deterministic id) and inserts into it.

Decision: the original brief called for `slots: Record<string, Node[]>`; storing slots as real children avoids duplicating the tree logic (search, ops, layers, clipboard) for a second place where nodes live.

### Overrides (NodeOverride)

```ts
interface NodeOverride {
  style?: Record<string, string>; // merged
  unsetStyle?: string[]; // removes from the main component
  text?: string;
  attrs?: Record<string, string>; // merged
  hidden?: boolean;
  classes?: string;
  states?: Record<string, Record<string, string>>; // merged per state variant
  src?: string;
  svg?: string;
  props?: Record<string, PropValue>; // props of a nested instance
  vector?: Vector; // svg node: with it, svg is the generated markup (or the one given)
  effect?: EffectSpec; // effect node (whole object, like setMedia)
  video?: VideoSpec; // video node
  embed?: EmbedSpec; // embed node
  data?: unknown[]; // repeater: items (`[]` counts as an empty list)
  dataSource?: DataSource; // repeater: data source
}
```

Each field only applies to its own node type (`src` on image, `svg`/`vector` on svg, `effect`/`video`/`embed` on the node of the same type, `data`/`dataSource` on repeater). An `svg` without `vector` discards the main component's vector in the view (the drawing is no longer the vector's). `{{prop}}` placeholders do not apply inside `effect`, `video`, `embed` or `data`; on a repeater inside a main component, the template's `{{field}}` bindings that match the name of a prop are resolved by the prop (the others are left to the repeater).

**Path**: ids of the main component's nodes separated by `/`. A direct node of the main component is `el_label01`; a node inside an instance nested in the main component is `<id of the nested instance in the main component>/<id of the node in its main component>` (e.g. `in_okbtn001/tx_label01`). Ids are stable: inserting or reordering nodes in the main component does not invalidate overrides (overrides for nodes that no longer exist are ignored).

## Expansion

`expandInstance(doc, instance)` returns the instance's concrete tree; `expandDocument(doc)` returns the document with all instances expanded (same objects where there is no instance; cached per document). Canvas render, the render page (screenshot), `get_layout` and the HTML/Tailwind/SVG exporters use the expanded tree. React generates one component per main component (see Export).

Order of application, for instance `I` of component `C`:

1. Clone `C.root`.
2. Effective props = defaults from `C.props` + `I.props`.
3. Variants of `C` whose `when` matches, in order.
4. `{{prop}}` placeholders.
5. `I.overrides` (after the variants: what the instance changed wins).
6. Root: `I.style`, `I.attrs`, `I.states`, `I.classes` merged onto the root; `position`, `name`, `hidden`, `locked` from the instance.
7. Slots (see above).
8. Nested instances are expanded recursively, receiving `I`'s overrides with their path prefix.

### Expanded ids

- The expanded root has the instance's id and keeps `componentId` and `props` as a marker (the type becomes that of the main component's root).
- Nodes coming from a main component's tree get a **virtual** id `<instance id>/<path>` (e.g. `in_ab12cd34/tx_label01`, nested `in_ab12cd34/in_okbtn001/tx_label01`). `isVirtualId(id)` = contains `/`.
- Real nodes (slot containers and the slot content of a page instance) keep their id.
- Missing component, cycle or depth > 16: the instance becomes a warning container (dashed border, text "Missing component") with the instance's id.
- Component too large: if the expansion of an instance would generate more than `MAX_EXPANDED_NODES` (50,000) nodes, it becomes the same warning container with the text "Component too large" (the warning in `warnings` carries the estimated size). Depth alone does not limit a wide DAG (C1 with 4 instances of C2, C2 with 4 of C3... gives 4^10 nodes in 10 levels). The size comes from `expandedSize(doc, componentId)`, memoized per components array (linear in the library): nodes of the main component's root, with each nested instance counting the size of its component (upper bound: includes the slots' default content). The limit is per instance (including nested), not per document: a document with many large instances grows linearly with their number.
- Cache: `expandDocument` per document object and each page instance by (node object, components array). Pending: the per-instance cache key is the identity of the `doc.components` array, so any change to any main component invalidates the expansion of all instances (including those of unaffected components); a stable per-component key (version/hash of the main component and its dependencies) would avoid this, but requires versioning the main components on each op.

### Editing through the expanded id (op routing)

`applyOp` routes ops whose targets are not real page nodes:

- **Virtual instance id** (`in_x/path`): `updateStyles`, `setText`, `setAttrs`, `setNodeFlags` (`hidden`), `setClasses`, `setStates`, `setSrc`, `setSvg`, `setVector`, `setMedia`, `setData` and `setInstanceProps` (nested instance) become `setInstanceOverrides` on the owning instance. That is why the tools and panels of phases 6 to 8 (`bind_data`, `refresh_data`, `update_effect`, `update_media`, `set_path`, `set_vector_paint`, `set_image`, the Data, Image, Effect and Vector sections) work with the virtual id; those that change structure (`boolean_op`, `flatten`, `text_to_outlines`, convert to repeater) are rejected inside the instance, like the others. Structure (`createNode` outside a slot, `deleteNodes`, `moveNodes`, `duplicateNodes`, `setTag`) is rejected with a message asking you to edit the main component or detach.
- **Node in a main component's tree** (real id inside `doc.components[].root`): any node op is applied to a temporary document with the main component's root and becomes `updateComponent { root }`. This is how the editor (main component edit mode) and the MCP (`update_styles` with main component ids) edit the main component.
- Exact inverse (that of the routed op), so undo/redo work the same.
- An op the router does not know (outside `targetIds`) aimed at a virtual id fails with `Operation "X" is not supported on instance nodes; use set_instance_override or detach the instance (detach_instance)`; aimed at a main component node, with `Operation "X" is not supported on nodes of a main component; ...` (instead of "Node not found"). The targets of these ops are deduced from the usual fields (`nodeId`, `nodeIds`, `parentId`, `changes[].nodeId`).

## Ops

Primitives (in `ops.ts`, with exact inverse):

| Op                     | Fields                                                                 | Inverse                                      |
| ---------------------- | ---------------------------------------------------------------------- | -------------------------------------------- |
| `addComponent`         | `component`, `index?`                                                  | `deleteComponent` (see `force` below)        |
| `deleteComponent`      | `componentId` (rejects if there are instances)                         | `addComponent` at the original position      |
| `updateComponent`      | `componentId`, `name?`, `description?`, `props?`, `variants?`, `root?` | `updateComponent` with the previous values   |
| `replaceNode`          | `nodeId`, `node` (swaps the node in place; new ids validated)          | `replaceNode` back                           |
| `setInstanceProps`     | `changes[{ nodeId, set?, unset? }]`                                    | `setInstanceProps` with the previous values  |
| `setInstanceOverrides` | `changes[{ nodeId, overrides \| null }]` (replaces the map)            | `setInstanceOverrides` with the previous map |

`deleteComponent.force` is **internal**: only the inverse of an `addComponent` made when instances of that id already existed (orphans, e.g. created by `createNode` before the main component) uses it, so that undo returns exactly to the previous state. In the common case the inverse is `deleteComponent` without `force`: undo runs the inverses in reverse order, so the instances created later were already undone (and `createComponentOps` uses a provisional node so that `addComponent` happens without instances). The public entry point rejects `force` (`assertPublicOps` in `ops.schema.ts`, called by `DocumentStore.applyOps`, which serves the WS `op:apply` and the MCP tools); undo/redo applies the inverses from the history, without going through it.

Planners (in `components/plan.ts`, return `Op[]` applied as one history entry):

| Function                                              | Ops                                                                                                                                               |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `createComponentOps(doc, nodeId, { name, props })`    | `replaceNode` (node → provisional) + `addComponent` (root = the node, same ids, free after the swap) + `replaceNode` (→ instance)                 |
| `instanceNodeFor(doc, componentId, { props, slots })` | (node) instance ready for `createNode`, with the slot containers                                                                                  |
| `detachInstanceOps(doc, nodeId)`                      | `replaceNode` (instance → concrete tree with new ids; slot content keeps its ids; nested instances remain instances)                              |
| `pushOverridesToMainOps(doc, nodeId)`                 | `updateComponent` (overrides written to the main component) + `setInstanceOverrides` (clears)                                                     |
| `resetInstanceOps(doc, nodeId)`                       | `setInstanceOverrides` null                                                                                                                       |
| `importKitOps(doc, kit, kitName, { onlyMissing })`    | `addComponent` for the missing ones, `updateComponent` for the diverged ones (without `onlyMissing`) + missing tokens and `dark` theme (see Kits) |

`createComponent` rejects root frames, nodes inside instances (virtual ids) and nodes already inside a main component that would create a cycle.

## Kits

A kit is a `*.mockup.json` document with `components` and the tokens they use (and, optionally, a showcase page). The default is `kits/shadcn-like.mockup.json` (shadcn/ui aesthetic, MIT; no copied code), with the Phase 3 shadcn preset tokens (`--color-*`, `--radius*`, `dark` theme).

| Component | Props                                                                                          | Slots               |
| --------- | ---------------------------------------------------------------------------------------------- | ------------------- |
| Button    | `variant` (default, secondary, outline, ghost, destructive), `size` (sm, default, lg), `label` | —                   |
| Input     | `placeholder`, `value`, `type`                                                                 | —                   |
| Card      | `title`, `description`                                                                         | `content`, `footer` |
| Navbar    | `brand`                                                                                        | `links`, `actions`  |
| Tabs      | `tab1`, `tab2`, `tab3`, `active` (enum 1..3)                                                   | `content`           |
| Dialog    | `title`, `description`                                                                         | `content`, `footer` |
| Table     | `caption`                                                                                      | `rows`              |
| List      | —                                                                                              | `items`             |

`import_kit` copies the components (with `kit` filled in) and creates only the missing tokens (and their `dark` theme overrides). A kit component is identified by the kit's **id** (stable, e.g. `cp_sbutton1`), not by name: renaming does not make the component look missing.

Re-importing does not undo the user's edits to the main components. `importKitOps` classifies each kit component:

| Status      | When                                                                                 | Op                |
| ----------- | ------------------------------------------------------------------------------------ | ----------------- |
| `added`     | The id is not in the document.                                                       | `addComponent`    |
| `unchanged` | It is, with the same `kit`, and is identical to the kit's.                           | —                 |
| `diverged`  | It is, with the same `kit`, but differs (edit, name, props) and `onlyMissing` is on. | — (kept)          |
| `updated`   | It is, with the same `kit`, differs and `onlyMissing` is off (overwrite).            | `updateComponent` |

Components with the id of one in the kit but a different `kit` (or no `kit`) are never touched and are reported in `skipped`.

- `insert_component('kit/Name')` (MCP) and inserting from the editor's tab use `onlyMissing: true` when the component is missing: they add the kit's missing components (the request and its dependencies) and the missing tokens, without touching existing ones.
- `import_kit(name)` (default `overwrite: false`) also uses `onlyMissing`: it adds the missing ones and lists the diverged ones, with the instruction to update. `import_kit(name, overwrite: true)` replaces the diverged ones (only those of the same kit) with the kit's; it is one history entry (undoable).

## Extending

Checklist for anyone adding ops, node fields or node types (vectors, grid, effects, embeds...) without breaking components. Real function names (search for them; line numbers change).

**New op that targets nodes** (besides the usual: type in `Op` in `ops.ts`, `OpSchema` and `OP_TYPES` in `ops.schema.ts`, handler with exact inverse in the `applyOp` `switch` in `apply.ts`):

- [ ] `targetIds` (`components/route.ts`): a `case` returning the ids the op targets. Without it the op is rejected on instance and main component nodes (see "Editing through the expanded id").
- [ ] If it is about **content** (changes a node's visuals, not the structure): a `case` in `virtualToOverrides` (`components/route.ts`) converting the op into a `NodeOverride` (probably with a new field, see below). Without a `case` it falls into the `default`, which rejects it as structure ("edit the main component or detach the instance").
- [ ] If it is about **structure** and has targets that are not in `changes[]`: a `case` in `routeComponentOp` (like `deleteNodes`/`moveNodes`) rejecting virtual ids with `refuseStructure` and grouping by owner. Ops with `changes[].nodeId` are already partitioned by the `default` of `routeComponentOp`.
- [ ] Nodes of a main component: `applyInComponent` applies any op on a temporary document; if the op cannot touch the main component's root (like delete/move), add the rejection to the `switch` at the start of `applyInComponent`.
- [ ] Tests in `components/ops.test.ts` (routing): virtual id, main component id, undo/redo.

**New field on `Node` that must be overridable per instance/variant**:

- [ ] `NodeOverride` (`types.ts`).
- [ ] `RawOverrideSchema` (`ops.schema.ts`): the shape accepted in `setInstanceOverrides`.
- [ ] `NodeOverrideSchema` and `OVERRIDE_KEYS` (`schema.ts`): file reading (with the same sanitizing of the field as in `NodeSchema`) and stable order in serialization. The field itself also goes in `NodeSchema` and `orderNode`.
- [ ] `applyOverride`, `mergeOverride` and `substOverride` (`components/expand.ts`); if the field accepts `{{prop}}`, also `substNode`. If it is an object or list, copy it in `copyNode` (expansion must not mutate the main component).
- [ ] `normalizeOverride` (`components/ops.ts`): strict validation (throws on an unsafe value) used by `setInstanceOverrides` and by the router.
- [ ] If the MCP should expose it: the `nodeOverrideSchema` of `set_instance_override` (`packages/server/src/mcp/tools/components.ts`).

**New `NodeType`**:

- [ ] `NodeType` (`types.ts`) and the `type` `z.enum` in `NodeSchema` (`schema.ts`).
- [ ] `ID_PREFIX` (`ids.ts`): the id prefix (also used by `derivedNodeId` in kit import and in detach).
- [ ] `assertRootShape` (`components/ops.ts`): if the type cannot be the root of a main component (like `frame` and `instance`), reject it there and in the `refine` of `componentDefSchema` (`schema.ts`).
- [ ] If the type has its own field (like `src` on `image`, `svg` on `svg`), the "only applies to this type" rule in `applyOverride` and in the `case` of `virtualToOverrides`.

## Icons

Two bundled offline kits: **Lucide** (`lucide-static`) and **Heroicons** (`@iconify-json/heroicons`, MIT). `search_icons(query, kit?)` searches both (or just one) and returns `kit/name`; `insert_icon(name)` accepts `lucide/arrow-right`, `heroicons/arrow-right` or the name without a kit (Lucide first).

## MCP

| Tool                          | Description                                                                                                         |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `list_components`             | The document's library (id, name, kit, props, number of instances) and available kits.                              |
| `get_component`               | Props, variants, the main component's tree with ids (to edit via `update_styles` etc.) and HTML.                    |
| `create_component`            | Turns a node into a component (the node becomes the first instance).                                                |
| `update_component`            | Name, description, props and variants.                                                                              |
| `update_component_html`       | Replaces the main component's tree with HTML (Tailwind accepted; `{{prop}}` and `data-slot`).                       |
| `delete_component`            | Removes the main component (rejects with instances, unless `detach_instances`).                                     |
| `insert_component`            | Inserts an instance (`componentId`, name or `kit/Name`; imports what is missing from the kit) with props and slots. |
| `set_instance_props`          | Sets/removes instance props.                                                                                        |
| `set_instance_override`       | Overrides an instance node by path (style, text, attributes, hidden).                                               |
| `reset_instance`              | Removes the overrides.                                                                                              |
| `detach_instance`             | Detaches: the instance becomes plain nodes.                                                                         |
| `push_overrides_to_main`      | Writes the instance's overrides to the main component.                                                              |
| `go_to_main`                  | Selects/frames the main component in the editor and returns its tree.                                               |
| `import_kit`                  | Imports a kit by name (`shadcn-like`) or path to a `.mockup.json`; `overwrite` overwrites edited ones.              |
| `search_icons`, `insert_icon` | Extended with several kits.                                                                                         |

Final parameters (full table in [MCP.md](MCP.md#components)): `insert_component(component, parentId?, props?, slots?, index?, name?, styles?)`, `get_component(component)`, `create_component(nodeId, name?, description?, props?)` (props with `bind: { nodeId, target }`), `update_component(componentId, name?, description?, props?, variants?)` (lists replace), `set_instance_override(nodeId, path, style?, unset_style?, text?, attrs?, hidden?)`, `import_kit(name, overwrite?)`. Virtual ids (`in_x/path`) and main component nodes work in the read tools (`get_html`, `get_styles`, `get_tree_summary`, `get_screenshot`, `get_code`...), and `get_screenshot('cp_...')` renders the main component in a default instance.

Kits: the `kits/` folder is found via `MOCKUP_KITS_DIR`, via `resources/kits` (packaged app) or by walking up from the code folder to the repository root (development and daemon bundle). HTTP: `GET /api/kits` (`{ kits: [{ name, components: [{ id, name, description, props }] }] }`) and `GET /api/kits/:name` (the kit's document). By path (`import_kit('/abs/my.mockup.json')`), the `.mockup.json` extension is required; a file with malformed JSON gives "Invalid JSON" (without passing on the parser's message, which may include snippets of the file) and an invalid document lists the schema errors.

Guide: `get_guide('components')`.

## Editor

Details in [EDITOR.md](EDITOR.md#components).

- The editor works on the **expanded view** (`expandDocument` of the daemon's document): canvas, layers, selection and properties see instances as concrete trees; the planners receive the real document.
- **Components** tab in the left panel: the document's library (click edits the main component; drag or + inserts) and the daemon's kits (`GET /api/kits`; click or drag inserts, importing the kit in the same call).
- **Create component** from the selection: Ctrl+Alt+K (also in the context menu, with "Go to main" and "Detach instance").
- Instances with a purple indicator (outline, handles and icon in layers); inner nodes in light purple; slot container with its own icon.
- Inner nodes: style, text, attributes and hide become overrides; move, duplicate, group and delete are blocked with a warning.
- Instance properties panel: controls per prop type, slots, "Go to main", "Detach", "Reset" (overrides) and "Push to main".
- **Main component editing** in isolated mode (synthetic page `COMPONENT_EDIT_PAGE_ID`, root in a non-editable frame with the width of the source instance): edits use the real ids and propagate to the instances; the Component section edits name, description and props. The MCP's `go_to_main` enters the mode. Esc (no selection) or "Done" returns and selects the source instance.
- Editable slots on the canvas: slot content is a real node (select, edit text, insert, drag).

## Export

Details per format in `EXPORT.md` (Components section).

- HTML, Tailwind and SVG: expanded instances (the result is the same as the canvas); virtual ids (`in_x/...`) are also exportable.
- React: one component per main component used (`export function Button({ variant = 'default', label = 'Button', ... }: ButtonProps)`), with typed props (`enum` becomes a union of literals, `slot` becomes `ReactNode`; the first slot also accepts `children`; every component accepts `className` and `style`, merged onto the root), variants as conditional styles or classes (a chain of ternaries per property) and instances as `<Button variant="outline" label="Save" />`. Instances with overrides on inner nodes (or `attrs`/`classes`/`states`, custom slot, prop outside the type) come out expanded in place, with the comment `{/* instance of Button with overrides */}`. The instance's `style` (position, margin) goes inline on the component tag.
