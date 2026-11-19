# Architecture

## Overview

```
 Agent (Claude Code, Codex)
        |  stdio (JSON-RPC)
        v
 mockup mcp  (@mockup/cli)  -- stdio <-> Streamable HTTP proxy
        |  1. uses the live daemon (daemon.json + /api/health)
        |  2. otherwise starts headless Electron (screenshot)
        |  3. otherwise starts the Node daemon (no render)
        |  HTTP  POST/GET/DELETE /mcp
        v
 +---------------------------------------------------+        +-------------------+
 | Desktop app (@mockup/desktop, Electron)           |        | Disk              |
 |  +---------------------------------------------+  | -----> | *.mockup.json     |
 |  | In-process daemon (@mockup/server)          |  |  save  | assets/           |
 |  |  127.0.0.1:4747                             |  |        | daemon.json ...   |
 |  |  DocumentStore: docs, History, selection    |  |        +-------------------+
 |  |  HTTP /api/* /assets/* /render/* and editor |  |
 |  |  at /   MCP /mcp   WebSocket /ws            |  |
 |  +---------------------------------------------+  |
 |  RenderService: hidden window at /render.html,    |
 |  capture via CDP (Page.captureScreenshot)         |
 |  Editor window (BrowserWindow) + native menu      |
 +---------------------------------------------------+
        ^  WS (events and requests)
        v
 Editor (@mockup/editor: app window or browser)
```

All mutations go through the daemon, which is the single source of truth at runtime. The editor and the MCP server are clients of the same `DocumentStore`. HTTP MCP clients (alternative) talk directly to `/mcp`, without the proxy.

