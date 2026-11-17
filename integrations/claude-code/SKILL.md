---
name: mockup-studio
description: Use when the user asks for a mockup, wireframe, screen prototype, landing page or visual UI; creates and iterates on designs in Mockup Studio via MCP with screenshots.
---

# Mockup Studio

Creates mockups in Mockup Studio through the `mockup-studio` MCP server, views the result in a screenshot and iterates until it looks right.

## Prerequisite

- The `mockup-studio` MCP server must be registered and connected (`claude mcp list`).
- If the tools (`create_frame`, `write_html`, `get_screenshot`...) do not show up, run `mockup setup claude` and restart Claude Code.
- If the screenshot fails, run `mockup doctor` (see the end of this file).

## Workflow

1. Understand the request: purpose of the screen, audience, sections, visual tone. Ask only what blocks you.
2. Call `get_guide('getting-started')` the first time in the session.
3. Create or open the document at a sensible path in the user's project, for example `design/<name>.mockup.json`: `create_document(path, name)` or `open_document(path)`.
4. Define the tokens before the content with `set_tokens`: colors (`--color-primary`, `--color-bg`, `--color-text`), spacing (`--space-4`), radius (`--radius-md`), font (`--font-sans`). For a dark theme: `create_theme` + `set_frame_theme` (see `get_guide('tokens')`).
5. Create one frame per breakpoint with `create_frame`:
   - `Desktop` 1440x900
   - `Tablet` 768x1024
   - `Mobile` 390x844
6. Build the content section by section with `write_html(html, css, parentId)`: real CSS, `display:flex` and `gap`. One section per call (header, hero, features, footer).
7. After each section, `get_screenshot(nodeId)` and check:
   - consistent alignment and spacing
   - nothing cut off or overflowing the frame
   - contrast and text that wraps in bad places
   - typographic hierarchy and identical repeated elements
8. Fix with `update_styles`, `set_text`, `move_nodes`, `set_tag`. Use `undo` if you make a mistake.
9. Use `get_layout(nodeId)` when you need exact measurements (position, size, overflow).
10. For the other breakpoints, `duplicate_nodes([frameId])`, `rename_nodes`, adjust the width and adapt the layout (`column`, less `padding`).
11. When the user asks for code, `export(nodeIds, format)` with `html`, `tailwind` or `react` (`get_code` only reads, it does not write files).
12. When done, call `finish_working` and tell the user where the file is.

## Quality rules

- Spacing in multiples of 4 and 8 px.
- Clear typographic hierarchy: one dominant heading, subheadings, body text of 16 px or more, at most 2 families.
- AA contrast: 4.5:1 for normal text, 3:1 for large text.
- Realistic content (names, prices, product copy), never lorem ipsum.
- Images with `insert_image`; icons with `search_icons` and `insert_icon` (Lucide).
- Clear layer names with `rename_nodes` ("Hero", "Primary button", "Plan card").
- Use tokens via `var(--color-primary)` instead of repeated loose colors.
- Prefer `write_html` over many `create_node` calls.

## Saving context

- `get_screenshot` with `scale: 1`, `maxWidth: 800` and `format: "jpg"`; `scale: 2` only for details.
- Capture the section that changed, not the whole frame.
- `get_tree_summary(nodeId, depth)` with a small `depth` (1 or 2); `get_html` only for the node you need.

## If the screenshot is unavailable

- The tool warns that the render engine is not active (Node daemon without Electron).
- Run `mockup doctor`: it shows the daemon mode, whether Electron was found and port 4747.
- Open the Mockup Studio app, or run `mockup stop` and let `mockup mcp` start again.
- Meanwhile, check the structure with `get_tree_summary` and `get_html` and tell the user you did not see the result.
- More details: `get_guide('troubleshooting')`.
