# Scripts

JavaScript scripts to automate document edits: rename 10 nodes, change the color of every button, rearrange spacing, take screenshots. The script runs in a **sandbox** (worker + `node:vm`) that only sees the `doc` API; everything it changes goes into a **single undo**.

Code in `packages/server/src/scripts/`:

| File               | Role                                                                                                       |
| ------------------ | ---------------------------------------------------------------------------------------------------------- |
| `sandbox.ts`       | Creates the worker, the synchronous RPC, the timeout and the limits; `runInSandbox(code, handler, opts)`.  |
| `worker-source.ts` | Worker and bootstrap texts (JavaScript in a string, see Security).                                         |
| `host.ts`          | Daemon side of the API (`ScriptHost`): validates the arguments and applies the ops to the `DocumentStore`. |
| `selector.ts`      | Mini node selector (`doc.select("...")`).                                                                  |
| `service.ts`       | `ScriptService`: execution, the `scripts/*.js` library and AI generation.                                  |
| `prompt.ts`        | System prompt and code extraction for AI generation.                                                       |

MCP tools in `mcp/tools/scripts.ts` (`run_script`, `list_scripts`); guide `get_guide('scripts')` in `mcp/guide-scripts.ts`.

## How a script runs

The code is the **body of an `async function`** in strict mode: `await` and `return` work and the returned value (serialized as JSON) comes back in `result`.

```js
const buttons = doc.select('button');
buttons.forEach((b) => {
  b.style.background = '#2563eb';
});
console.log(buttons.length, 'buttons updated');
return buttons.map((b) => b.id);
```

There is no `require`, `import`, `process`, `fetch` or `setTimeout`, and `eval`/`new Function` do not generate code (the `Function` constructor exists but rejects strings: "Code generation from strings disallowed"). Only the API below and standard JavaScript (Array, Map, JSON, Math, RegExp, Promise, Intl...). There is also no `ArrayBuffer`, typed arrays or `WebAssembly` (see Security).

## API

### `doc`

| Member                                                                            | Description                                                                                                                                                                                                                                                                                                                  |
| --------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `doc.id`, `doc.name`                                                              | Document id and name.                                                                                                                                                                                                                                                                                                        |
| `doc.pages()`                                                                     | `[{ id, name, frameIds }]`.                                                                                                                                                                                                                                                                                                  |
| `doc.frames(pageId?)`                                                             | Root frame nodes (all pages, or only the given one).                                                                                                                                                                                                                                                                         |
| `doc.get(id)`                                                                     | Node (`NodeHandle`) or `null`. Also accepts a node.                                                                                                                                                                                                                                                                          |
| `doc.select(query)`                                                               | All matching nodes, in document order.                                                                                                                                                                                                                                                                                       |
| `doc.selectOne(query)`                                                            | The first one or `null`.                                                                                                                                                                                                                                                                                                     |
| `doc.selection()`                                                                 | Nodes selected in the editor (or the `selection` passed at execution); ids that no longer exist are ignored.                                                                                                                                                                                                                 |
| `doc.apply(op \| op[])`                                                           | Applies editor ops immediately (see `packages/core/src/ops.ts`). Returns one result per op (e.g. `{ idMap }` for `duplicateNodes`). An invalid op throws `Error`. An array is atomic.                                                                                                                                        |
| `doc.create(parent \| null, { tag, name, text, style, attrs, children, index? })` | Creates a node (and its children) and returns the handle. `parent` is an id or node; `null` creates a frame on the first page. Panel extra, shortcut for `createNode`.                                                                                                                                                       |
| `doc.screenshot(nodeId?, { scale?, format? })`                                    | Renders the node (default: the first selected one or the first frame). Returns `{ nodeId, width, height, mime }` (node size in CSS px); the image goes in `result.images`. `scale` 1, 2 or 3; `format` `png` or `jpg`. Without a render engine it throws `Error` with the render-unavailable message. Up to 8 per execution. |
| `doc.tokens()`                                                                    | `{ "--name": "value" }` (base tokens).                                                                                                                                                                                                                                                                                       |
| `doc.setTokens(obj)`                                                              | Sets tokens (the `--` prefix is optional; `null` removes). Returns the current tokens.                                                                                                                                                                                                                                       |
| `console.log/info/warn/error`                                                     | One log line per call (objects become JSON; `warn` and `error` get a `[warn]`/`[error]` prefix).                                                                                                                                                                                                                             |

