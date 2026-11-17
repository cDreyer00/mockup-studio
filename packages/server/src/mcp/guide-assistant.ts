/** Guide `get_guide('assistant')`: the editor's AI assistant and how the agent works within a turn. */
export const ASSISTANT_GUIDE = `# Assistant guide

Mockup Studio has an **AI assistant** in the editor: one chat panel per document. The user writes a request ("make this card more compact"), the daemon spawns a subprocess of the installed agent CLI (Claude Code or Codex), and that CLI edits the canvas through the MCP tools of this same server. There is no API key of its own: the account already signed in to the CLI is used.

## How you (the agent) get called

- Each user request is a **turn**. Your MCP session opens with a turn token (\`/mcp?turn=<token>\`), which the daemon generates for that turn only.
- **All your changes in the turn form a single undo group**: the user undoes the whole turn with one Ctrl+Z in the editor. This also applies to run_script and remix calls made in the turn.
- Inside a turn, \`undo\` and \`redo\` are **refused**. Fix a mistake with the editing tools (update_styles, set_text, delete_nodes...), never by undoing.
- When the turn ends (or the user cancels), the token stops being valid: new writes are refused with the message "The assistant turn ... has already ended". Stop when you get that error; what was already done can still be undone in a single step.
- The prompt carries the document (name and docId), the user's selection with the tree summary and, when rendering is available, a screenshot of the selection. The selection may have changed since then: confirm with get_selection if it matters.

## Best practices inside a turn

1. **Pass an explicit docId** to every tool (the one from the prompt). The active document may change.
2. **Work on the selection.** With no selection, the request applies to the document: look at the frames with get_tree_summary before editing.
3. **Edit a little and check**: apply, call get_screenshot on the changed node and fix. Prefer a few large calls (write_html, update_styles with several nodeIds) over many small ones.
4. Use the document's design tokens and components (get_guide('tokens'), get_guide('components')) instead of loose values.
5. **Do not use tools outside mockup-studio** (shell, files, web): the CLI runs without them.
6. Call finish_working when done, so the editor clears the "agent working" badge.
7. **Reply briefly and write design content in the user's language**: reply in 1 to 3 sentences saying what changed. The text appears in the user's chat.
8. If the request is ambiguous, pick the most conservative interpretation, do it and say what you assumed; the user can undo and ask again.

## Remix

\`remix(nodeId, kind, count?, prompt?)\` generates variations of a node (all in a single undo group):

- \`color-scale\`: a 10-shade scale from the node's color.
- \`font-pairs\`: font pairs (heading and body).
- \`spacing\`: a 4/8 spacing scale.
- \`layout\`: 3 flex rearrangements (direction, alignment, distribution).
- \`ai\`: free-form variations from \`prompt\` (uses an assistant turn).

## Scripts

\`run_script\` runs JavaScript against the document (\`doc\` API), also in a single undo group. Details and examples in get_guide('scripts').
`;
