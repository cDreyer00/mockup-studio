# Native Tailwind CSS v4

Mockup Studio supports Tailwind CSS v4 as a way to write the design: the agent (or the user,
pasting HTML) writes markup with Tailwind classes, the canvas renders the result and the export
returns idiomatic Tailwind. The document model is still **real CSS per node**
(`node.style`); the classes are translated by Tailwind's official compiler.

## Overview

```
 Tailwind classes (write_html, import_component, set_classes, paste, "Classes" panel)
        |  @mockup/core/tailwind  (official `tailwindcss` v4 compiler)
        v
 node.style  +  node.states { hover, dark, md, md:hover, ... }  +  node.classes (hint)
        |  render (canvas, screenshot)          |  export
        v                                       v
 resolveStateStyle(node, frame, theme, preview)   engine.nodeClasses(node) → canonicalized classes
```

## Where the compiler runs

- The `tailwindcss` v4 package is plain JavaScript, with no dependencies and no Node or DOM APIs (it is
  the same core as `@tailwindcss/browser`). That is why the engine lives **in the core**, in the
  `@mockup/core/tailwind` subpackage (`packages/core/src/tailwind/`), and runs the same in the daemon, the editor, in
  Electron and in tests. We do not use `@tailwindcss/node`: it depends on `fs`/native `lightningcss`
  and would only work in the daemon.
- The subpackage stays **outside the core's main index**: the editor loads it on demand
  (`import('@mockup/core/tailwind')`), in a separate chunk, so it does not weigh down the canvas.
- The API used is the compiler's design system (`__unstable__loadDesignSystem`): `candidatesToAst`
  (class → CSS rules), `parseCandidate`/`printCandidate` (variants), `getClassOrder` (cascade
  order), `canonicalizeCandidates` (`p-[16px]` → `p-4`, `mt-2 mb-2` → `my-2`) and `getClassList`
  (autocomplete). The API is marked unstable by Tailwind: the version is pinned (exact,
  `4.3.5`) in the core's `package.json`, the round-trip tests catch behavior changes and
  a test in `canonicalize.test.ts` fails with a clear message if the shape of
  `utilities.keys`/`getClassList`/`canonicalizeCandidates` changes, which the engine overrides in the light design
  system. When updating `tailwindcss`, run that test first.
- The default theme (`tailwindcss/theme.css`) is embedded in `theme.generated.ts` by the script
  `packages/core/scripts/sync-tailwind-theme.mjs` (run it when updating `tailwindcss`; a test
  fails if the generated file is out of date), because the core does not read files.

### Per-document engine and cache

`getTailwindEngine(doc)` creates (asynchronously, ~20 ms) an engine with:

- Tailwind's default theme as `@theme default inline` — the values go into the node already resolved
  (`p-4` → `padding: 1rem`, `bg-blue-500` → `oklch(62.3% 0.214 259.815)`);
- the document tokens that fall in a theme namespace (`--color-*`, `--font-*`, `--text-*`,
  `--radius-*`, `--shadow-*`, `--spacing`, `--breakpoint-*`...) as a regular `@theme` — the node stays
  **bound to the token** (`bg-primary` → `background-color: var(--color-primary)`), so changing the
  token or the theme changes the render;
- `@custom-variant dark (&:where([data-theme=dark], [data-theme=dark] *))` and the
  `theme-<name>` variants of the document's themes.

The cache is keyed by the tokens that go into `@theme` (and by the theme names): changing a token
produces a new key and a new engine on the next call, with no manual invalidation. It keeps the last 8
engines. Once created, everything is synchronous and cached per class. When creating an engine, the
cache schedules `engine.warmup()` when idle (`requestIdleCallback` in the editor, `setTimeout(0)` in the
daemon, after responding; `getTailwindEngine(doc, { warmup: false })` turns it off), so the
first "Show as Tailwind" and the first `get_code` do not stall. Paths without Tailwind
(`get_code`/`export` with `styles: 'inline'`) do not load the engine.

## Classes → style

`engine.classesToStyles(classes)`:

1. Each class is read by Tailwind itself (`parseCandidate`). Variants are separated from the
   utility; the utility without variants is compiled (`candidatesToAst`).
2. Declarations are applied in **Tailwind's cascade order** (`getClassOrder` of the whole
   class list, per state), not in attribute order (`p-4 px-2` and `px-2 p-4` give the
   same result, as in the browser: `px-2` comes after `p-4` in the CSS and wins on the
   horizontal axis; likewise `border border-b-0`, `rounded-lg rounded-t-none`, `hover:p-1 hover:px-8`);
   `!important` beats regular declarations and is stored as `value !important`.