### Queries

`doc.select`, `doc.selectOne` and `node.select` (the latter only looks at the node's descendants) accept three forms.

**1. String (CSS mini-selector)**, evaluated in the daemon over the real document (component instances are **not** expanded):

| Syntax                                                  | Matches                                                                                                                                         |
| ------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `*`                                                     | Any node.                                                                                                                                       |
| `frame`, `element`, `text`, `image`, `svg`, `instance`  | The node type.                                                                                                                                  |
| `button`, `h1`, `a`...                                  | The tag (case-insensitive).                                                                                                                     |
| `#id`                                                   | The node id.                                                                                                                                    |
| `.class`                                                | Tailwind class written on the node (`node.classes`).                                                                                            |
| `[name="x"]`, `[name=x]`                                | Name equal to `x`.                                                                                                                              |
| `[name^=x]`, `[name*=x]`, `[name$=x]`                   | Starts with, contains, ends with.                                                                                                               |
| `[text*=x]`, `[tag=x]`, `[type=x]`, `[src]`, `[hidden]` | Other fields: `id`, `name`, `tag`, `type`, `text`, `src`, `classes`, `component`, `hidden`, `locked`. `[field]` without a value tests presence. |
| `[style.color]`, `[style.color="red"]`                  | Style property (kebab-case or camelCase).                                                                                                       |
| `[attrs.href^=http]`                                    | HTML attribute.                                                                                                                                 |
| `A B`, `A > B`                                          | `B` descendant / direct child of `A`.                                                                                                           |
| `A, B`                                                  | Union.                                                                                                                                          |

They combine on the same node: `section.hero > button[style.background="red"]`. An invalid selector throws `Error: Invalid selector "...": reason (position N)`.

**2. Function** `(node) => boolean`, run in the script over the node's **JSON snapshot**:

```js
doc.select((n) => n.tag === 'button' && n.style.background === 'red');
```

The snapshot has `id, type, tag, name, text, attrs, style, classes, position, hidden, locked, src (up to 200 characters), componentId, props, parentId, childIds, frameId, pageId`. Changing the snapshot does not change the document.

**3. Object** `{ type?, tag?, name?, text?, within? }`: `name` and `text` accept a **string (exact equality)** or a **RegExp**; `within` is the id (or node) whose descendants are searched.

```js
doc.select({ type: 'text', text: /buy/i, within: header.id });
```

### Node (`NodeHandle`)

An object that holds only the id: **each read fetches the current state** and each write applies an op. Compare nodes by `id` (`a.id === b.id`).

| Member              | Read                              | Write                                                                  |
| ------------------- | --------------------------------- | ---------------------------------------------------------------------- |
| `id`, `type`, `tag` | yes                               | no                                                                     |
| `name`              | layer name                        | `node.name = "x"` (`renameNodes`)                                      |
| `text`              | text (or `undefined`)             | `node.text = "x"` (`setText`; `null` removes)                          |
| `style`             | proxy object: `node.style.color`  | `node.style.color = "red"`, `delete node.style.color` (`updateStyles`) |
| `attrs`             | proxy object: `node.attrs.href`   | `node.attrs.href = "/"`, `delete node.attrs.title` (`setAttrs`)        |
| `classes`           | Tailwind class string             | no (use `doc.apply({ type: 'setClasses', ... })`)                      |
| `position`          | `{ x, y }` or `undefined`         | `node.position = { x, y }` (`setPosition`)                             |
| `parent`            | node or `null` (root frame)       | no                                                                     |
| `children`          | child nodes                       | no                                                                     |
| `frame`             | root frame that contains the node | no                                                                     |

Methods: `setStyle(obj)` (several styles in one op; `null` or `""` removes), `remove()`, `duplicate()` (returns the clone), `select(query)`, `toJSON()` (the snapshot; `JSON.stringify(node)` and `return node` use it).

`style` and `attrs` behave like objects: `Object.keys(node.style)`, `"color" in node.style` and `JSON.stringify(node.style)` work. In `style`, camelCase keys become kebab-case (`borderRadius` = `border-radius`); `--custom` stays as is. Assigning `null`, `undefined` or `""` to a style removes it. Assigning the whole object (`node.style = {...}`) throws an error that points to `setStyle`.

Reading a node that was removed throws `Error: Node "..." no longer exists`.

### Examples

Rename 10 nodes:

```js
const items = doc.select('section.list > div').slice(0, 10);
items.forEach((n, i) => {
  n.name = `Item ${i + 1}`;
});
return items.length;
```

Change the color of every button:

```js
const buttons = doc.select('button');
if (!buttons.length) throw new Error('No buttons found');
for (const b of buttons) b.setStyle({ background: 'var(--color-primary)', color: '#fff' });
return buttons.length;
```

Create a card with children and take a screenshot:

```js
const card = doc.create(doc.frames()[0], {
  tag: 'section',
  name: 'Card',
  style: { padding: '16px', background: '#fff', 'border-radius': '12px' },
  children: [
    { tag: 'h2', text: 'Title' },
    { tag: 'p', text: 'Short description.' },
  ],
});
return doc.screenshot(card, { scale: 2 });
```

Ops directly (any editor op):

```js
doc.apply([
  { type: 'updateStyles', nodeIds: [a.id, b.id], styles: { gap: '16px' }, unset: ['margin'] },
  { type: 'moveNodes', nodeIds: [b.id], parentId: a.id },
]);
```

Tokens:

```js
doc.setTokens({ '--color-primary': '#2563eb', '--radius': '8px' });
return doc.tokens();
```

## Undo per execution

All ops of an execution use a **single undo group** (`opts.group` or a new `script:<uuid>`): one `undo` reverts the whole script, whether it has 1 or 1000 ops. At the end, the service closes the group it created; a group received from outside (an assistant turn's, for example) remains that caller's, so `run_script` inside a turn joins the turn's undo.

`opsCount` counts the applied ops.

**Error midway:** there is no automatic rollback. The ops before the error (or the timeout) **stay applied, in the same group**: the result comes back with `ok: false`, the `error` and the `opsCount`, and an undo reverts them. For all-or-nothing, put the changes into a single `doc.apply([...])` (atomic) or revert with undo. A `doc.apply` that throws (invalid op) applies none of the ops in that batch.

The origin of the ops (`source`) is `editor` when the panel runs and `mcp` for `run_script`.

## Security and limits

The script is untrusted code (sometimes written by an AI). Layers:

1. **Worker thread** (`worker_threads`, `eval: true` from a string, because the daemon is bundled into a single file). `env: {}`, no stdin/stdout, `resourceLimits` (heap 128 MB, young generation 16 MB, stack 4 MB). Running out of memory terminates only the worker and becomes a readable error.
2. **Timeout on the main thread**: `worker.terminate()` after 10 s (`timeoutMs`, maximum 60 s). Kills `while (true) {}`, loops after `await`, catastrophic regex and waiting on a slow call. Logs collected up to that point are returned.
3. **Isolated `node:vm` context**: `vm.createContext(vm.constants.DONT_CONTEXTIFY, { codeGeneration: { strings: false, wasm: false } })`. Only the JavaScript builtins exist: no `process`, `require`, `Buffer`, timers, `fetch`, `URL`. `eval` and `new Function` reject strings (`codeGeneration.strings: false`) and `WebAssembly` does not exist; `SharedArrayBuffer`, `Atomics`, `WeakRef` and `FinalizationRegistry` were removed. So were `ArrayBuffer`, `DataView` and the typed arrays: they allocate **outside the heap** and the memory limit would not see them.
4. **JSON bridge**: the only thing the context receives from the host is a function `(method, argsJson) => string` kept in a closure of the bootstrap (evaluated inside the context). No object, function or error from the worker's realm reaches the user's code (otherwise `x.constructor.constructor('return process')()` escapes): data crosses as JSON strings, the bridge never throws, and any error caught on the other side is discarded and rethrown as the context's own `Error`. The API (`doc`, handles, `console`) is built with context objects, frozen and installed as a non-writable global. Synchronous calls use `MessageChannel` + `SharedArrayBuffer`/`Atomics.wait` in the worker and `receiveMessageOnPort`.
5. **Extra defenses**: `Error.prepareStackTrace` locked (non-writable and non-configurable; no callsites with `getThis`/`getFunction`) and the user's code starts in a microtask, with no worker frames on the stack; the arguments of each call are validated in the daemon (`parseOp` on each op, size and count limits); user regular expressions never run on the main thread (search by object/function runs in the worker; the mini-selector does not use user regex).
6. **`import` rejected**: `import()` in a `vm` context with no loader rejects with an error **from the worker's realm**, and from it `process` is reachable. Since `eval`/`Function` do not exist, the only way to write `import(...)` is the token in the script text: the word `import` (`/\bimport\b/`) is rejected anywhere in the code, including in comments and strings (accepted false positive; rewrite the text).
7. **Body validation**: the code is wrapped in `(async function () { "use strict"; <code>
})`, and a body like `}); something(); (async function(){` would close the wrapper and run code outside the function (non-strict, synchronous). So, BEFORE compiling in the context, the worker checks that the text is, on its own, a valid async function body in strict mode: `new AsyncFunction('"use strict";
' + code)` with the worker's own constructor, only to parse (it is never called). V8's parser analyzes the body separately from the header, so any stray `}`/`)` becomes a `SyntaxError` and **nothing runs**; `})` inside a comment, string, template or regex stays valid. The script also gets a `"use strict"` at the top, as an extra defense.
8. **Locked globals**: after installing `doc` and `console`, every remaining global (`Object`, `Function`, `Array`, `Error` and subclasses, `Promise`, `JSON`, `Proxy`, `Reflect`, `Map`, `String`, `Number`...) becomes non-writable and non-configurable. `globalThis.Error = ...`, `Object.defineProperty(globalThis, 'Error', ...)` and `delete globalThis.Error` fail with `TypeError`. The bootstrap uses only references captured before the user's code (`ErrorCtor`, `Array.from`, `Number`...), never rereads `globalThis.X`, so the API's errors remain instances of the original `Error`.
9. **Cancellation and assistant turn**: `ScriptRunOptions` accepts `signal` (`AbortSignal`) and `alive` (`() => boolean`). Aborting the `signal` terminates the worker immediately (`terminate`) and returns `ok: false` ("canceled"). `alive` is checked in two ways: (a) the host checks before EVERY call and every write (`apply`, `create`, `setTokens`, node setters, `remove`, `duplicate`...) and, if it is false, rejects with "The assistant turn ended; the script was interrupted." without applying anything; (b) a watchdog on the main thread (every 100 ms) terminates the worker when `alive()` becomes false, which covers loops that never call the API. In the MCP, `run_script` passes `alive: () => { try { ctx.group(); return true } catch { return false } }`: if the assistant turn that opened the session ends or is canceled while the script is running, it stops and writes nothing more (the ops already applied stay in the turn's group). Outside a turn (`ctx.group()` with no turn) `alive` is always true.

Limits (`SANDBOX_LIMITS` in `sandbox.ts`):

| Limit                     | Value                                                                            |
| ------------------------- | -------------------------------------------------------------------------------- |
| Timeout                   | 10 s default, 50 ms to 60 s                                                      |
| Worker heap               | 128 MB (+ 16 MB young generation), stack 4 MB                                    |
| Script code               | 500,000 characters                                                               |
| Logs                      | 500 lines, 2,000 characters per line, 256 KB                                     |
| Result (`return`)         | 1,000,000 characters of JSON (above that `ok: false`; the ops already done stay) |
| Argument of one call      | 4,000,000 characters of JSON                                                     |
| API calls per execution   | 200,000                                                                          |
| Ops per `doc.apply`       | 20,000                                                                           |
| Nodes per `doc.create`    | 2,000 (depth 24)                                                                 |
| Screenshots per execution | 8                                                                                |
| Simultaneous executions   | 4 (the rest wait)                                                                |

Non-serializable values in `return` and in logs become a string (function, symbol, `BigInt`, error, RegExp); `Map` becomes `{ map: [[k, v]...] }` and `Set` `{ set: [...] }`; a circular reference becomes `String(value)`.

## `scripts/*.js` library

Saved scripts live in the `scripts/` folder **next to the document file** (`<.mockup.json folder>/scripts/`), one `.js` file per script with the function body (as in the panel). A document without a file: `dir: null`, an empty list and a clear error on save.

- Names: letters (including accented ones), digits, space, `_`, `.` and `-`, up to 100 characters; `.js` is appended. Slashes, `..`, names that start with `.` or end in a space/dot, and reserved Windows names (`con`, `nul`...) are rejected (path traversal).
- `list` sorts by name and ignores anything that is not a valid `.js`.
- WebSocket messages (`script:*`, in `packages/core/src/protocol.ts`): `script:run` (`ScriptRunResult`), `script:list` (`{ dir, scripts }`), `script:read` (`{ name, code }`), `script:save` (`{ name }`), `script:delete`, `script:generate` (`{ code }`).

## Generate with AI

`script:generate` (`ScriptService.generate`) asks the assistant for the code (`generateText`, with no tools and no MCP) with a system prompt that describes this API and requires only JavaScript code, plus the document summary and the selection. If the response comes in a code block with a triple-backtick fence (`js`), only its content is used. The generation **does not run** the code: the panel shows the script for the user to review and run. Without an assistant in the daemon: clear error.

## MCP

`run_script({ code? , name?, docId?, timeoutMs? })`: runs `code` or the saved script `name` (one of the two). Uses `ctx.group()` as the undo group, so inside an assistant turn the script joins the turn's undo. Returns text with `Script ok: N op(s)`, the logs, the `Result`, the images from `doc.screenshot()` (as response images, before the text) and the tree summary of the changed nodes. If the script fails, the response is an error (`isError`) with the message (and the line), the logs and how many ops had already been applied.

`list_scripts({ docId? })`: name, size and date of the library scripts, and the folder path (an agent can create `.js` files there with its own file tools).

The guide is at `get_guide('scripts')`.

## Known limitations

- **`import` is a forbidden token** anywhere in the text (see Security): `// import everything` is also rejected.
- **No `setTimeout`, `fetch`, files, `ArrayBuffer`** and the like; `await` only waits for the API's own calls and local promises. A promise that never resolves ends the execution with an explanatory error.
- **Strictly synchronous inside**: each node read is a round trip to the daemon. For many nodes, prefer `doc.select(...)` (one call) and `doc.apply([...])` (one atomic op) over loops with `node.style.x = ...`; both work, but the latter generates one op per assignment.
- **Component instances are not expanded** in search: `doc.select('button')` does not see buttons inside an instance; use `set_instance_override`/`set_instance_props` (via `doc.apply`) or edit the main component.
- **No rollback**: an error midway leaves the earlier ops applied (revert with an undo).
- **Heap, not RSS**: the memory limit is the worker's heap; execution is also bounded by the timeout.
- The sandbox is **defense in depth, not an absolute guarantee**: `node:vm` is not a security boundary by itself. The layers above close the known vectors (covered by tests in `sandbox.test.ts`), but do not run scripts of unknown origin on a daemon exposed to the network.
