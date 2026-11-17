# Mockup Studio plan

AI-oriented canvas design editor with an MCP server that covers everything the UI does. Personal use, local, offline-first, no account. Top priority: when the user asks an agent for a mockup, the agent uses the app via MCP to create, view (screenshot) and edit the design.

## MVP (branch `feature/mvp`)

### Task 1 — Foundation (done)

- Monorepo (npm workspaces, ESM, TypeScript, Vitest).
- `core`: model, ops with inverse, `History`, HTML <-> nodes, tree summary, zod schema.
- Daemon: open documents, HTTP, WebSocket, MCP (Streamable HTTP), autosave.
- CLI: `mockup mcp | serve | open | new`.
- Basic MCP: read and write documents, nodes, styles, tokens, selection, undo/redo.
- Editor scaffold as a read-only viewer.
- Initial documentation.

### Task 2 — Full visual editor (done)

- **Infinite canvas**
  - Zoom: Ctrl+wheel, pinch, `+`, `-`, `Shift+0`, `Shift+1`, `Shift+2`.
  - Pan: space, middle button, wheel.
- **Selection**
  - Click, Shift, marquee.
  - Double-click enters the node; Esc goes up one level.
  - Handles, hover and distance ruler with Alt.
- **Move**
  - Frames on the canvas.
  - Reorder in a flex container, with an indicator.
  - `x`/`y` on absolute children.
  - Arrows: 1 px; with Shift: 10 px.
- **Resize**
  - Handles; Alt resizes from the center; Shift keeps the aspect ratio.
  - Modes auto, 100% and fill.
- **Tools**: Frame (F), Container (R), Text (T), Image (upload to `assets/`).
- **Text**: inline editing.
- **Layers panel**
  - Tree, drag to change the parent, rename, hide, lock.
  - Context menu: duplicate, delete, group, ungroup, order.
- **Properties panel**
  - Position and size, flex layout, typography, appearance, effects, tag/attributes, name.
  - Inputs with drag and units; advanced CSS.
- **Pages**.
- **Undo/redo** via the daemon.
- Internal **clipboard** and pasting external HTML.
- **Selection synced** with the MCP; "agent working" badge.
- **File**: open, new, save, recent, unsaved indicator.
- **Performance** with 300 nodes. Pending items inherited from task 1: `applyOp` deep-copies the document via JSON on every op, and `doc:changed` sends the whole document over the WebSocket on every change. Measure with 300 nodes and, if needed, switch to structural cloning (`structuredClone`/path copy) and to op deltas over the WS.
- **Quality**: Vitest tests, 5 e2e tests with Playwright, `docs/EDITOR.md`, screenshot in the README.

Result: everything above delivered (see [EDITOR.md](EDITOR.md)). Measurement with 300 nodes: `applyOp` < 1 ms, full `doc:changed` < 1 ms to serialize and integrate, MCP → canvas latency ~31 ms, dragging at 60 fps; JSON cloning and the full document over the WS were kept. Decisions: zustand for the stores; `setTag` op (with the `set_tag` MCP tool); `history` (`canUndo`/`canRedo`) in the events; `doc:new`/`doc:close` over the WS; `POST /api/assets/:docId` and `GET /api/recent`.

Items inherited from task 2 that remain open (native dialogs, "Save as" and `src` swapping were handled in task 3):

- Op for the page background (`page.background`): the background still has no op and no control in the panel.
- Canvas: marquee with Ctrl to select children of a frame; drag on the canvas to change the parent (today only via layers); mixed selection (free + in-flow) moves only the free ones; `grid` parent treated as a vertical block when reordering.
- Text created outside a frame shows a warning instead of creating a frame.

### Task 3 — Electron, screenshot and export (done)

- **`packages/desktop`**
  - electron-vite and electron-builder; in-process daemon; native menu; dialogs; `.mockup.json` association; custom icon.
  - `--headless` mode; `mockup mcp` starts headless Electron with a fallback to the Node daemon.
  - `npm run dist`: NSIS and portable.
