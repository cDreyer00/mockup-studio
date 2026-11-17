# Agent integration

How to register the Mockup Studio MCP server in Claude Code, Codex CLI and other clients. Tool reference in [MCP.md](MCP.md).

## 1. Prerequisites and CLI installation

All clients use the `mockup` command (`mockup mcp` speaks MCP over stdio). There are two ways to install it.

**From source** (Node 24, npm 11):

```bash
npm install
npm run build
npm link -w @mockup/cli
```

This creates `mockup`, `mockup.cmd` and `mockup.ps1` in npm's global folder, which is already on the PATH. To undo: `npm unlink -g @mockup/cli`.

**From the app installer** (`npm run dist` produces `dist/MockupStudio-Setup-<version>-x64.exe`):

- Installs per user and registers the CLI: `mockup.cmd` in `%LOCALAPPDATA%\MockupStudio\bin`, and that folder is added to the user's PATH. Open a new terminal afterwards.
- `mockup.cmd` runs the app's own executable as Node (`ELECTRON_RUN_AS_NODE=1`), so Node does not need to be installed.
- Uninstalling removes the shim and the PATH entry.
- Manual commands: `mockup install-cli` and `mockup uninstall-cli` (both accept `--bin-dir <folder>`), or `"Mockup Studio.exe" --install-cli` / `--uninstall-cli` (installation repair; the portable build refuses, because it runs from a temporary folder).

**Verify:**

```bash
mockup --version
mockup doctor          # --json for machine-readable output
```

`mockup doctor` checks:

