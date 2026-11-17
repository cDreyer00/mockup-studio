# Real data

Mockups with real content: lists, tables and card grids filled from JSON, CSV or an HTTP API. The agent (or the UI) writes **one** item as a template and binds a data list to it; the canvas, the screenshot and the exported code show one item per row.

## Repeater

A repeater is a `type: 'repeater'` node (id `rp_...`). It behaves like a regular container (it has `tag`, `style` and `attrs`, so `display: grid`, `flex`, `gap` etc. work as usual) and stores:

| Field        | Type                    | Description                                                      |
| ------------ | ----------------------- | ---------------------------------------------------------------- |
| `data`       | `unknown[]`             | Items (up to 1000 and 2 MB serialized).                          |
| `dataSource` | `DataSource` (optional) | Where the data came from, for refreshing, and the field mapping. |
| `children`   | `Node[]`                | The **template**: all children repeat, in order, once per item.  |

`DataSource`:

| Field       | Description                                                                                                                              |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `kind`      | `inline` (pasted or edited in the table), `json` or `csv` (local file) or `url` (HTTP(S)).                                               |
| `path`      | Absolute path of the file (`json`/`csv`). With `inline`, only a reference to where the data came from before it was edited.              |
| `url`       | http(s) URL (`url`). JSON or CSV, by content-type or extension.                                                                          |
| `select`    | Path to the list inside the JSON, e.g. `data.items`. Without it: the list itself, or the first property that is a list (up to 2 levels). |
| `mapping`   | Template field → path in the item, e.g. `{ "name": "user.fullName" }`.                                                                   |
| `limit`     | Maximum number of items read from the source.                                                                                            |
| `fetchedAt` | When the data was read (ISO 8601).                                                                                                       |

The source is stored in the document: `refresh_data` (or the **Refresh** button in the panel) re-reads the file or URL. There is no automatic refresh. Editing the table in the panel switches the source to `inline` in the same op (keeping `path`/`url`, `mapping` and `fetchedAt` as a reference), so **Refresh** is disabled and does not discard the edit; to go back to reading the file or URL, use **Bind…**/`bind_data` again.

## Bindings

In `text`, `src` and in attribute values (`href`, `alt`, `title`, `aria-label`, `data-*`...) of the template nodes:

| Syntax                | Result                                             |
| --------------------- | -------------------------------------------------- |
| `{{name}}`            | Item field.                                        |
| `{{address.city}}`    | Dotted path; list indexes too (`{{photos.0}}`).    |
| `{{role \| No role}}` | Default value when the field is missing or empty.  |
| `{{$number}}`         | Position starting at 1 (`{{$index}}` starts at 0). |
| `{{$item}}`           | The whole item (lists of strings or numbers).      |

Objects and lists become JSON; a nonexistent field becomes empty. Dangerous URLs coming from the data (`javascript:`, `vbscript:`, `data:text/html`) are discarded in `href`/`src`. Styles do not accept bindings (`{` and `}` are rejected in CSS); to vary color or size per item, use classes/attributes or data with different image paths.

## Expansion

`expandRepeaterChildren` (core, `data.ts`) generates the copies: item 0 keeps the template's ids and the following items get the suffix `~<index>` (`tx_ab12~3`). These ids exist only during expansion, never in the document or in ops.

- **Canvas and render page** (`NodeView`): the repeater renders the expanded items; each copy uses the template node's `data-node-id`, so clicking any item selects the real template node and editing the template changes all items.
- **Screenshot and `get_layout`**: come from the render page, with the same items as the canvas.
- **Export** (html, tailwind, react, svg): `resolveRoots` expands before generating the code; the repeater comes out as the container with all the items (in React, repetition extraction can turn it into a `map`). Images coming from the data go into the asset copy.
- **Nested repeater**: a repeater inside the template uses its own data (not the outer item's); ids remain unique.
- **No data**: the template appears once, with empty bindings.

## MCP flow

1. Write the template with `write_html`, using bindings:

   ```json
   {
     "name": "write_html",
     "arguments": {
       "parentId": "fr_ab12cd34",
       "html": "<div style=\"display:grid;grid-template-columns:repeat(4,1fr);gap:16px\"><article style=\"padding:16px;border-radius:12px;background:#fff\"><img src=\"{{photo}}\" alt=\"{{name}}\" style=\"width:100%;height:120px;object-fit:cover\"><h3>{{name}}</h3><p>{{role | No role}}</p></article></div>"
     }
   }
   ```

2. Bind the data to the container with `bind_data` (it becomes a repeater; the children become the template): `data` (inline list), `path` (local JSON/CSV), `url` (HTTP) or `text` + `format` (pasted content). Optional: `select`, `mapping`, `limit`.
3. Check with `get_screenshot`. `get_data` shows the source, the columns, the template fields with no matching column and the first rows.
4. `refresh_data` re-reads the source after the file or API changes.

`get_html` of a repeater returns the template with `data-mockup-repeat="<id>"` and `data-repeat="<items>"`. A `write_html` (e.g. `mode: "replace"`) that carries this mark recreates the repeater with the original's data and source (new id, mark removed from the attributes); without the mark the element becomes a regular container and the response warns which repeaters lost their data (`undo` restores).

Full tools and parameters in [MCP.md](MCP.md#real-data); the `get_guide('data')` guide summarizes the flow for the agent.

## Editor

- **"Data" panel** (properties, repeater selected): source and read date, **Refresh**, **Bind…** (paste JSON/CSV, file path or URL, `select`, limit), **editable table** (edit cell, add/remove row and column; each edit is a `setData` op, with undo) and the **mapping** of template fields that do not exist in the data.
- **Convert to repeater**: containers with children get the action in the panel and in the context menu.
- Layers shows the repeater with the repeat icon; the tree summary in the MCP server shows `repeat:20` (and `<json`, `<csv` or `<url` when there is an external source).

## Op and format

- `setData` op: `{ type: 'setData', changes: [{ nodeId, data?, source? }] }` — `data` replaces the list (omitted keeps it), `source` sets the source (`null` removes it). The inverse restores the previous values. Only valid for `repeater` nodes.
- Converting a container into a repeater is `deleteNodes` + `createNode` (the new repeater receives the children with the same ids), in a single undo entry.
- In the file, `dataSource` and `data` come after `hidden` and before `children` in each node.

## Reading JSON and CSV

- JSON: file or response up to 5 MB; BOM ignored; a syntax error becomes a clear message.
- CSV: RFC 4180 (quotes, doubled quotes, line breaks inside quotes), separator detected from the first line (`,`, `;`, tab or `|`), first row = header (an unnamed column becomes `colN`), values as text.
- URL: http(s), 20 s timeout, up to 5 MB.
- File (`path`): absolute, only `.json`, `.csv` and `.tsv`; rejected if any folder or the file itself is hidden (name starting with `.`, e.g. `~/.ssh`, `~/.claude`), also after following symlinks. Through the editor (`POST /api/data/:docId/:nodeId/bind`) the file must be in the document's folder or in the home folder; the route requires a local Origin, like the other writes.
- Limits: 1000 items and 2 MB serialized per repeater.
