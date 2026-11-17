# AI assistant

A chat in the editor talks to the canvas using the agent CLIs already installed on the machine: **Claude Code** (`claude`) and **Codex** (`codex`). The daemon opens the CLI as a subprocess, registers its own MCP in it, and the CLI edits the document through the same tools any external agent uses ([MCP.md](MCP.md)). There is no API key of its own: whichever account is already logged in to the CLI is used.

Each user request is a **turn**, and **each turn is a single undo step** in the editor.

## Overview

1. The user writes the request in the "Assistant" panel (with the current selection as context).
2. The daemon builds the context (document, selection, tree summary, screenshot) and starts the CLI.
3. The CLI connects to the daemon's MCP with a turn token and edits the canvas. The editor sees the changes live, as with any MCP edit.
4. The agent's text arrives in the panel by streaming. At the end, the final message carries the status, the tools used and how many ops were applied.

## Architecture

```
 editor (Assistant panel)
   │  WebSocket: assistant:send / cancel / history / clear / config
   │  ◄──────── assistant:event (turn-start, text, tool, tool-result, turn-end, cleared)
   ▼
 daemon (packages/server)
   AssistantService ── resolve backend ── AgentBackend.run(input, emit, signal)
        │                                      │
        │ turn token (resolveTurn)             ▼
        │                              CLI subprocess (claude -p / codex exec)
        │                              temporary cwd; prompt via stdin;
        │                              MCP config and system prompt via temporary file
        │                                      │  HTTP Streamable
        ▼                                      ▼
   DocumentStore.applyOps({ group })  ◄── MCP  /mcp?turn=<token>   (same daemon, 127.0.0.1)
```

Pieces:

- `packages/server/src/agent/assistant.ts`: `AssistantService` (turns, context, history, configuration, WS messages).
- `packages/server/src/agent/cli.ts`: `ClaudeCliBackend`, `CodexCliBackend`, JSONL parsers, `findExecutable`, `detectBackends`.
- `packages/server/src/agent/backend.ts`: the `AgentBackend` contract.
- `packages/server/src/mcp/session.ts` and `mcp/server.ts`: recognize the `?turn=` token and apply the turn's undo group.
- `packages/server/test/fixtures/fake-agent-cli.mjs`: the tests' fake CLI.

## Backends and detection

The `AssistantService` knows a list of backends (`claude`, then `codex`). The configuration `backend: "auto"` uses the first available one; you can also pin an id.

How the CLI is found (`findExecutable`):

- It searches the `PATH`. On Windows it respects `PATHEXT` and prefers `.exe` over `.cmd`/`.bat` (an `.exe` runs directly, without a shell).
- `.cmd`/`.bat` run via `shell: true` with a single already-quoted command (arguments with `"`, `%` or a line break are rejected; that is why no argument carries JSON).
- Override environment variables:

| Variable            | Effect                                                                                                                      |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `MOCKUP_CLAUDE_BIN` | Path to the Claude Code executable.                                                                                         |
| `MOCKUP_CODEX_BIN`  | Path to the Codex executable.                                                                                               |
| `MOCKUP_AGENT_CLI`  | Path to a `.mjs`/`.js` script: the `claude` backend runs `node <script>` instead (used in tests and e2e with the fake CLI). |

`MOCKUP_AGENT_CLI` is meant for tests/e2e and also applies in production: **it is not a security boundary**. Whoever controls the daemon's environment (environment variables, `PATH`, `MOCKUP_CLAUDE_BIN`) already controls which process it runs; that is why there is no `NODE_ENV` restriction. Do not set this variable outside of tests.

Each backend's `info()` returns `{ id, name, available, path?, detail? }` (`detail` = version from `--version`, or the reason for unavailability) and is cached for 30 s.

## Flags used

**Claude Code** (`claude`):

```
claude -p --input-format stream-json --output-format stream-json --verbose
  --include-partial-messages
  --tools ""                                  no built-in tools (Bash, Read, Edit...)
  --strict-mcp-config --mcp-config <file>     only the daemon's MCP (temporary file)
  --allowedTools mcp__mockup-studio           allows all tools of that server
  --permission-mode dontAsk                   anything not allowed is denied, without a prompt
  --setting-sources ""                        ignores the user's settings/hooks
  --disable-slash-commands
  --append-system-prompt-file <file>          system prompt via file (no quoting)
  [--model <m>] [--resume=<session_id>]
```

