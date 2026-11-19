# @mockup/desktop

Mockup Studio desktop app (Electron): editor window, embedded daemon, render/screenshot engine and headless mode.

## How to run

```bash
npm run build                                   # at the root (needs core, server and editor built)
npm start -w @mockup/desktop                    # window
npm start -w @mockup/desktop -- --headless --port 4747 --data-dir D:\data file.mockup.json
npm test -w @mockup/desktop                     # unit + real integration with headless Electron
npm run dist                                    # root: build + NSIS installer and portable build in dist/
npm run icons -w @mockup/desktop                # regenerates build/icon.png and build/icon.ico from build/icon.svg
```

## Architecture

- **Build:** electron-vite. The main process is emitted as ESM (`out/main/index.js`) with ALL dependencies bundled (server, core, express, ws, MCP SDK, zod...); only `electron` is external, so the final package ships no `node_modules`. The preload is emitted as CJS (`out/preload/index.cjs`, a sandbox requirement). There is no renderer build: the editor comes from `packages/editor/dist` (in dev) or from `resources/editor` (packaged, via `extraResources`, alongside `resources/docs`).
- **Main process** (`src/main/index.ts`): starts `startDaemon({ render, editorDir, openFiles, writeInfo: true })` in-process (port 4747, same `daemon.json` as the CLI) and opens a `BrowserWindow` at `http://127.0.0.1:<port>/` (`contextIsolation`, `sandbox`, no `nodeIntegration`; navigation to other origins blocked, http(s) links go to the browser). Single instance (`requestSingleInstanceLock`): a second run forwards the files and opens the window. If the port already has a Mockup Studio daemon without render (Node), the app asks for `POST /api/shutdown`, waits for the port to be released, starts its own daemon and reopens the other one's documents and those from argv. If the other one has render (another Electron instance), the window uses that daemon; in headless mode the app exits with code 1. With `--headless`, `POST /api/shutdown` (`mockup stop`) stops the app; with a window, it responds 409.
- **Lifecycle:** headless mode has no window and does not quit on `window-all-closed`. In window mode, when the last window closes the app keeps running headless if there are active MCP sessions (checked every 5 s) and quits when they drop to zero; with no sessions, it quits immediately. `before-quit` closes the daemon (saves pending changes) and the render. Only with `--data-dir` or `MOCKUP_DATA_DIR` set by the user before starting (the CLI does not force it) does Electron's `userData` go to `<folder>/electron`, which isolates the single-instance lock.
- **Menu** (`src/main/menu.ts`): native File, Edit, View and Help menus. Shortcuts the editor already handles on the keyboard (Ctrl+S, Ctrl+Shift+S, Ctrl+Z, Ctrl+Shift+Z, `-`, Shift+Plus, Shift+0, Shift+1) are only displayed (`registerAccelerator: false`) so they do not fire twice. The "Open recent" list comes from `recent.json` and is rebuilt when the window gains focus and when the editor reports a state change.

### Editor bridge (preload and IPC)

`window.mockupDesktop` only exists when the page comes from `127.0.0.1`/`localhost`:

| API                                        | IPC channel                                                                                                                                        |
| ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `showOpenDialog()`                         | `desktop:openDialog` (invoke)                                                                                                                      |
| `showSaveDialog({ title?, defaultPath? })` | `desktop:saveDialog` (invoke); the path comes back ending in `.mockup.json`                                                                        |
| `onMenu(cb)`                               | `desktop:menu` (main → renderer)                                                                                                                   |
| `setPresentationFullScreen(on)`            | `desktop:presentationFullScreen` (invoke); resolves with whether the window is full screen afterwards; leaving restores the pre-presentation state |
| `onLeaveFullScreen(cb)`                    | `desktop:leaveFullScreen` (main → renderer), fired on the window's `leave-full-screen`                                                             |
| `setDocumentState({ title, path, dirty })` | `desktop:docState` (send); window title with `•` when dirty, `setRepresentedFilename`/`setDocumentEdited`                                          |

Menu actions: `new`, `open`, `openRecent` (with the path in `arg`), `save`, `saveAs`, `close`, `undo`, `redo`, `zoomIn`, `zoomOut`, `zoomReset`, `zoomFit`, `presentFromStart`, `presentFromCurrent` (View menu, F5 / Shift+F5, display only). The IPC handlers check that the sender frame is from the daemon's origin.

## RenderService (`src/main/render.ts`)

Implements `RenderProvider` (`capture` and `measure`) from `@mockup/server`.