- **`RenderService`**
  - Offscreen `BrowserWindow`, render page, fonts and assets, `deviceScaleFactor` 1 to 3, `capturePage`, cache by hash.
  - JPG via `nativeImage`; SVG via the core exporter and `measure(nodeId)`.
  - Routes `GET /render/:docId/:nodeId.png|svg`.
- **Exporters** in `packages/core/src/export`, with snapshots:
  - html: classes by slug, tokens in `:root`.
  - tailwind: v4, idiomatic classes, arbitrary values `[...]`.
  - react: TSX, Tailwind or inline `className`, PascalCase, extraction of repetitions into `map`.
- **New MCP**
  - `get_screenshot(nodeId?, scale?, format?, maxWidth?)`, `get_layout(nodeId, depth?)`.
  - `export(nodeIds[], format, scale?, outputDir?)`, `get_code(nodeId, format, styles?)`.
  - `insert_image`, `insert_icon` (Lucide via `lucide-static` and Heroicons via `@iconify-json/heroicons`, MIT), `search_icons`.
  - `list_fonts`, `get_font_info`, `add_font` (offline-first).
  - `finish_working`.
  - Guides `screenshot-loop` and `export`.
- `docs/EXPORT.md`.

Result: everything above delivered (see [ARCHITECTURE.md](ARCHITECTURE.md), [EXPORT.md](EXPORT.md), [MCP.md](MCP.md) and the [desktop README](../packages/desktop/README.md)).

- Electron 45 app with the in-process daemon, the `RenderService` (hidden window at `/render.html`, capture via CDP `Page.captureScreenshot`, scale 1 to 3, JPG and `maxWidth` via `nativeImage`, LRU cache by hash, serial queue and window recovery), native menu, open/save dialogs, "Save as" (`doc:saveAs`, Ctrl+Shift+S) and `--headless` mode. `mockup mcp` starts headless Electron and falls back to the Node daemon (no screenshot); `mockup serve --render` runs Electron in the foreground.
- `npm run dist` produces the NSIS installer (per user) and the portable build in `dist/`; `.mockup.json` association via ProgID in `OpenWithProgids` (Windows only sees the last extension).
- Exporters html, tailwind (v4), react (Tailwind or inline) and svg (with measured layout or `<foreignObject>`), with snapshots. A single document base CSS (`base.ts`): the same on the canvas, in the render and in the exported code; the UI CSS does not leak into the design.
- MCP: `get_screenshot`, `get_layout`, `export`, `get_code`, `insert_image`, `insert_icon`, `search_icons`, `list_fonts`, `get_font_info`, `add_font`, `finish_working`, and the guides `screenshot-loop` and `export`. New ops `setFonts` and `setSrc`; `agent:finished` event; routes `GET /render/:docId/:nodeId.(png|jpg|svg)`; static editor at `/`; `render` in `/api/health`.
- Items inherited from task 1 resolved: the WebSocket no longer accepts `Origin` `file://` (the app serves the editor from the daemon itself); `style` values that escape the declaration are rejected on edit and discarded on read and export; tokens get the `--` prefix automatically. Only the MCP `allowedHosts` remains open, which does not include the bind host (only matters if the daemon stops listening on 127.0.0.1).

Items inherited for task 4:

- The app's native menu and dialogs are not exercised in automated UI tests.
- The render cache does not invalidate if a file in `assets/` is replaced keeping the same name.
- The NSIS installer is generated, but installation and file association were not tested on a clean machine; no code signing.
- `add_font` with `google` only downloads the normal style and the latin subset, and was not tested against the internet.
- The exported Tailwind was only validated in a Vite project with `@tailwindcss/vite`; other bundlers were not tested.
- SVG with layout ignores `transform`, multiple shadows and non-linear gradients.
- `insert_image` uses the intrinsic size, without limiting it to the parent's.
- The headless daemon (Electron) started by `mockup mcp` keeps running until it is stopped (like the Node daemon).

