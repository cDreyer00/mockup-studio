# Tokens and themes

A document's design system is a set of CSS variables (tokens), optional metadata (group and description) and themes that override tokens on entire frames. It is all real CSS: what the editor shows is what the export delivers.

## Model

Three `Document` fields (types in `packages/core/src/types.ts`):

| Field       | Type                                           | Description                                                                               |
| ----------- | ---------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `tokens`    | `Record<string,string>`                        | Base tokens, equivalent to `:root { --name: value }`.                                     |
| `tokenMeta` | `Record<string,{ group?, description? }>`      | Group and description per token. Optional; without a group, it is inferred from the name. |
| `themes`    | `{ name, overrides: Record<string,string> }[]` | Themes. `overrides` are the overridden tokens, equivalent to `[data-theme="x"] {}`.       |

A frame's theme is the node's `data-theme` HTML attribute (constant `THEME_ATTR`), in `node.attrs`. It applies to the node and all descendants; the theme of the nearest ancestor wins. Token names follow `--[A-Za-z0-9_-]+`; theme names, letters, digits, `-` and `_` (up to 64 characters, starting with a letter or digit).

```json
{
  "tokens": {
    "--blue-600": "#2563eb",
    "--slate-900": "#0f172a",
    "--color-primary": "var(--blue-600)",
    "--color-primary-hover": "color-mix(in oklch, var(--color-primary), black 15%)",
    "--color-surface": "#ffffff",
    "--space-4": "16px",
    "--space-card": "calc(var(--space-4) * 1.5)"
  },
  "tokenMeta": {
    "--color-primary": { "group": "color", "description": "Primary action" }
  },
  "themes": [
    {
      "name": "dark",
      "overrides": { "--color-surface": "var(--slate-900)", "--blue-600": "#60a5fa" }
    }
  ]
}
```

And on a dark frame: `{ "attrs": { "data-theme": "dark" } }`.

## Groups

The built-in groups (`TOKEN_GROUPS`) are `color` (Colors), `typography` (Typography), `spacing` (Spacing), `radius` (Radius), `shadow` (Shadow) and `other` (Other). `tokenMeta[name].group` also accepts a free name, which appears under its own name. A free name equal to the label or id of a built-in group (case- and accent-insensitive, e.g. `Colors`, `colors`) counts as the built-in one (`canonicalTokenGroup`): the panel and `get_tokens` show a single group, and the value type is checked as for the built-in one.

Without an explicit group, `inferTokenGroup` decides by the name's prefix and, if there is no known prefix, by the value:

- `color`/`colors`, `bg`, `background`, `fg`, `foreground`, `surface`, `border-color`, `accent`, `brand`: color.
- `shadow`, `elevation`, `drop-shadow`, `inset-shadow`: shadow.
- `radius`, `radii`, `rounded`, `corner`: radius.
- `font`, `text`, `leading`, `tracking`, `line-height`, `letter-spacing`, `typography`, `type`: typography.
- `space`, `spacing`, `spacer`, `gap`, `size`, `padding`, `margin`, `inset`, `container`: spacing.
- No prefix: hex, `rgb()`/`oklch()`/`color-mix()` or a named color become color; a length with a unit becomes spacing; `0 4px 12px #0003` becomes shadow; the rest is "Other".

## Resolution

The semantics are those of CSS: a variable is resolved on the element where it is declared.

