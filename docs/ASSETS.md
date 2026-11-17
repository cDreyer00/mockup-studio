# Assets and images

A document's images and fonts live in `assets/`, next to the `.mockup.json`. The daemon serves these files, gives each one a **stable direct link** (a content-addressed local CDN), keeps a global **library**, counts where each asset is used and optimizes images. Everything works offline.

## Where files live

| Location                    | Contents                                                                                                            |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `<document folder>/assets/` | Document assets (images, `fonts/`, `placeholders/`). Nodes use paths relative to it.                                |
| `<data folder>/cdn/`        | Local CDN and library: `<hash>.<ext>` by content and `index.json` with name, type, size, dimensions, date and tags. |

`hash` is the first 32 hexadecimal characters of the SHA-256 of the bytes. The same content always gives the same link, in any document, with the document closed and after restarting the daemon. Without a data folder (tests), the CDN uses a temporary folder of the process.

A `/cdn` link used directly as `src` (or in `url(...)` and in repeater data) works on the canvas and in the screenshot while the daemon is running. On a code `export` (html, tailwind, react), the daemon's own links (`127.0.0.1`/`localhost`, or relative `/cdn/...`) that the library knows become `assets/cdn/<hash>.<ext>` and the file is copied to `<output>/assets/cdn/`; the document does not change. For the mockup not to depend on the library, prefer a `src` relative to `assets/` (`upload_asset` without `library`).

## References and usage

`collectAssetRefs(doc)` (core, `assetRefs.ts`) finds where each file is used:

- `src` of `img` nodes (`src`);
- `url(assets/...)` in styles (`style`), for example `background-image`;
- files of `doc.fonts` (`font`);
- `src` coming from repeater data (`data`, see [DATA.md](DATA.md)).

This feeds the usage counter, "remove unused" and the rewriting of references during optimization (`rewriteAssetRefsOps`: `setSrc`, `updateStyles`, `setData` and `setFonts` in a single undo entry). Files cited by repeaters' `dataSource.path` are also kept.

## HTTP