- A reusable `BrowserWindow` (sandbox, no preload) loads `/render.html` and waits for `window.__mockupRenderReady === true`. It is recreated if the render process dies (`render-process-gone`) or hangs (30 s timeout per operation). Operations go into a serial queue.
- **Render page contract:** `window.__mockupRender.render({ doc, docId, nodeId, transparent? })` returns `RenderBox { frameId, frameWidth, frameHeight, x, y, width, height }` (the node's frame is rendered at 0,0; x/y/width/height is the node's rectangle relative to the frame, in CSS px) and `window.__mockupRender.measure(nodeId)` returns the `LayoutNode`.
- **Capture via CDP** (`webContents.debugger`, protocol 1.3): `Emulation.setDeviceMetricsOverride` with a viewport ≥ frame (width/height declared in the style or, if missing, measured by a first render, repeating the render when the viewport grows) and `deviceScaleFactor = scale`; alpha 0 background with `transparent`; then `Page.captureScreenshot` with the node's `clip`. If CDP fails, it falls back to `capturePage` (ignores the scale).
- Limit of 16384 px per side after scaling (clear error). JPG: `nativeImage.toJPEG(quality ?? 90)`. `maxWidth`: `nativeImage.resize` with `best` quality.
- 256 MB LRU cache (by bytes) keyed by the sha256 of `{ node's frame, tokens, fonts, page background, docId, nodeId, scale, format, quality, maxWidth, transparent, size and date of the referenced files }` (images, relative `url()`s and fonts in `assets/`): replacing a file keeping the same name invalidates the cache.
- The viewport (`frame × scale`) is validated against 16384 px per side before resizing the window. The render window denies `will-navigate` and `window.open`.
- **"Visible" off-screen window:** with a truly hidden window (`show: false` and never shown) Chromium's renderer falls back on `Page.captureScreenshot` on Windows. So the render window is created frameless, transparent, unfocused, outside the taskbar and positioned off-screen, and receives `showInactive()`.
- `MOCKUP_RENDER_DEBUG=1` logs the CDP commands; `MOCKUP_DISABLE_GPU=1` turns off GPU acceleration in headless mode.
- `captureFrames` captures N frames (`start + i/fps`, up to 1800) by calling `__mockupRender.setTime(t)` and `Page.captureScreenshot` for each frame, without cache; it is the basis of the mp4/webm/gif `export`.
- WebGL (effects): in `--headless` mode main turns on `enable-unsafe-swiftshader`, so without a GPU Chromium falls back to SwiftShader (software) and the screenshot of effects keeps working. The interactive window (which loads third-party iframes and YouTube) does not turn on SwiftShader: it uses the GPU, and without a GPU the effects show the fallback. `MOCKUP_RENDER_GL=swiftshader` enables and forces software rendering in any mode (`use-angle=swiftshader`, `use-gl=angle`), useful in a VM/CI.
- ffmpeg: in dev the daemon uses `ffmpeg-static` from `node_modules`; packaged, the binary goes in `resources/ffmpeg/` (`extraResources`, `ffmpeg.exe` on Windows, `ffmpeg` on macOS/Linux) and main sets `MOCKUP_FFMPEG` pointing to it.
  - `ffmpeg-static` **downloads the binary on `npm install`** (`install` script, from the project's GitHub, for the installer's platform and architecture). Without network on install, or with `--ignore-scripts`, the binary does not exist: the daemon looks for `ffmpeg` on the PATH and, without it, the mp4/webm/gif export fails with a clear error (the package ships without ffmpeg). To package for another platform, run the install on it (or set `npm_config_platform`/`npm_config_arch`, see the `ffmpeg-static` README). `MOCKUP_FFMPEG` (or `FFMPEG_BIN` on install) points to your own ffmpeg.
  - **License:** the `ffmpeg-static` binary is GPL-3.0-or-later (compiled with libx264). Distributing the packaged app with it means complying with the GPL for that binary (the `ffmpeg.exe.LICENSE`/`ffmpeg.LICENSE` and the README with the source origin go in `resources/ffmpeg/`). To avoid this, package without ffmpeg and use `MOCKUP_FFMPEG` with an ffmpeg installed by the user.

## Packaging (`electron-builder.yml`)

Output in `dist/` at the repository root. Windows targets: `nsis` (wizard, per user, folder choice; installs to `%LOCALAPPDATA%\Programs\Mockup Studio`) and `portable`. The Electron used comes from `node_modules/electron/dist` (`electronDist`, version pinned in the yml because the package declares a range). No code signing.

**File association:** Windows only sees the last extension of `*.mockup.json` (`.json`). Registering `.json` as the default would hijack every JSON file, so `build/installer.nsh` creates the ProgID `MockupStudio.Document` (command `"<exe>" "%1"`) and includes it in `HKCU\Software\Classes\.json\OpenWithProgids`, which makes it appear in "Open with". The uninstaller removes the keys. The app opens the file received in argv.

## Embedded CLI

The package ships the `mockup` CLI for those without Node. `scripts/build-cli.mjs` (esbuild, part of `npm run build -w @mockup/desktop`) produces `out/cli/mockup.mjs` and `out/cli/daemon.mjs` (ESM, node22 target, everything bundled) from `packages/cli/dist/bin.js` and `packages/server/dist/bin.js`; so cli and server must be built first. They go to `resources/cli/` (`extraResources`, outside the asar), alongside `resources/integrations/`. They run with the executable itself as Node: `ELECTRON_RUN_AS_NODE=1 "Mockup Studio.exe" resources\cli\mockup.mjs help`.

- **NSIS installer** (`build/installer.nsh`): on install it runs `install-cli --quiet`, which creates `%LOCALAPPDATA%\MockupStudio\bin\mockup.cmd` and adds the folder to the user's PATH (applies to new terminals). On uninstall it runs `uninstall-cli --quiet` (before deleting the files); on an in-place update the CLI is just reinstalled. `ELECTRON_RUN_AS_NODE` is set only during each call.
- **Repair:** `"Mockup Studio.exe" --install-cli [--bin-dir D] [--quiet]` and `--uninstall-cli` run the same command and exit with its code, with no window or daemon.
- **Portable:** does not register the CLI. The executable extracts itself to a temporary folder on every run, so a `mockup.cmd` pointing to it would break when the app closed; `--install-cli` refuses with a message (detects `PORTABLE_EXECUTABLE_DIR`). To use `mockup` with the portable build, install the CLI via Node (`npm link`) and point `MOCKUP_DESKTOP_EXE` to the portable executable if you want screenshots.
- **Manual undo:** `--uninstall-cli` (or `mockup uninstall-cli`); if the uninstaller cannot clean the PATH, the entry is left pointing to a nonexistent folder (harmless).

## References

- [docs/PLAN.md](../../docs/PLAN.md) (task 3)
- [docs/ARCHITECTURE.md](../../docs/ARCHITECTURE.md)