### Task 4 — Agent integration and end-to-end QA

- **CLI installation**: `npm link`, `mockup.cmd` in `%LOCALAPPDATA%\MockupStudio\bin` via the installer, `mockup doctor`.
- **`docs/INTEGRATION.md`**
  - Claude Code: `claude mcp add --scope user mockup-studio -- mockup mcp` and HTTP variant.
  - Codex: `codex mcp add mockup-studio -- mockup mcp` and `config.toml`.
  - `mcpServers` JSON for Cursor, VS Code and Claude Desktop.
  - `mockup setup claude|codex|all`.
- **Guides in the MCP**: `getting-started` (6 steps), `design-system`, `responsive`, `screenshot-loop`, `export`, `troubleshooting`, `setup`.
- Review of the descriptions of all tools.
- `integrations/claude-code/SKILL.md` and `integrations/codex/AGENTS.snippet.md`.
- **E2E QA** with a real 3-screen mockup (completed 2026-11-16).
- Final README with MIT license.

Result (integration; the e2e QA was done afterwards):

- CLI: `npm link -w @mockup/cli` exposes `mockup`; `mockup doctor [--json]` (Node, data folder, daemon, mode and render, port, Electron, fonts, `mockup`/`claude`/`codex` on the PATH and registration) with the registration commands filled in; `mockup setup claude|codex|all [--http] [--skill] [--print] [--command path|shim|absolute]`, idempotent; `mockup install-cli`/`uninstall-cli` (`mockup.cmd` shim and user PATH via the registry, preserving `%VAR%`); `mockup --version`.
- Packaged app: CLI and Node daemon in `resources/cli` (esbuild bundle, run with `ELECTRON_RUN_AS_NODE=1`), `integrations/` in `resources/integrations`; NSIS runs `install-cli` on install and `uninstall-cli` on uninstall (not on update); `--install-cli`/`--uninstall-cli` on the exe itself.
- MCP: server `instructions`; guides `getting-started` (6 steps), `design-system` (absorbs `tokens`), `layout`, `responsive` (Mobile/Tablet/Desktop), `screenshot-loop`, `export`, `troubleshooting` and `setup`, also as `guide://<topic>`; descriptions of all tools reviewed, with examples; per-field parameter errors, with a call example, and a suggestion for a nonexistent tool.
- `docs/INTEGRATION.md`, `integrations/claude-code/SKILL.md`, `integrations/codex/AGENTS.snippet.md`, final README and `LICENSE` (MIT).
- Verified on Windows: Claude Code 2.1.319 and Codex 0.163.0 start `mockup mcp` through the npm `.cmd` shim (without `cmd /c`); `claude mcp list` shows `mockup-studio` connected and Codex calls the tools.

Pending:

- ~~E2E QA with a real 3-screen mockup~~: completed 2026-11-16.
- The NSIS installer was not run on a machine (only built); PATH hooks tested via `--install-cli`/`--uninstall-cli` of `win-unpacked` with a temporary folder.
- If `uninstall-cli` fails during uninstall, the NSIS fallback deletes the shim but the PATH entry stays (harmless).

## Next phases

After the MVP, one branch per phase. Status on 2026-11-17: **phases 1 to 9 are integrated** in the `chore/integracao-fases` branch (merge of `feature/design-system`, with phases 2, 3, 4 and 9, and of `feature/revisao-fases-paralelas`, with phases 5 to 8; see "Phase integration" at the end).

### Phase 2 — Tokens and themes in real CSS (`feature/design-system`, done)

