# Site snapshot

Brings sections of real sites onto the canvas as **editable nodes** (real HTML/CSS, not an image). There are three entry points, all through the same daemon pipeline:

| Entry point                    | Who uses it | How                                                                                                                                       |
| ------------------------------ | ----------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Browser extension (MV3)        | User        | Selects the section under the cursor in any tab and sends it to the app (or copies it to paste with Ctrl+V in the editor).                |
| `import_url` / Import from URL | Agent       | The app opens the page in an isolated headless Electron, runs the capture on the selector and creates the frame. Needs the render engine. |
| `import_html`                  | Agent       | Full HTML (with `<style>`/`<link>`) rendered the same way; without a render engine it falls back to the core's HTML → nodes conversion.   |

## How it works

1. **Capture** (`@mockup/snapshot-core`, runs in the browser): walks the element's subtree and, for each node, reads `getComputedStyle` for a curated list of properties. Only what differs from the default is kept (each tag's default is measured in a hidden iframe with the same base CSS as the canvas document, `documentBaseCss`); inherited properties only appear when they change relative to the parent, and the root gets explicit typography. Sizes: `width`/`height` in px only when the element does not have an automatic size (tested by switching to `auto` and measuring, with the original `style` restored), always on the root and on replaced elements. `::before`/`::after` with content become real nodes; `fixed` becomes `absolute` relative to the root, `sticky` becomes `relative`. Images (`<img>`, `background-image`) and fonts (used `@font-face`) become assets, embedded as a data URL when the page allows reading the bytes. Limits: 3000 nodes, 40 levels (`stats.truncated` warns).
2. **Format** (`SnapshotPayload`, `packages/snapshot-core/src/format.ts`): the root node in the core's format, with `asset:<id>` references in the images' `src` and in `url("asset:<id>")` in styles, the asset list (original URL and, if any, the data URL), the fonts, the reference capture and warnings.
3. **Import** (daemon, `packages/server/src/snapshot/`): validates the payload, swaps the ids, turns the root into a frame (positioned to the right of the page's last frame), writes the images to `assets/` (unsaved document: data URL), embeds background images as a data URL (up to 2 MB; the canvas does not resolve relative `url()`s in styles), writes the fonts to `assets/fonts/` and registers them in `doc.fonts`, and creates next to it a hidden frame **"Reference — <name>"** with the screenshot. All in a single history entry (one undo reverts it).
4. **Simplification** (`planCleanup`, same logic in the MCP and the editor): removes empty wrappers, unwraps neutral wrappers with a single child and makes sizes fluid (a `width` in px equal to the parent's content width becomes auto; a `height` in px on blocks with content becomes `min-height`).

## Extension (Chrome and Edge)

### Install (developer mode)

1. `npm run build` (or just `npm run build -w @mockup/snapshot-core -w @mockup/extension`).
2. Open `chrome://extensions` (or `edge://extensions`) and turn on **Developer mode**.
3. **Load unpacked** and choose the `packages/extension/dist` folder.
4. Pin the "Mockup Studio — Capture section" icon to the toolbar.

After a new build, click "Reload" on the extension's card.

### Use

1. Keep Mockup Studio open (desktop app or `mockup serve`) with an active document. Save the document so images and fonts go to `assets/`.
2. On the site's tab, click the extension icon. Choose the destination: **Send to Mockup Studio** (default) or **Copy to paste (Ctrl+V)**. The daemon port (default 4747) is saved in the popup; the popup shows whether the app is running.
3. **Select section**: the outline follows the cursor and the label shows tag, classes and size. **↑** goes up to the parent element, **↓** goes back to the child, **Esc** cancels, click captures.
4. Sent: the frame appears on the canvas (toast "Sent to Mockup Studio (N nodes)"). If the app does not respond, the snapshot is copied and you just paste it into the editor with Ctrl+V.

The reference capture uses `chrome.tabs.captureVisibleTab`: only the visible part of the element goes into the image (see [Reference cropped to the viewport](#reference-cropped-to-the-viewport)).

### Manual test script for the extension

1. `npm run build -w @mockup/extension` (assembles `packages/extension/dist`).
2. `chrome://extensions` > **Developer mode** > **Load unpacked** > `packages/extension/dist`. Check that the id is `agjagmcpikghnfnnapjbicplkmommmkn` (fixed, comes from the manifest `key`; it is the only one the daemon accepts).
3. With Mockup Studio open and an active document, open a site and click the extension icon. The popup should show "Mockup Studio is running".
4. Choose **Send** (or **Copy**) and click **Select section**: the outline follows the cursor; test **hover**, **↑**, **↓** and **Esc** (cancels); click the section.
5. Send mode: toast "Sent to Mockup Studio (N nodes)" and the frame (plus the hidden "Reference") appears in the editor. Copy mode: toast "Copied", and Ctrl+V on the editor canvas creates the frame.
6. Close the app and repeat in Send mode: the toast says the app did not respond and that the capture was **copied**; open the app and paste with Ctrl+V.
7. Select a section larger than the window (or shrink the window): the imported frame carries the warning "The reference image covers only the visible part of the section...".
8. Huge section (thousands of large images): the error toast asks for a smaller section (see limits below).

### Size limits

- The content script captures with `maxInlineTotalBytes` of 32 MiB (the sum of the size of the embedded data URLs, in characters: ~4/3 of the bytes; the core's default is 40 MiB). What exceeds the limit keeps only the URL and the daemon tries to download it.
- The snapshot goes to the service worker through `chrome.runtime.sendMessage`, which Chrome limits to ~64 MiB per message. The extension measures the JSON (including the reference) and, above 48 MiB, removes the `dataUrl` of the largest assets until it fits (the daemon downloads them by URL) and adds a warning to `stats.warnings`; a reference that alone exceeds 24 MiB is removed (with a warning). If it still does not fit, the error toast says the section is too large and suggests a smaller one.
- User messages: app down (no response) copies to the clipboard and warns; a daemon HTTP error (400, 403, 413...) shows an error toast with the status and the `{ error }` message and does **not** copy; a `sendMessage` size failure shows the section-too-large message.

### Reference cropped to the viewport

The reference image is the `captureVisibleTab` cropped to the section's rectangle, limited to the visible part of the tab. When the rectangle goes past the viewport (on any side), the extension adds to `stats.warnings` "The reference image covers only the visible part of the section (WxH of W2xH2 px); scroll the page or use import_url for the full capture." (if none of the section is visible, there is no reference and the warning says so). `reference.width`/`height` are the size of the crop, consistent with the image. The editable frame always carries the whole section; only the reference is partial.

### What the e2e covers and what it does not

`packages/editor/e2e/snapshot-extension.spec.ts` has two blocks:

- **simulated activeTab** (a copy of `dist` with `host_permissions: ["<all_urls>"]`, same id): fixed id, send and fidelity on the canvas (dimensions and pixels), inline editing, copy mode + paste, cropped reference with a warning, app down (copies) and daemon HTTP error (does not copy). The start of the selector is called directly in the service worker.
- **real manifest** (`dist` unmodified: no `host_permissions`, with `key`): fixed id, popup with "running" status (ping), the service worker's POST passing the fixed id's Origin and CORS, rejection of injection without the user gesture (the popup shows "Could not start on this page.") and the full flow: CDP `Extensions.triggerAction` (Playwright's Chromium 159) plays the role of the icon click, opens the real popup and grants `activeTab` to the tab; the popup is driven by `Runtime.evaluate`.

It does not cover: the physical click on the toolbar icon (browser UI), the "pin extension" menu, Edge, reading the toasts (they live in a closed shadow root) and real sites (CSP, cookies, iframes).

### Permissions

`activeTab` (access to the tab only after the icon click), `scripting` (inject the selector) and `clipboardWrite` (copy). No `host_permissions` and no telemetry: the POST to `http://127.0.0.1:<port>/api/snapshot` leaves from the service worker with `Origin: chrome-extension://<id>`, and the daemon accepts that origin **only on that route** (with CORS and preflight); the other routes keep rejecting extension origins.

## Paste into the editor

The clipboard format is the payload JSON as plain text (starts with `{"format":"mockup-snapshot"`). In the editor, Ctrl+V with that content sends the snapshot to the daemon (`POST /api/snapshot`), centers the frame in the viewport, selects it and shows "Section imported (N nodes)" with the warnings, if any.

The editor also has:

- **Import from URL** (globe icon in the toolbar): URL, CSS selector (empty = whole page), viewport width (default 1440) and "Attach reference image". Needs the render engine (desktop app or `mockup serve --render`).
- **Simplify import** (context menu of a node with children, on the canvas or in the Layers): applies `planCleanup` in a single history entry.

## MCP

| Tool               | Use                                                                                                                                                 |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `import_url`       | `url` http(s), `selector` (default `body`), viewport `width`/`height` (default 1440x900), `timeout_ms` (default 20000, up to 60000).                |
| `import_html`      | `html`, `css`, `assets_base_url` (resolves relative URLs), `selector`, `width`/`height`. Without a render engine: core conversion (lower fidelity). |
| `cleanup_imported` | `nodeId` and the rules `remove_empty`, `unwrap`, `fluid` (all on by default).                                                                       |

The import tools also accept `name`, `reference`, `pageId`, `x`, `y` and `docId`. Suggested flow (`get_guide('import')`): import, `get_screenshot` of the frame and compare with the "Reference" frame, `cleanup_imported`, extract tokens from repeated colors with `set_tokens`. Details in [MCP.md](MCP.md#importing-sites).

## HTTP

| Route                   | Body                                                                            | Notes                                                                |
| ----------------------- | ------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| `POST /api/snapshot`    | `{ payload, docId?, pageId?, x?, y?, reference?, name? }` (or the bare payload) | Accepts local Origin and `chrome-extension://`. Body up to 64 MB.    |
| `POST /api/import/url`  | `{ url, selector?, viewport?: { width, height }, timeoutMs?, ...position }`     | 503 without a render engine.                                         |
| `POST /api/import/html` | `{ html, css?, assetsBaseUrl?, selector?, viewport?, timeoutMs?, ...position }` | Without a render engine uses the core conversion (`method: 'html'`). |

They respond with `SnapshotImportResult` (`docId`, `pageId`, `frameId`, `referenceId?`, `nodes`, `images`, `fonts`, `warnings`, `method`). Errors: 400 invalid body/URL, 404 nonexistent document or page, 409 no document open, 502 capture failure, 503 no render engine.

## Headless capture (desktop app)

The app's `RenderProvider.snapshot` (`packages/desktop/src/main/snapshot.ts`) opens **a new window per import**, in its own in-memory session (`mockup-snapshot`), and destroys it at the end:

- network: only `http`, `https`, `ws`, `wss`, `data`, `blob` and `about`; `file://` is canceled; permissions, downloads, popups and navigations after the initial one are denied; audio muted. Local network isolation is detailed in [Capture window isolation](#capture-window-isolation);
- exact viewport via CDP; after load it waits for the selector to appear (up to 5 s in `import_url` and `import_html` with `assets_base_url`, where the page's JS may build the DOM; up to 1 s in `import_html` without a base, static HTML with JS off), then `document.fonts.ready` and the images (up to 3 s). A selector that does not appear gives the error `Selector "..." not found ... (waited N s after load)`;
- the HTTP status of the main navigation (`import_url`) 4xx/5xx is **not** an error: the error page is imported (it may be what you want, e.g. the design of a 404) and the result carries the warning `The page responded HTTP <status>: ...`. A network failure (DNS, connection refused) is still an error;
- the capture runs in an isolated world (the page's JS does not interfere); the reference comes from `Page.captureScreenshot` with the element's rectangle;
- total deadline `timeout_ms` (default 20 s): once exceeded, the window is destroyed and the tool responds with an error.

### Capture window isolation

The imported page is untrusted code; the window prevents it from using the user's machine as a bridge (`packages/desktop/src/main/netguard.ts`, applied in `snapshot.ts`):

- **Daemon always blocked:** any request (main navigation included) to the daemon's origin (127.0.0.1/localhost/`[::1]` on its port) is canceled.
- **Main navigation free:** the imported URL can be any `http(s)`, including `localhost` and the local network (the user's dev server). Its origin (protocol, host and port) becomes the import's **trusted origin** and is updated if the server redirects. In `import_html` with `assets_base_url`, the trusted origin is that of `assets_base_url`; without it, no private origin is trusted.
- **Subrequests** (images, CSS, fonts, `fetch`/XHR, iframes, websockets...) to loopback (`127/8`, `::1`, `localhost`, `*.localhost`), private networks (`10/8`, `172.16/12`, `192.168/16`, `fc00::/7`), link-local (`169.254/16`, `fe80::/10`), `0/8`, CGNAT (`100.64/10`) and IPv4-mapped IPv6 are **blocked**, unless the origin equals the trusted origin. A page at `http://127.0.0.1:5173` loads its assets, but does not reach `http://localhost:5173` or `http://127.0.0.1:3000`.
- **DNS:** for host names (not IPs) the window resolves with `dns.lookup` (all addresses) before allowing and blocks if any is private; a resolution failure also blocks. The result is cached for 30 s per host.
- **JavaScript off in `import_html` without `assets_base_url`:** the HTML gets a `script-src 'none'` CSP (via `<meta>` right after the doctype), so the page's `<script>`, `on*=` handlers and `javascript:` do not run. The capture is not affected because it runs in an isolated world, which ignores the page's CSP. `webPreferences.javascript: false` was tested and **does not work**: it also turns off the isolated world and the import times out. With `assets_base_url` (and in `import_url`) the page is "real" and JS runs normally.
- **Residual risk:** Chromium's resolver is independent of Node's `dns.lookup` (its own cache, secure DNS/DoH, `/etc/hosts` and system resolvers may answer differently), and there is a window between the check and the connection (DNS rebinding). So blocking by name is a second line; the first is the IP/`localhost` literals, evaluated without DNS. The daemon's asset download has its own check at connection time (see below).

## Security and limits

- **Extension Origin:** `POST /api/snapshot` only accepts `chrome-extension://<fixed id>` (the id comes from the manifest `key`, `MOCKUP_EXTENSION_ID` in `@mockup/snapshot-core`); any other extension gets 403. Whoever packages the extension with a different key allows the new id through the daemon's `MOCKUP_EXTENSION_IDS` environment variable (comma- or space-separated list, 32-letter a-p ids, read on every request).
- **Local network in asset download:** the image and font URLs in the payload (which may come from the extension, the clipboard or the capture window) are downloaded by the daemon with its own client that rejects destinations in loopback (`127/8`, `::1`), private networks (`10/8`, `172.16/12`, `192.168/16`, `fc00::/7`), link-local (`169.254/16`, `fe80::/10`), `0/8`, CGNAT (`100.64/10`), multicast/reserved and IPv4-mapped IPv6. The check is done at the connection's own DNS resolution (no window for DNS rebinding) and on every redirect (up to 5). **Exception:** URLs with the same origin (protocol, host and port) as `source.url`, the imported page; this way importing from a dev server on `localhost` downloads its assets. The failure becomes an import warning ("local network destination blocked: ...") and the asset is left without a file.
- **Dangerous URLs:** `javascript:` and non-image `data:` values in `href`, `src`, `action`, `formaction` and `xlink:href` (and in images' `src`) are removed and go into the "Items removed for security" warning.
- **Budget per import:** the sum of bytes of loaded images and fonts (decoded or downloaded data URL) is limited to 150 MB (`MAX_IMPORT_TOTAL_BYTES`), in addition to 20 MB per file. When exceeded, a single warning reports it and the remaining assets are left without a file.
- **Viewport:** width from 320 to 3840 px and height from 200 to 4000 px (`IMPORT_VIEWPORT_LIMITS`), the same in the editor, the routes and the MCP.

## Limitations

- Pages behind a login only through the extension (`import_url` opens a clean session, with no cookies).
- `canvas`, `video`, `iframe`, `object` and `embed` become gray placeholders of the same size.
- Images and fonts from another origin without CORS: the extension cannot read the bytes and the daemon downloads them from the original URL; if the server requires cookies or blocks it, the image is empty (with a warning). Stylesheets from another origin without CORS may hide `@font-face` (the font falls back).
- Values are resolved at the capture viewport: percentages, `vw`, `fr` and `clamp()` become px. For another breakpoint, import again with another width.
- Animations, transitions, `:hover` and states are not included; only the state at the moment of capture.
- `counter()` in pseudo-elements is ignored; `list-style-image` and `border-image` with `url()` are not imported.
- The extension's reference capture only covers the visible part of the element (the extension warns; use `import_url` for the full capture).
- `cleanup_imported` is heuristic: check the screenshot afterwards (undo reverts it).

## Tests

- `packages/snapshot-core/test/capture.test.ts`: real capture in Playwright's Chromium of the fixtures in `packages/snapshot-core/test/fixtures/` (header with nav, hero with image, button with pseudo-element; fonts; extra cases).
- `packages/server/src/snapshot.*.test.ts`: pipeline, routes (extension origin) and MCP tools with a fake render engine.
- `packages/desktop/src/snapshot.integration.test.ts`: `import_url` via MCP in the real headless Electron against a local page, measuring the time (< 10 s).
- `packages/editor/e2e/snapshot-extension.spec.ts`: the extension loaded in Playwright's Chromium, in two blocks (simulated activeTab with `host_permissions` only on the copy; and the real manifest, with popup, Origin/CORS, rejection without a gesture and full flow via CDP `Extensions.triggerAction`). Details in [What the e2e covers and what it does not](#what-the-e2e-covers-and-what-it-does-not).
- `packages/editor/e2e/snapshot-paste.spec.ts`: paste snapshot, simplify and the import URL dialog.