- **Scope**: `:root` resolves `tokens`. A node inside `data-theme="x"` sees the base tokens with the theme's overrides; custom properties declared in ancestors' styles apply to descendants.
- **Aliases follow the theme**: `--color-primary: var(--blue-600)` changes by itself when the theme overrides `--blue-600`. For that, the theme CSS also redeclares the base tokens that depend (directly or indirectly) on an overridden token, with the base value, so that they are resolved inside the theme. Overriding the alias itself in the theme also works.
- **Cycles**: all variables in the loop end up with no value (as in CSS) and show up as a problem.
- **Fallback**: `var(--x, 8px)` uses the fallback if `--x` does not exist. Without a fallback, the reference stays in the text and goes into the report's `broken`.
- **Inline SVG**: the markup of SVG nodes can use `var(--token)` (in `style`, presentation attributes such as `fill`, or an internal `<style>`). On the canvas and in the screenshot the SVG is drawn in an `<img>` via data URI, where the document's variables do not reach; for that reason `inlineSvgVars(svg, scopeVarsFor(doc, nodeId))` replaces the `var()`s with the values from the node's scope (tokens, effective theme and ancestors' custom properties) before building the image, and the SVG follows the token and the theme. Variables declared inside the SVG itself are left as they are. The data URI also gets `xmlns` when it is missing (without it the image does not load and comes out 0x0). In the exporters, HTML, React and the layout-less SVG (`foreignObject`) keep the SVG in the DOM and the `var()`s as they were written; the SVG with measured layout (standalone, without token CSS) resolves the `var()`s the same way.

### calc() and color-mix()

`getComputedLike(doc, nodeId, { theme?, evaluate? })` resolves the theme (the node's or the one forced in `theme`) and evaluates `calc()` and `color-mix()` when possible (e.g. `calc(var(--space-4) * 2)` becomes `32px`; `color-mix(in oklch, #2563eb, black 15%)` becomes a color). With `evaluate: false` the text is kept. The exported CSS keeps `calc()`/`color-mix()` as they were written.

### Validation

`validateTokenValue(name, value, { group, vars })` returns `null` or a problem:

- `error`: invalid syntax (unbalanced parentheses/quotes, a value that escapes the declaration, empty). The MCP server rejects the whole call.
- `warning`: accepted, but suspicious (reference to a nonexistent token, or the type does not match the group, such as a color in a spacing token). It goes into the response.

The type check resolves the `var()`s and uses css-tree's per-property lexer (`color`, `box-shadow`, `font-family`...).

**Why css-tree**: it is pure, synchronous JavaScript, about 200 KB in the `dist/csstree.esm` bundle, which runs in the browser, in Node and in the Electron and CLI bundles. The lexer validates values per property, including `color-mix()`. `lightningcss-wasm` would require asynchronous initialization and a WASM binary of several MB, and it is a CSS transformer, not a per-property validator.

## Ops

In `packages/core/src/ops.ts`, all with an exact inverse (one undo each):

| Op              | Fields                            | Effect                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| --------------- | --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `setTokens`     | `set?`, `unset?`, `theme?`        | Sets/removes tokens in the base or, with `theme`, in that theme's overrides (which must exist).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `setTokenMeta`  | `set?`, `unset?`                  | Sets (replaces entirely) or removes group/description.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `setThemes`     | `themes`                          | Replaces the list of themes (create, remove, rename, reorder).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `replaceTokens` | `tokens`, `tokenMeta?`, `themes?` | Replaces the whole system; used by import and by the inverses.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `renameToken`   | `from`, `to`                      | Renames the key (base, meta, themes) and all `var(--old)` (styles, `attrs` values, inline SVG markup, `node.states` states, tokens and themes) and the `node.classes` classes that use the token: `[var(--old)]`/`(--old)` forms always; utilities with the theme's short name (`bg-brand`, `hover:bg-brand/90`, `rounded-card`) only when source and destination are in the same namespace (`--color-*` → `--color-*`). Undo gives back the old classes. Rejects a destination that already exists or is already declared in some node's style. Result: `{ from, to, nodes, references }`. |

The planners `planDeleteTokens`, `planApplyToken`, `planCreateTheme`, `planDeleteTheme`, `planRenameTheme`, `planSetFrameTheme` and `planImportTokens` build the composite ops (for example, deleting a theme also removes the `data-theme` from nodes). `getTokenReport(doc)` returns tokens with group, value, resolved value (base and per theme), usages, problem, plus themes with their frames, unused tokens and broken references. States (`node.states`) count as usage; broken references in them come out with `property: 'state:<key>:<prop>'` (e.g. `state:hover:background-color`), and custom properties declared in a state apply only to that state.

## MCP tools

Every write tool generates ops and applies them in a single call (one undo entry, the same path as the editor). `get_guide('tokens')` brings the recommended flow.

| Tool              | Parameters                                                                 | Description                                                                                            |
| ----------------- | -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `get_tokens`      | `group?`, `theme?`, `format?` (`text`/`json`), `docId?`                    | Tokens by group (value, resolved, description, usages, unused, problem), themes and broken references. |
| `set_tokens`      | `tokens?`, `unset?`, `theme?`, `groups?`, `descriptions?`, `docId?`        | Sets/removes tokens, in the base or in a theme; saves group and description.                           |
| `rename_token`    | `from`, `to`, `docId?`                                                     | Renames and updates the references (styles, states, `attrs`, SVG, classes).                            |
| `apply_token`     | `nodeIds`, `property`, `token`, `docId?`                                   | Writes `property: var(--token)` to the nodes.                                                          |
| `create_theme`    | `name`, `overrides?`, `copyFrom?`, `docId?`                                | Creates a theme.                                                                                       |
| `delete_theme`    | `name`, `docId?`                                                           | Removes the theme and the frames' `data-theme`.                                                        |
| `rename_theme`    | `from`, `to`, `docId?`                                                     | Renames the theme and the frames' `data-theme`.                                                        |
| `set_frame_theme` | `nodeIds`, `theme` (name or `null`), `docId?`                              | Sets the frames' theme; `null` goes back to the base tokens.                                           |
| `import_tokens`   | `content`, `format?` (`css`/`json`), `mode?` (`merge`/`replace`), `docId?` | Imports CSS or DTCG; returns counts and warnings.                                                      |
| `export_tokens`   | `format` (`css`/`json`/`tailwind`), `docId?`                               | Returns the text.                                                                                      |

`get_styles` accepts `theme` to show the values as if the node itself had `data-theme` with that theme (in place of whatever it has). As in CSS, inherited properties (color, font...) arrive already computed on the ancestor that declares them: a theme on the child does not change the frame's inherited `color: var(--fg)`. To see a whole frame in the theme, query the frame or change its theme with `set_frame_theme`.

```js
set_tokens({
  tokens: {
    '--blue-600': '#2563eb',
    '--color-primary': 'var(--blue-600)',
    '--color-primary-hover': 'color-mix(in oklch, var(--color-primary), black 15%)',
    '--space-4': '16px',
  },
  groups: { '--blue-600': 'color' },
  descriptions: { '--color-primary': 'Primary action' },
});
create_theme({ name: 'dark', overrides: { '--blue-600': '#60a5fa' } });
set_frame_theme({ nodeIds: ['fr_ab12cd34'], theme: 'dark' });
get_styles({ nodeIds: ['el_ab12cd34'], theme: 'dark' });
rename_token({ from: '--color-brand', to: '--color-primary' });
```

Rules of `set_tokens`: names without `--` get the prefix; `unset` without `theme` removes from the base, the metadata and all themes (`planDeleteTokens`); with `theme`, only from the overrides. A value error rejects the whole call; a warning goes into the response. `groups` and `descriptions` merge with the existing meta (an empty description deletes it).

## Import and export

| Format     | Import                                                                                                                                                           | Export                                                                                                                                                                 |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `css`      | `:root { ... }` for the base; themes only via `[data-theme="x"]`, `.dark`, `.light` or `.theme-x`; reads `@theme`, `@media (prefers-color-scheme)` and `@layer`. | `:root` and one `[data-theme="x"]` per theme (with the dependent aliases redeclared).                                                                                  |
| `json`     | W3C Design Tokens (DTCG): nested groups, `$value`, `$type`, `$description`, `{a.b}` aliases.                                                                     | The same fields; Mockup Studio's group and the per-theme values go in `$extensions["mockup-studio"]`.                                                                  |
| `tailwind` | (use `css`; `@theme` is read)                                                                                                                                    | Tailwind v4: `@theme { ... }` for the theme namespaces, `:root` for the rest, theme rules and `@custom-variant theme-<name>` (plus `dark` when a `dark` theme exists). |

`import_tokens` with `mode: "merge"` (default) keeps what exists and overwrites repeated names (themes are merged by name); `replace` replaces tokens, metadata and themes. The result carries `warnings` (ignored rules, discarded values, metadata with the wrong type: `$description` or group/themes in `$extensions` that are not text/object are discarded, and the token is imported).

## Code exporters

The project exporters (see [EXPORT.md](EXPORT.md)) use the same system:

- **HTML**: `:root { ... }` with the tokens and `[data-theme="x"] { ... }` per theme; frames keep the `data-theme` attribute.
- **Tailwind**: the block above (`@theme`, theme rules and `@custom-variant`).
- **React inline**: inline styles keep `var(--token)` and the tokens CSS comes along.

## Editor

Details and gestures in [EDITOR.md](EDITOR.md#tokens-and-themes). Every panel action generates the same ops as the MCP tools (same undo).

| In the editor                                             | MCP tool                                          |
| --------------------------------------------------------- | ------------------------------------------------- |
| **Tokens** tab: create, edit value, group and description | `set_tokens` (`tokens`, `groups`, `descriptions`) |
| Rename (double click on the name)                         | `rename_token`                                    |
| Delete token                                              | `set_tokens` with `unset`                         |
| Theme being edited + edit value / remove override         | `set_tokens` with `theme` (and `unset`)           |
| Create, rename and delete theme                           | `create_theme`, `rename_theme`, `delete_theme`    |
| Import (paste CSS or JSON) and Export                     | `import_tokens`, `export_tokens`                  |
| "Bind to token" icon on property inputs                   | `apply_token`                                     |
| Frame **Theme** row in the properties panel               | `set_frame_theme`                                 |
| Unused and broken warnings                                | `get_tokens` (`unused`, `broken`, `problem`)      |

The canvas and the render page (screenshot) inject the theme rules with the `.cv-world ` scope, so what the agent sees in `get_screenshot` is the same CSS as the exported HTML.