| Route                                     | Description                                                                                                                                                                                                                                                                                                                                                                                                         |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /cdn/:hash.:ext`                     | File by content. `Cache-Control: public, max-age=31536000, immutable`, the assets CSP (`default-src 'none'`, `sandbox`), `nosniff` and `inline` for SVG (opens in the tab without running scripts). 404 for a nonexistent hash, an extension different from the registered one or an invalid name.                                                                                                                  |
| `GET /api/assets/:docId`                  | `{ assets }`: each file in `assets/` (recursive, without hidden and temporary files) with `path`, `name`, `ext`, `kind` (`image`/`font`/`other`), `mime`, `size`, dimensions, `mtime`, `hash`, `cdnUrl`, `uses`, `nodeIds` and `refKinds`. Read-only: `cdnUrl` is empty for a file not yet registered in the CDN (upload, link, `get_asset_url` and optimization register it). Document without a path: empty list. |
| `POST /api/assets/:docId?name=`           | Upload (raw binary body, up to 20 MB) → `{ src }`. Already existed.                                                                                                                                                                                                                                                                                                                                                 |
| `DELETE /api/assets/:docId?path=&force=1` | Removes a file. 409 if it is in use and without `force`.                                                                                                                                                                                                                                                                                                                                                            |
| `POST /api/assets/:docId/remove-unused`   | `{ dryRun? }` → `{ removed, kept }`. Only images and fonts without references.                                                                                                                                                                                                                                                                                                                                      |
| `POST /api/assets/:docId/link`            | `{ path }` → `{ hash, url, cdnPath }`: the direct link ("Copy link").                                                                                                                                                                                                                                                                                                                                               |
| `POST /api/assets/:docId/optimize`        | `{ paths?, maxWidth?, format?, quality? }` → `{ results: [{ path, newPath, before, after }], skipped: [{ path, reason }] }`.                                                                                                                                                                                                                                                                                        |
| `GET /api/library?query=`                 | `{ assets }` from the library (`hash`, `ext`, `name`, `mime`, `size`, dimensions, `addedAt`, `tags`, `url`). Accent-insensitive search by name and tag.                                                                                                                                                                                                                                                             |
| `POST /api/library?name=`                 | Sends bytes to the library → the item.                                                                                                                                                                                                                                                                                                                                                                              |
| `POST /api/library/:hash/import`          | `{ docId }` → `{ src }`: copies into the document's `assets/`, without overwriting (fonts into `fonts/`).                                                                                                                                                                                                                                                                                                           |
| `DELETE /api/library/:hash`               | Removes from the library.                                                                                                                                                                                                                                                                                                                                                                                           |

## Optimization (sharp)

`optimize_assets` and the `/optimize` route use [sharp](https://sharp.pixelplumbing.com/), an **optional** dependency of `@mockup/server`, loaded with a dynamic `import()`:

- shrinks to `maxWidth` without enlarging; converts to WebP (default) or keeps the format (`format: 'keep'`), `quality` defaults to 82;
- ignores SVG, GIF and animated images;
- writes `name.webp` (or `name-optimized.<ext>`), without overwriting, and only swaps the references if the result is smaller;
- does not delete the originals: use `remove_unused_assets` afterwards.

Without the module, the tool responds with an error explaining how to install it (`npm install sharp -w @mockup/server`). sharp is left out of the desktop app and packaged CLI bundles (it is native): in development it is resolved from the repository's `node_modules`; in the installed app it is copied along with its dependencies and the build platform's binary (`@img/sharp-win32-x64`) into `resources/native/node_modules` (`extraResources` in `electron-builder.yml`), where the server looks for it when the normal `import()` fails (also via `MOCKUP_NATIVE_MODULES`).

## Image adjustments

All in real CSS on the `img` node (core, `image.ts`), the same on the canvas, in the screenshot and in the exported code:

| Adjustment | Property          | Values                                                                                                                                                                                             |
| ---------- | ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Fit        | `object-fit`      | `cover`, `contain`, `fill`, `none`, `scale-down`.                                                                                                                                                  |
| Position   | `object-position` | Presets `center`, `top`, `bottom`, `left`, `right`, `top-left`... or CSS (`30% 70%`).                                                                                                              |
| Filters    | `filter`          | `blur` (px), `brightness`, `contrast`, `saturate` (%; 100 = neutral), `hue-rotate` (deg), `sepia`, `grayscale`, `invert` (%), `opacity` (%). Unknown functions (e.g. `drop-shadow`) are preserved. |
| Crop       | `object-view-box` | `inset(t% r% b% l%)` over the original image. Supported in Chromium (canvas, render, Electron); other browsers ignore the property and show the whole image.                                       |
| Mask       | `clip-path`       | Ready-made shapes: `circle`, `ellipse`, `rounded`, `triangle`, `diamond`, `pentagon`, `hexagon`, `star`, `arrow`, or any CSS `clip-path`.                                                          |

## Placeholders

`generate_placeholder` (and the **Generate** button in the Image section) creates SVGs locally, without a network, **deterministic by seed** (`placeholders.ts`, mulberry32 PRNG over FNV-1a): `avatar` (person or initials with `label`), `product` (bottle, box or bag), `landscape` (sky, sun and mountains) and `logo` (geometric mark + name). With a saved document, the file goes to `assets/placeholders/<type>-<seed>-<W>x<H>.svg` (reused if the content is the same); without a path, it is inlined as a data URL.

## Editor

- **Assets tab** (left panel, next to Layers): thumbnail grid, search, "Unused" filter, usage counter (clicking selects the nodes), upload by dragging or with the **Upload** button, **Insert** (into the selected node or into the container at the center of the screen) and drag onto the canvas, **Copy link** (`/cdn` URL), **Remove**, **Remove unused** (with the list before confirming), **Optimize** (WebP, optional maximum width) and the **Library** section (search, import, upload and remove).
- **Image section** (properties): replace image, fit, position (3×3 grid and free field), filters with sliders (live preview and one undo entry on release), mask, crop and placeholder.
- **Visual crop**: **Crop** button or double click on the selected image. The image appears whole with the outside area darkened and a rectangle with 8 handles; dragging inside moves the crop. Enter, **Apply** or clicking outside confirms; Esc cancels. Writes `object-view-box` in a single op. With an `object-fit` other than `cover`/`fill`, the calculation uses `fill` and the panel warns.

## MCP

Tools in [MCP.md](MCP.md#assets-cdn-and-library) and [MCP.md](MCP.md#image-adjustments-and-placeholders); guide `get_guide('assets')`.