- Tokens with groups (colors, typography, spacing, radius, shadow).
- Themes: `themes: { name, overrides }`; frame with `theme`.
- Resolution of `var()`, `calc()` and `color-mix()` in `getComputedLike` and in the exporters (HTML with `:root` and `[data-theme]`, Tailwind `@theme`, React with CSS vars).
- Validation with `css-tree` or `lightningcss`.
- Tokens panel in the editor, with a token picker in the inputs.
- MCP: expanded `get_tokens`, `rename_token`, `apply_token`, `create_theme`, `set_frame_theme`, `import_tokens` (CSS `:root` and W3C Design Tokens JSON), `export_tokens(css|json|tailwind)`.
- `docs/TOKENS.md`.

Result (branch `feature/design-system`; see [TOKENS.md](TOKENS.md)):

- Core: optional `tokenMeta` (group, description) and `themes` on the document (old files stay the same); frame theme in the `data-theme` attribute; ops `setTokens` with `theme`, `setTokenMeta`, `setThemes`, `replaceTokens` and `renameToken` (updates all references, exact undo). Resolution with CSS semantics (aliases redeclared inside the theme, cycles without value), `calc()`/`min()`/`max()`/`clamp()` and `color-mix()` evaluated in `getComputedLike`; validation with css-tree (bundle `dist/csstree.esm`); CSS, W3C Design Tokens and Tailwind v4 import/export.
- Exporters: HTML with `:root` and `[data-theme]`, Tailwind with theme rules and `@custom-variant theme-<name>`, inline React with the theme variables; render cache also keyed by the themes.
- Editor: Tokens tab (search, groups, inline editing, themes, import/export, warnings), "bind to token" in the inputs, theme per frame, `background-blend-mode`.
- MCP: expanded `get_tokens`/`set_tokens`, `rename_token`, `apply_token`, `create_theme`, `rename_theme`, `delete_theme`, `set_frame_theme`, `import_tokens`, `export_tokens`, `theme` in `get_styles` and the `tokens` guide.

Pending: token picker in gradients, `transform`, `filter` and `flex`; reordering tokens by drag; the canvas chunk grew (~650 kB) with css-tree and zod.

### Phase 3 — Native Tailwind (`feature/design-system`, done)

- Accept utility classes in `write_html` and when pasting (class to CSS).
- Faithful Tailwind export and round-trip.

Result (see [TAILWIND.md](TAILWIND.md)):

