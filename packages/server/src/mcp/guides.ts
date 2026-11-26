import { ASSISTANT_GUIDE } from './guide-assistant.js';
import { MOTION_GUIDE } from './guide-motion.js';
import { SCRIPTS_GUIDE } from './guide-scripts.js';
import { IMPORT_GUIDE, IMPORT_GUIDE_INFO } from '../snapshot/guide.js';
import { EFFECTS_GUIDE } from './guides-effects.js';

export const GUIDE_TOPICS = [
  'getting-started',
  'design-system',
  'tokens',
  'layout',
  'grid',
  'vectors',
  'responsive',
  'screenshot-loop',
  'tailwind',
  'components',
  'export',
  'effects',
  'motion',
  'troubleshooting',
  'setup',
  'assistant',
  'scripts',
  'import',
  'assets',
  'data',
] as const;
export type GuideTopic = (typeof GUIDE_TOPICS)[number];

/** Title and short description of each guide (used by the `guide://<topic>` resources). */
export const GUIDE_INFO: Record<GuideTopic, { title: string; description: string }> = {
  'getting-started': {
    title: 'Guide: getting started',
    description: '6-step flow to create a mockup from scratch, tips and the list of guides.',
  },
  'design-system': {
    title: 'Guide: design system and tokens',
    description: 'Tokens as CSS variables, spacing and typography scales, colors with contrast.',
  },
  tokens: {
    title: 'Guide: tokens and themes',
    description:
      'Build the design system before the frames: groups, aliases, light/dark themes, calc/color-mix, import and export.',
  },
  layout: {
    title: 'Guide: layout',
    description: 'Flexbox, sizes, absolute positioning and spacing best practices.',
  },
  grid: {
    title: 'Guide: CSS Grid',
    description:
      'Grid with write_html or set_grid, placing children with place_in_grid, named areas and get_layout.',
  },
  vectors: {
    title: 'Guide: vectors and shapes',
    description:
      'create_shape, insert_svg, set_path, set_vector_paint, boolean_op, flatten and text_to_outlines.',
  },
  responsive: {
    title: 'Guide: responsive',
    description:
      'One frame per breakpoint (Mobile, Tablet, Desktop): duplicate, adapt and position.',
  },
  'screenshot-loop': {
    title: 'Guide: screenshot loop',
    description: 'Create, check with get_screenshot, fix; visual checklist and saving context.',
  },
  export: {
    title: 'Guide: export',
    description:
      'get_code vs export, formats (png, svg, html, tailwind, react), output folder and assets.',
  },
  effects: {
    title: 'Guide: effects, video, embeds and animated export',
    description:
      'add_effect as a background, presets, screenshot with time, video, Lottie/Rive/YouTube, Three.js and mp4/webm/gif export.',
  },
  motion: {
    title: 'Guide: motion, animations and slide transitions',
    description:
      'animate, builds (click order), split + stagger, easings, loops, slide transitions, get_timeline, filmstrip screenshots and preview_motion.',
  },
  troubleshooting: {
    title: 'Guide: troubleshooting',
    description:
      'Render unavailable, node not found, port in use, overflow, logs and parameter errors.',
  },
  tailwind: {
    title: 'Guide: native Tailwind',
    description:
      'Tailwind classes in write_html and import_component (shadcn), set_classes, hover/dark/md states, screenshot per state and limitations.',
  },
  components: {
    title: 'Guide: components',
    description:
      'shadcn-like kit, insert_component with props and slots, creating components with bind, editing the main component, overrides, detaching and React export.',
  },
  setup: {
    title: 'Guide: installing and registering the MCP',
    description:
      'Install the mockup CLI and register the MCP in Claude Code, Codex, Cursor and VS Code.',
  },
  assistant: {
    title: 'Guide: editor assistant and remix',
    description:
      'Assistant turns (Claude Code/Codex via subprocess), per-turn undo group, selection context and remix (color-scale, font-pairs, spacing, layout, ai).',
  },
  scripts: {
    title: 'Guide: scripts',
    description:
      'run_script: document JavaScript API (doc.select, node.style, doc.apply, doc.screenshot), sandbox, timeout and the scripts/*.js library.',
  },
  import: IMPORT_GUIDE_INFO,
  assets: {
    title: 'Guide: assets, images and placeholders',
    description:
      'Document assets vs library/CDN, upload, stable links, optimize, set_image and generate_placeholder.',
  },
  data: {
    title: 'Guide: real data and repeaters',
    description:
      'Template with {{field}}, bind_data with JSON/CSV/URL, select, mapping, refresh_data and limits.',
  },
};