The daemon does not depend on Electron: `startDaemon` takes an optional `RenderProvider`. The desktop app injects the `RenderService` (and the built editor's `editorDir`). Without it (pure Node daemon), screenshot, `get_layout` and the measured SVG are unavailable, and `GET /api/health` returns `render: false`. In `--headless` mode the app opens no window: it is what `mockup mcp` and `mockup serve --render` start.

## Packages

| Package            | Name                                   | Responsibility                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ------------------ | -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `packages/core`    | `@mockup/core`                         | Document model, pure ops with inverses, `History` (undo/redo), `htmlToNodes`/`nodesToHtml`, `getTreeSummary`, `getComputedLike`, zod schema (`parseDocument`/`serializeDocument`). html, tailwind, react and svg exporters (`export/`, see [EXPORT.md](EXPORT.md)). `layout.ts` (`LayoutNode`, measured geometry), `fonts.ts` (`@font-face` for embedded fonts), `base.ts` (the document's single base CSS: the same on the canvas, in the render and in the exported code, with Tailwind's preflight when `cssBase: 'tailwind'`; the editor UI's CSS does not leak into the design) and `states.ts` (per-variant states). Subpackage `@mockup/core/tailwind`: Tailwind v4 engine using the official compiler (see [TAILWIND.md](TAILWIND.md)). No DOM and no Node APIs. |
| `packages/server`  | `@mockup/server` (bin `mockup-daemon`) | Node daemon on 127.0.0.1. `DocumentStore` (open documents, per-document undo, selection, autosave with an 800 ms debounce, save as), HTTP (includes `/render/*` and the static editor at `/`), WebSocket and MCP. `RenderProvider` contract. Express 5 and ws.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `packages/cli`     | `@mockup/cli` (bin `mockup`)           | `mockup mcp`, `mockup serve [--port] [--render]`, `mockup stop`, `mockup open <file>`, `mockup new <file> [--name]`. Discovers the daemon and locates Electron to start headless mode (`electron.ts`, `discover.ts`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `packages/editor`  | `@mockup/editor`                       | Vite + React 19 + zustand. Complete visual editor (canvas, selection, layers, properties, pages, clipboard, undo/redo via the daemon); every mutation becomes an `Op` sent over WS. See [EDITOR.md](EDITOR.md).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `packages/desktop` | `@mockup/desktop`                      | Electron app: editor window, in-process daemon, `RenderService` (screenshot via CDP), native menu, preload with native dialogs, `--headless` mode, NSIS installer and portable build (electron-vite + electron-builder). See the [package README](../packages/desktop/README.md).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |

## Flow of an edit

1. A client (MCP tool or the editor via WS `op:apply`) produces one or more serializable `Op`s.
2. The `DocumentStore` applies each op to the document (a pure function: returns a new document and the inverse ops) and records the pair in the document's `History`.
3. The document's `revision` is incremented, the document is marked `dirty` and autosave is rescheduled (800 ms debounce).
4. The store emits the change event with `source` (`editor`, `mcp` or `system`).
5. The WS server sends `doc:changed` (with `ops`, `source`, `revision` and the full `doc`) to all connected clients.
6. The editor integrates the received document with structural sharing (nodes that did not change keep their identity) and renders only what changed. Whoever originated the edit also receives an `ack` with the `reqId`, after `doc:changed`.
7. Every write via MCP returns, in the response, the tree summary at depth 2.

Undo and redo run the inverse ops stored in the `History` and follow the same path (event, WS, editor).

## Editor

- **State**: `docStore` (mirror of the daemon: documents, active document, history, agent activity) and `uiStore` (selection, hover, tool, active page, viewport, drag previews, main component being edited), both zustand. Only the WS client writes to `docStore`. The active document lives in `rawDoc` (as the daemon stores it) and in `doc` the **view** used by the UI: expanded component instances (`expandDocument`) and, in main component edit mode, the synthetic page containing it (see [COMPONENTS.md](COMPONENTS.md#editor)).
- **Client** (`client/daemon.ts`): one request per `reqId`, resolved by the `ack` or rejected by the `error`; `apply(ops)` = one history entry. The local selection is published with `selection:set`; `selection:changed` with `source: 'mcp'` selects and frames the nodes in the editor.
- **Render**: frames and nodes as real HTML/CSS (`React.memo` per node); selection, handles and rulers in an overlay layer; pan/zoom directly on the `transform`.
- **Previews**: dragging and resizing show a transient local preview; on release, the ops go in a single call.
- **Agent badge**: frames touched by ops with `source: 'mcp'` in the last 4 s.

Details, shortcuts and measurements in [EDITOR.md](EDITOR.md).

## Render and screenshot

The daemon does not know Electron. It uses the `RenderProvider` contract (`packages/server/src/render.ts`):

| Method               | Description                                                                                                                                                                            |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `capture(req)`       | `{ doc, docId, nodeId, scale?, format?, quality?, maxWidth?, transparent? }` returns `{ data, mime, width, height, pixelWidth, pixelHeight }` (`width`/`height` in the node's CSS px). |
| `measure(target)`    | Returns the `LayoutNode` of the node's subtree.                                                                                                                                        |
| `close()` (optional) | Releases the render window; the daemon calls it on shutdown.                                                                                                                           |

Without a provider, render calls fail with the message `RENDER_UNAVAILABLE` (MCP tools with `isError`, `/render` route with 503).

### Render page

`packages/editor/render.html` (editor build, served at `/render.html`) mounts only the node's frame, with the same node component and the same base CSS as the canvas (`documentBaseCss`), without selection, artboard shadow or UI.

- `window.__mockupRenderReady` becomes `true` when the page is mounted.
- `window.__mockupRender.render({ doc, docId, nodeId, transparent? })` renders the node's root frame at 0,0 and returns `RenderBox { frameId, frameWidth, frameHeight, x, y, width, height }`: the node's rectangle relative to the frame, in CSS px. The background is the document page's; with `transparent` the background is transparent.
- `window.__mockupRender.measure(nodeId)` returns the `LayoutNode` of the already rendered node.
- Before responding, `render` waits for fonts (`@font-face` of embedded fonts) and images (`decode`, with a 5 s limit per wait).

### LayoutNode

Geometry measured in the real DOM (`getBoundingClientRect` and `getComputedStyle`), in `packages/core/src/layout.ts`. Coordinates in CSS px **relative to the root frame's corner** (frame at 0,0, scale 1). Each node carries `id`, `name`, `type`, `tag`, `x`, `y`, `width`, `height`, a subset of the computed style (`LayoutStyle`), the rendered text lines (`LayoutTextLine`: text, rectangle and approximate baseline) and the children. It feeds `get_layout` and the SVG exporter.

### RenderService (desktop app)

`packages/desktop/src/main/render.ts` implements the `RenderProvider`:

- **A reusable window** loads `/render.html` and waits for `__mockupRenderReady`. Frameless, transparent, offscreen, unfocused and out of the taskbar (see [Technical decisions](#technical-decisions)).
- **Serial queue:** one operation at a time (capture and measure), even if the previous one fails.
- **Recovery:** if the render process dies (`render-process-gone`), the window fails to become ready or an operation takes longer than 30 s, the window is destroyed and recreated on the next call.
- **Capture:** CDP (`webContents.debugger`) with `Emulation.setDeviceMetricsOverride` (viewport greater than or equal to the frame, `deviceScaleFactor` = scale) and `Page.captureScreenshot` with the node's `clip`. The scale ranges from 1 to 3. `transparent` (PNG only) clears the default background. If CDP fails, it falls back to `capturePage` (no scale).
- **Format:** `maxWidth` downsizes with `nativeImage.resize` (`best` quality); JPG comes from `nativeImage.toJPEG` (default quality 90). Limit of 16384 px per side after scaling, with a clear error.
- **LRU cache** limited to 256 MB (sum of the images' bytes), keyed by the sha256 of `{ the node's frame, tokens, fonts, page background, docId, nodeId, scale, format, quality, maxWidth, transparent, size and date of the referenced files }` (image `src`, relative `url()` and fonts, read from `assets/`): replacing a file while keeping its name invalidates the cache.
- **Limits and isolation:** the viewport (`frame × scale`) is validated against 16384 px per side before resizing the window; the render window denies navigation and new windows.

## File format

`*.mockup.json` file: JSON with 2 spaces and keys in a stable order. Images live in `assets/` next to the file. `version` is always `1`. The source of truth for the types is `packages/core/src/types.ts`; the zod schema validates on read.

### Document

| Field       | Type                                      | Description                                                                                       |
| ----------- | ----------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `version`   | `1`                                       | Schema version.                                                                                   |
| `id`        | string                                    | Document id (`doc_xxxxxxxx`).                                                                     |
| `name`      | string                                    | Document name.                                                                                    |
| `pages`     | `Page[]`                                  | Pages.                                                                                            |
| `tokens`    | `Record<string,string>`                   | The document's CSS variables, e.g. `{ "--color-primary": "#6c5ce7" }`.                            |
| `tokenMeta` | `Record<string,{ group?, description? }>` | Optional. Group and description per token (see [TOKENS.md](TOKENS.md)).                           |
| `themes`    | `{ name, overrides }[]`                   | Optional. Themes that override tokens; the frame uses a theme through the `data-theme` attribute. |
| `fonts`     | `FontRef[]`                               | Fonts used.                                                                                       |
| `cssBase`   | `'tailwind'` (optional)                   | Base CSS with Tailwind v4's preflight (absent = default base).                                    |
| `meta`      | `DocumentMeta`                            | `createdAt`, `updatedAt` (ISO 8601) and free extra keys.                                          |

### Page

| Field        | Type     | Description                         |
| ------------ | -------- | ----------------------------------- |
| `id`         | string   | Page id (`pg_xxxxxxxx`).            |
| `name`       | string   | Name.                               |
| `frames`     | `Node[]` | The page's root nodes (frames).     |
| `background` | string   | Page canvas background (CSS value). |

### Node

| Field      | Type                                                 | Description                                                                                             |
| ---------- | ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `id`       | string                                               | Id with a per-type prefix.                                                                              |
| `type`     | `'frame' \| 'element' \| 'text' \| 'image' \| 'svg'` | Node type; also `'repeater'` (see [DATA.md](DATA.md)).                                                  |
| `name`     | string                                               | Readable name (layer).                                                                                  |
| `tag`      | string                                               | HTML tag: `div`, `section`, `button`, `img`, `h1`, `p`, `span`...                                       |
| `attrs`    | `Record<string,string>`                              | HTML attributes, without `style` and without `class`.                                                   |
| `style`    | `Record<string,string>`                              | Real CSS in kebab-case, e.g. `{ "display": "flex", "gap": "24px" }`. Tokens via `var(--color-primary)`. |
| `text`     | string (optional)                                    | Text content (`type: 'text'`).                                                                          |
| `src`      | string (optional)                                    | Image: relative path in `assets/` or data URL (`type: 'image'`).                                        |
| `svg`      | string (optional)                                    | Inline SVG markup (`type: 'svg'`).                                                                      |
| `children` | `Node[]`                                             | Children.                                                                                               |
| `locked`   | boolean                                              | Locked for editing in the UI.                                                                           |
| `hidden`   | boolean                                              | Hidden.                                                                                                 |
| `position` | `{ x, y }` (optional)                                | Position on the canvas (root frames) or x/y of children with `position: absolute`.                      |
| `classes`  | string (optional)                                    | Tailwind classes as written: export round-trip hint (see [TAILWIND.md](TAILWIND.md)).                   |
| `states`   | `Record<string, Record<string,string>>` (optional)   | Per-variant styles: `hover`, `dark`, `md`, `md:hover`... (`states.ts`, see [TAILWIND.md](TAILWIND.md)). |

Frames are the page's root nodes: they have `width` and `height` in `style` and `position` on the canvas. They serve as artboards and as breakpoints.

Repeaters (`type: 'repeater'`) also have `data` (list of items, up to 1000 and 2 MB) and `dataSource` (`inline`, `json`, `csv` or `url` source, with `path`/`url`, `select`, `mapping`, `limit` and `fetchedAt`); the children are the template repeated per item. See [DATA.md](DATA.md).

### FontRef

| Field     | Type                                       | Description                                                                 |
| --------- | ------------------------------------------ | --------------------------------------------------------------------------- |
| `family`  | string                                     | Family name.                                                                |
| `source`  | `'local' \| 'file' \| 'google'` (optional) | Font source. Only `file` generates `@font-face`; `local` just registers it. |
| `files`   | `string[]` (optional)                      | Font files (relative to `assets/`, e.g. `fonts/inter-400.woff2`).           |
| `weights` | `number[]` (optional)                      | Weight of each file (parallel to `files`) or the covered range.             |
| `styles`  | `string[]` (optional)                      | Style of each file (`normal` or `italic`), parallel to `files`.             |

`files[i]` has weight `weights[i]` and style `styles[i]` when the lists have the same length; otherwise all files cover the `weights` range (default 100 to 900). `fontFaceCss` (`fonts.ts`) generates the `@font-face` rules: the canvas and the render page use `/assets/<docId>/<file>` and the exported code uses `assets/<file>`.

## Ids

`nanoid` with 8 characters from the alphabet `[0-9a-z]`, preceded by a prefix that identifies the type.

| Prefix | Entity   |
| ------ | -------- |
| `fr_`  | frame    |
| `el_`  | element  |
| `tx_`  | text     |
| `im_`  | image    |
| `sv_`  | svg      |
| `rp_`  | repeater |
| `pg_`  | page     |
| `doc_` | document |

Functions in `ids.ts`: `newId`, `newNodeId(type)`, `newPageId`, `newDocumentId`, `typeFromId`.

## Ops and inverses

Defined in `packages/core/src/ops.ts`. Each op is a JSON object with `type`. `applyOp` returns `{ doc, inverse, result? }`; `inverse` is the list of ops that exactly undoes the application.

| Op (`type`)      | Fields                                                                               | Inverse                                                                                                                          |
| ---------------- | ------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------- |
| `createNode`     | `node`, `parentId?` (null = root frame), `pageId?`, `index?`                         | `deleteNodes` of the created node                                                                                                |
| `deleteNodes`    | `nodeIds[]`                                                                          | `createNode` for each removed node, at its original position                                                                     |
| `moveNodes`      | `nodeIds[]`, `parentId?` (null = root frame), `pageId?`, `index?`                    | `moveNodes` back to the previous parent and index                                                                                |
| `updateStyles`   | `changes[{ nodeId, set?, unset? }]` or `nodeIds[]` + `styles` + `unset?`             | `updateStyles` restoring previous values and keys                                                                                |
| `setText`        | `changes[{ nodeId, text }]`                                                          | `setText` with the previous text                                                                                                 |
| `setAttrs`       | `changes[{ nodeId, set?, unset? }]`                                                  | `setAttrs` restoring previous attributes                                                                                         |
| `renameNodes`    | `changes[{ nodeId, name }]`                                                          | `renameNodes` with the previous names                                                                                            |
| `duplicateNodes` | `nodeIds[]`, `idMap?` (oldId to newId, includes descendants)                         | `deleteNodes` of the clones; the `idMap` is returned in `result.idMap`                                                           |
| `setPosition`    | `changes[{ nodeId, position }]`                                                      | `setPosition` with the previous positions                                                                                        |
| `createPage`     | `pageId`, `name`, `index?`, `background?`, `frames?`                                 | `deletePage`                                                                                                                     |
| `deletePage`     | `pageId`                                                                             | `createPage` with the removed page's name, index, background and `frames`                                                        |
| `renamePage`     | `pageId`, `name`                                                                     | `renamePage` with the previous name                                                                                              |
| `setTokens`      | `set?`, `unset?`, `theme?` (theme overrides)                                         | `setTokens` restoring values and removing the created ones                                                                       |
| `setTokenMeta`   | `set?`, `unset?`                                                                     | `setTokenMeta` restoring the previous metadata                                                                                   |
| `setThemes`      | `themes[]`                                                                           | `setThemes` with the previous list                                                                                               |
| `replaceTokens`  | `tokens`, `tokenMeta?`, `themes?`                                                    | `replaceTokens` with the previous system                                                                                         |
| `renameToken`    | `from`, `to` (updates all `var()`s; `result: { from, to, nodes, references }`)       | `renameToken` back and restoration of the changed values                                                                         |
| `setNodeFlags`   | `changes[{ nodeId, locked?, hidden? }]`                                              | `setNodeFlags` with the previous values                                                                                          |
| `setTag`         | `changes[{ nodeId, tag }]`                                                           | `setTag` with the previous tags (locked tags and void elements with children are rejected; `image` only `img`, `svg` only `svg`) |
| `setFonts`       | `fonts[]` (`FontRef`; replaces the whole list, no repeated families)                 | `setFonts` with the previous list                                                                                                |
| `setSrc`         | `changes[{ nodeId, src }]` (`image` nodes only)                                      | `setSrc` with the previous `src`s                                                                                                |
| `setSvg`         | `changes[{ nodeId, svg, attrs? }]` (`svg` nodes only, sanitized)                     | `setSvg` with the previous markup (and the previous `attrs`, if `attrs` was given, which replaces `node.attrs`)                  |
| `setClasses`     | `changes[{ nodeId, classes }]` (`null`/`''` removes; does not touch the style)       | `setClasses` with the previous classes                                                                                           |
| `setStates`      | `changes[{ nodeId, states }]` (replaces `node.states`; keys validated and canonical) | `setStates` with the previous states                                                                                             |
| `setCssBase`     | `base` (`default` or `tailwind`)                                                     | `setCssBase` with the previous base                                                                                              |
| `setData`        | `changes[{ nodeId, data?, source? }]` (`repeater` nodes only)                        | `setData` with the previous data and source (`source: null` removes the source)                                                  |

`renameToken` also updates the `var()`s inside `states` (inverse with `setStates`).

For the history to be deterministic, `duplicateNodes`'s `idMap` and `createNode`'s ids are recorded in the stored op.

## WebSocket protocol

Endpoint `ws://127.0.0.1:4747/ws`. JSON messages, one per frame. Types in `packages/core/src/protocol.ts`. On connect, the server sends `hello`.

The handshake's `Origin` is validated (`isAllowedOrigin`): it accepts absent (non-browser clients) and `http(s)` on `localhost`, `127.0.0.1` or `[::1]` (any port). `Origin: null` and `file://` are rejected (the desktop app loads the editor from `http://127.0.0.1:<port>`), because `sandbox` iframes and `data:` pages from any site send that value. Everything else gets 403. In `op:apply`, `docId` (string) and `ops` (array) are required; each op is validated by the core and any exception becomes an `error` with the `reqId`.

### Server to client

| `type`              | Fields                                                                                                                                      | Description                                                                                      |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `hello`             | `documents: OpenDocumentInfo[]`, `activeDocId`, `doc` (active document or null), `selection[]`, `revision`, `history: { canUndo, canRedo }` | Initial state.                                                                                   |
| `doc:opened`        | `info`, `doc`, `history`                                                                                                                    | Document opened or created.                                                                      |
| `doc:changed`       | `docId`, `ops[]`, `source`, `revision`, `doc`, `history`                                                                                    | Change applied. In the MVP it includes the full document.                                        |
| `doc:saved`         | `docId`, `path`                                                                                                                             | Document saved to disk.                                                                          |
| `doc:closed`        | `docId`                                                                                                                                     | Document closed.                                                                                 |
| `agent:finished`    | `docId`, `nodeIds[]` (empty = all frames)                                                                                                   | The agent finished (`finish_working`): the editor clears the "AI" badge from the frames.         |
| `selection:changed` | `docId`, `nodeIds[]`, `source`                                                                                                              | Selection changed.                                                                               |
| `active:changed`    | `docId` (or null)                                                                                                                           | Active document changed.                                                                         |
| `editor:command`    | `commandId`, `command` (`presentation:start` \| `presentation:stop` \| `presentation:goto`)                                                 | Command for an editor window (presentation mode, from the MCP); it answers with `editor:result`. |
| `ack`               | `reqId`, `result?`                                                                                                                          | Success response to a request.                                                                   |
| `error`             | `reqId?`, `message`                                                                                                                         | Error.                                                                                           |

`source` is `'editor'`, `'mcp'` or `'system'`. `OpenDocumentInfo` has `docId`, `name`, `path` (null if unsaved), `dirty` and `revision`.

### Client to server

Every request has a `reqId` (string) and is answered with `ack` or `error`.

| `type`            | Fields                                                       | Description                                                                                                                                                    |
| ----------------- | ------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `op:apply`        | `docId`, `ops[]`                                             | Applies ops.                                                                                                                                                   |
| `selection:set`   | `docId`, `nodeIds[]`                                         | Sets the selection.                                                                                                                                            |
| `doc:open`        | `path`                                                       | Opens a file.                                                                                                                                                  |
| `doc:new`         | `path`, `name`                                               | Creates a document (ack with the info, without `doc`).                                                                                                         |
| `doc:close`       | `docId`                                                      | Closes the document (saves if pending); ack `{}`.                                                                                                              |
| `doc:save`        | `docId?`                                                     | Saves (default: active document).                                                                                                                              |
| `doc:saveAs`      | `docId?`, `path`                                             | Saves to another path (see below); ack with the document info.                                                                                                 |
| `undo`            | `docId?`                                                     | Undoes.                                                                                                                                                        |
| `redo`            | `docId?`                                                     | Redoes.                                                                                                                                                        |
| `active:set`      | `docId`                                                      | Sets the active document.                                                                                                                                      |
| `editor:register` | `focused`, `presenting?`                                     | Registers the connection as an editor window; sent on connect, whenever the window gets focus and when a presentation starts or ends (`presenting`). Ack `{}`. |
| `editor:result`   | `commandId`, `ok`, `result?` (`PresentationState`), `error?` | Answer to an `editor:command`. Ack `{}`.                                                                                                                       |

The daemon (`EditorChannel`, `packages/server/src/editors.ts`) sends `presentation:start` to the most recently focused window (ties: the most recently registered), and `presentation:goto` / `presentation:stop` to the window that most recently started presenting (as reported by `editor:register { presenting }` or an `editor:result`), falling back to the focused one. It fails if no window is registered, if the window closes before answering, or after 8 s without an answer; an answer that arrives later (up to 60 s) still updates which window presents.

`doc:saveAs` (`store.saveAs`): normalizes the path (`.json` becomes `.mockup.json`) and **overwrites** the destination (the native dialog already confirmed). Rejects with 409 if another open document uses the same path. Copies the contents of `assets/` next to the new file (without deleting the source and without overwriting files that already exist), makes the document point to the new path, emits `doc:saved` and updates the recents. In the editor: Ctrl+Shift+S, with the native dialog in the desktop app.

## HTTP

Base `http://127.0.0.1:4747`.

The `Host` header is validated before any route (`isAllowedHost`, DNS rebinding protection): the hostname must be `127.0.0.1`, `localhost`, `::1` or the `host` configured in the daemon, with any port. Otherwise, 403 `{ error: 'Host not allowed' }`. Errors: `HttpError` and body-parser 4xx errors keep their status; any other becomes 500 `{ error: 'Internal error' }` (detail only in the log).

| Route                                        | Description                                                                                                                                                                                                                                                                                                            |
| -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/health`                            | Daemon state (`ok`, `name`, `pid`, `port`, `startedAt`, `version`, `docs`, `activeDocId`, `render`, `mode`, `canShutdown`); used by the CLI to confirm `daemon.json`. `render` is `true` when there is a render engine (desktop app or headless Electron).                                                             |
| `GET /api/docs`                              | `{ documents, activeDocId }` with the open documents.                                                                                                                                                                                                                                                                  |
| `GET /api/docs/:id`                          | `{ info, doc, selection }`: full document.                                                                                                                                                                                                                                                                             |
| `POST /api/open`                             | Body `{ path }`. Opens a file.                                                                                                                                                                                                                                                                                         |
| `POST /api/new`                              | Body `{ path, name }`. Creates a document.                                                                                                                                                                                                                                                                             |
| `POST /api/shutdown`                         | Shuts the daemon down, saving the documents (202); 409 in the app with a window. See "Daemon mode and shutdown over HTTP".                                                                                                                                                                                             |
| `POST /api/save`                             | Body `{ docId? }`. Saves.                                                                                                                                                                                                                                                                                              |
| `POST /api/active`                           | Body `{ docId }`. Sets the active document.                                                                                                                                                                                                                                                                            |
| `GET /api/recent`                            | `{ recent: string[] }`: recent documents that still exist on disk.                                                                                                                                                                                                                                                     |
| `POST /api/assets/:docId?name=`              | Raw binary body (up to 20 MB; extensions png, jpg, jpeg, gif, webp, svg, avif). Writes to `assets/` with a sanitized name and suffix `-1`, `-2` if it already exists; responds `{ src }` relative to `assets/`. 404 nonexistent document, 409 no path (save first), 400 invalid name/extension/body, 413 too large.    |
| `GET /assets/:docId/*`                       | Serves files from the document's `assets/`.                                                                                                                                                                                                                                                                            |
| `GET /render/:docId/:nodeId.(png\|jpg\|svg)` | Image of the node. Query: `scale` (1, 2 or 3), `quality` (0 to 100, JPG), `maxWidth` (px), `transparent` (`1`/`true`, PNG). PNG and JPG come from the `RenderProvider`; SVG comes from `exportSvg` (with `measure` when there is a render; without render, the `<foreignObject>` fallback). `Cache-Control: no-store`. |
| `/ws`                                        | WebSocket (upgrade).                                                                                                                                                                                                                                                                                                   |
| `/mcp`                                       | MCP Streamable HTTP.                                                                                                                                                                                                                                                                                                   |
| `GET /` and other editor paths               | Static editor (SPA), only when the daemon receives an `editorDir` with `index.html`. Static files first; an extensionless `GET` outside `/api`, `/assets`, `/mcp`, `/ws` and `/render` returns `index.html`. Same origin as the API, assets and WS.                                                                    |

Asset, data and file routes (mounted by `routes/index.ts`):

- `GET /cdn/:hash.:ext`, `GET|DELETE /api/assets/:docId`, `POST /api/assets/:docId/link|remove-unused|optimize` and `/api/library`: local content-addressed CDN, assets with usages and library ([ASSETS.md](ASSETS.md#http)).
- `POST /api/data/:docId/:nodeId/bind|refresh` and `POST /api/placeholder/:docId`: repeater data ([DATA.md](DATA.md)) and placeholders.
- `GET /api/files`, `POST /api/files/meta|folders|add|forget`, `GET /api/files/thumbnail` and `GET /api/search/nodes`: file index, thumbnails and node search (see [File index](#file-index-and-thumbnails)).

`/render` responses:

| Code | When                                                                                                    |
| ---- | ------------------------------------------------------------------------------------------------------- |
| 400  | `scale` outside 1, 2 or 3; `quality` outside 0 to 100; invalid `maxWidth`.                              |
| 404  | Extension other than png, jpg and svg; nonexistent document or node.                                    |
| 500  | Render or `exportSvg` failure (render error in `{ error }`; the SVG one is generic, detail in the log). |
| 503  | PNG/JPG without a render engine (pure Node daemon).                                                     |

The SVG goes out with the same CSP as the assets (`ASSET_CSP`: `default-src 'none'; img-src data:; style-src 'unsafe-inline'; sandbox`) and `X-Content-Type-Options: nosniff`, so opened directly in a tab it runs no script and loads no resources. Document images are inlined as data URLs (read from `assets/`, without leaving the folder).

## MCP

- Transport: Streamable HTTP at `http://127.0.0.1:4747/mcp`, with `@modelcontextprotocol/sdk` 1.x.
- Sessions: the server assigns a session id on initialization; the client sends it in the `mcp-session-id` header on subsequent requests.
- Protection: the transport uses `enableDnsRebindingProtection` with `allowedHosts` `127.0.0.1:<port>`, `localhost:<port>` and `[::1]:<port>` (the SDK compares the whole `Host` header, with port). An external host gets 403.
- Lifecycle: an unknown `mcp-session-id` responds 404 (`-32001`, `Session not found`) so the client reinitializes; a request without a session that is not `initialize` responds 400. `DELETE /mcp` ends the session.
- TTL: a session idle for more than 30 min (`sessionTtlMs`) is closed by a periodic sweep; each request renews `lastSeen`.
- `mockup mcp` exposes the same server over stdio, proxying to the HTTP endpoint.
- Tools, conventions and guides in [MCP.md](MCP.md).

## Data folder

`%LOCALAPPDATA%/MockupStudio` on Windows; on other systems, `~/.mockup-studio`. The `MOCKUP_DATA_DIR` variable overrides it.

| File          | Contents                                                                                         |
| ------------- | ------------------------------------------------------------------------------------------------ |
| `config.json` | `{ port? }`                                                                                      |
| `recent.json` | Paths of recent documents.                                                                       |
| `daemon.json` | `{ port, pid, startedAt, url, mcpUrl, wsUrl }`. Written when the daemon starts, removed on exit. |
| `files.json`  | File index: virtual folders, tags and favorites (see below).                                     |
| `cdn/`        | Local CDN and library: `<hash>.<ext>` and `index.json` (see [ASSETS.md](ASSETS.md)).             |
| `thumbs/`     | Home screen thumbnails: `<sha1(path)>-<width>.png`.                                              |

`daemon.json` is only removed by its own pid (`removeDaemonInfo(dir, process.pid)`): an old daemon that exits does not delete a newer one's file.

### File index and thumbnails

`files.json`: `{ version: 1, folders: string[], files: { [path]: { folder?, tags, favorite?, addedAt, lastOpenedAt? } } }`, with virtual folders nested by `/` (`Clients/Acme`). `files.ts` keeps one index per `DocumentStore`: files that are opened, created and saved are added automatically (store events); writing is atomic and queued.

- `GET /api/files?folder=&tag=&query=&favorites=1&recursive=1`: joins the index, the recents (`recent`: position in `recent.json`) and the open ones (`open`, `docId`). `folder` lists only the files directly in the folder (`recursive=1` includes subfolders; `/` = no folder); `query` searches name, tags and the nodes' text (`documentText`, cached by mtime), accent-insensitive.
- `POST /api/files/meta` (`{ path, folder?, tags?, addTags?, removeTags?, favorite? }`), `/folders` (`create`, `rename` moves subfolders and files, `delete` moves the files up to the parent folder), `/add` (file or folder, up to 2 levels) and `/forget` (removes the file from the list for good without touching the disk: an open document is closed first, saving pending changes, then the index entry, the `recent.json` entry and the cached thumbnails go; opening the file again registers it again).
- `POST /api/files/delete` (`{ path, dryRun? }`): deletes a `.mockup.json` and the `assets/` files only it uses, then forgets it. An open document is closed first (pending changes saved; no autosave can recreate the file). Exclusive-asset rule: `assets/` is shared by every document in the folder, so an asset referenced by this document (image `src`, `url(assets/...)`, fonts, video/poster, Lottie/Rive, repeater data sources, `assets/` attributes) is removed only when no other `.mockup.json` in the same folder uses it: siblings are parsed (`documentAssetPaths`) and compared normalized (forward slashes, URL-decoded, case-insensitive on Windows), and a plain mention of the path in their text (as written, decoded, URL-encoded, with backslashes, JSON-escaped) also keeps it, which is the only check for siblings that do not parse; open documents are checked in memory. If a sibling cannot be read, every asset is kept; unreferenced files are never touched; folders left empty in `assets/` are removed. Links: an asset is removed only when its `realpath` is `realpath(folder)/assets/<path>`, so a symbolic link or junction anywhere on the way (`assets/`, a subfolder, the file itself) leaves it alone (checked when planning and again right before removing); a `.mockup.json` that is itself a symbolic link only has the link removed (target and assets stay). A `src` counts as an asset on images (and video/embeds through their own fields); on other nodes only when it starts with `assets/`. The desktop app injects `trash` (`shell.trashItem`) into `startDaemon`, so files go to the Recycle Bin / Trash (`mode: "trash"`); the plain Node daemon deletes permanently (`mode: "permanent"`). A failing trash aborts before any asset is touched; the error says when the document was already closed (it stays closed, changes saved, file still on disk). Responds `{ path, name, open, mode, trashName, assets, keptAssets, failedAssets }`; `dryRun` only returns the plan. 404 missing file (an open document never saved to disk gets a message saying so; the home screen card shows it as not found and disables **Delete file…**), 400 relative path, folder or another extension. `/forget` validates the path the same way (absolute `.mockup.json`, 400 otherwise).
- `GET /api/files/thumbnail?path=&w=480`: first visible frame of the first page with frames, via the `RenderProvider` (`maxWidth` up to 1024), cached in `thumbs/` and invalidated by mtime. Closed document: images from `assets/` are inlined as data URLs in a clone (up to 20 MB); embedded fonts are not yet. Only for files in the index, the recents or open ones (an `<img>` sends no Origin; any other path gives 404). 503 without render, 404 without a file or without frames.
- `GET /api/search/nodes?query=&docId=`: the core's `searchNodes` over the open documents.

### Writing

- `create` uses `normalizeDocumentPath` (`.json` becomes `.mockup.json`) and opens with the `wx` flag: it never overwrites (error `The file already exists`).
- Each document has a save queue (`saveChain`): there are never two simultaneous writes to the same file. `dirty` only goes back to `false` if the written revision is still the current one.
- Writing to a unique temporary file (`<file>.<pid>.<ts>.<counter>.<random>.tmp`) followed by `rename`, with 3 retries (50, 100 and 200 ms) on `EPERM`/`EBUSY`/`EACCES`. On error, the temporary file is removed.

The default port is 4747. It can be set with `--port` or `MOCKUP_PORT` (and `port` in `config.json`).

## Daemon discovery by the CLI

`mockup mcp`:

1. Reads `daemon.json` from the data folder.
2. Checks it with `GET /api/health` on the registered port.
3. If it responds, uses that daemon (if it has no render, see "Daemon without render" below). Otherwise (file missing, stale or unresponsive), starts a detached headless daemon and waits for it to become healthy. The order of preference is:
   1. **Headless Electron** (with screenshot): `<exe> [app] --headless --port <port>`, detached, without `ELECTRON_RUN_AS_NODE`. `MOCKUP_DATA_DIR` is only passed along if the user set it: otherwise headless uses the same `userData` (and the same single-instance lock) as the app opened from the Start menu. The CLI waits for `/api/health` with `render: true` (30 s); output goes to `daemon.log` in the data folder.
   2. **Node daemon** (no render), if Electron is not found, exits before responding or times out. The CLI logs the reason to stderr and warns that screenshot and measured layout are unavailable.
4. Proxies stdio to Streamable HTTP at `mcpUrl`.

Electron is looked up in `locateElectron` (`packages/cli/src/electron.ts`), in this order:

| Order | Source                                                                                                             |
| ----- | ------------------------------------------------------------------------------------------------------------------ |
| 1     | `MOCKUP_DESKTOP_EXE`: path to the executable (packaged app or Electron binary), if it exists.                      |
| 2     | Folder recorded in the registry (`InstallLocation` of the uninstall key, HKCU then HKLM): covers a custom folder.  |
| 3     | Per-user NSIS install: `%LOCALAPPDATA%\Programs\Mockup Studio\Mockup Studio.exe` (Windows).                        |
| 4     | Development package: built `@mockup/desktop` (`out/main/index.js`) with the `electron` binary from `node_modules`. |

`MOCKUP_NO_ELECTRON=1` disables the lookup and forces the Node daemon. `mockup serve --render` uses the same lookup, but runs headless Electron in the foreground (inherited stdio) and fails with a message if it does not find it; without `--render`, `mockup serve` starts the Node daemon, which serves the editor at `/` when it is built.

The headless daemon started by `mockup mcp` (Electron or Node) keeps running after the proxy exits: it is terminated by a signal, by `mockup stop` or by the user.

### Daemon mode and shutdown over HTTP

`GET /api/health` reports `mode`: `desktop` (Electron app, with a window or headless), `headless` (Node daemon detached by the CLI) or `serve` (the user's `mockup serve`). `canShutdown` says whether `POST /api/shutdown` is accepted. The route has the same protection as the other writes (local Host, absent or local Origin), responds 202 and closes the daemon, saving the documents. Standalone Node and `mockup serve` end the process; headless Electron exits with `app.quit()`; the app with a window responds 409 and only closes through the window. `mockup stop` discovers the daemon and calls this route (without killing a process by pid).

### Daemon without render

If the daemon found has `render: false` and Electron is available, `ensureDaemon` acts according to the mode. In `headless` (started by the CLI): reads `GET /api/docs`, requests shutdown, waits for the port to free up and starts headless Electron, reopening the documents via argv; if Electron fails, it goes back to a Node daemon with the same documents. In `serve` (the user's): keeps the daemon and warns in the log that screenshot is unavailable and how to fix it (`mockup stop` or `mockup serve --render`). Documents without a file do not survive the switch. The desktop app does the same when it finds the port taken by a daemon without render: requests shutdown, waits, starts the embedded daemon and reopens its documents and those from argv. If the other one has render (another Electron instance), the window uses that daemon.

## Security

- **127.0.0.1 only**, no authentication. The `Host` header is validated on all routes (DNS rebinding).
- **Origin:** the WebSocket and HTTP writes (`/mcp` and `/api` other than GET/HEAD/OPTIONS) only accept an absent `Origin` or `http(s)` on `localhost`, `127.0.0.1` or `[::1]` (`isAllowedOrigin`). `file://` and `null` are **no longer** accepted: the desktop app serves the editor from the daemon itself, on the same origin.
- **App window:** `contextIsolation` on, `sandbox` on, no `nodeIntegration`. Navigation to another origin is blocked (`http(s)` links open in the browser) and `window.open` is denied. Only the clipboard (read and sanitized write) is allowed, and only for the daemon's origin.
- **Preload:** `window.mockupDesktop` is only exposed when the page comes from `http://127.0.0.1` or `http://localhost`; the IPC handlers check that the sending frame is from the daemon's origin.
- **Render window:** `sandbox`, `contextIsolation`, no `nodeIntegration` and no preload; it only loads the daemon's `/render.html`.
- **SVG and assets:** responses with a restrictive `Content-Security-Policy` and `nosniff` (see HTTP).
- **Exported CSS:** declarations whose value escapes the declaration are rejected on edit and discarded on read and on export (see [EXPORT.md](EXPORT.md)).

## Technical decisions

- **npm workspaces:** one repository, builds and tests with a single `npm install`; packages referenced by version (`0.1.0`).
- **ESM across the whole monorepo**, TypeScript with `tsc`.
- **core without DOM and without Node:** runs the same in the daemon, the editor, Electron and the tests.
- **MCP SDK 1.x** (`@modelcontextprotocol/sdk`). A v2 exists, distributed in separate packages; migration is left for later.
- **Express 5 and ws:** HTTP and WebSocket on the same server, with no additional framework.
- **zod 4:** validation of the file and of the tools' parameters.
- **Vitest 5:** unit and integration tests in every package.
- **Full document in the `doc:changed` event:** simplifies the clients in the MVP; op deltas are left for later optimization.
- **127.0.0.1 only:** local use, no authentication.
- **Electron 45 + electron-vite + electron-builder:** the main process is emitted as ESM with all dependencies bundled in (server, core, express, ws, MCP SDK, zod); only `electron` stays external, so the final package carries no `node_modules`. The preload is emitted as CJS (a sandbox requirement). The editor comes from `packages/editor/dist` (dev) or from `resources/editor` (packaged). Output in `dist/`: per-user NSIS installer and portable build, without code signing.
- **CDP `Page.captureScreenshot` instead of `capturePage`:** `capturePage` captures at the screen's scale and accepts neither `deviceScaleFactor` nor a clip outside the viewport. With `Emulation.setDeviceMetricsOverride` the render comes out at scale 1 to 3 with the node's `clip`. `capturePage` stays as a fallback if CDP fails.
- **Render window "shown" offscreen:** with a truly hidden window (`show: false` never displayed), Chromium's renderer falls back on `Page.captureScreenshot` on Windows. The window is created frameless, transparent, unfocused, out of the taskbar, at `x,y = -20000` and receives `showInactive()`.
- **`.mockup.json` association via ProgID:** Windows only sees the last extension (`.json`); registering `.json` as the default would hijack every JSON file. The installer (`build/installer.nsh`) creates the ProgID `MockupStudio.Document` (command `"<exe>" "%1"`) and lists it in `HKCU\Software\Classes\.json\OpenWithProgids`, so it shows up in "Open with". The uninstaller removes the keys.
- **Single base CSS for the document (`base.ts`):** `documentBaseCss` is the same source for the canvas, the render page and the exported code. On the canvas it is restricted to the container (`.cv-world`), with typography only on the frames, so as not to affect the UI's labels and badges. The editor UI's CSS does not leak into the design.
- **Single instance in the app:** `requestSingleInstanceLock` (per `userData`); a second run passes the files to the open app. Closing the last window with active MCP sessions leaves the app running in headless mode.