3. Internal variables (`--tw-shadow`, `--tw-ring-color`, `--tw-border-style`,
   `--tw-gradient-*`...) are **resolved on the node itself**, with the `@property` `initial-value`s
   and the fallbacks — the stored style is regular CSS, editable in the panel:
   `shadow-md` → `box-shadow: 0 4px 6px -1px rgb(0 0 0 / 0.1), 0 2px 4px -2px rgb(0 0 0 / 0.1)`;
   `ring-2 ring-blue-500` → `box-shadow: 0 0 0 2px oklch(...)`. Empty shadow layers
   (`0 0 #0000`) are dropped; `calc()` without `var()` is evaluated (`calc(0.25rem * 4)` → `1rem`).
4. Document variables (tokens) stay as `var(...)`.

Result: `{ style, states, children?, applied, unknown, unsupported }`.

### Variants → `node.states`

| Tailwind variant                                                              | Where it goes           | When it applies on the canvas/screenshot                                                 |
| ----------------------------------------------------------------------------- | ----------------------- | ---------------------------------------------------------------------------------------- |
| `hover:`, `focus:`, `focus-visible:`, `focus-within:`, `active:`, `disabled:` | `states.hover` etc.     | In the editor's state preview and in `get_screenshot(state)`                             |
| `dark:`                                                                       | `states.dark`           | Inside a frame/node with the `dark` theme (`data-theme="dark"`) or in the `dark` preview |
| `sm:` `md:` `lg:` `xl:` `2xl:`                                                | `states.md` etc.        | When the **root frame's width** is ≥ the breakpoint (640, 768, 1024, 1280, 1536 px)      |
| Combinations (`md:hover:`, `dark:hover:`, `lg:dark:focus:`)                   | `states["md:hover"]`... | When all parts apply                                                                     |