export const GUIDES: Record<GuideTopic, string> = {
  assistant: ASSISTANT_GUIDE,
  scripts: SCRIPTS_GUIDE,
  motion: MOTION_GUIDE,
  'getting-started': `# Getting started with Mockup Studio

The document is a tree of real HTML/CSS nodes: pages > frames (artboards) > elements.
Every node has a stable id (e.g. \`fr_ab12cd34\`, \`el_...\`, \`tx_...\`).

## 6-step flow

1. \`create_document(path, name)\` or \`open_document(path)\`, then \`get_basic_info\` — see pages, frames, open documents and the selection.
2. \`set_tokens({...})\` — define the design system first: colors, spacings, radii, fonts (see \`get_guide('design-system')\` and \`get_guide('tokens')\`).
3. \`create_frame(name, width, height)\` — create the root artboard (e.g. "Desktop", 1440x900).
4. \`write_html(html, css?, parentId?)\` — write HTML + CSS in one go, section by section (header, hero, features, footer), using \`var(--...)\` from the tokens.
5. \`get_screenshot(nodeId)\` — LOOK at the result and fix it with \`update_styles\`, \`set_text\` or \`undo\`; repeat until it looks right (see \`get_guide('screenshot-loop')\`).
6. \`export\` (files) or \`get_code\` (code in the response) and, finally, \`finish_working\` to clear the "AI" badge in the editor.

## Tips

- Prefer \`write_html\` over many \`create_node\` calls: it is faster and more readable.
- Without \`parentId\`, the content goes to the selected node or to the first frame; pass \`parentId\` to be sure.
- \`get_tree_summary\` shows the structure; \`get_html\` and \`get_styles\` show the code and the effective styles.
- Saving to disk is automatic; \`save_document\` forces a write.
- HTML with Tailwind classes (shadcn/ui, Tailwind UI): \`write_html\` detects it on its own and \`import_component\` creates the shadcn tokens; see \`get_guide('tailwind')\`.
- Reusable components (Button, Card, Navbar...): \`insert_component('shadcn-like/Button', parentId, props)\`; see \`get_guide('components')\`.
- Effects, video and embeds: \`add_effect\`, \`insert_video\`, \`insert_embed\`, \`insert_three\` (see \`get_guide('effects')\`).
- Animations, click builds and slide transitions: \`animate\`, \`set_slide_transition\`, \`get_timeline\`, \`preview_motion\` (see \`get_guide('motion')\`).
- Images, icons and fonts: \`insert_image\`, \`insert_icon\` (\`search_icons\`; Lucide and Heroicons kits, names \`kit/name\`), \`add_font\` (\`list_fonts\`).
- \`docId\` is optional (the active document is used), except in \`close_document\`.

## Guides

\`design-system\`, \`tokens\`, \`layout\`, \`grid\`, \`vectors\`, \`responsive\`, \`screenshot-loop\`, \`tailwind\`, \`components\`, \`export\`, \`effects\`, \`motion\`, \`troubleshooting\`, \`setup\`, \`assistant\`, \`scripts\`, \`import\`, \`assets\`, \`data\` — use \`get_guide(topic)\`.
`,
  'design-system': `# Design system and tokens

Define the tokens BEFORE drawing. Tokens are CSS variables of the document; changing a value updates every node that uses it.

## Usage

- Define: \`set_tokens({ tokens: { "--color-primary": "#2563eb", "--space-4": "16px" } })\` (the \`--\` prefix is added if missing).
- Remove: \`set_tokens({ tokens: {}, unset: ["--old"] })\`.
- Read: \`get_tokens\`. \`get_styles\` returns the already resolved values.
- Themes (light/dark), semantic aliases, groups, \`calc()\`/\`color-mix()\`, renaming, importing and exporting: \`get_guide('tokens')\`.
- Apply in CSS: \`var(--color-primary)\`, in both \`write_html\` and \`update_styles\`.

## Names

\`--color-*\`, \`--space-*\`, \`--radius-*\`, \`--font-*\`, \`--shadow-*\`. Name by role (\`--color-surface\`), not by value (\`--color-gray-100\`).

## Spacing

A scale of multiples of 4/8: 4, 8, 12, 16, 24, 32, 48, 64. Use only these values in \`gap\`, \`padding\` and margins.

## Typography

- Scale: 12, 14, 16, 20, 24, 32, 48 px, with line-height ~1.5 for body text and ~1.2 for headings.
- Use 1–2 families at most (e.g. one for headings, one for text). \`list_fonts\` shows the available ones; \`add_font\` registers/embeds another (e.g. Google Fonts).
- Weights: 400 (text), 600/700 (headings and buttons).

## Colors and contrast (WCAG AA)

- Normal text: minimum contrast 4.5:1 against the background. Large text (>= 24px, or 19px bold) and icons: 3:1.
- Small palette: primary, surface (background), text, secondary text, border and states (success, error).
- Do not use color as the only indication of state.

## Radius and shadow

Pick 2–3 radii (e.g. 4, 8, 16, 999) and 2–3 shadows and reuse them; avoid one-off values per component.

## Full example

\`\`\`js
set_tokens({
  tokens: {
    "--color-primary": "#2563eb",
    "--color-primary-contrast": "#ffffff",
    "--color-surface": "#ffffff",
    "--color-surface-alt": "#f1f5f9",
    "--color-text": "#0f172a",
    "--color-text-muted": "#475569",
    "--color-border": "#cbd5e1",
    "--color-success": "#15803d",
    "--color-danger": "#b91c1c",
    "--space-1": "4px", "--space-2": "8px", "--space-3": "12px", "--space-4": "16px",
    "--space-6": "24px", "--space-8": "32px", "--space-12": "48px", "--space-16": "64px",
    "--radius-sm": "4px", "--radius-md": "8px", "--radius-lg": "16px",
    "--font-sans": "Inter, system-ui, sans-serif",
    "--shadow-sm": "0 1px 2px rgba(15,23,42,0.08)",
    "--shadow-md": "0 4px 12px rgba(15,23,42,0.12)"
  }
})
\`\`\`
`,
  tokens: `# Tokens and themes

Build the design system BEFORE the frames. Tokens are CSS variables of the document; themes override some of them on whole frames.

## Recommended flow

1. \`set_tokens\` with groups: primitive colors, semantic colors as aliases of the primitives, typography, spacing, radius and shadow.
2. \`create_theme("dark", overrides)\` overriding primitives or semantics.
3. Use \`var(--...)\` in \`write_html\` and \`update_styles\`, or bind an existing prop with \`apply_token\`.
4. \`set_frame_theme\` on duplicated frames to get light and dark side by side.
5. \`get_screenshot\` of each frame to check.
6. \`get_tokens\` to find unused tokens and broken references; \`rename_token\` to rename without breaking anything; \`import_tokens\`/\`export_tokens\` to exchange with CSS, W3C Design Tokens (JSON) and Tailwind.

## 1. Base tokens, with groups

\`\`\`js
set_tokens({
  tokens: {
    "--blue-600": "#2563eb", "--blue-700": "#1d4ed8",
    "--slate-50": "#f8fafc", "--slate-900": "#0f172a", "--slate-600": "#475569",
    "--color-primary": "var(--blue-600)",
    "--color-primary-hover": "color-mix(in oklch, var(--color-primary), black 15%)",
    "--color-surface": "var(--slate-50)",
    "--color-text": "var(--slate-900)",
    "--color-text-muted": "var(--slate-600)",
    "--space-2": "8px", "--space-4": "16px", "--space-8": "32px",
    "--space-card": "calc(var(--space-4) * 1.5)",
    "--radius-md": "8px",
    "--font-sans": "Inter, system-ui, sans-serif",
    "--shadow-md": "0 4px 12px rgba(15,23,42,0.12)"
  },
  descriptions: { "--color-primary": "Primary action" }
})
\`\`\`

- The group (Colors, Typography, Spacing, Radius, Shadow, Other) is inferred from the name prefix (\`--color-*\`, \`--space-*\`, \`--radius-*\`, \`--font-*\`, \`--shadow-*\`) and, with no known prefix, from the value. Force it with \`groups: { "--blue-600": "color" }\`.
- An invalid value (parentheses, quotes) rejects the call; a suspicious type (e.g. a color in a spacing token) is accepted with a warning.

## 2. Themes

\`\`\`js
create_theme({ name: "dark", overrides: {
  "--color-surface": "var(--slate-900)",
  "--color-text": "var(--slate-50)",
  "--color-text-muted": "#94a3b8"
}})
\`\`\`

A theme lists only what changes. To adjust it later: \`set_tokens({ theme: "dark", tokens: {...} })\`. \`create_theme\` accepts \`copyFrom\` to start from another theme. \`delete_theme\` and \`rename_theme\` update the frames that use it.

## 3. Aliases follow the theme

An alias (\`--color-primary: var(--blue-600)\`) is resolved in the frame's scope: if the theme overrides \`--blue-600\`, \`--color-primary\` and everything that depends on it change together, with no redeclaration. Overriding the alias in the theme works too. Cycles and nonexistent references show up as a problem in \`get_tokens\`.

## 4. Light/dark frames

Duplicate the frame and apply the theme: \`set_frame_theme({ nodeIds: ["fr_..."], theme: "dark" })\`. With \`theme: null\` the frame goes back to the base tokens. The theme applies to the frame and all its descendants. \`get_styles({ nodeIds, theme: "dark" })\` shows the effective values as if the node were in that theme.

## calc() and color-mix()

They work as normal CSS (\`calc(var(--space-4) * 2)\`, \`color-mix(in oklch, var(--color-primary), black 15%)\`). \`get_tokens\` and \`get_styles\` show the evaluated result when possible; in the exported HTML/CSS the text is kept as is.

## Maintenance

- \`get_tokens\` (\`format: "json"\` for the full report): usages, unused, broken references, themes and the frames that use them.
- \`rename_token({ from: "--color-brand", to: "--color-primary" })\` updates the styles of all nodes, other tokens and themes.
- \`import_tokens({ content, format?, mode: "merge" | "replace" })\` reads CSS (\`:root\`, \`[data-theme]\`, Tailwind v4 \`@theme\`) or W3C Design Tokens JSON. \`export_tokens({ format: "css" | "json" | "tailwind" })\` returns the text.
- Everything is undone with \`undo\`, one call per entry.
`,
  layout: `# Layout

Nodes use real CSS. Use flexbox for almost everything.

## Flex

- Container: \`display:flex; flex-direction:column; gap:16px; padding:24px;\`
- Alignment: \`align-items:center; justify-content:space-between;\`
- Line wrapping: \`flex-wrap:wrap\`. Child that takes the remaining space: \`flex:1\`.

## Sizes

- \`auto\`: fits the content (default).
- \`100%\`: fills the full width/height of the parent (e.g. \`width:100%\`).
- Fill the main axis: \`flex:1\` (or \`flex-grow:1\`).
- Limits: \`max-width:1200px; min-height:400px\`.

## Absolute position

- On the child: \`position:absolute; top:..; left:..\`, with the parent at \`position:relative\`.
- To position frames on the canvas, use \`set_position(nodeId, x, y)\` (root frames and absolute children).

## Best practices

- Spacing with \`gap\` and \`padding\` (values from the \`--space-*\` tokens); avoid loose margins.
- Root frames have fixed width/height (e.g. 1440x900); the inner content should flow (\`width:100%\`, \`max-width\`).
- Build by sections: one \`write_html\` per block, each with its own flex container.
- \`get_styles(nodeIds)\` shows the effective styles; \`get_layout(nodeId)\` shows real position and size (needs render).
- Two-dimensional grids: \`get_guide('grid')\` (\`set_grid\`, \`place_in_grid\`). Shapes and SVG: \`get_guide('vectors')\`.
`,
  grid: `# CSS Grid

Use grid for two-dimensional layouts (cards, dashboards, galleries, forms); flex is still better for a single row or column.

## With write_html

\`\`\`html
<section class="cards">
  <article class="card">A</article>
  <article class="card wide">B</article>
  <article class="card">C</article>
</section>
\`\`\`

css: \`.cards{display:grid;grid-template-columns:repeat(3,1fr);gap:24px}.wide{grid-column:span 2}\`

## With tools

- \`set_grid(nodeId, columns, rows?, gap?, columnGap?, rowGap?, areas?, placeItems?, justifyItems?, alignItems?)\` — \`columns\` accepts a number (\`3\` = three 1fr columns), CSS text (\`"1fr 200px minmax(100px, 1fr)"\`, \`"repeat(auto-fill, minmax(200px, 1fr))"\`) or a list (\`["200px", "1fr"]\`).
- \`place_in_grid(nodeIds, column, row, span?)\` — cell (starts at 1); \`span\` is a number (columns) or \`{ columns: 2, rows: 1 }\`; \`area: "header"\` uses a named area. The parent must be a grid.

Dashboard example:

\`\`\`
set_grid({ nodeId: "el_main", columns: "240px 1fr", rows: "64px 1fr", gap: 16, areas: ["side top", "side content"] })
place_in_grid({ nodeIds: ["el_sidebar"], area: "side" })
place_in_grid({ nodeIds: ["el_topbar"], area: "top" })
\`\`\`

## Tips

- Prefer \`fr\` and \`minmax()\` over fixed widths; \`repeat(auto-fill, minmax(220px, 1fr))\` creates responsive grids with no breakpoint.
- Each name in \`areas\` must form a rectangle; use \`.\` for an empty cell.
- \`get_layout(nodeId)\` shows the measured tracks (sizes and column/row lines) when there is render; use it to check that the children landed in the right cells.
- A child with \`position:absolute\` leaves the grid. Items outside the declared tracks create implicit tracks (\`grid-auto-rows\` controls the height).
- The exported code (html, tailwind, react) keeps \`display:grid\`, the tracks and the placement.
`,
  vectors: `# Vectors and shapes

Shapes and icons are \`svg\` nodes. Those created by these tools have an editable vector model (paths, viewBox, paint); \`get_svg(nodeId)\` shows the markup and the paths.

## Create

- \`create_shape({ parentId, shape: "rect"|"ellipse"|"line"|"polygon"|"star", x?, y?, width?, height?, sides?, points?, styles? })\` — paint styles (\`fill\`, \`stroke\`, \`stroke-width\`...) go to the vector. With x/y it is absolute (the parent must be a frame or position:relative).
- \`insert_svg({ parentId, svg, width?, height? })\` — imports SVG markup; the original is preserved until the first edit. If the SVG uses filters, masks, text or partial opacity, it shows up but is not editable (the response warns about it).
- \`insert_icon\` (Lucide) also generates svg nodes; \`set_vector_paint\` and \`get_svg\` work on them.

## Edit

- \`set_path({ nodeId, d, pathId?, fit? })\` — replaces the \`d\` (e.g. \`"M 0 0 L 100 0 L 50 80 Z"\`); \`fit: true\` adjusts the viewBox and the node box.
- \`set_vector_paint({ nodeId, pathIds?, fill?, stroke?, strokeWidth?, linecap?, linejoin?, dasharray?, opacity? })\` — \`fill\`/\`stroke\` accept a color or gradient: \`{ type: "linear", stops: [{ offset: 0, color: "#f00" }, { offset: 1, color: "#00f" }], x1: 0, y1: 0, x2: 1, y2: 0 }\`.
- \`boolean_op({ nodeIds, op: "union"|"subtract"|"intersect"|"exclude" })\` — between 2+ sibling svgs; the bottom one is the "first" of subtract; curves are flattened.
- \`flatten({ nodeIds })\` — merges the paths into a single node/path.
- \`text_to_outlines({ nodeIds })\` — text becomes outlines using the document or system font; it stops being editable as text.

## Tips

- In simple icons the color comes from the paths' \`stroke\`/\`fill\` (\`currentColor\` follows the parent's text color).
- Check with \`get_screenshot\`; everything is undone with \`undo\`.
- An svg coming from \`write_html\` is legacy: \`get_svg\` infers the paths and the first edit creates the vector.
`,
  responsive: `# Responsive with frames

In Mockup Studio, each root frame is a breakpoint (artboard) on the same page. Use these names and sizes:

- \`Mobile\` — 390x844
- \`Tablet\` — 768x1024
- \`Desktop\` — 1440x900

With several screens in the same document (login, dashboard, detail...), name them \`<Screen> - <Breakpoint>\`: \`Login - Desktop\`, \`Login - Mobile\`, \`Dashboard - Desktop\`. Put each screen on a row (same \`y\`) and the breakpoints side by side (\`set_position\`).

## Flow

1. Build \`Desktop\` first: \`create_frame({ name: "Desktop", width: 1440, height: 900 })\` and the content with \`write_html\`.
2. \`duplicate_nodes({ nodeIds: [desktopId] })\` — the clone appears on the canvas; the result carries the new id.
3. \`rename_nodes({ nodeIds: [cloneId], names: ["Tablet"] })\` and \`update_styles({ nodeIds: [cloneId], styles: { width: "768px", height: "1024px" } })\`. Repeat for \`Mobile\` (390x844).
   If the Mobile layout is very different (tab bar, stacked cards), it is faster to create the frame and write its HTML with \`write_html\` than to adapt the clone.
4. Adapt each clone: \`flex-direction: column\` instead of \`row\`, smaller \`padding\` and fonts, grids with fewer columns (use \`update_styles\` on the containers).
5. \`set_position(frameId, x, y)\` to lay them out side by side without overlap: next x = previous x + width + 100.
6. \`get_screenshot\` of each frame and fix.

## Tips

- Keep the same layer names across frames: it makes comparing and editing easier.
- Prefer \`width:100%\` and \`max-width\` inside the frames over fixed widths.
- Touch targets on Mobile at least 44px tall.
- \`get_basic_info\` lists frames with size and position.
`,
  'screenshot-loop': `# Screenshot loop

Do not rely on structure alone: after each set of changes, look at the result.

## Loop

1. Create or edit (\`write_html\`, \`update_styles\`, \`insert_image\`...).
2. \`get_screenshot(nodeId)\` — check the image.
3. Fix whatever is wrong (\`update_styles\`, \`set_text\`, \`undo\`) and repeat step 2.
4. When done, \`finish_working\` to clear the "AI" badge in the editor.

## Visual checklist

- Consistent alignment and spacing (gap, padding).
- Nothing cut off or spilling out of the frame (overflow); images with the correct aspect ratio.
- Content taller than the frame: with a fixed height, flexbox squeezes the blocks (\`flex-shrink\`) and the screenshot looks like it fits, but the exported code (minimum height) ends up taller. Add up the heights with \`get_layout\` or give the blocks an explicit height (on an \`<svg>\` use \`set_attrs\` with \`height\` or \`update_styles\`).
- Enough contrast between text and background (4.5:1 for normal text).
- Text wrapping in bad places (headings over many lines, buttons with two-line text).
- Hierarchy: consistent sizes and weights; repeated elements identical.

## Save context

- Prefer \`scale: 1\` and use \`maxWidth\` (e.g. 800) on large frames; \`scale: 2\` only for details.
- Capture the node that changed (one section), not the whole frame, when possible.
- \`format: "jpg"\` produces smaller images.

## Exact measurements

\`get_layout(nodeId, depth?)\` lists \`id "name" tag x,y wxh\` (px, relative to the frame) and the text of the lines.
Use it to check alignment, spacing and overflow with numbers.

## Availability

Screenshot and \`get_layout\` require the render engine (desktop app or headless Electron). On a plain Node daemon
the tools tell you how to enable it (see \`get_guide('troubleshooting')\`); meanwhile use \`get_tree_summary\` and \`get_html\`.
`,
  export: `# Export

## get_code vs export

- \`get_code(nodeId, format)\` — returns the code in the response, without writing files. Good for reading/pasting.
- \`export(nodeIds, format, outputDir?)\` — writes one file per node and copies the assets used.

## Formats

- \`png\` / \`jpg\` (\`scale\` 1-3): image of the node; requires render.
- \`svg\`: vector of the node (with render it uses the real measurements; without render, a fallback with foreignObject).
- \`html\`: HTML document with CSS in classes.
- \`tailwind\`: HTML with Tailwind v4 classes (\`<name>.tailwind.html\`).
- \`react\`: component \`<Name>.tsx\` (\`styles\`: "tailwind" or "inline"); if there is CSS, \`theme.css\` or \`<Name>.css\`.

## Output folder

- Default: \`<document folder>/exports/\`. A document with no path requires \`outputDir\` (absolute).
- Files use the node name as a slug (\`Desktop 1440\` becomes \`desktop-1440.png\`).
- Files with the same name are OVERWRITTEN (marked "(replaced)"); use another \`outputDir\` to preserve versions.
- For html/tailwind/react, the images and fonts used are copied to \`<outputDir>/assets/\`.
- The \`export\` response lists the files and only repeats the code up to 20 KB in total; to read a node's code use \`get_code\`.
- React in a Vite project: copy \`assets/\` to \`public/assets/\` and export with \`assetsBase: "/assets/"\` (images and fonts then use absolute paths that the bundler resolves).

## Tips

- Give layers clear names (\`rename_nodes\`): they become file and component names.
- Export one node per component; use \`get_screenshot\` first to check the visuals.
`,
  effects: EFFECTS_GUIDE,
  troubleshooting: `# Troubleshooting

## "Render unavailable" / get_screenshot fails

The daemon is running on plain Node, without the Electron that draws the nodes. Run \`mockup doctor\` for the diagnosis.
Options: open the desktop app; or \`mockup stop\` and reconnect the MCP client (the CLI starts a daemon with render); or \`mockup serve --render\`.
If the app executable is not found, set \`MOCKUP_DESKTOP_EXE\` to its path. Without render, carry on with \`get_tree_summary\` and \`get_html\`.

## "Node not found"

The id does not exist (or was removed/regenerated, e.g. after \`write_html\` with mode "replace"). Use \`get_tree_summary\` to list the current ids.

## "No document open"

Use \`list_documents\`; if empty, \`open_document(path)\` or \`create_document(path, name)\`.

## "MCP tool call requires approval, but approval policy is never" (Codex)

Codex blocks the tools that write when it runs without interactive approval (\`codex exec\`). The user must allow the server in \`~/.codex/config.toml\` (\`[mcp_servers.mockup-studio]\` with \`default_tools_approval_mode = "approve"\`) or run with \`-c 'mcp_servers.mockup-studio.default_tools_approval_mode="approve"'\`. Tell the user instead of working around it by writing the HTML by hand.

## Port 4747 in use

Another process is using the port. Free it or pick another with the \`MOCKUP_PORT\` variable (e.g. \`MOCKUP_PORT=4848\`) and adjust the HTTP client URL.

## The content ended up in the wrong place

Without \`parentId\`, \`write_html\` uses the selected node (\`get_selection\`) or the first frame. Always pass \`parentId\` and check with \`get_tree_summary\`. Use \`undo\` to revert and \`move_nodes\` to reposition.

## Cut-off text or overflow

Run \`get_layout(nodeId)\` and compare sizes: a child larger than its parent indicates overflow. Adjust \`width:100%\`, \`flex-wrap:wrap\`, \`min-width:0\` or increase the frame height.

## Parameter errors

The message lists the problem field (required missing, wrong type, value outside the options) and ends with "Example: tool({...})". Fix the field and call again.

## Logs

The daemon writes to \`<data folder>/daemon.log\` (\`mockup doctor\` shows the path).
`,
  tailwind: `# Native Tailwind

Mockup Studio understands Tailwind v4 classes (the same compiler as the editor): the classes become real CSS on the node
(\`style\`, and \`states\` for hover/dark/md), and the classes you wrote are kept in \`node.classes\` so the export
returns the same code. The document's base CSS becomes the Tailwind preflight (\`set_css_base\`).

## Recommended flow

1. \`write_html(html)\` with \`class="..."\`: Tailwind is detected automatically (\`tailwind: "auto"\`); force it with \`tailwind: "on"\` or \`css: "tailwind"\`, turn it off with \`"off"\`. Tokens become classes (\`--color-brand\` → \`bg-brand\`): define them with \`set_tokens\` first.
2. Pasted shadcn/ui or Tailwind UI: \`import_component(html)\` creates the missing shadcn preset tokens (\`--color-primary\`, \`--radius\`... and the "dark" theme) in the same call (a single undo). \`tokens: "none"\` does not create them.
3. Adjustments: \`set_classes(nodeIds, classes, mode)\` — \`replace\` (default), \`add\` or \`remove\`. \`get_classes(nodeIds)\` shows the node as Tailwind; \`suggest_classes(query)\` completes names (\`hover:bg-\`, \`bg-pri\`).
4. Check: \`get_screenshot(nodeId, state?)\` with \`state\` = hover, focus, focus-visible, focus-within, active, disabled or dark.
5. Code: \`get_code(nodeId, 'tailwind')\` / \`'react'\` (the author's classes are reused); \`get_tailwind_config\` shows the \`@theme\` generated from the tokens.

## States and breakpoints

- \`hover:\`, \`focus:\`, \`focus-visible:\`, \`focus-within:\`, \`active:\`, \`disabled:\`, \`dark:\` and \`sm:\`/\`md:\`/\`lg:\`/\`xl:\`/\`2xl:\` (combinable: \`md:hover:\`, \`dark:hover:\`) become the node's \`states\`. To edit a state directly: \`update_styles(nodeIds, styles, state: "hover")\`.
- Breakpoints apply by the ROOT FRAME'S WIDTH (mobile first): \`md:\` applies when the frame is 768px or wider (sm 640, lg 1024, xl 1280, 2xl 1536; the document's \`--breakpoint-md\` etc. tokens change these widths). A 390px frame shows only the base. To see the desktop, create or duplicate a 1280px frame (one frame per breakpoint; see \`get_guide('responsive')\`).
- \`dark:\` applies in frames/nodes with the "dark" theme (\`data-theme\`) and in the \`state: "dark"\` preview, which also swaps the tokens for the "dark" theme if the document has one.
- \`get_styles(nodeIds, state?)\` and \`get_node_info\` show style, classes and states.

## Limitations

- Variants with no equivalent stay only in \`node.classes\` (and in the exported code), with no effect on the render: \`group-*\`, \`peer-*\`, \`aria-*\`, \`data-*\`, \`before:\`/\`after:\`, \`has-*\`, \`[&_svg]:\` and arbitrary selectors. The write_html/set_classes response lists these classes with the reason.
- Unknown classes (\`foo-bar\`) are kept, with no effect.
- Default theme values are inlined (\`p-4\` → \`padding: 1rem\`); the document's tokens come in as \`var(--...)\`.
`,
  components: `# Components

Component = **main component** (in the document's library) + **instances** (\`◆Name\` nodes scattered around). Editing the main component changes all instances; each instance has its own props, slots and overrides.

## Using the kit

- \`list_components\` shows the library and the kits; \`get_component('shadcn-like/Button')\` shows props, options and the tree.
- \`shadcn-like\` kit: Button, Input, Card, Navbar, Tabs, Dialog, Table, List (uses the shadcn tokens; \`import_kit\` creates the missing ones).
- \`insert_component('shadcn-like/Button', parentId, { variant: 'outline', label: 'Save' })\` imports from the kit what is missing (without touching main components already imported) and inserts the instance. \`import_kit\` does not overwrite edited main components (it lists the diverging ones); \`overwrite: true\` replaces them.
- Slots receive HTML (Tailwind accepted): \`insert_component('shadcn-like/Card', parentId, { title: 'Plan' }, slots: { content: '<p>…</p>' })\`. The response carries the slot ids (use them as parentId of write_html).
- Props: \`set_instance_props(nodeIds, { variant: 'ghost' })\`. Invalid props list the valid ones; an enum lists the options.

## Creating a component

\`create_component(nodeId, name, props: [{ name: 'label', type: 'string', bind: { nodeId: 'tx_…', target: 'text' } }])\`: the node becomes the first instance and the text becomes \`{{label}}\`. \`bind.target\`: \`text\`, \`attr:href\` or \`style:color\`. A container with \`data-slot="content"\` becomes a slot. Enum/boolean props change the appearance through variants (\`update_component\`: \`variants: [{ when: { variant: 'outline' }, overrides: { '': { style: {...} } } }]\`).

## Editing

- The main component (affects all): \`update_styles\`/\`set_text\`/\`set_attrs\` on the ids from \`get_component\` (or \`go_to_main\`), or \`update_component_html(componentId, html)\` (one root element; keep \`{{prop}}\` and \`data-slot\`).
- One instance: \`set_instance_override(nodeId, path, { style, text, ... })\`, or \`update_styles\` on the virtual id \`in_x/tx_y\` (becomes an override). \`reset_instance\` discards it, \`push_overrides_to_main\` promotes it to the main component.
- Detach from the component: \`detach_instance(nodeId)\` (returns the new id). \`delete_component(id, detach_instances)\`.
- Internal structure (creating/moving/deleting nodes) only on the main component or after detaching; inside slots anything goes (write_html, create_node).

## Reading and checking

\`get_tree_summary\`, \`get_html\`, \`get_styles\` and \`get_screenshot\` accept the instance id and virtual ids (\`in_x/...\`) and read the expanded version. \`get_screenshot('cp_…')\` renders the main component in a default instance. \`get_code(nodeId, 'react')\` generates one React component per main component (typed props, instances as \`<Button variant="outline" />\`).
`,
  setup: `# Installing and registering the MCP

## Install the CLI

- In the repository: \`npm run build\` and \`npm link -w @mockup/cli\`.
- Or use the app installer, which puts \`mockup.cmd\` in \`%LOCALAPPDATA%\\MockupStudio\\bin\` on the user's PATH.

## Verify and register

- \`mockup doctor\` — checks the installation, daemon and render.
- Automatic registration: \`mockup setup claude\`, \`mockup setup codex\` or \`mockup setup all\` (with \`--skill\` it also installs the Claude Code skill). It does not recreate an identical registration and preserves the Codex config; \`--force\` recreates from scratch. On Codex, \`--approve\` allows the tools that write (required with \`codex exec\`) and \`--agents\` installs the snippet in \`~/.codex/AGENTS.md\`.

## Claude Code

- stdio: \`claude mcp add --scope user mockup-studio -- mockup mcp\`
- HTTP: \`claude mcp add --scope user --transport http mockup-studio http://127.0.0.1:4747/mcp\`
- Check: \`claude mcp list\` or \`/mcp\`.

## Codex

\`codex mcp add mockup-studio -- mockup mcp\`, or in \`~/.codex/config.toml\`:

\`\`\`toml
[mcp_servers.mockup-studio]
command = "mockup"
args = ["mcp"]
\`\`\`

## Other clients

Cursor, Claude Desktop:

\`\`\`json
{ "mcpServers": { "mockup-studio": { "command": "mockup", "args": ["mcp"] } } }
\`\`\`

VS Code (\`.vscode/mcp.json\`):

\`\`\`json
{ "servers": { "mockup-studio": { "type": "stdio", "command": "mockup", "args": ["mcp"] } } }
\`\`\`

## Windows

If the client cannot find \`mockup\` (\`.cmd\` shim), use the absolute path printed by \`mockup doctor\`.

Details in \`docs/INTEGRATION.md\`.
`,
  import: IMPORT_GUIDE,
  assets: `# Assets, images and placeholders

## Where files live

- **Document assets**: the \`assets/\` folder next to the \`.mockup.json\`. This is what the mockup actually uses (image \`src\`, backgrounds, fonts). A document with no path on disk embeds images as a data URL.
- **Library / CDN**: files stored by content, outside any document, reusable across several mockups.

## Tools

- \`upload_asset(source, name?, library?)\` — brings a file (absolute path, URL or data URL) into the document assets or the library.
- \`list_assets(scope?, query?, unused?)\` — lists the files with size, dimensions and how many nodes use each one.
- \`get_asset_url(id)\` — direct link \`/cdn/<hash>.<ext>\`, stable by content: the same file always gives the same link.
- \`optimize_assets(paths?, maxWidth?, format?, quality?)\` — shrinks and converts images (webp) and updates the references.
- \`remove_unused_assets(dryRun?)\` — removes what no node uses; run it first with \`dryRun: true\`.
- \`insert_image(parentId, source)\` — creates an img node from an image.

## Adjusting an image: \`set_image\`

One call, one undo:

\`\`\`
set_image({ nodeId, fit: 'cover', position: 'top-left',
  filters: { grayscale: 100, blur: 2 },   // null resets to neutral; an existing drop-shadow is preserved
  crop: { top: 10, bottom: 10 },           // % of each side (object-view-box)
  clipPath: 'circle' })                    // circle, ellipse, rounded, triangle, diamond, pentagon, hexagon, star, arrow or 'none'
\`\`\`

It also swaps the image (\`source\`: path, URL, data URL or a file already in \`assets/\`) and the \`alt\`.

## Sample images: \`generate_placeholder\`

\`generate_placeholder(nodeId, kind, seed?)\` with kind \`avatar\`, \`product\`, \`landscape\` or \`logo\`. On an image node it swaps the src; on a container it creates a child image. It is offline and deterministic: the same seed gives the same file (\`assets/placeholders/\`). Vary the seed (person name, product id) for lists with different images.

## Tips

- Prefer the user's real images when they exist; placeholders are for filling in.
- In \`src\`, prefer the relative \`assets/\` path over the \`/cdn\` link: the link only works while the daemon is running (code \`export\` copies the daemon's \`/cdn\` links to \`assets/cdn/\`).
- Check the result with \`get_screenshot\`.
`,
  data: `# Real data and repeaters

A **repeater** repeats its content (the template) once per item of a list. Render, screenshot and export (html, tailwind, react, svg) already come out with the data.

## Flow

1. Write ONE sample item with \`write_html\`, inside a container, using \`{{field}}\`:
   \`<div class="list"><article class="card"><img src="{{photo}}" alt="{{name}}"><h3>{{name}}</h3><p>{{price | negotiable}}</p></article></div>\`
2. \`bind_data(nodeId: <id of the .list div>, ...)\` with ONE source. The container becomes a repeater (the id changes, the children keep their ids).
3. \`get_screenshot\` to check; adjust the template with the usual tools and use \`get_data\` to see columns and rows.

## Bindings

\`{{field}}\`, \`{{a.b}}\` (nested path, \`{{items.0.name}}\`), \`{{field | default}}\` (uses the default if missing) and specials: \`{{$index}}\` (0, 1, ...), \`{{$number}}\` (1, 2, ...), \`{{$item}}\` (the whole item, for a list of strings). They work in text, \`src\` and attributes.

## \`bind_data\` sources

- \`data\`: a direct list (\`[{ "name": "Ana" }]\`).
- \`text\` + \`format\` (\`json\` or \`csv\`): pasted content.
- \`path\`: absolute \`.json\`, \`.csv\` or \`.tsv\` file (up to 5 MB; the CSV separator is detected: comma, semicolon, tab).
- \`url\`: http(s) that returns JSON or CSV (up to 5 MB, 20 s).
- \`select\`: path of the list inside the JSON (\`data.items\`); without it the server finds the first list.
- \`mapping\`: \`{ "name": "user.fullName" }\` binds the template field to another path of the item without rewriting the template.
- \`limit\`: only the first N items.

The response lists the columns and the template fields and warns about fields with no matching column.

## Refreshing and checking

- \`refresh_data(nodeId)\` rereads the source file or URL (pasted data has no source to reread).
- \`get_data(nodeId, limit?)\` shows the source, columns, template fields and the first rows.
- Running \`bind_data\` again on the repeater only swaps the data. One \`undo\` reverts the conversion.

## Rewriting a repeater with HTML

\`get_html\` returns only the repeater's template, marked with \`data-mockup-repeat="<id>"\` (and \`data-repeat="<items>"\`, informational). Keep that attribute in the HTML sent to \`write_html\` (e.g. \`mode: "replace"\`): the element comes back as a repeater with the data and source of the original (new id). Without the mark it becomes a plain container and the response warns that the data was lost (\`undo\` restores it). To change only the card, prefer editing the template nodes.

## Limits

Up to 1000 items and 2 MB of data per repeater; beyond that, use \`limit\` or \`select\`. A container with no children does not become a repeater (create the template first); a root frame does not either (put the template in a div inside it).
`,
};