The `session_id` is only passed as `--resume=<id>` (a single argument, confirmed with the real CLI) and only if it matches `[A-Za-z0-9_][A-Za-z0-9_-]{0,127}`; see "History".

The prompt goes via stdin as a `stream-json` message:

```json
{
  "type": "user",
  "message": {
    "role": "user",
    "content": [
      { "type": "text", "text": "..." },
      { "type": "image", "source": { "type": "base64", "media_type": "image/png", "data": "..." } }
    ]
  }
}
```

**Codex** (`codex`):

```
codex exec [-i <image.png>] --json --skip-git-repo-check --ephemeral -s read-only -C <folder>
  [-m <model>]
  -c mcp_servers.<each user server>.enabled=false               (one -c per server)
  --disable shell_tool --disable unified_exec --disable apps    (only those that exist in the version)
  --disable browser_use --disable computer_use --disable in_app_browser
  -c mcp_servers.mockup_studio.url=<MCP url with ?turn=>
  -c mcp_servers.mockup_studio.default_tools_approval_mode=approve
```

The prompt (system prompt + context + request) goes via stdin. `approve` avoids blocking the tools that write in `codex exec`. The `-c` values stay unquoted: if they are not valid TOML, Codex uses the raw string, so nothing needs quotes in `.cmd`. The conversation is not resumed via `resume` (`--ephemeral` turns): the recent history is summarized in the prompt.

**Codex isolation.** `-c` only _adds_ to the user's config (`~/.codex/config.toml`), so without care the agent would inherit their global MCPs (including a `mockup-studio` over stdio, with no turn token) and the shell. That is why, before each turn, the backend queries Codex (with a 5 s timeout and 10 s cache):

- `codex mcp list --json`: each listed server gets `-c mcp_servers.<name>.enabled=false`; the turn's server uses the key `mockup_studio` (or `mockup_studio_turn` if the user already has a server with that name, so the turn URL never mixes with theirs);
- `codex features list`: the features `shell_tool`, `unified_exec`, `apps`, `browser_use`, `computer_use` and `in_app_browser` get `--disable` (only those the installed version lists; `--disable` of a nonexistent feature fails).

What **is** isolated: the configured MCP servers, the shell and unified execution, and the apps/browser/computer-use integrations. The `-s read-only` sandbox still applies as a second barrier.

What **cannot** be isolated:

- The user's config is still read (default model, `instructions`, profiles, hooks, plugins, the working folder's `AGENTS.md`): there is no stable flag to ignore it.
- If `codex mcp list` or `codex features list` fails or times out, the turn runs without that isolation (fail-open, recorded in the log; the failure is not cached). The user's shell and MCPs are back in that turn, but the `read-only` sandbox and the system prompt still apply.
- Servers whose name has characters outside `[A-Za-z0-9_-]` (dot, space, quotes) cannot be disabled: Codex does not accept a quoted key in `-c`. They are recorded in the log and stay active.
- Built-in tools that are not one of the features disabled above (e.g. web search) were not verified and stay as Codex defines them; the `read-only` sandbox limits what they write to disk.