- CLI and Node version (>= 24, or Electron's bundled Node)
- data folder
- daemon: running or not, mode (desktop, headless, serve) and whether render/screenshot is available
- port 4747: free, in use by Mockup Studio or taken by another program
- Electron available and system fonts
- `mockup`, `claude` and `codex` on the PATH, and whether `mockup-studio` is already registered
- the registration commands already filled in with the right path

## 2. Automatic registration

```bash
mockup setup claude          # Claude Code only
mockup setup codex           # Codex CLI only
mockup setup all             # both
```

Flags:

- `--http`: registers the HTTP transport (`http://127.0.0.1:4747/mcp`) instead of stdio.
- `--skill`: copies `integrations/claude-code/SKILL.md` to `~/.claude/skills/mockup-studio/SKILL.md`.
- `--print`: only prints the instructions, without running anything.
- `--force`: recreates the registration from scratch (`remove` + `add`), even when it is already identical. Discards extra fields (env, headers, approvals).
- `--approve` (Codex): writes `default_tools_approval_mode = "approve"` in the `[mcp_servers.mockup-studio]` section. Idempotent.
- `--agents` (Codex): appends the snippet from `integrations/codex/AGENTS.snippet.md` to `~/.codex/AGENTS.md` (or `$CODEX_HOME/AGENTS.md`), between `<!-- mockup-studio:start -->` and `<!-- mockup-studio:end -->`. Running it again does not duplicate: it updates what is between the markers and preserves the rest.
- `--command path|shim|absolute`: form of the registered command.
  - `path`: `mockup`, resolved via the PATH.
  - `shim`: absolute path of `%LOCALAPPDATA%\MockupStudio\bin\mockup.cmd`.
  - `absolute`: absolute path, without depending on the PATH. In the packaged app it is the app executable with `ELECTRON_RUN_AS_NODE=1`; from the repository, `node.exe` plus the CLI script.

Setup reads the current registration directly from `~/.claude.json` (or `$CLAUDE_CONFIG_DIR/.claude.json`) and from `~/.codex/config.toml` (or `$CODEX_HOME/config.toml`), without running `mcp get` (which starts the server and is slow). It is idempotent and does not destroy your config:

- Already registered with the same command: runs nothing ("nothing to do").
- Claude with a different command: warns that re-registering discards extra fields and runs `remove -s user` + `add --scope user`. If the server only exists in the local or project scope, it reports that and adds it in the user scope.
- Codex with a different command: edits only the section's launch keys in `config.toml` (`command`/`args`/`env`, or `url` with `--http`). Keys such as `default_tools_approval_mode`, timeouts, comments (including at the end of the line) and the other sections are left as they are. An inline `env = { ... }` is updated inline.
- Transport switch in Codex: when moving to `--http`, it removes `command`, `args`, `env`, `env_vars` and `cwd` (Codex does not accept these keys on an HTTP server and does not start); when going back to stdio, it removes `url`, `bearer_token_env_var`, `http_headers` and `env_http_headers`. Setup lists what it removed.
- Before writing, setup checks the result with a TOML parser: if it is not valid or does not have the expected command, it writes nothing and suggests editing by hand or `--force`. An already invalid `config.toml` is flagged (line and column) by setup and by `mockup doctor`.
- Without the section in Codex: `codex mcp add`.
- Without the executables on the PATH, it prints the instructions.

`mockup doctor` shows the registered scope and command and warns (`!`) if the command differs from the current one. In Codex it also warns if `default_tools_approval_mode = "approve"` is missing (`mockup setup codex --approve`) or the snippet in `AGENTS.md` (`--agents`).

## 3. Claude Code

**stdio (recommended).** `mockup mcp` starts the daemon on its own and, with the app/Electron available, has screenshot:

```bash
claude mcp add --scope user mockup-studio -- mockup mcp
```

**HTTP.** Requires a running daemon (app open, `mockup serve --render` or `npm run dev`):

```bash
claude mcp add --scope user --transport http mockup-studio http://127.0.0.1:4747/mcp
```

Verify and remove:

```bash
claude mcp list                          # mockup-studio: mockup mcp - ✔ Connected
claude mcp remove mockup-studio -s user
```

Inside Claude Code, `/mcp` shows the server state and the tools.

**Skill (optional).** Teaches the workflow to the agent:

```bash
mockup setup claude --skill
```

Or copy [integrations/claude-code/SKILL.md](../integrations/claude-code/SKILL.md) by hand to `~/.claude/skills/mockup-studio/SKILL.md`.

**Snippet for the global `CLAUDE.md`** (`~/.claude/CLAUDE.md`):

```markdown
## Mockup Studio

For requests for a mockup, screen, prototype or landing page, use the `mockup-studio` MCP server:

1. `get_guide('getting-started')`, then `create_document` at a project path (`design/<name>.mockup.json`).
2. `set_tokens` (colors, spacing, font) and `create_frame` (one frame per breakpoint: Desktop 1440x900, Tablet 768x1024, Mobile 390x844).
3. `write_html` one section at a time; `get_screenshot` after each one and fix until it looks right.
4. `export` (html, tailwind or react) if code is requested; `finish_working` when done.
```

## 4. Codex CLI

**stdio:**

```bash
codex mcp add mockup-studio -- mockup mcp
```

Works on Windows (verified with Codex CLI 0.163.0 and the `mockup.cmd` shim from `npm link`). The equivalent in `~/.codex/config.toml`:

```toml
[mcp_servers.mockup-studio]
command = "mockup"
args = ["mcp"]
```

On Windows, paths in TOML use `\\` or single-quoted literals (`'C:\path\bin.js'`).

**Environment variables.** Codex does not pass the whole environment to the MCP server. For `MOCKUP_PORT`, `MOCKUP_DATA_DIR` and similar, declare them in the config:

```toml
[mcp_servers.mockup-studio.env]
MOCKUP_PORT = "4747"
```

Or use `--env K=V` in `codex mcp add`.

**Tool approval.** Codex only lets through without asking the tools marked as read-only. The ones that write (`create_document`, `write_html`, `export`...) ask for approval, and in `codex exec` (policy `never`) they are **blocked** (`MCP tool call requires approval, but approval policy is never`). To allow the Mockup Studio ones, which only touch design documents and the export folder:

```toml
[mcp_servers.mockup-studio]
command = "mockup"
args = ["mcp"]
default_tools_approval_mode = "approve"
```

Or for a single run: `codex exec -c 'mcp_servers.mockup-studio.default_tools_approval_mode="approve"' "..."`. `mockup setup codex` does not turn this on by itself (it is a permission decision for the user): use `mockup setup codex --approve` to write the key.

**AGENTS.md.** Without the snippet from [integrations/codex/AGENTS.snippet.md](../integrations/codex/AGENTS.snippet.md), a request such as "create a login screen mockup" makes Codex hand-write an HTML instead of using the MCP. `mockup setup codex --agents` installs the snippet in `~/.codex/AGENTS.md`, between markers and without duplicating.

**HTTP** (daemon running):

```bash
codex mcp add mockup-studio --url http://127.0.0.1:4747/mcp
```

```toml
[mcp_servers.mockup-studio]
url = "http://127.0.0.1:4747/mcp"
```

Verify:

```bash
codex mcp list
codex mcp get mockup-studio
```

**Windows:** if some environment cannot find `mockup`, register the absolute command: `mockup setup codex --command absolute`.

**AGENTS.md (by hand).** Instead of `--agents`, paste the contents of [integrations/codex/AGENTS.snippet.md](../integrations/codex/AGENTS.snippet.md) into `~/.codex/AGENTS.md` (global) or the project's `AGENTS.md`.

## 5. Other clients

Clients with `mcpServers` JSON:

- Cursor: `~/.cursor/mcp.json` (global) or `.cursor/mcp.json` (project).
- Claude Desktop: `%APPDATA%\Claude\claude_desktop_config.json`.

```json
{
  "mcpServers": {
    "mockup-studio": {
      "command": "mockup",
      "args": ["mcp"]
    }
  }
}
```

VS Code, in `.vscode/mcp.json`:

```json
{
  "servers": {
    "mockup-studio": {
      "type": "stdio",
      "command": "mockup",
      "args": ["mcp"]
    }
  }
}
```

HTTP variant (daemon running):

```json
{
  "servers": {
    "mockup-studio": {
      "type": "http",
      "url": "http://127.0.0.1:4747/mcp"
    }
  }
}
```

If the client does not resolve `mockup.cmd` without a shell, see the next section.

## 6. Windows

- With `npm link`, `claude mcp add --scope user mockup-studio -- mockup mcp` works: Claude Code resolves the `mockup.cmd` shim. So does Codex (verified).
- Claude Code does not need `cmd /c mockup mcp`.
- Clients that do not resolve `.cmd` without a shell: use `cmd /c mockup mcp` or the absolute path printed by `mockup doctor`, for example `"C:\Program Files\nodejs\node.exe" "C:\...\packages\cli\dist\bin.js" mcp`.
- In Git Bash, `/c` is converted to `C:/`. Write `cmd //c` or use PowerShell.
- With the installer, `mockup.cmd` lives in `%LOCALAPPDATA%\MockupStudio\bin`. Open a new terminal after installing for the PATH to take effect.

## 7. How it works

- `mockup mcp` speaks MCP over stdio with the client and acts as a proxy to a single daemon at `127.0.0.1:4747`.
- The daemon is shared with the editor: what the agent does shows up on the canvas in real time, and the editor's selection reaches the agent.
- If there is no daemon, the CLI starts headless Electron (with the render engine, required for screenshot). Without Electron, it falls back to a Node daemon, with no screenshot. `MOCKUP_NO_ELECTRON=1` forces the Node daemon.
- `mockup stop` stops the daemon (the app with a window refuses: close it from the window).
- Variables: `MOCKUP_PORT` (default 4747), `MOCKUP_DATA_DIR`, `MOCKUP_DESKTOP_EXE`, `MOCKUP_NO_ELECTRON=1`.

## 8. Troubleshooting

- Start with `mockup doctor`.
- **Tools do not show up:** `claude mcp list` / `codex mcp list`; register again with `mockup setup all`.
- **Screenshot unavailable:** the daemon is in Node mode, without render. Open the app, or `mockup stop` and let `mockup mcp` start headless Electron. Check that Electron was found (`MOCKUP_DESKTOP_EXE`).
- **Port in use:** another program is using 4747. Use `MOCKUP_PORT` (the same value in the client and the daemon) or free the port.
- **Logs:** `daemon.log` in the data folder. Default on Windows: `%LOCALAPPDATA%\MockupStudio`; on other systems, `~/.mockup-studio`; `MOCKUP_DATA_DIR` changes the folder.
- In the MCP: `get_guide('troubleshooting')` and `get_guide('setup')`.