- The key is canonical (`breakpoint:dark:pseudo`); `hover:md:` becomes `md:hover`.
- Each state stores only what changes relative to the base style (including properties
  recomputed by variables: `hover:ring-red-500` stores the state's whole `box-shadow`).
- Application order (like the specificity of the generated CSS): base, breakpoints in ascending
  order, `dark`, and last the pseudo-class states.
- `dark:` corresponds to the document's `dark` theme (tokens phase): the same `data-theme` that
  switches the tokens activates the `dark:` classes. In the Tailwind export the same `@custom-variant` is emitted.
- `dark` preview (editor and `get_screenshot(state: 'dark')`): if the document has a theme named
  `dark`, the rendered root frame gets `data-theme="dark"` (DOM only; the document does not change),
  so the tokens switch together with the `dark:` variants, as in `get_styles(state: 'dark')`.
  Without a `dark` theme, only the `dark:` variants are applied.
- Nested dark: `dark:` applies across the whole subtree of a dark node, even inside a descendant
  with `data-theme="light"` (that descendant's tokens go back to the light theme, but the
  `dark:` variants stay on). This is what the exported CSS does (`[data-theme=dark] *`), and the canvas
  follows the same rule.

### Breakpoints and frames

Frames are the design's viewports. An `md:flex-row` applies in a 1280 px frame and not in a
375 px one: the same responsive markup renders "mobile" or "desktop" depending on the frame it is in. To
see both versions, duplicate the frame and change the width (the MCP's `responsive` guide already recommends
Mobile/Tablet/Desktop frames). In the export, `md:` classes come back as they are and take effect
through the browser viewport, as in any Tailwind project.

The widths come from the document's `--breakpoint-sm` … `--breakpoint-2xl` tokens (px or rem; missing ones
use Tailwind's default), through a single helper (`breakpointsOf(doc)`): with
`--breakpoint-md: 900px`, `md:` activates from 900 px on the canvas, in the screenshot, in
`get_styles`, in the HTML export's `@media` and in the compiled Tailwind. `get_styles(state: 'md')`
simulates the document's minimum `md` width even in a narrower frame.

### What does not become style

| Case                                                                                                                     | Handling                                                                                                                                                                                                     |
| ------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Class Tailwind does not know (`group`, `peer`, `my-class`)                                                               | `unknown`: stays in `node.classes`, with no effect, and comes back unchanged in the export                                                                                                                   |
| Variant with no equivalent (`group-hover:`, `peer-*:`, `aria-*:`, `data-*:`, `before:`, `[&_svg]:`, `max-md:`, `has-*:`) | `unsupported` (with the reason): stays in `node.classes` and comes back unchanged in the export                                                                                                              |
| Utility with its own `@media` or a pseudo-element selector (`container`, `placeholder:*`)                                | `unsupported`                                                                                                                                                                                                |
| Classes for children (`space-y-2`, `space-x-*`, `divide-y`, `*:p-2`)                                                     | The CSS goes to the children (below their own classes); the parent's class is not re-exported. Removing the class (`remove`/`replace`) undoes what it wrote on the children that still have the stored value |
| `animate-*`                                                                                                              | `animation` is stored, but the `@keyframes` do not exist on the canvas (it does not animate)                                                                                                                 |

`write_html`/`import_component` report the `unknown`/`unsupported` classes in the response.

## `node.classes`: the round-trip hint

`node.classes` stores the classes **as they were written**. The render never uses this field (it uses
`style`/`states`); it serves so the export can return the author's classes:

- `engine.nodeClasses(node)` compiles `node.classes` and, for each class, checks whether the
  properties it produces (including via `--tw-*` variables: `from-red-500` affects the
  `background-image` of `bg-linear-to-r`) **still match** the node's current style, per state.
  The ones that match are reused in the original order; the remaining properties generate new classes.
- Edited the padding in the panel? `p-4` no longer matches and `p-6` comes out (or whatever fits); the rest
  stays as the author wrote it. Renamed a token? `renameToken` also rewrites the classes
  (`bg-brand`, `hover:bg-brand/90`, `bg-[var(--color-brand)]` → `accent`) when source and target
  are in the same namespace; undo returns the old classes.
- `unknown`/`unsupported` classes always come back (the model cannot check them).
- On file load, classes with forbidden characters (`<`, `{`, `}`, `;`, `"`, backtick) are
  discarded and the valid ones stay: the same rule as the `setClasses` op and the HTML import.
- Token uses in `node.states` (e.g. `hover:bg-hov`) count in the token report
  (`get_tokens`): they do not show up as unused, and broken references in a state come out with
  `property: 'state:hover:background-color'`.

**Why a dedicated field and not `attrs.class`:** `attrs` is documented as "without `style` and without
`class`" and several places (import sanitization, exporters, `setAttrs`, render) remove or
reject `class`; on the canvas, a real `class="hidden flex"` would collide with the editor UI's CSS.
A separate field makes it clear it is a hint, not applied CSS.

## Style → classes (idiomatic export)

`engine.stylesToClasses(style)`:

1. MVP static mapping (`cssToTailwind`: spacing scale, theme colors and document tokens,
   typography, borders, shadows, flex/grid, `[prop:value]` as a last resort).
2. **Canonicalization** by Tailwind itself (`canonicalizeCandidates`, with `rem: 16` and
   `collapse`): `p-[16px]` → `p-4`, `bg-[#6c5ce7]` → `bg-primary` (if the token exists),
   `pt-4 pb-4` → `py-4`, `text-sm leading-[1.25]` → `text-sm/tight`.
3. **Verification**: the resulting classes are compiled again and compared with the style
   (normalized values: rem ↔ px, colors in hex). A class that does not reproduce the value becomes
   `[prop:value]`; redundant classes (e.g. `border-solid` alongside `border`) are dropped.

**Cost of canonicalization:** on the first call of each engine, `canonicalizeCandidates`
computes the signature of every class in `getClassList()` (~23 thousand) and, for each new
arbitrary value, tests every functional root. The engine uses a "light" design system, without the
`mask-*`, `scroll-*` and `scrollbar-*` classes and roots (they only declare
`mask*`/`scroll*` properties, so they never have another class's signature), and only falls back to the full list
when the input touches those properties: the result is identical (test in
`canonicalize.test.ts`). Results are cached per engine; `engine.warmup()` brings the
warm-up forward. Landing: first cold export 2.4 s → 1.2 s; after `warmup()` ~0.3 s;
repeated ~15 ms.

The output is therefore always faithful to the render, and idiomatic whenever Tailwind has a name for
the value. States come out with the variant prefix (`hover:`, `md:`, `dark:`, `md:hover:`).
`style=""` only carries values that cannot become a safe arbitrary class (with `{`, `}`, `;`, `<`,
`>` or backtick); any other property comes out as `[prop:value]`, so an inline style never
overrides a `hover:`/`md:` for the same property.

`text-*` and `line-height`: nodes written in CSS usually have only `font-size` (inherited line
height). When a node uses a named size without Tailwind's default `line-height`, the exported
theme neutralizes that size (`--text-sm--line-height: inherit`) and the verification takes this
into account. Nodes imported from Tailwind already carry the `font-size` + `line-height` pair and skip
the neutralization.

## Base CSS (`cssBase`)

Tailwind assumes the preflight (margin reset, `0 solid` borders, headings with no size of their own,
buttons with no background, lists with no marker, block `img`). The document gets `cssBase: 'tailwind'`:

- the document's base CSS (`documentBaseCss`, the same on the canvas, in the render and in the code) now
  includes Tailwind v4's preflight (`TAILWIND_PREFLIGHT`, scoped on the canvas) and Tailwind's
  typographic root (font `--font-sans`, `line-height: 1.5`);
- `write_html`, `import_component` and paste in the editor turn the base on automatically on the first
  Tailwind import (in the same op, one undo), warning in the response;
- `set_css_base('default' | 'tailwind')` in the MCP and the "Base CSS" selector in the document panel
  turn it on/off. Switching the base affects every node in the document (e.g. `h1` with no size of its own).

## shadcn/ui and pasted components

shadcn/ui components use semantic colors (`bg-primary`, `text-muted-foreground`,
`border-input`) that only exist with shadcn's theme variables. `import_component(html)`:

- detects classes that use those colors (`usesShadcnColor`) and creates the missing tokens from shadcn v4's
  "neutral" preset (`--color-background`, `--color-primary`, `--color-card`, `--color-border`,
  `--radius` and relative `--radius-sm..xl`, etc.) and the `dark` theme with the overrides
  (`planShadcnTokens`); tokens already defined are not touched;
- applies shadcn's base rule `* { border-color: var(--color-border) }` as `border-color` on
  nodes with a border and no color (in any Tailwind write, when the document has the preset's
  `--color-border` and `--color-primary` tokens);
- names the layers by `data-slot` (`Card header`, `Card title`...).

Paste in the editor follows the same rule as `import_component`: it creates the missing shadcn tokens (in the
same ops as the paste, one undo, with an on-screen warning) and applies the default border
`var(--color-border)`. `write_html` only creates the tokens with `tokens: 'auto'`.

## Tools and interface

| Interface (editor)                            | MCP                                                                                         |
| --------------------------------------------- | ------------------------------------------------------------------------------------------- |
| Paste HTML with Tailwind classes              | `write_html` (automatic detection, `tailwind: 'on'`, `css: 'tailwind'`), `import_component` |
| "Classes" field in the Properties panel       | `set_classes(nodeIds, classes, mode)`                                                       |
| Autocomplete in the classes field             | `suggest_classes(query)`                                                                    |
| "Show as Tailwind"                            | `get_classes(nodeIds)`, `get_code(format: 'tailwind')`                                      |
| State preview (hover, focus, active, dark...) | `get_screenshot(state)`, `get_styles(state)`                                                |
| The node's state list (remove a state)        | `get_node_info`, `update_styles(state, unset)`, `set_classes(mode: 'remove')`               |
| `hover:`/`md:`/`dark:` classes in the field   | `set_classes`, `update_styles(state)` (writes the CSS directly into the state)              |
| Document "Base CSS" selector                  | `set_css_base`, `get_tailwind_config`                                                       |
| Export Tailwind/React                         | `export`, `get_code`                                                                        |

Guide for agents: `get_guide('tailwind')`. Details of each tool in [MCP.md](MCP.md), of the
interface in [EDITOR.md](EDITOR.md) and of the export in [EXPORT.md](EXPORT.md).

## Known limitations

- Group/sibling/attribute variants (`group-hover:`, `peer-*`, `aria-*`, `data-*`, `has-*`),
  pseudo-elements (`before:`, `after:`, `placeholder:`), arbitrary variants (`[&_svg]:`) and
  `max-*:` do not affect the render; they are preserved in the class.
- In the editor, states are edited through the classes field (`hover:bg-...`); the panel's style fields
  (size, typography...) always edit the base style, even with the preview active. The MCP
  writes CSS directly into a state with `update_styles(state)`.
- The classes field applies in `replace` mode: the classes become the node's style (deleting
  a node's classes clears the style they generated). On a node without `node.classes` the field opens with the
  classes equivalent to the current style (`engine.nodeClasses`). `replace` (field and
  `set_classes`) keeps the positioning (`position`, `left`, `top`, `right`, `bottom`,
  `z-index`) and the CSS with no equivalent class when the new classes do not define those
  properties; to remove them, use `update_styles(unset)`.
- The editor's state preview is global (it applies to every node and does not change when switching
  documents).
- Without the `node.classes` hint, some values come out as an equivalent arbitrary class instead of the
  idiomatic form (`shadow-sm`, `ring-*`, `bg-blue-500/50`, `bg-linear-*` gradients): the output recompiles
  to the same style, it is just less readable.
- Inline HTML and React do not carry the CSS of classes the model does not represent (`aria-*:`,
  `has-[...]:`, `[&_svg]:`, `group-hover:`); the Tailwind export returns them as they are.
- `animate-*` does not animate on the canvas; transitions are not simulated in the preview.
- React export with `styles: 'inline'` and SVG do not carry the states.
- Custom breakpoints (`--breakpoint-*` in tokens) change the width of `sm` … `2xl`, but
  new names (`--breakpoint-3xl`) only reach the compiler: the node's states recognize only
  `sm`, `md`, `lg`, `xl` and `2xl`.