In both: `windowsHide: true`, a dedicated working folder (outside the user's project), temporary files deleted at the end of the turn.

## Context sent

**System prompt**: role (design assistant inside Mockup Studio), use only the `mockup-studio` MCP tools, explicit `docId`, work on the selection, check with `get_screenshot`, do not call `undo`, call `finish_working` and reply briefly (1 to 3 sentences on what it did). The extra text from `RunTurnOptions.instructions` is appended.

**User prompt**:

- document: name and `docId`;
- selection: ids and `getTreeSummary(node, 3)` of each node (limited to ~6000 characters); with no selection, the summary of the frames;
- if there is a render engine, a screenshot of the first selected node (or the first frame), scale 1 and `maxWidth` 1024. A screenshot failure does not prevent the turn;
- with no session to continue, a short summary of the last messages of the conversation;
- the user's request.

## Streaming

Claude emits `stream_event` with `text_delta` (with `--include-partial-messages`): they become `text` events immediately, without repeating the text when the complete `assistant` message arrives. Messages separated by tools are joined with a blank line. Codex delivers each `agent_message` complete. `tool_use`/`tool_result` (Claude) and `mcp_tool_call` (Codex) become `tool` and `tool-result` (name without the `mcp__mockup-studio__` prefix, summary = first line of the result, up to 200 characters). Non-JSON lines from the CLI are ignored and recorded in the log.

## Undo group

- Each turn has a group `assistant:<turnId>` (or the `group` passed in `RunTurnOptions`, when another service nests a turn).
- The turn token (`crypto.randomBytes(16)`) goes in the MCP URL. The MCP passes the group to `store.applyOps(..., { group })`, and `History` merges consecutive applications of the same group into one entry: **a single Ctrl+Z undoes the whole turn**.
- `undo`/`redo` through the MCP are rejected within a turn. The agent corrects with the editing tools.
- At the end of the turn (success, error or cancellation) the group is closed, the token becomes invalid (old sessions reject writes; new sessions get 403) and the daemon calls `finishWorking` to clear the "agent working" badge.
- The final message's `opsCount` is the number of ops applied with the turn's group, counted by the `DocumentStore` in each `applyOps` (`groupOpsCount`), summing all the group's undo entries.

Limit: merging only applies to **consecutive** applications. If the user edits the document (or undoes) in the middle of the turn, the agent's next op opens a new entry: the turn then has more than one undo step (`opsCount` stays correct). While the turn runs, the assistant panel warns that user edits split the undo.

## Cancellation and timeout

- `assistant:cancel` aborts the turn: the CLI's process tree is terminated (Windows: `taskkill /pid <pid> /T /F`; others: process group). The turn ends with `status: "cancelled"`; what the agent had already done stays in the document and is undone by a single undo.
- Each turn has a timeout (default 10 minutes) that also kills the tree and ends with `status: "error"`.
- There is only one turn per document at a time: a second `send` while a turn is running is rejected.
- The service's `close()` (daemon shutdown) cancels everything and waits.
- If the daemon process exits (`process.on('exit')`) with agent subprocesses still alive, they are all killed synchronously (`SIGKILL` on each child's group outside Windows, where they run in their own group and would survive; on Windows, a single `taskkill /T /F`). The listener only exists while there are children.

## History

Decision: a **sidecar file per document**, next to the document: `a.mockup.json` → `a.assistant.json`; any other name just gets the suffix (`a.json` → `a.json.assistant.json`), so that `a.json` and `a.mockup.json` in the same folder do not share history. If there is an open document with the exact name of the sidecar file (e.g. `a.assistant.json`), that document's history stays in memory only instead of overwriting it. It does not go in the document (the project file does not get dirty or grow with conversation) and it travels with the project folder. Document without a path (not yet saved): history in memory only; on save, it starts being written.

```json
{
  "version": 1,
  "messages": [
    {
      "id": "msg_...",
      "role": "user",
      "text": "...",
      "turnId": "turn_...",
      "at": "ISO",
      "selection": ["..."]
    },
    {
      "id": "msg_...",
      "role": "assistant",
      "text": "...",
      "status": "done",
      "tools": [],
      "opsCount": 3,
      "backend": "claude"
    }
  ],
  "sessions": { "claude": "<Claude Code session_id>" }
}
```

- Up to 200 messages (the oldest drop off). Written (atomically: uniquely named temporary `<file>.<pid>.<n>.<random>.tmp` + `rename`) at the end of each turn and on `clear`; writes to the same file are serialized, in order; loaded on demand in `history(docId)`.
- `sessions` stores the `session_id` per backend: the next turn uses `--resume=<id>` (the working folder is stable per document, because the CLI stores the session per folder). If the resume fails before any tool or text, the turn is redone without it; if there was already text or a tool, the error is shown (redoing would repeat effects).
- The sidecar file is untrusted input (it may come from a downloaded project): only `session_id`s that match `[A-Za-z0-9_][A-Za-z0-9_-]{0,127}` are valid, both when loading the file and when receiving the session from the backend; the rest is silently discarded (the conversation just restarts without `--resume`). This way a value like `--settings={...}` never becomes a CLI argument.
- `ephemeral` turns (`RunTurnOptions.ephemeral`) do not enter the history.

## Configuration

`assistant:config` reads or writes `{ backend: "auto" | "claude" | "codex" | ..., models?: { <backend>: <model> }, model?: string }`, persisted in `<dataDir>/assistant.json` (with no data folder, in memory only).

- The model is **per backend** (`models`): a Claude id is no use to Codex, so in `auto` each backend receives only its own (`--model` on Claude, `-m` on Codex); with no model for the chosen backend, the CLI default applies. A `models` in the patch is merged into the current one; an empty value deletes the entry.
- `model` is a shortcut: on write it applies to the backend of the same patch (or the current one) and is rejected with `backend: "auto"` (use `models`); on read it returns the configured backend's `models[backend]`.
- Compatibility: an old `assistant.json` with only `model` now applies to the configured backend and, in `auto`, to `claude` (what `auto` picks first).
- An unknown `backend`, an unknown id in `models` or an invalid model are rejected.

`generateText` (used by script generation) accepts optional `docId` and `signal`: with `docId`, at most one generation per document (the second is rejected) and `assistant:cancel`/`cancel(docId)` also cancels it; `signal` cancels in any case. Without `docId`, up to 4 simultaneous generations.

## WebSocket protocol

Client to server (all with `reqId`; the ack carries the result):

| Message             | Fields                                      | Result                                                    |
| ------------------- | ------------------------------------------- | --------------------------------------------------------- |
| `assistant:send`    | `docId`, `prompt`, `selection?`, `backend?` | `{ turnId }` (the rest arrives via events)                |
| `assistant:cancel`  | `docId`                                     | `{ cancelled }`                                           |
| `assistant:history` | `docId`                                     | `{ messages, running: turnId \| null, backends, config }` |
| `assistant:clear`   | `docId`                                     | `{}` (rejected while a turn is in progress)               |

A missing, empty or non-text `docId` is rejected in `cancel`/`history`/`clear` ("requires docId"); a document that is not open returns the store's error ("Document not found...") — only the `cancel` of a turn still in progress on an already-closed document is accepted.
| `assistant:config` | `config?: { backend?, model?, models? }` | `{ config, backends }` |

Server to client: `{ type: "assistant:event", docId, event }`, with `event.kind`:

- `turn-start` `{ turnId, user, backend }`
- `text` `{ turnId, text }` (delta)
- `tool` `{ turnId, tool: { id, name, input } }`
- `tool-result` `{ turnId, toolId, ok, summary? }`
- `turn-end` `{ turnId, message }` (`message`: `status` `done | cancelled | error`, `text`, `error?`, `tools`, `opsCount`, `backend`)
- `cleared`

During a turn, `assistant:history` also returns the request and an assistant message with `status: "running"` (text and tools so far), so the editor can reconnect in the middle of the turn.

## Plugging in another backend (`AgentBackend`)

A backend implements (in `agent/backend.ts`):

```ts
interface AgentBackend {
  readonly id: string;
  readonly name: string;
  info(): Promise<AssistantBackendInfo>;
  run(
    input: AgentRunInput,
    emit: (ev: AgentRunEvent) => void,
    signal: AbortSignal,
  ): Promise<AgentRunResult>;
}
```

`AgentRunInput` carries `prompt`, `system`, `images`, `mcp` (`{ name, url }` with the turn token), `resumeSession`, `model` and `cwd`. The backend emits `text`, `tool`, `tool-result` and `session`, returns `{ text, sessionId? }`, rejects with a readable error on failure and with `AbortError` when the `signal` aborts. A direct API (no CLI) only needs to connect to the MCP at `input.mcp.url` (HTTP MCP client) and pass the tools on to the model. Register by passing `agentBackends` to `startDaemon` (or to the `backends` option of `AssistantService`).

## Security

- The MCP only listens on `127.0.0.1` (or the daemon's host) and `/mcp` validates the `Host`.
- The turn token is random (128 bits), is valid only while the turn runs and only ties the session to one document and one undo group; after it, writes are rejected.
- Claude runs without built-in tools (`--tools ""`), with `dontAsk`: only the `mockup-studio` MCP's tools are allowed. Codex runs in a `read-only` sandbox, with the user's MCPs, the shell and the integrations disabled by flag (limits in "Codex isolation").
- No key is read or stored by Mockup Studio: authentication belongs to the CLI itself. The prompt and screenshot go to the chosen CLI's provider.
- The subprocess runs in a temporary folder, never in the project folder; arguments do not carry user content.

## Troubleshooting

| Symptom                                 | What to do                                                                                                                   |
| --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| "No AI agent available"                 | Install Claude Code or Codex and open the CLI once in the terminal to log in. Check with `mockup doctor`.                    |
| CLI installed but not found             | Set `MOCKUP_CLAUDE_BIN` / `MOCKUP_CODEX_BIN` to the executable's path and restart the daemon.                                |
| Login/authentication error in the turn  | The message includes the end of the CLI's stderr. Run `claude` (or `codex login`) in the terminal and sign in again.         |
| "A turn is already in progress"         | Cancel the current turn or wait for it to finish.                                                                            |
| Turn takes long and ends with "timeout" | The limit is 10 minutes per turn; split the request.                                                                         |
| The agent says the turn ended           | The user cancelled or time ran out; the changes already made stay and a Ctrl+Z undoes them.                                  |
| No screenshot in the context            | The daemon has no render engine (plain Node daemon); open the desktop app. The turn works without the image.                 |
| Conversation "forgot" the context       | The `--resume` failed and the turn restarted without it (short summary in the prompt); clear the conversation if you prefer. |

## Remix

Generates variations of a node **side by side**: clones the root frame that contains the node (with all descendants) and applies a transformation to the equivalent node in each clone. The clones sit in a row to the right, starting after the rightmost frame of the page that overlaps the source one vertically, with 80 px between them, and are named `<frame> — <variation>`. All ops of a remix go into a single undo entry (one Ctrl+Z undoes everything) and the created frames are left selected.

Local kinds (deterministic, no AI; pure planner `planRemix` in `packages/core/src/remix/`):

| `kind`        | Default / max | What it does                                                                                                                                                                                                                |
| ------------- | ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `color-scale` | 10 / 10       | 10-shade scale (stops 50–900, OKLCH) from the node's first solid color among `background-color`, `background`, `color`, `border-color` and `fill` (`var()` resolved); the base falls on the closest-lightness stop.         |
| `font-pairs`  | 4 / 10        | Curated pairs (Editorial, Neutral, Display, Technical, Humanist, Classic) filtered by local fonts (installed or from the document); headings (h1–h6, ≥ 24 px or weight ≥ 600) get the heading font, the rest the body font. |
| `spacing`     | 4 / 5         | 4/8 scale over `padding`, `margin` and `gap` in px: compact, grid 4, grid 8, comfortable, spacious. Variations equal to the original or to a previous one are dropped, so fewer than `count` may come out.                  |
| `layout`      | 3 / 3         | Rearrangements of the nearest flex container: reversed direction, reversed order and centered with wrap.                                                                                                                    |

The `ai` kind (requires `prompt`, default 3 variations) runs an assistant turn with instructions to duplicate the frame, position the copies, rename them and check with `get_screenshot`. The remix uses its own undo group (or the caller's: a `remix` with `ai` made from inside another turn goes into the same undo) and returns only the new root frames **created by the ops of that group** (`groupCreatedIds`): frames the user creates on the page during the turn are not included.

`font-pairs` depends on the machine's fonts: the curated list is filtered by the families installed on the system (`listSystemFonts`) and by those of the document (`doc.fonts`), so the same document may generate different pairs on another machine; if nothing can be listed, the list is not filtered and the browser falls back to the generic fallback (`serif`, `sans-serif`, `monospace`) when the font is missing.

Available in the editor's context menu (WS message `remix`) and in the MCP tool `remix({ nodeId, kind, count?, prompt?, docId? })`.

## Editor interface

The "Assistant" side panel (built separately, in `packages/editor`) shows the active document's conversation: the user's request, the agent's text streaming, the tools called (with ok/error) and the result of each turn, with buttons to cancel the turn in progress and clear the conversation, and the choice of backend/model. It only speaks the WebSocket protocol above.
