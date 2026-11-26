# Editor

Mockup Studio's visual editor (`packages/editor`, Vite + React 19 + zustand). It runs in the browser (and, in task 3, inside Electron) and talks to the daemon over WebSocket. **Every document mutation becomes a core `Op` sent to the daemon (`op:apply`)**; the editor never changes the document locally. This way the editor and the MCP always see the same document, and the daemon's undo/redo applies to both.

![Editor with the landing example](img/editor.png)

## How to use

```bash
npm install
npm run build
npm run dev          # daemon on 127.0.0.1:4747 + editor on http://localhost:5173
```

Open a document with the **File › Open…** menu (path to the `.mockup.json`), with `mockup open <file>`, or through the MCP (`open_document`). **File › New…** creates a document (the daemon appends `.mockup.json` and never overwrites an existing file).

Typical flow: create a frame (F and drag), draw containers (R) and texts (T) inside it, adjust in the properties panel, move and resize on the canvas, undo/redo, save (Ctrl+S; the daemon's autosave also writes 800 ms after the last edit).

## Layout

- **Top bar**: File menu (New, Open, Recent, Save, Save as, Close), tools, undo/redo, document name with an unsaved indicator (dot) and a selector when several are open, zoom and connection status. The window title shows the file name (with `●` when there are unsaved changes).
- **Left panel**: four tabs, **Layers** (pages — create, rename with a double click, delete from the context menu, switch —, node search and the layer tree of the active page), **Components** (see [Components](#components)), **Tokens** (see [Tokens and themes](#tokens-and-themes)) and **Assets** (see [Assets, images, data and files](#assets-images-data-and-files)).
- **Canvas**: infinite, with frames rendered as real HTML/CSS.
- **Right panel**: three tabs, **Design** (properties of the selection or, with no selection, the document name and a summary of tokens and themes), **Assistant** (see [AI assistant](#ai-assistant)) and **Scripts** (see [Scripts](#scripts)). The Design tab keeps its usual width; Assistant and Scripts widen the panel (380 px) to fit conversation and code.

## Canvas

- **Zoom**: Ctrl+wheel or pinch (at the pointer), `+`/`-`, `Shift+0` (100%), `Shift+1` (fit all), `Shift+2` (zoom to selection) and the bar's zoom menu.
- **Pan**: wheel (Shift+wheel horizontally), space+drag, middle button or the Hand tool (H).
- **Selection** (rules in the style of design tools): click selects the direct child of the frame (or a sibling of the current selection); double click goes down one level; Ctrl+click selects the exact element; Shift+click toggles; Esc goes up one level; dragging on empty space makes a frame marquee (Shift adds). Clicking or dragging the **frame name** selects/moves the frame. Locked nodes are not selectable on the canvas.
- **Hover** with an outline, by the same rule as click (Ctrl/Cmd shows the exact element); **Alt** shows the distance ruler between the selection and the node under the pointer.
- **Move**: root frames change `position`; `position: absolute` children change `left`/`top`; in-flow children of a flex/block parent are **reordered** with an insertion indicator (`moveNodes` with an index). Shift constrains to the axis; Esc cancels the drag.
- **Resize** with the 8 handles (`width`/`height` in px); Alt resizes from the center; Shift keeps the proportion. The `W × H` label appears under the selection.
- **Create**: Frame (F) and Container (R) by drawing with a drag (a simple click creates at the default size); Text (T) with a click, already in editing; Image (bar button, click on the canvas, `Ctrl+Shift+K`, paste or drop a file) uploads the file to the document's `assets/` (`POST /api/assets/:docId`) and creates an `img` node with a relative `src`. Inside a flex parent the node enters the flow; in a block parent it becomes `absolute` (the parent gets `position: relative` if it is static).
- **Inline text**: double click on a selected text edits it; Enter confirms, Shift+Enter breaks the line, Esc cancels.
- **Context menu** (right button, also on layers): create component, go to main, detach instance, duplicate, group into container, ungroup, order (front, forward, backward, back), hide, lock, **Remix** (see [Remix](#remix)) and delete.
- **Live MCP**: changes made by agents appear without reloading; a selection made through the MCP (`set_selection`) selects and frames the nodes; frames touched by the MCP in the last 4 s show a pulsing **AI** badge next to the name. The editor's selection is published to the daemon (`get_selection`).

## Layers and pages

- Tree with an icon per type/tag, name and tag; expand/collapse; hide (eye) and lock (padlock).
- Click selects, Ctrl+click toggles, Shift+click selects the range. Double click renames.
- Dragging rows reorders or changes the parent (before/after/inside), including to the page root, at the current position: text, image and SVG get a frame around them (with 24 px of inset, as in paste) and lose absolute positioning; containers (`element`) become root nodes with the measured position and size, but keep `type: element` (the core's `moveNodes` does not change the type). All in a single undo entry.
- The selection is synchronized with the canvas and the MCP (ancestors expanded and scrolled to the row).

## Properties

Collapsible sections, with multi-selection ("Mixed" when values differ):

- **Name**, type/tag and **Theme** (the element's `data-theme`; see below).
- **Position and size**: X/Y (frames and absolute nodes), W/H with Fixed, Auto, 100% or Fill mode (`flex: 1` on the main axis of the flex parent), rotation (`transform: rotate()`), `position`.
- **Layout**: display, direction, gap, wrap, alignment, distribution, padding (linked or per side), margin, overflow.
- **Typography**: family, weight, size, line height, spacing, alignment, color, decoration, transform and the text content.
- **Appearance**: opacity, background (color, gradient or image), border, radius (single or per corner), multiple shadows, `mix-blend-mode` and `background-blend-mode`.
- **Effects**: `filter` and `backdrop-filter` blur (preserving other functions).
- **Classes** (Tailwind): see [Tailwind](#tailwind).
- **Tag and attributes**: tag (`setTag` op), id, href, alt, placeholder, type and free attributes.
- **Advanced CSS**: the node's raw properties (`prop: value;` per line), applied on blur or with Ctrl+Enter by diff (set/unset).

Numeric inputs accept units (`px`, `%`, `rem`, `auto`, `calc()`...), ↑/↓ arrows (Shift = ×10) and **dragging the label** horizontally (live preview, a single undo entry on release).

## AI assistant

The **Assistant** tab of the right panel: one conversation per document with an agent (Claude Code or Codex, installed and logged in on the machine) that edits the design through the same MCP tools.

- **Messages**: the user's on the right; the assistant's with the text (line breaks preserved), the **tools called** as chips (running, ok or error; the summary text is in the `title`) and, when the turn changed the document, the footer "N changes — Ctrl+Z undoes the turn". Errors and cancellations appear in the message itself.
- **Streaming**: the text and tools of the turn in progress arrive through `assistant:event` and appear immediately; the **Cancel** button (`assistant:cancel`) replaces the send button during the turn.
- **Input**: Enter sends, Shift+Enter breaks the line. The indicator below the field shows the context sent ("2 nodes selected" or "no selection — the whole document").
- **Backend**: Automatic / Claude Code / Codex selector (with "unavailable" when the CLI was not found), saved through `assistant:config`. With no backend, the panel asks you to install and log in to Claude Code or Codex.
- **History**: loaded by `assistant:history` when opening the panel, switching documents or reconnecting; the trash button clears it (`assistant:clear`). State lives in `state/assistantStore.ts` (per document: messages, partial turn, backends, configuration).
- **Undo**: each turn becomes **one** entry in the daemon's history; a single Ctrl+Z undoes everything the agent did in the turn.
- The empty state offers suggestions (a click fills the field).

## Scripts

The **Scripts** tab: a **CodeMirror 6** editor (JavaScript, dark theme, autocomplete for `doc.` and node members) to automate the document. CodeMirror is loaded on demand (`import()`), outside the main chunk; while it loads (or if it fails) a `textarea` stands in as the editor.

- **Run**: button or Ctrl+Enter (`script:run`, with the current selection). The script runs in the daemon; `console.log` goes to the output, the `return` becomes the result (JSON) and an error appears in red. Images from `doc.screenshot()` appear as `<img>`, and the footer shows "N ops • X ms". Each run is **one** undo entry.
- **API**: `doc.select(query)`, `doc.selectOne(query)`, `doc.get(id)`, `doc.selection()`, `doc.frames()`, `doc.pages()`, `doc.create(parent, spec)`, `doc.apply(op)`, `doc.screenshot(node?)`, `doc.tokens()`/`doc.setTokens(...)`. The _handles_ have `id`, `type`, `tag`, `name`, `text`, `style` (proxy), `attrs`, `children`, `parent`, `frame`, `setStyle(obj)`, `remove()`, `duplicate()` and `select(query)`. E.g.: `doc.select('text').forEach((n, i) => n.name = 'Item ' + (i + 1))`.
- **Library**: saved scripts live in `scripts/*.js` next to the document (`script:list/read/save/delete`); open, save, save as (asks for the name) and delete (with confirmation). Document without a path: the panel warns that it must be saved first.
- **Generate with AI**: describe what you want and the generated code (`script:generate`) goes into the editor for review before running.
- Ready-made **examples** (rename texts in sequence, change the buttons' color...) and the per-document draft (survives switching tabs).

## Remix

Context menu items (canvas and layers), enabled with **exactly one** node selected (not in expanded instances): **Remix: color scale**, **font pairs**, **spacing**, **layout** and **Remix with AI…** (asks for the request and the number of variations, default 3). The daemon creates the variations as side-by-side frames and selects them; the editor frames them and notifies by toast. An entire remix is **one** undo entry (a single Ctrl+Z removes all the frames). In the AI remix the panel opens the Assistant tab to follow the turn. Daemon errors appear as a toast.

## Components

Model, expansion and ops in [COMPONENTS.md](COMPONENTS.md). In the editor:

- **Expanded view**: the `docStore` keeps the daemon's document in `rawDoc` and exposes the **view** in `doc` (`expandDocument`, memoized, with structural sharing between versions). Canvas, index, layers, selection, overlay and properties work on the view with no special code; the core planners (`createComponentOps`, `instanceNodeFor`, `detachInstanceOps`, `importKitOps`...) receive the `rawDoc`. An instance appears with its own id (type of the main component's root, `componentId`/`props` as a marker), the inner nodes with virtual ids `in_x/path` and the slot content with the real ids.
- **Selection**: clicking an instance selects the instance; double click goes down to the inner nodes (like any child), Ctrl+click goes straight there. Inner nodes do **not** move, reorder, duplicate, group or get deleted (warning on screen; in layers they are not draggable or renameable), but style, text (double click), attributes, classes and hide become instance **overrides** (the daemon routes the ops). Inserting (tools, paste, drop) never goes into an inner node or the instance root, only into the **slot content**, which is a real node: it selects, edits text, inserts and drags like any node. The slot container itself does not move.
- **Purple indicator**: purple hover/selection outline, handles and size label on instances, inner nodes, slot containers and the main component being edited; in layers, instance with a component icon (strong purple), inner nodes in light purple and slot container with a dashed icon.
- **Create component** (Ctrl+Alt+K or context menu): the selected node (not a root frame, not an inner node) becomes the main component and is replaced by the first instance, in one undo entry; props inferred from `{{name}}` and `data-slot`.
- **Components tab**: search by name; **In this document** lists the main components (name, kit, number of instances in the pages): click edits the main component, dragging to the canvas or the + button inserts an instance (inside the selected container, right after the selection or in the first frame). The daemon's **kits** (`GET /api/kits`, e.g. **shadcn-like kit**) insert with a click or by dragging: `importKitOps` with `onlyMissing` (if the component is not yet in the document; brings only the missing components and tokens, without touching main components already imported) and the instance's `createNode` (computed on the document with the kit applied locally) go in a single call. Dropped in a block parent, the instance becomes `absolute` at the point; outside frames, it gets a frame around it.
- **Instance panel** (Instance section): source component, one control per prop (text, number, toggle, options, color with token picker) that produces `setInstanceProps` (going back to the default removes the prop), slot buttons (they select the container) and **Go to main**, **Detach** (`detachInstanceOps`), **Reset** (removes the overrides; disabled without overrides) and **Push to main** (`pushOverridesToMainOps`).
- **Main component edit mode** (Go to main, click on the tab, context menu or the MCP's `go_to_main`): the canvas shows only the synthetic page `COMPONENT_EDIT_PAGE_ID` with the main component's root (nested instances expanded) inside a dashed, non-editable frame, with the width of the source instance; the badge "Editing component X · N instances · **Done**" sits at the top. Edits use the real ids of the main component's nodes (the daemon turns them into `updateComponent`) and propagate to all instances; normal undo/redo. The panel shows the **Component** section (name, description and props: add, remove, rename, type, default and options). **Esc** with no selection (or Done) returns to the source page and selects the instance you came from; switching page also leaves the mode. The main component's texts show the placeholders (`{{label}}`).
- **Copy/paste**: copying an instance copies the instance (not the expanded tree); an inner node comes out as concrete nodes. Pasting at the page root wraps the instance in a frame.

## Tokens and themes

Everything becomes ops sent with `daemon.apply` (one undo per action, the same path as the MCP); the editor keeps no token state outside the document. The canvas and the render page inject `.cv-world [data-theme="x"] { --token: … }` (`themeRulesCss`), so a frame's theme is the `data-theme` attribute and the CSS is the same as the HTML export.

### Tokens tab

- Grouped **list** (Colors, Typography, Spacing, Radius, Shadow, Other and, at the end, free groups), with collapsible sections and **search** by name, value or description. Each row shows the preview (color swatch, spacing bar, radius, shadow, family/weight), the name, the value and the resolved value (`= #fff`) when it differs from the declared one.
- **Indicators**: a discreet _unused_ icon (no element or token references it) and a _problem_ triangle (red for a broken value/reference, amber for a warning), with the message in the `title` and below the row.
- **Edit value**: click the value, Enter confirms, Esc cancels. Validation (`validateTokenValue`) blocks errors (message under the field) and accepts warnings, showing them.
- **Rename**: double click the name (`renameToken`, updates every `var()`).
- **New token**: `+` button (name, value, group; empty group = inferred).
- **More options** (`⋯` or right button on the row): rename, edit value, group and description (`setTokenMeta`), copy `var(--x)`, remove the theme override, delete (`planDeleteTokens`; Ctrl+Z undoes).
- **Theme being edited**: the selector at the top chooses _Base_ or a theme. With a theme, editing a value writes to the theme's override (`setTokens` with `theme`); the row shows the theme's label and the button to remove the override; inherited values appear faded. Buttons to create (copies the current theme, if any), rename and delete a theme (the nodes' `data-theme` follows).
- **Import** (CSS or W3C JSON, merge or replace mode, shows the parser's warnings) and **Export** (CSS, JSON or Tailwind, with a Copy button).

### Binding tokens in inputs

Each color, size, spacing, radius, typography (size, line height, letter spacing, family, weight), border color and shadow color input has a diamond icon ("Bind to a token") that opens a picker with search and the list of tokens of the property's type (color, spacing, radius, typography; **All** shows the rest) with the resolved value. Choosing writes `var(--token)` (`planApplyToken`) to all selected nodes. When the value is already `var(--x)`, the input becomes a **chip** with the token name and the value resolved in the node's scope (respecting `data-theme`); clicking the chip swaps the token and the unbind button writes the literal resolved value. Implemented generically in `properties/TokenBinding.tsx` (`TokenBound`), plugged into the shared components.

### Theme per element

The **Theme** row of the properties panel (frames and any element) sets the `data-theme` (`planSetFrameTheme`); "Default (base)" removes it. When the element declares no theme, the select shows the inherited one (`Inherited (dark)`).

### No selection

The right panel shows the summary (number of tokens and themes, unused, with problems), the **Base CSS** selector (Default / Tailwind (preflight), `setCssBase` op) and the "Open tokens panel" button.

## Tailwind

Tailwind is native to the model: `node.classes` (classes as written), `node.states` (per-variant styles: `hover`, `focus`, `active`, `disabled`, `dark`, `sm`..`2xl` and combinations like `md:hover`) and `Document.cssBase`. The engine (the official Tailwind v4 compiler, ~260 kB) is loaded **on demand**, in a separate chunk, only when the Classes section appears or when HTML with classes is pasted; while it loads the section shows "Loading Tailwind…" and, if the import fails, shows the error without breaking the panel.

- **Render with states**: the canvas and the render page (`window.__mockupRender.render({ ..., state })`) apply `resolveStateStyle` to each node. The root frame provides the context: a breakpoint applies when the **frame width** (the frame is the viewport; the resize preview counts) is greater than or equal to it; `dark` applies inside a node with `data-theme="dark"` (for the subtree) or in the "dark" preview; pseudo-states apply in the preview. The context only changes when crossing a breakpoint, and only nodes with `states` reprocess the style.
- **State preview**: "Preview" selector in the top bar (None, hover, focus, active, focus-visible, focus-within, disabled, dark; `previewState` in the `uiStore`). It applies to all nodes on the canvas and does not change the document.
- **Base CSS**: the canvas and the render use `documentBaseCssFor(doc, ...)`; with `cssBase: 'tailwind'` the Tailwind preflight is included. Choose it under "Base CSS" in the document panel (no selection).
- **Classes section**:
  - Classes field (Enter or losing focus applies; Shift+Enter breaks the line; Esc discards). Applying uses `planSetClasses(..., 'replace')`: the classes become the node's style (`style`, `states` and `classes` change in a single call, one undo), keeping positioning (`position`, `left`, `top`...) and CSS with no equivalent class when the classes do not define them. On a node without `classes`, the field opens with the classes equivalent to the current style (`engine.nodeClasses`); leaving without editing applies nothing. Multi-selection shows "Mixed" and applies to all.
  - Autocomplete (`engine.suggest`) for the class under the cursor, including with a variant prefix (`hover:bg-`): ↑/↓ navigate, Enter or Tab accept, Esc closes; the CSS of the highlighted class appears at the bottom of the list.
  - Unknown classes, or classes with no equivalent in the model, appear as a discreet warning below the field.
  - **Show as Tailwind** (remembered in the `uiStore`): the idiomatic classes for the node's current style, with variants (`engine.nodeClasses`), read-only, with a Copy button, plus the CSS that has no equivalent class. It also works for nodes generated from CSS, without `classes`.
  - **States**: lists the node's `states` with the CSS of each and a button to remove (`setStates` op).
- **Pasting HTML**: if the pasted HTML looks like Tailwind (`detectTailwind`), the editor keeps the classes (`htmlToNodes(html, { keepClasses: true })`), compiles them (`applyTailwindToNodes`) and, if the document does not yet use the preflight, adds `setCssBase` in the same call (one undo). As with the MCP's `import_component`, if the HTML uses shadcn colors (`bg-primary`, `border-input`...) that the document does not have, the tokens of the shadcn preset (and the `dark` theme) go in the same ops, with a warning on screen, and borders without a color get `var(--color-border)`. Without Tailwind, behavior is as usual.
- **`dark` state preview**: besides the `dark:` variants, it swaps the tokens for the document's `dark` theme (the root frame gets `data-theme="dark"` only in the DOM), like `get_screenshot(state: 'dark')`. Breakpoints (`md:`...) use the widths of the document's `--breakpoint-*` tokens.

## Assets, images, data and files

Details in [ASSETS.md](ASSETS.md) and [DATA.md](DATA.md).

- **Home screen**: appears in place of the canvas when nothing is open and through the bar's **Home** button (house) or **File › Home**. Sidebar with Recent, Favorites, All, nested virtual folders (create, rename and delete from the context menu; dragging a card to the folder moves the file) and tags. Search by name, tag and content (node text). Cards with a thumbnail of the first frame (without a render engine, a neutral card with the name and number of frames), folder, tags, favorite star and an "open" badge; clicking opens. Card menu: favorite, edit tags, move to folder, **Remove from index** (takes the card off the list for good: index, recents and thumbnail; an open document is closed first, with pending changes saved; the file stays on disk and opening it again brings it back) and **Delete file…** (also **Delete** on a focused card): a confirmation names the file and lists the `assets/` files used only by it, which go with it (assets another document in the same folder may use are kept); in the desktop app everything goes to the Recycle Bin, in the browser with the plain Node daemon it is deleted permanently, and the dialog says which. An open document is closed first (if the delete then fails, the error says the document was closed). Assets reached through a symbolic link or junction are never removed, and a linked `.mockup.json` only loses the link. **Delete file…** is disabled on cards whose file is not on disk ("File not found", including an open document never saved). **New document** and **Add file or folder** (native dialog on desktop). Loading: coming back to the home screen shows the last list of that view at once and refreshes it in the background; changes to open documents (open, close, save, path) and each reconnection to the daemon refresh it at most every 500 ms, and edits never hold the list back. A list that fails or takes longer than 10 s shows an error with **Retry** (the last list stays). Thumbnails load at most two at a time, only for cards near the viewport, and are cancelled when the home screen closes, so slow thumbnails never block the list or other requests to the daemon. When a file is saved its card keeps the previous thumbnail until the new one arrives (and if the new one fails).
- **Layers | Assets tabs** in the left panel. The Assets tab lists the files in `assets/` with a thumbnail, search, an "Unused" filter, a usage counter (clicking selects the nodes), upload by dragging or **Upload**, **Insert** and dragging to the canvas, **Copy link** (stable `/cdn` URL), **Remove**, **Remove unused**, **Optimize** (WebP) and the global **Library**.
- **Node search** at the top of Layers (Ctrl+F): the core's `searchNodes` on the active document, with the filters `tag:`, `name:`, `text:`, `class:`, `id:`, `attr:`, `data:`; clicking a result switches page, selects and frames.
- **Image section** (selection of images only): replace image, `object-fit`, `object-position` (3×3 grid and free field), filters with slider and field (live preview, one undo entry on release; preserves unknown functions, such as the blur from the Effects section), `clip-path` mask (ready-made shapes or CSS), **Crop** and **Generate placeholder** (type and seed).
- **Visual crop** (Crop button or double click on the selected image): shows the whole image with the outside area darkened and a rectangle with 8 handles; dragging inside moves it. Enter/**Apply**/click outside confirms (`object-view-box`), Esc cancels.
- **Repeaters on the canvas**: the repeater shows one item per row of `data`; all copies use the template node's `data-node-id`, so clicking any item selects (and editing changes) the template. In inline editing, item 0 shows the raw text (`{{field}}`).
- **Data section** (repeater selected): source and read date, **Refresh**, **Bind…** (paste JSON/CSV, path or URL, `select`, limit), editable table (cell, row and column; each edit is a `setData` op; up to 500 rows drawn) and mapping of template fields with no column. Containers with children get **Convert to repeater** (section and context menu).

## Presentation

Plays the current page like a slide show. Each **visible top-level frame** (artboard) is one slide, in the same order as the Layers panel (top first); hidden frames are skipped.

- **Start**: the **Present** button in the top bar (from the selected frame, or from something inside it; with no selection, from the first), **F5** (from the first frame), **Shift+F5** (from the selected frame), the desktop app's **View** menu, or the MCP tool `start_presentation` (see [MCP.md](MCP.md)). The button is disabled when the page has no visible frames. In main component edit mode the page you came from is presented.
- **Navigate**: Right / Down / Space / Page Down / Enter or a click anywhere = next; Left / Up / Backspace / Page Up = previous; Home / End = first / last; Esc = exit. The small control bar (`3 / 8`, previous, next, exit) hides after about 2 s without moving the mouse, together with the cursor, and comes back on any mouse movement.
- **Rendering**: the slide is drawn with the same renderer as the canvas and the screenshots (components expanded, tokens and themes, fonts, effects and videos running, the Preview state selector applied), scaled to fit the screen keeping its aspect ratio, with the slide's transition between slides (a short fade when it has none; no animation with reduced motion). See the next two bullets. The design is not interactive and no editor chrome (selection, handles, rulers, labels) is shown.
- **Builds**: elements with a motion build (`build` 1..n) stay hidden until the n-th click. Right / Space / click plays the next build, and moves to the next slide once all are played; Left undoes one build instantly, then goes back to the previous slide with all its builds shown. Build 0 plays when the slide appears. The counter shows `3 / 8 · 1/2` when the slide has builds. The MCP `presentation_goto` accepts `build`.
- **Transitions**: each slide's `slideTransition` is how it enters (played time-reversed when going back). Both slides are animated with the Web Animations API (transform, opacity, filter; no re-render per frame); navigating during a transition finishes it first. With a **magic move** transition, layers with the same name on both slides (unique on each slide, top-most only, not root frames) morph from their old position and size to the new one while the rest crossfades.
- **Live updates**: edits from you or the agent show up right away. The current frame is kept by id when frames are added, reordered or hidden; if it is removed the presentation stays at the same position. A page with no frames shows a black stage and `0 / 0`. Closing the document or deleting the presented page ends the presentation.
- **Editor input is disabled** while presenting: no editor shortcut, clipboard command or desktop menu action (other than the presentation ones) runs, and browser keys such as F5 or Ctrl+R (reload) do nothing. Tab, F11 and F12 keep working; Tab reaches the control buttons, and Enter / Space on a focused button activate it.
- **Exit**: the canvas stays mounted underneath, so the page, zoom and scroll are exactly as they were, and the focus goes back to where it was (e.g. the Present button). If you ended on the frame you started from, the selection is unchanged; otherwise the last frame shown is selected (only when it is on the page the editor shows: the MCP can present another page). Starting again while presenting (e.g. `start_presentation`) switches page and slide in place, without leaving full screen.
- **Full screen**: in the desktop app the window goes full screen (and leaves it on exit; leaving full screen ends the presentation). In the browser the page requests full screen when you start from a click or key (leaving it with Esc ends the presentation); if the browser refuses (e.g. started from the MCP without a gesture) it presents inside the window.

## Motion

Animate nodes visually; the model and engine are described in the motion docs, and the agent can do the same through the MCP.

- **Animation section** (Design tab, any selection, multiple supported): lists the node's animations with a kind badge (In / Out / Emphasis / Loop), preset, build (`On start` or `Click N`) and duration. **Add animation** opens the preset picker (kind tabs, search, groups; hovering a tile previews the real preset). With several nodes selected, **Cascade** adds that many ms of delay per successive node. Each row expands to preset, kind, duration, delay, easing (named, or a custom `cubic-bezier()` / `linear()` / `spring` string, validated), build, iterations (number or infinity), alternate, split (children / words / chars, text only) with stagger, preset parameters, and a keyframes JSON editor for `custom`. **Preview** plays the frame timeline from that animation. Every edit is one undo step.
- **Slide transition** (top-level frame selected): preset, direction, duration, easing and **Apply to all frames on this page**.
- **Timeline panel**: the **Motion** toolbar button or **M** shows it under the canvas (about 220 px, resizable). It shows the selected frame (or the first visible one): ruler in seconds (Ctrl+wheel zooms), shaded build bands (`On start`, `Click 1`...), the transition bar, and one row per animated node with a bar per animation (loops end hatched, split stagger as a lighter tail), colored by kind. Click a bar to select the node and its row; drag a bar to change the delay (10 ms snap, Shift = 100 ms) and its right edge to change the duration; click or drag the ruler to scrub the canvas; Space plays / pauses, Stop returns to the design state. Closing the panel stops the preview. The canvas shows the design state by default; loops follow the effects play / pause.

## Shortcuts

| Shortcut                            | Action                                                                                         |
| ----------------------------------- | ---------------------------------------------------------------------------------------------- |
| V / H / F (or A) / R / T            | Select / Hand / Frame / Container / Text                                                       |
| Ctrl+Shift+K                        | Insert image                                                                                   |
| Ctrl+Alt+K                          | Create component from selection                                                                |
| Space (hold)                        | Temporary pan                                                                                  |
| Alt (hold)                          | Distance ruler; resize from the center                                                         |
| Delete / Backspace                  | Delete                                                                                         |
| Ctrl+D                              | Duplicate                                                                                      |
| Ctrl+G / Ctrl+Shift+G               | Group into container / ungroup                                                                 |
| Ctrl+] / Ctrl+[                     | Bring forward / send backward                                                                  |
| Ctrl+Shift+] / Ctrl+Shift+[         | Bring to front / send to back                                                                  |
| Ctrl+Shift+H / Ctrl+Shift+L         | Hide / lock                                                                                    |
| Arrows / Shift+arrows               | Move 1 px / 10 px (reorders in-flow children)                                                  |
| Esc                                 | Back to the Select tool; go up one level; with no selection, finish editing the main component |
| Enter / Shift+Enter                 | Select the children / the parent                                                               |
| Ctrl+A                              | Select siblings (or all frames)                                                                |
| Ctrl+Z / Ctrl+Shift+Z or Ctrl+Y     | Undo / redo                                                                                    |
| Ctrl+C / Ctrl+X / Ctrl+V            | Copy / cut / paste                                                                             |
| Ctrl+S / Ctrl+Shift+S               | Save / Save as                                                                                 |
| + / - / Shift+0 / Shift+1 / Shift+2 | Zoom: in, out, 100%, all, selection                                                            |
| M                                   | Show / hide the motion timeline                                                                |
| F5 / Shift+F5                       | Present from the first frame / from the selected frame                                         |

Shortcuts are ignored while focus is in a text field, a dialog or inline editing (except Ctrl+S).

## Clipboard

- **Copy** writes the nodes' HTML (`nodesToHtml`) to the system clipboard, with a marker, and keeps a faithful internal copy.
- **Paste**: content copied in the editor itself comes back with full fidelity and **new ids**; external HTML (from a browser, an agent or text that looks like HTML) goes through the core's `htmlToNodes` (HTML that looks like Tailwind: see [Tailwind](#tailwind)); images become an upload to `assets/`; plain text becomes a text node.
- **Destination**: inside the selected node (if it accepts children), after it (if it is a leaf) or at the page root (as a frame, in the center of the screen).

## Internal architecture

| Folder / file                          | Contents                                                                                                                                |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `client/daemon.ts`                     | WS client: reconnection, Promise-based requests (`ack`/`error` by `reqId`), merging messages into the stores, asset upload and recents. |
| `state/docStore.ts`                    | Daemon state: documents, active document (`rawDoc`) and the expanded view (`doc`), history (`canUndo`/`canRedo`), agent activity.       |
| `state/uiStore.ts`                     | Local state: selection, hover, tool, page, viewport, text editing, drag previews, state preview, focus requests, toasts, panel tabs.    |
| `state/assistantStore.ts`              | Assistant per document: messages, turn in progress (partial text and tools), backends and configuration.                                |
| `tailwind/`                            | On-demand loading of the Tailwind engine (`loader.ts`) and the `useTailwind` hook.                                                      |
| `state/share.ts`                       | Structural sharing: node objects that did not change keep their identity between document versions.                                     |
| `model/tree.ts`                        | Per-document node index (cached in a `WeakMap`) and queries (parent, chain, siblings, selection top...).                                |
| `actions.ts`                           | Shared commands (delete, duplicate, group, order, move with arrows...) with tested pure builders.                                       |
| `canvas/`                              | Canvas, node rendering, overlay (selection, handles, marquee, ruler), interactions, creation, image.                                    |
| `layers/`                              | Pages and the layer tree.                                                                                                               |
| `components/`                          | Components: expanded view and main component page (`model.ts`), edit mode, commands, kits, Components tab, Instance/Component sections. |
| `properties/`                          | Properties panel and CSS parsers (shadows, borders, boxes, filters, advanced CSS).                                                      |
| `dock/`                                | `RightDock`: the Design, Assistant and Scripts tabs of the right panel.                                                                 |
| `assistant/`                           | AI assistant panel (messages, tool chips, composer, backend selector).                                                                  |
| `scripts/`                             | Scripts panel: CodeMirror editor (`cm.ts`, on demand), output, library, examples and per-document drafts.                               |
| `remix/`                               | Remix menu actions (`daemon.remix`, AI Remix dialog, framing of the created frames).                                                    |
| `presentation/`                        | Presentation mode: store (`presentationStore.ts`), overlay (`PresentationView`), start helper and MCP commands (`editorCommands.ts`).   |
| `render/`, `desktop/`                  | Render page (screenshots/measurement) and the bridge to the desktop app.                                                                |
| `toolbar/`, `shortcuts/`, `clipboard/` | Top bar, shortcuts and clipboard.                                                                                                       |
| `ui/`                                  | Shared controls (numeric input with units, sections, color, menus, dialog, toasts).                                                     |

## Save as, embedded fonts and desktop app

- **Save as…** (File, Ctrl+Shift+S) sends `doc:saveAs`: the daemon writes to the new path (overwriting), copies `assets/` next to the new file without overwriting what already exists, and points the document at it (`doc:saved` with the new path). It rejects a path that already belongs to ANOTHER open document. In the browser the path is typed; on desktop it opens the native dialog.
- **Embedded fonts**: the canvas injects a `<style>` with the `@font-face` rules from `doc.fonts` (the core's `fontFaceCss`, files in `/assets/<docId>/...`), so fonts from `add_font` appear as in the export. The document's families appear in the font selector.
- **"AI" indicator**: the server's `agent:finished` event clears the badge from the frames of the nodes listed (or all of them, if the list is empty).
- **Desktop bridge** (`desktop/bridge.ts`): with `window.mockupDesktop` (Electron preload), New/Open/Save as use the native dialogs, the native menu triggers the same flows (`onMenu`; undo/redo go to the focused field when editable) and the editor reports name/path/unsaved state to the window (`setDocumentState`).
- **Render page** (`render.html`, `src/render/`): generated together with the editor at `dist/render.html` and served at `/render.html`. It does not connect to the WebSocket. `window.__mockupRenderReady` becomes `true` on mount; `window.__mockupRender.render({ doc, docId, nodeId, transparent? })` renders only the root frame that contains the node, at (0,0), with the same `NodeView` as the canvas (no shadow, label or badge), waits for fonts, images and 2 frames, and returns `RenderBox`; `measure(nodeId)` returns the measured `LayoutNode` of the last render. Background: `transparent: true` makes html/body transparent (and uses `color-scheme: normal`; the main process must use a transparent window background), otherwise it uses the frame's page `background`.

Drag and resize previews (`ui.setPreview`) are transient: only on release does the editor send the ops, in a single call (= one undo entry).

## Performance

Decisions:

- The document arrives in full on every `doc:changed`; the editor applies **structural sharing** (`shareStructure`), so only the changed nodes (and their ancestors) get new objects.
- `NodeView` and `FrameView` use `React.memo` by node identity; each node subscribes only to its own drag preview.
- Selection, hover, marquee and handles live in a separate **overlay layer**: changing the selection or moving the mouse does not re-render the tree.
- Pan and zoom write the `transform` directly to the DOM (no React render).
- Layer rows and the properties panel subscribe only to the nodes they display.

Measurements (Windows, document with 300 nodes in 6 frames × 50):

| Measurement                                                        | Result                             | Where                                    |
| ------------------------------------------------------------------ | ---------------------------------- | ---------------------------------------- |
| `applyOp` in the daemon (`updateStyles`/`setPosition`/`moveNodes`) | ~0.8 / 0.65 / 0.63 ms per op       | `packages/core/src/perf.test.ts`         |
| `JSON.stringify` of the document (cost of `doc:changed`)           | ~0.21 ms                           | `packages/core/src/perf.test.ts`         |
| Document cloning: JSON vs `structuredClone`                        | ~0.62 ms vs ~0.87 ms (kept JSON)   | `packages/core/src/perf.test.ts`         |
| Editor: `JSON.parse` + sharing + index                             | ~0.30 + 0.36 + 0.04 ms per message | `packages/editor/src/state/perf.test.ts` |
| MCP `update_styles` → updated DOM latency (end to end)             | mean ~31 ms, max ~46 ms (10 ops)   | `packages/editor/e2e/perf.spec.ts`       |
| Dragging a frame with 50 nodes (interval between frames)           | p95 ~16.7 ms (60 fps)              | `packages/editor/e2e/perf.spec.ts`       |

With these numbers, JSON cloning in the core and the full document in `doc:changed` stay well below one frame (16 ms) and were kept; op deltas over WS are left for when documents grow by an order of magnitude.

## Tests

- Unit (Vitest, `npm test`): canvas geometry (click, flex insertion, resizing, marquee, ruler, fit), layers (drop, flattening, range), properties (CSS parsers and diff, size modes, boxes), shortcuts, clipboard, commands, WS client, structural sharing and index. Component tests with happy-dom.
- E2E (Playwright + Chromium, `npm run test:e2e`): starts a daemon on port 4848 with a temporary `MOCKUP_DATA_DIR` and Vite on 5273 pointing to it. They cover creating a frame with the tool, HTML via MCP appearing live and synchronized selection (editor ↔ MCP), move and resize, undo/redo, save and reopen, Tailwind (shadcn on the canvas, hover preview, class editing, show as Tailwind, base CSS), the tokens and themes panel (create, edit, rename, theme with override, bind to a token and switch the frame's theme checking the color on the canvas, unused/broken warnings, import and export), the editing flow (container, inline text with line break, rename, copy/paste, duplicate, delete, new page), scripts (rename 10 texts with a script and undo everything with one Ctrl+Z) and Remix (color scale creates 10 frames, one Ctrl+Z removes them), components (Ctrl+Alt+K, instances with props through the panel, main component editing propagating to 3 instances and undo, text override and Reset, inner node blocking, shadcn-like kit by click and by dragging, editable slot, `go_to_main` and Esc) presentation mode (`presentation.spec.ts`: Present button, keys, inert editor shortcuts, restore on exit, F5, live MCP edits, `start_presentation` and leaving the browser full screen with the canvas scroll kept) and the performance measurements. After Playwright, `test:e2e` runs `test:e2e:desktop`: the real integration in headless Electron of effects (non-empty mesh gradient, `time`, webm/gif/mp4 export) and media (video with poster and `time`, Three.js island, Lottie and Rive from `assets/`), in `packages/desktop/src/*.integration.test.ts`.
- `npm run screenshot` regenerates `docs/img/editor.png` with `examples/landing.mockup.json`.
- E2E ports and folder by environment variable: `MOCKUP_E2E_DAEMON_PORT` (default 4848), `MOCKUP_E2E_EDITOR_PORT` (default 5273) and `MOCKUP_E2E_DIR` (default: a new temporary folder per run, with the documents and the daemon's `MOCKUP_DATA_DIR`). `MOCKUP_E2E_DAEMON` is derived from the port and read by the helpers. Change the ports if the everyday daemon (4747) or another process occupies the defaults.

The first time: `npx playwright install chromium`.
