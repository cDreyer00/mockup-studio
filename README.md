# Mockup Studio

An AI-oriented canvas design editor (artboards/frames) with an MCP server that can do everything the UI does. Local, offline-first, no account.

When you ask an agent (Claude Code, Codex) for a mockup, it drives the app over MCP to create, look at (screenshot) and edit the design. The document is real HTML and CSS stored in a readable JSON file (`*.mockup.json`).

## Features

- Canvas with frames (artboards), layers, properties, pages, undo/redo.
- Real HTML and CSS in `*.mockup.json`, with tokens as CSS variables.
- Full MCP server with 114 tools: everything the editor does, plus screenshots, measurements, images, icons and fonts.
- Node screenshots rendered by Electron, so the agent can see the result and iterate.
- Presentation mode: play a page as a slide show, one frame per slide (button, F5, desktop menu or MCP).
- Export to html, tailwind, react, svg, png and jpg.
- Offline, no account, local use.

![Mockup Studio editor](docs/img/editor.png)

## What's included

Monorepo with core, daemon, MCP server, visual editor, desktop app (Electron) with render engine and packaging, CLI with `doctor` and `setup`, and agent integrations.

On top of that: tokens and themes, native Tailwind, components, website snapshots, assets and real data, vectors and grid, effects and embeds, AI assistant, scripts and remix. Scope and design notes in [docs/PLAN.md](docs/PLAN.md).

## Installation

**Installer (Windows).** `npm run dist` builds `dist/MockupStudio-Setup-<version>-x64.exe`. The install is per user and adds the `mockup` CLI to the PATH (open a new terminal afterwards). A portable build is produced too; it does not register the `mockup` CLI (it runs from a temporary folder).

**From source.** Requirements: Node 24 and npm 11.

```bash
git clone https://github.com/cDreyer00/mockup-studio.git
cd mockup-studio
npm install
npm run build
npm link -w @mockup/cli     # creates the `mockup` command
```

To undo: `npm unlink -g @mockup/cli`.

## Register with your agent

```bash
mockup doctor            # diagnostics and registration commands
mockup setup all         # registers with Claude Code and Codex
claude mcp add --scope user mockup-studio -- mockup mcp   # or the manual command
```

Codex: `codex mcp add mockup-studio -- mockup mcp`. Details, HTTP, Cursor, VS Code, Windows and troubleshooting in [docs/INTEGRATION.md](docs/INTEGRATION.md).

## Quick start

