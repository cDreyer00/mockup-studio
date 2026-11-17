<!-- Paste this block into ~/.codex/AGENTS.md (global) or the project's AGENTS.md. Requires the `mockup-studio` MCP server to be registered (`mockup setup codex`). -->

## Mockup Studio (visual mockups)

Use the `mockup-studio` MCP server when the user asks for a mockup, wireframe, screen prototype, landing page or visual UI. If the tools do not exist, run `mockup setup codex` and `mockup doctor`.

### Workflow

1. `get_guide('getting-started')` the first time in the session.
2. `create_document` (or `open_document`) at a project path, such as `design/<name>.mockup.json`.
3. `set_tokens` first: colors, spacing, radius, font (themes with `create_theme`; see `get_guide('tokens')`).
4. `create_frame` per breakpoint: `Desktop` 1440x900, `Tablet` 768x1024, `Mobile` 390x844.
5. `write_html(html, css, parentId)` one section at a time, with real CSS (flex and `gap`).
6. `get_screenshot(nodeId)` after each section. Check alignment, cut-offs, contrast and text wrapping.
7. Fix with `update_styles`, `set_text`, `move_nodes`. Use `get_layout` for measurements.
8. `export(nodeIds, format)` as `html`, `tailwind` or `react` when code is requested.
9. `finish_working` when done.

### Quality rules

- Spacing in multiples of 4 and 8 px; clear typographic hierarchy; AA contrast.
- Realistic content, no lorem ipsum.
- `insert_image` for images; `search_icons` and `insert_icon` for icons.
- Clear layer names with `rename_nodes`; colors via tokens (`var(--color-primary)`).

### Saving context

- Screenshot with `scale: 1`, `maxWidth: 800` and `format: "jpg"`.
- `get_tree_summary` with a small `depth`.
- No screenshot available: `mockup doctor` and `get_guide('troubleshooting')`.
