/** Guide `get_guide('scripts')`: the document scripting API (run_script, scripts panel). */
export const SCRIPTS_GUIDE = `# Scripts: automating batch edits

\`run_script\` runs JavaScript in a sandbox with access ONLY to the document API (\`doc\`). Use it for repetitive or batch edits (rename 10 nodes, change the color of all buttons, adjust spacings) instead of dozens of tool calls. Everything the script changes goes into a single undo.

\`\`\`
run_script({ code: "doc.select('button').forEach(b => b.style.background = '#2563eb'); return doc.select('button').length;" })
\`\`\`

The code runs as the body of an \`async function\` in strict mode: \`await\` and \`return\` work; the returned value (JSON) comes back in the result. There is also \`run_script({ name: "my-script" })\` for a script saved in \`scripts/\` next to the document (see \`list_scripts\`).

## API

\`\`\`
doc.id, doc.name
doc.pages()                 -> [{ id, name, frameIds }]
doc.frames(pageId?)         -> root frame nodes
doc.get(id)                 -> node or null
doc.select(query)           -> nodes (document order)
doc.selectOne(query)        -> first node or null
doc.selection()             -> nodes selected in the editor
doc.apply(op | op[])        -> results (applies immediately; an invalid op throws Error)
doc.create(parent | null, { tag, name, text, style, attrs, children })  -> created node (parent null = new frame)
doc.screenshot(nodeId?, { scale?: 1|2|3, format?: 'png'|'jpg' })     -> { nodeId, width, height, mime }
doc.tokens()                -> { "--name": "value" }
doc.setTokens({ "--name": "value" })   -> current tokens (null removes a token)
console.log / info / warn / error      -> log lines returned at the end
\`\`\`

### Queries (select, selectOne, node.select)

- **string** (mini CSS selector): \`*\`, types (\`frame\`, \`element\`, \`text\`, \`image\`, \`svg\`, \`instance\`), tags (\`button\`, \`h1\`), \`#id\`, \`.class\`, attributes \`[name="x"]\`, \`[name^=x]\`, \`[name*=x]\`, \`[name$=x]\`, \`[text*=x]\`, \`[tag=x]\`, \`[style.color]\`, \`[style.color="red"]\`, \`[attrs.href^=http]\`, descendant (space) and child (\`>\`) combinators, comma-separated list. E.g.: \`"section.hero > button, h1"\`.
- **function** \`(node) => boolean\`: receives the node's JSON snapshot ({ id, type, tag, name, text, attrs, style, classes, position, parentId, childIds, frameId, hidden, locked }).
- **object** \`{ type?, tag?, name?, text?, within? }\`: \`name\` and \`text\` accept a string (exact match) or RegExp; \`within\` is a node id (descendants only).

Component instances are NOT expanded: an instance is an \`instance\` node; to change the text inside one use \`set_instance_override\` or edit the main component (get_guide('components')).

### Node (NodeHandle)

Each read fetches the current state; each write applies an op.

\`\`\`
node.id, node.type, node.tag, node.classes (read-only)
node.name = "New"                      // renameNodes
node.text = "Hello"                    // setText
node.style.color = "red"               // updateStyles; read: node.style.color; delete: delete node.style.color
node.style.backgroundColor = "#fff"    // camelCase or kebab-case (node.style['background-color'])
node.setStyle({ padding: "8px", margin: null })   // several at once (null or "" removes)
node.attrs.href = "/contact"           // setAttrs; delete node.attrs.title removes
node.position                          // { x, y } (assignable)
node.parent, node.children, node.frame // nodes (parent is null on a root frame)
node.select(query)                     // descendants only
node.remove()                          // deleteNodes
node.duplicate()                       // returns the clone
node.toJSON()                          // snapshot (used by JSON.stringify(node))
\`\`\`

Compare nodes by \`id\` (\`a.id === b.id\`). After \`remove()\`, reading the node throws "no longer exists".

### Ops (doc.apply)

Accepts any editor op, for example:

\`\`\`
{ type: "updateStyles", nodeIds: [id], styles: { gap: "16px" }, unset: ["margin"] }
{ type: "renameNodes", changes: [{ nodeId, name }] }
{ type: "setText", changes: [{ nodeId, text }] }
{ type: "moveNodes", nodeIds: [id], parentId, index }
{ type: "setNodeFlags", changes: [{ nodeId, hidden: true }] }
\`\`\`

An array is applied atomically (all or nothing); an invalid op throws Error with the reason.

## Examples

Rename the first 10 items of a list:

\`\`\`js
const items = doc.select("section.list > div").slice(0, 10);
items.forEach((n, i) => { n.name = "Item " + (i + 1); });
return items.length;
\`\`\`

Change the color of all buttons (and complain if none was found):

\`\`\`js
const buttons = doc.select("button");
if (!buttons.length) throw new Error("No button found");
for (const b of buttons) { b.style.background = "var(--color-primary)"; b.style.color = "#fff"; }
console.log(buttons.length + " buttons updated");
return buttons.map((b) => b.id);
\`\`\`

Screenshot of the frame (the image comes back in the run_script result):

\`\`\`js
const frame = doc.frames()[0];
const info = doc.screenshot(frame, { scale: 1 });
return info;
\`\`\`

## Limits and behavior

- No \`require\`, \`import\`, \`process\`, \`fetch\`, \`setTimeout\`, \`eval\`/\`Function\`: only the API above and standard JavaScript. The word "import" is rejected anywhere in the code.
- 10 s timeout (\`timeoutMs\` up to 60000): the script is interrupted, even in infinite loops. Memory is limited (128 MB): exceeding it becomes an error, never crashes the server.
- Logs: up to 500 lines; result (\`return\`) up to 1 MB as JSON; up to 8 screenshots per run (they need the desktop app/render).
- All ops of the run form ONE undo group (a single \`undo\` reverts the whole script; inside an assistant turn, it joins the turn's undo).
- If the script fails midway, the ops already done stay applied (and in the same undo); the result says how many. Check with get_tree_summary / get_screenshot.
- \`list_scripts\` lists the library (\`scripts/*.js\` next to the .mockup.json).
`;