- Ask the agent: "create a mockup of a landing page for a finance app, with desktop and mobile versions". It creates the frames, checks the screenshots and iterates.
- Open the editor to view and adjust: the desktop app or `npm run dev` (editor at http://localhost:5173, daemon at `http://127.0.0.1:4747`). Use **File › Open…** or, from the terminal, `mockup open examples/landing.mockup.json`.
- CLI commands: `mockup mcp` (stdio for agents), `mockup serve [--port N] [--render]`, `mockup open`, `mockup new`, `mockup stop`, `mockup doctor`, `mockup setup`, `mockup install-cli`, `mockup uninstall-cli`, `mockup --version`.

Editor guide, shortcuts and performance measurements in [docs/EDITOR.md](docs/EDITOR.md).

## Development

```bash
npm install
npm run build
npm run dev
```

`npm run dev` starts the daemon at `http://127.0.0.1:4747` and the editor at http://localhost:5173. No document is opened automatically.

## Desktop app (Electron)

The desktop app opens the editor in a native window (native menu, open/save dialogs), embeds the daemon (HTTP, WebSocket and MCP on the same port 4747) and the render engine that produces PNG/JPG screenshots of nodes.

```bash
npm run build                          # core, server, cli, editor and desktop
npm start -w @mockup/desktop           # editor window
npm start -w @mockup/desktop -- --headless --port 4747   # no window (daemon + render only)
npm start -w @mockup/desktop -- path/to/file.mockup.json   # opens the file
```

- **Headless:** `--headless`, `--port N`, `--data-dir D`. A second launch forwards the files to the running instance (and opens the window, if applicable). When the window is closed while MCP agents are connected, the app keeps running without a window.
- **`mockup mcp` and Electron:** with no daemon running, the CLI starts Electron headless (`MOCKUP_DESKTOP_EXE` variable, the default install at `%LOCALAPPDATA%\Programs\Mockup Studio` or the monorepo package) and screenshots are available. Without Electron, it falls back to the Node daemon (no screenshots). `MOCKUP_NO_ELECTRON=1` forces the Node daemon. If a headless Node daemon (no screenshots) started by the CLI is already running, it is replaced by headless Electron with the same documents open; a `mockup serve` you started yourself is not killed (the CLI warns). `mockup stop` shuts down the discovered daemon (the windowed app refuses: close it from its window). `MOCKUP_DATA_DIR` is only forwarded to the app if you set it. `mockup serve --render` runs headless Electron in the foreground; `mockup serve` (Node) also serves the editor at `http://127.0.0.1:4747/` if the editor has been built.
- **Render over HTTP:** `GET /render/<docId>/<nodeId>.png?scale=1|2|3&transparent=1`, `.jpg?quality=90` and `.svg`.
- **Packaging:** `npm run dist` (from the root, after the build) writes to `dist/` the NSIS installer (`MockupStudio-Setup-*.exe`, per user, with folder choice) and the portable build (`MockupStudio-Portable-*.exe`), plus `dist/win-unpacked/`. No code signing.
- **File association (Windows):** Windows only sees the last extension of `.mockup.json` (`.json`), so the installer does NOT take over `.json`. It registers the `MockupStudio.Document` ProgID and lists it under "Open with" for `.json` files; the app opens the file passed as an argument. Icons: `npm run icons -w @mockup/desktop`.

Architecture details in [packages/desktop/README.md](packages/desktop/README.md).

## Tests

```bash
npm test                     # unit tests (Vitest) for all packages
npx playwright install chromium   # once
npm run test:e2e             # editor e2e (Playwright) + media integration in Electron
npm run test:e2e:desktop     # only the effects/video/embeds integration in real Electron
npm run screenshot           # regenerates docs/img/editor.png
npm run lint
```

## Repository layout

```
packages/
  core/      @mockup/core    model, ops, History, HTML <-> nodes, exporters, zod schema
  snapshot-core/ @mockup/snapshot-core website capture into nodes (used by the server and the extension)
  server/    @mockup/server  daemon: documents, HTTP, WebSocket, MCP
  cli/       @mockup/cli     `mockup` command (mcp, serve, open, new, stop, doctor, setup, install-cli, uninstall-cli)
  editor/    @mockup/editor  Vite + React 19 + zustand: visual editor (e2e in editor/e2e)
  desktop/   @mockup/desktop Electron shell, render engine and packaging
  extension/ @mockup/extension Chrome extension for page snapshots
docs/        PLAN, ARCHITECTURE, MCP, EDITOR, EXPORT, INTEGRATION and a guide per feature
integrations/ Claude Code skill and AGENTS.md snippet for Codex
examples/    example documents
kits/        ready-made component kits (.mockup.json)
```

## Documentation

- [docs/PLAN.md](docs/PLAN.md): MVP scope and later phases
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md): packages, file format, ops, WS protocol, HTTP
- [docs/MCP.md](docs/MCP.md): connection, conventions and tools
- [docs/EDITOR.md](docs/EDITOR.md): using the editor, shortcuts, panels and performance
- [docs/EXPORT.md](docs/EXPORT.md): html, tailwind, react and svg exporters
- [docs/INTEGRATION.md](docs/INTEGRATION.md): registering with Claude Code, Codex and other clients
- [packages/desktop/README.md](packages/desktop/README.md): Electron app, render and packaging

Feature guides:

- Tokens with groups and themes as real CSS: [TOKENS.md](docs/TOKENS.md).
- Tailwind classes in the model: [TAILWIND.md](docs/TAILWIND.md).
- Components: [COMPONENTS.md](docs/COMPONENTS.md).
- Website snapshots: [SNAPSHOT.md](docs/SNAPSHOT.md).
- Assets and real data: [ASSETS.md](docs/ASSETS.md), [DATA.md](docs/DATA.md).
- Vectors and grid: [VECTORS.md](docs/VECTORS.md), [GRID.md](docs/GRID.md).
- Animated effects (shaders and particles), render with `time` and mp4, webm and gif export: [EFFECTS.md](docs/EFFECTS.md).
- Video, Lottie, Rive, YouTube, iframe, Three.js islands and offline use: [EMBEDS.md](docs/EMBEDS.md).
- AI assistant, scripts and remix: [ASSISTANT.md](docs/ASSISTANT.md), [SCRIPTS.md](docs/SCRIPTS.md).

## License

MIT. See [LICENSE](LICENSE).