- Core: `@mockup/core/tailwind` engine with the official `tailwindcss` v4 compiler (pure JS, runs in the daemon, in the editor and in tests; loaded on demand in the editor), cache by `@theme` tokens; `node.classes` (round-trip hint), `node.states` (`hover`, `focus`, `active`, `disabled`, `dark`, `sm`..`2xl` and combinations), `cssBase: 'tailwind'` (preflight in the canvas, render and export); ops `setClasses`, `setStates`, `setCssBase`; canonicalized reverse path (`canonicalizeCandidates`, with a light design system without `mask-*`/`scroll-*` and a per-engine cache: first landing export 2.4 s → 1.2 s cold, ~15 ms repeated) and checked against the compiler; shadcn/ui token preset.
- Exporters: Tailwind and React with the engine (author's classes reused, variants, `@custom-variant dark`, `line-height` neutralization only where needed); HTML with per-state rules (`:hover`, `@media`, `dark` theme).
- Editor: render with states (breakpoint by frame width, `dark` by theme), state preview in the bar, "Classes" section with autocomplete, warnings, "Show as Tailwind" and states list, base CSS in the document panel, paste Tailwind HTML.
- MCP: `write_html` with Tailwind detection (`tailwind`, `css: 'tailwind'`), `import_component`, `set_classes`, `get_classes`, `suggest_classes`, `get_tailwind_config`, `set_css_base`, `state` in `get_screenshot`/`get_styles`/`update_styles`, `get_code`/`export` with the engine, `tailwind` guide.

Pending: group/attribute variants and pseudo-elements stay only in the class; the panel's style fields do not edit states (only the classes field); `animate-*` does not animate on the canvas; the screenshot `state` was not exercised in real Electron (only with a fake provider); the first export of each engine (new tokens) still costs ~1 s of Tailwind canonicalization warm-up.

### Phase 4 — Components (`feature/design-system`, done)

- Main components and instances with overrides; props and variants.
- Per-document library.
- MCP to create, instantiate and detach.

Result (see [COMPONENTS.md](COMPONENTS.md)):

- Core: `doc.components` (`ComponentDef` with props `string|number|boolean|enum|color|slot`, variants by `when` and root), `instance` node with `props` and `overrides` by path of main component ids; slots as `data-slot` containers that are real children of the instance (reuse ops, layers and selection); `expandInstance`/`expandDocument` with virtual ids `instance/path` and structural sharing; `applyOp` routes ops on virtual ids (becomes an override) and on main component nodes (becomes `updateComponent`); ops `addComponent`, `deleteComponent`, `updateComponent`, `replaceNode`, `setInstanceProps`, `setInstanceOverrides`; planners `createComponentOps` (with `bind`), `instanceNodeFor`, `detachInstanceOps`, `pushOverridesToMainOps`, `resetInstanceOps`, `importKitOps`. Old documents without `components` stay the same.
- Exporters: HTML, Tailwind and SVG expand the instances; React generates a typed component per main component (enum as a union of literals, slots as `ReactNode`/`children`, conditional variants).
- Kit `kits/shadcn-like.mockup.json` (Button, Input, Card, Navbar, Tabs, Dialog, Table, List, shadcn tokens and `dark` theme), served at `/api/kits` and packaged in `resources/kits`. Icons: Heroicons (`@iconify-json/heroicons`, MIT) alongside Lucide, with unified search per kit.
- MCP: `list_components`, `get_component`, `create_component`, `update_component`, `update_component_html`, `delete_component`, `insert_component` (imports the kit if needed), `set_instance_props`, `set_instance_override`, `reset_instance`, `detach_instance`, `push_overrides_to_main`, `go_to_main`, `import_kit`; reading and screenshot by virtual and main component ids; `components` guide.
- Editor: Components tab (library and kit, drag/click), Ctrl+Alt+K, isolated editing of the main component, purple indicator, props panel, editable slots, go to main, detach, reset and push to main.

Pending: overrides do not remove attributes/states from the main component (no `unsetAttrs`/`unsetStates`); `update_component_html` generates new ids (old overrides stop taking effect); renaming a prop in the panel does not rewrite the `{{placeholders}}`; inserting a kit component imports the whole kit; React does not export variants that change attributes, visibility or props of nested instances, nor extract `.map` inside the components; "Reset"/"Push to main" do not apply to nested instances.

### Phase 5 — Snapshots and versions (`feature/snapshot-web`, done as site snapshot)

- Named versions, visual diff, restore.

Delivered as **site snapshot** (see [SNAPSHOT.md](SNAPSHOT.md)): sections of real sites become editable nodes (real HTML/CSS) via the `@mockup/snapshot-core` package (in-browser capture with curated `getComputedStyle`, pseudo-elements as nodes, images and fonts downloaded to `assets/`), via the MV3 extension (`packages/extension`, Chrome and Edge), via paste in the editor and via the desktop app (isolated headless capture, with `netguard` against private networks). MCP: `import_url`, `import_html`, `cleanup_imported`; `import` guide.

Pending: named versions, visual diff and restore remain open; pages behind login only via the extension; captured `canvas`/`video`/`iframe` become placeholders; values are resolved at the capture viewport; animations and states are not included.

### Phase 6 — Assets

- Manager for images, fonts and icons.
- Optimization and batch import.
- Editable inline SVG.

Delivered in the `feature/assets-dados` branch (assets with direct link, image, real data and organization; see [ASSETS.md](ASSETS.md) and [DATA.md](DATA.md)):

- **Assets**: content-addressed local CDN (`/cdn/<hash>.<ext>`, stable across documents and restarts), global library, listing with usages, remove unused, optimization with sharp (optional), Assets tab in the editor. MCP: `list_assets`, `upload_asset`, `get_asset_url`, `optimize_assets`, `remove_unused_assets`.
- **Images**: Image section (fit, position, filters, `clip-path` mask), visual crop with handles (`object-view-box`) and deterministic SVG placeholders. MCP: `set_image`, `generate_placeholder`.
- **Real data**: `repeater` node with `data` and `{{field}}` bindings, `setData` op, expansion in the canvas, render, screenshot and export; JSON/CSV/URL with stored source and manual refresh; Data section with an editable table. MCP: `bind_data`, `refresh_data`, `get_data`.
- **Organization**: `files.json` with virtual folders, tags and favorites, home screen with thumbnails and search by name/tag/content, node search. MCP: `list_files`, `search_nodes`, `tag_file`, `manage_folders`, `move_files`.
- Guides `assets` and `data`.

Pending: in the packaged app sharp ships in `resources/native` only for the platform where the package was built (Windows x64); `object-view-box` crop only shows in Chromium (the exported code shows the whole image in Firefox/Safari); thumbnails of closed documents without the embedded fonts; styles do not accept bindings; batch import and editable inline SVG remain open; data validation serializes the whole list (`JSON.stringify` in `DataSchema`) on every `setData`; `fetchBytes` (images and data by URL) does not filter private network addresses.

### Phase 7 — Vectors and grid (`feature/vetores-grid`, done)

- Basic vector drawing: pen, shapes, boolean operations.
- Grids and columns, guides and snapping.

Result (see [VECTORS.md](VECTORS.md) and [GRID.md](GRID.md)):

- Core: `Node.vector` (paths, viewBox, paint and gradients; `raw` preserves the imported SVG), `setVector` op, shapes (`rect`, `ellipse`, `line`, `polygon`, `star`), boolean operations with `polygon-clipping`, flatten, SVG ids scoped per node on export; first-class CSS Grid (tracks, areas, spans) with reading and summary.
- Editor: pen, shape tool, point editing, Vector section, grid overlay with tracks, target cell and span handles.
- MCP: `create_shape`, `set_path`, `insert_svg`, `get_svg`, `set_vector_paint`, `boolean_op`, `flatten`, `text_to_outlines`, `set_grid`, `place_in_grid`, measured tracks in `get_layout`; guides `vectors` and `grid`.

### Phase 8 — Effects and embeds (`feature/efeitos-embeds`, done)

- Filters, masks, blend modes.
- Embeds (video, iframe, Lottie) and simple animations.

Result (see [EFFECTS.md](EFFECTS.md) and [EMBEDS.md](EMBEDS.md)):

- Core: `effect` nodes (seven effects: six custom GLSL shaders and particles, with parameters and presets), `video` and `embed` (Lottie, Rive, YouTube, iframe and Three.js islands), `setMedia` op, effects runtime shared between editor, render and export.
- Render with deterministic `time` (waits for each media to draw the instant); HTML/Tailwind/React export with the media nodes (React with helpers and extra files; static effects as PNG) and animated export mp4, webm and gif with bundled ffmpeg.
- MCP: `list_effects`, `add_effect`, `update_effect`, `insert_video`, `insert_embed`, `insert_three`, `update_media`, `time` in `get_screenshot`, animated formats in `export`; `effects` guide.

### Phase 9 — AI assistant in the editor (`feature/design-system`, done)

- Side chat using the same tools as the MCP.
- Layout suggestions and variations.

Result (see [ASSISTANT.md](ASSISTANT.md) and [SCRIPTS.md](SCRIPTS.md)):

- Core: undo groups in `History` (consecutive applications of the same group become one entry; `closeGroup`), WS protocol `assistant:*`, `script:*` and `remix`, pure remix planners (`planRemix`, `colorScale` in OKLCH).
- Assistant: `claude` (`claude -p` with stream-json) and `codex` (`codex exec --json`) backends via subprocess, detected on the PATH (`.exe`/`.cmd`), with the daemon's own MCP at `/mcp?turn=<token>`; selection context (ids, tree summary, screenshot); streaming via `assistant:event`; one undo group per turn (undo/redo rejected during the turn; the session of a finished turn does not write); cancellation and timeout killing the process tree; history in `<base>.assistant.json` next to the document and `--resume` of the conversation; `AgentBackend` interface for a direct API.
- Scripts: sandbox in a worker (`eval`, `resourceLimits`, timeout via `terminate`) with `node:vm` without code generation and a JSON-only bridge; API `doc.select/get/selection/apply/screenshot/create/tokens` and handles with `style`/`attrs` in a Proxy; one run = one undo; `scripts/*.js` library; generate with AI; MCP `run_script` and `list_scripts`.
- Remix: `color-scale` (10 shades), `font-pairs`, `spacing` (4/8 scale), `layout` (3 flex rearrangements) and `ai`, via the context menu and the MCP `remix`; frames side by side in a single undo.
- Editor: Design/Assistant/Scripts tabs in the right panel, chat with streaming and tool chips, scripts panel with CodeMirror 6 (chunk on demand), Remix in the context menu.
- Guides `assistant` and `scripts`.
- Fixed in the desktop app: the `ws` bundle replaced the optional `bufferutil` with an empty object and the daemon hung on the first frame of 32 bytes or more from a WS client (bug predating the phase; regression test in `headless.integration.test`).
- Verified with the real CLIs on this machine (Claude Code 2.1.319 and Codex 0.163.0): "make the primary button stand out more" changes the selected button and a single undo reverts the turn.

Pending: a user edit in the middle of a turn breaks the group merge (the turn becomes more than one undo step); Codex does not allow turning off the built-in shell (runs in a `read-only` sandbox); scripts reject the word `import` anywhere in the text (defense against `import()` in the vm); no `save_script` in the MCP; the CodeMirror chunk is ~507 kB.

## Phase integration (`chore/integracao-fases`, 2026-11-17)

Merge of `feature/revisao-fases-paralelas` (phases 5 to 8, already joined from main) onto `feature/design-system` (phases 2, 3, 4 and 9), keeping the features from both sides. Decisions and adjustments:

- Components × phases 6 to 8: `setVector`, `setMedia` and `setData` target instance and main component nodes (`targetIds`) and, on a virtual id, become an override; `NodeOverride` gained `vector`, `effect`, `video`, `embed`, `data` and `dataSource` (file schema, strict validation and expansion). The tools and routes that read the node to build ops (`bind_data`, `refresh_data`, `get_data`, `generate_placeholder`, `boolean_op`, `flatten`, `text_to_outlines`) read through the expanded view (`docWithNodes`). See [COMPONENTS.md](COMPONENTS.md#overrides-nodeoverride).
- `write_html` with Tailwind (phase 3) and the repeater round-trip via `data-mockup-repeat` (phase 6) work together; `get_html` of instances marks the expanded repeaters.
- Exporters: a single React preamble (media helpers, slots' `ReactNode` and `safeUrl`), with the components rendered before the preamble to register the media inside them; `export` uses the expanded tree for render, video and static effects (including inside instances) and for the asset copy.
- Editor: single left panel with the Layers, Assets, Components and Tokens tabs (only the active one shows its name); files home screen in place of the canvas; screenshot with `state` (state preview) and `time` (animations).
- Fixed in the merge: unclosed CSS rules inherited from the parallel branch (`.data-error` in `properties.css`, which nested the vector CSS and broke the editor layout in Electron, and `.cv-crop-bar` in `canvas.css`, which hid the grid overlay); duplicated `ExpandOptions` in the core (the repeater's became `RepeaterExpandOptions`).
