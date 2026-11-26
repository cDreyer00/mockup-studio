# Effects

Effects are animated backgrounds and blocks drawn on a `<canvas>`: seven ready-made effects (six WebGL shaders and one particles effect), each with params and presets. Video, Lottie, Rive, YouTube, iframe and Three.js are covered in [EMBEDS.md](EMBEDS.md).

The shaders are the project's **own GLSL** (GLSL ES 1.0 fragment shaders, WebGL 1), written in `packages/core/src/effects/shaders.ts`; there is no third-party library. Particles use canvas 2D. The catalog (`packages/core/src/effects/catalog.ts`) is the single source for the editor, the render page, the MCP (`list_effects`) and the exporters.

An effect is a node with `type: 'effect'` and `effect: { kind, params }`:

```json
{ "kind": "mesh-gradient", "params": { "color1": "#0d1b4c", "speed": 0.5 } }
```

- `params` stores only what was changed; anything missing uses the catalog default.
- Numbers outside the range are clamped to `min`/`max` when resolved; through the MCP, out-of-range values, wrong types or unknown params are **rejected** with the list of problems.
- Accepted colors: `#rgb`, `#rgba`, `#rrggbb`, `#rrggbbaa`, `rgb()`, `rgba()` and `transparent`.
- In the shader, each param becomes the uniform `u_<name>` (colors as `vec4`, `select` as the option index), plus `u_resolution` and `u_time` (already multiplied by `speed`).

## Catalog

All effects accept `speed` (number, 0 to 4, step 0.05, default 1; 0 makes the effect static), except where noted.

| `kind`          | Category    | What it does                                                                   |
| --------------- | ----------- | ------------------------------------------------------------------------------ |
| `mesh-gradient` | `shader`    | Four-color gradient with soft blobs warped by noise, swirl and grain.          |
| `grain`         | `shader`    | Animated film noise over a two-color gradient.                                 |
| `halftone`      | `shader`    | Halftone dots, squares or lines that vary in size over a gradient.             |
| `waves`         | `shader`    | Flowing wavy lines with a gradient between two colors over a solid background. |
| `liquid-metal`  | `shader`    | Chrome liquid metal with moving procedural reflections.                        |
| `glass`         | `shader`    | Refractive fluted glass over a moving gradient, with blur and reflections.     |
| `particles`     | `particles` | Deterministic canvas 2D particles: position is a function of (seed, index, t). |

### Params and presets

Format: `name` type, default, range. Colors have no range.

**`mesh-gradient`**

| Param        | Type   | Default   | Range  |
| ------------ | ------ | --------- | ------ |
| `color1`     | color  | `#0d1b4c` |        |
| `color2`     | color  | `#00c2a8` |        |
| `color3`     | color  | `#7b2ff7` |        |
| `color4`     | color  | `#12d8fa` |        |
| `speed`      | number | 1         | 0 to 4 |
| `distortion` | number | 0.5       | 0 to 1 |
| `swirl`      | number | 0.3       | 0 to 1 |
| `grain`      | number | 0.15      | 0 to 1 |

Presets: `aurora`, `sunset`, `ocean`, `candy`.

**`grain`**

| Param       | Type   | Default   | Range    |
| ----------- | ------ | --------- | -------- |
| `color1`    | color  | `#1b1b1f` |          |
| `color2`    | color  | `#4a4a55` |          |
| `intensity` | number | 0.55      | 0 to 1   |
| `size`      | number | 1.5       | 0.5 to 6 |
| `speed`     | number | 1         | 0 to 4   |

Presets: `film`, `warm`, `cool`, `paper`. `size` is in px at 720 height.

**`halftone`**

| Param        | Type   | Default                               | Range   |
| ------------ | ------ | ------------------------------------- | ------- |
| `color`      | color  | `#111111`                             |         |
| `background` | color  | `#f4efe6`                             |         |
| `dotSize`    | number | 22                                    | 6 to 60 |
| `angle`      | number | 45                                    | 0 to 90 |
| `speed`      | number | 1                                     | 0 to 4  |
| `shape`      | select | `circle` (`circle`, `square`, `line`) |         |

Presets: `ink`, `pop`, `blueprint`, `scanlines`. `dotSize` is the cell side in px at 720 height; `angle` is in degrees.

**`waves`**

| Param        | Type   | Default   | Range     |
| ------------ | ------ | --------- | --------- |
| `color1`     | color  | `#22d3ee` |           |
| `color2`     | color  | `#e879f9` |           |
| `background` | color  | `#07070f` |           |
| `frequency`  | number | 4         | 0.5 to 12 |
| `amplitude`  | number | 1         | 0 to 2    |
| `lines`      | number | 14        | 1 to 40   |
| `speed`      | number | 1         | 0 to 4    |

Presets: `neon`, `silk`, `deep`, `mint`.

**`liquid-metal`**

| Param       | Type   | Default   | Range    |
| ----------- | ------ | --------- | -------- |
| `tint`      | color  | `#c9ced8` |          |
| `highlight` | color  | `#ffffff` |          |
| `contrast`  | number | 1.4       | 0.5 to 3 |
| `speed`     | number | 1         | 0 to 4   |
| `scale`     | number | 1         | 0.3 to 3 |

Presets: `chrome`, `gold`, `rose`, `obsidian`.

**`glass`**

| Param        | Type   | Default   | Range   |
| ------------ | ------ | --------- | ------- |
| `color1`     | color  | `#6d5dfc` |         |
| `color2`     | color  | `#ff8ab3` |         |
| `ribs`       | number | 24        | 4 to 80 |
| `refraction` | number | 1         | 0 to 2  |
| `blur`       | number | 0.25      | 0 to 1  |
| `speed`      | number | 1         | 0 to 4  |

Presets: `prism`, `dusk`, `lime`, `frost`.

**`particles`**

| Param        | Type    | Default                                           | Range      |
| ------------ | ------- | ------------------------------------------------- | ---------- |
| `count`      | number  | 120                                               | 10 to 2000 |
| `color`      | color   | `#ffffff`                                         |            |
| `background` | color   | `#0b1020` (`transparent` leaves the canvas empty) |            |
| `size`       | number  | 2.5 (average radius in px)                        | 0.5 to 12  |
| `speed`      | number  | 1                                                 | 0 to 4     |
| `direction`  | select  | `up` (`up`, `down`, `left`, `right`, `random`)    |            |
| `twinkle`    | number  | 0.5                                               | 0 to 1     |
| `links`      | boolean | `false` (lines between neighboring particles)     |            |
| `seed`       | number  | 1 (same seed, same drawing)                       | 0 to 9999  |

Presets: `stars`, `snow`, `embers`, `network`, `fireflies` (this one with a `transparent` background).

Applying a preset sets only the params it lists; the rest stay at the effect's defaults.

## In the editor

- **Effects button** (sparkle icon) in the toolbar: opens a gallery grouped into Shaders and Particles, with one thumbnail per preset (drawn by the runtime itself). Click inserts the effect as the **background** of the selected frame (or of the selected container; with no selection, of the first frame on the page). Alt+click or right-click inserts it as a **layer** (regular child).
- As a background, the effect becomes the first child, with `position: absolute; inset: 0; width/height: 100%; z-index: -1; pointer-events: none`, and the parent gets `position: relative` and `isolation: isolate` in the same operation (one undo reverts everything). A locked target or no frame shows a warning.
- **Effect section** in the Properties of an effect node: type, preset chips (the active preset is highlighted), one control per param (slider with a number field for numbers, color picker, checkbox for booleans, list for `select`) and "Restore defaults". Changing the type discards the old params. Dragging a slider only sends the change on release, so a drag is one undo step. With several effects of the same `kind` selected, the edit applies to all of them.
- **Pause and play**: the play/pause button in the toolbar (or **Shift+Space**) freezes and resumes all canvas animations (effects, particles, video, Lottie, Rive and Three.js), continuing from where they stopped. Space alone is still pan.
- If WebGL is unavailable or the shader fails to compile, the effect shows an approximate CSS background (the same one used in static exports) and a warning in the corner.

## Via MCP

`get_guide('effects')` gives a summary for the agent (see [MCP.md](MCP.md)). Tools:

| Tool            | Params                                                                                                                     | Description                                                                                                                                                                                                                   |
| --------------- | -------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `list_effects`  | none                                                                                                                       | Effects with category, description, params (`name:type range=default`) and presets.                                                                                                                                           |
| `add_effect`    | `nodeId`, `kind` (required), `params`, `preset`, `placement` (`background` \| `child`), `name`, `styles`, `index`, `docId` | Creates the effect. `background` (default) puts it as the first child of `nodeId`; `child` inserts a regular child (default `100%` x `240px`, accepts `index`). `nodeId` must be a container (not text, image, svg or media). |
| `update_effect` | `nodeId` (required), `params`, `kind`, `preset`, `reset`, `docId`                                                          | Merges `params` into the current ones; `preset` is applied before `params`; `kind` switches the effect (old params discarded); `reset: true` returns to defaults before applying preset and params.                           |

The `params` of `add_effect` are merged over the preset (`{ ...preset, ...params }`). An unknown preset, unknown param, wrong type or out-of-range value returns `isError` listing the problems and the valid effects.

Animated background for a whole frame:

```json
{
  "name": "add_effect",
  "arguments": {
    "nodeId": "fr_ab12cd34",
    "kind": "mesh-gradient",
    "preset": "aurora",
    "params": { "speed": 0.5 }
  }
}
```

Adjust it afterwards (the effect id comes in the `add_effect` or `get_tree_summary` response):

```json
{
  "name": "update_effect",
  "arguments": { "nodeId": "ef_ab12cd34", "params": { "speed": 1.2, "grain": 0.3 } }
}
```

Switch effect:

```json
{
  "name": "update_effect",
  "arguments": { "nodeId": "ef_ab12cd34", "kind": "particles", "preset": "stars" }
}
```

Check the result at two points in time:

```json
{ "name": "get_screenshot", "arguments": { "nodeId": "fr_ab12cd34", "time": 0 } }
{ "name": "get_screenshot", "arguments": { "nodeId": "fr_ab12cd34", "time": 2 } }
```

`time` (seconds, from 0) renders the frame of **all** animations at that instant: effects, particles, Lottie, Rive, Three.js and video. Without `time`, the render uses 0; the only difference is video with a `poster`, which shows the poster when `time` is not given (see [EMBEDS.md](EMBEDS.md)).

## How the render captures

Editor animations run in real time; the render page (screenshot and export) uses a **manual clock** so the result is deterministic:

1. `get_screenshot` with `time: t` calls `__mockupRender.render({ ..., time: t })`. The page pins the animation clock at `t` (at 0 without `time`) instead of letting time run.
2. Each media component registers a pending item when it starts loading or when the time changes, and releases it after drawing that instant. The page **waits for all pending items** (10 s limit in total; each pending item releases itself after 15 s at most, so a failing component does not block the capture), plus two `requestAnimationFrame`s, and only then measures and captures.
3. For frame sequences, the engine calls `setTime(t)`, waits the same way and takes a capture of each frame. The screenshot cache includes `time` in its key.
4. **Node animations** (`animations` on nodes) follow the same clock: with `time`, the page seeks the frame's motion timeline (builds and linear timeline) at that instant, and effects use the same instant. `build: n` shows the state after click build `n` (earlier builds finished, later ones not started); with `time`, `time` counts seconds into that build. Without `time` and `build`, animations show the design state. `times: [...]` (up to 12) renders a **filmstrip**: one whole frame per instant, each with its own motion scope, in a single grid (`columns`, default up to 4; 24 px gap and padding; a small label under each cell such as `0.40 s` or `build 1 + 0.40 s`). The effects clock holds a single time, so in a filmstrip effects are shown at the first instant. `build`, `times` and `columns` are part of the screenshot cache key.

Shader WebGL must be available in the render window. In the desktop app, if there is no GPU, Chromium falls back to **SwiftShader** (software WebGL, flag `enable-unsafe-swiftshader`); `MOCKUP_RENDER_GL=swiftshader` forces software rendering, useful in a VM or CI (see `packages/desktop/README.md`). Software is slower but produces the same drawing.

## Export

Each effect's `kind` and resolved params go into the exported code.

| Format      | Effect                                                                                                                              |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `html`      | `<canvas data-mockup-effect='{...}'>` with a CSS fallback background and a `<script>` that embeds the runtime and the shaders used. |
| `tailwind`  | Same as `html`, with Tailwind classes.                                                                                              |
| `svg`       | No JavaScript: the effect becomes the catalog's fallback gradient/color (`effectFallbackCss`).                                      |
| `react`     | `effects` option: `live` (default) or `static`. See below.                                                                          |
| `png`/`jpg` | Render capture (clock at `time` 0, or the screenshot's `time`).                                                                     |

- **Runtime**: the same code runs in the editor and in the export. It respects `prefers-reduced-motion: reduce` (draws only frame 0), follows the canvas size with `ResizeObserver` and, if WebGL fails, the CSS fallback background stays visible.
- **React `effects: 'live'`** (default): each effect becomes `<MockupEffect spec={...} />`, a component embedded in the `.tsx` that mounts a `<canvas>` and calls `playEffect(canvas, spec)` (returns `{ stop() }`, called in the `useEffect` cleanup). The `spec` lives in a typed constant (`EffectMount`) at the top of the file. The runtime goes in `mockup-effects.js` + `mockup-effects.d.ts`, next to the `.tsx`, with the shaders of the whole catalog, so the same file serves every component exported to the folder. The CSS fallback background stays in the canvas `className`/`style`.
- **React `effects: 'static'`**: writes a PNG of each effect node (captured at `time: 0`) to `assets/effects/<effect-id>.png`, and the effect becomes `<img src="assets/effects/<id>.png" alt="">`, with no runtime. Requires the render engine. `export` only: `get_code` always returns the `live` version and mentions `mockup-effects.js` without pasting the runtime.
- The CSS fallback also applies when the HTML is opened without JavaScript.

### Animated export: mp4, webm and gif

`export` renders the frames (from `start`, one every `1/fps` s), sends the PNGs to ffmpeg and writes `<node-slug>.mp4`, `.webm` or `.gif` to `outputDir` (default: `<document folder>/exports/`).

```json
{
  "name": "export",
  "arguments": {
    "nodeIds": ["fr_ab12cd34"],
    "format": "mp4",
    "fps": 30,
    "duration": 3,
    "maxWidth": 1280
  }
}
```

| Param      | Value                                                                                                     |
| ---------- | --------------------------------------------------------------------------------------------------------- |
| `format`   | `mp4`, `webm` or `gif`.                                                                                   |
| `fps`      | Integer from 1 to 60. Default 30; for `gif` default 15 and maximum 30 (larger values are reduced to 30).  |
| `duration` | Seconds, greater than 0 and up to 30. Default 3.                                                          |
| `start`    | Start instant of the animations, in seconds. Default 0.                                                   |
| `scale`    | 1 (default), 2 or 3.                                                                                      |
| `maxWidth` | Maximum width in px (minimum 16); scales down keeping the aspect ratio. Use with `gif` for smaller files. |

- The total number of frames is `duration x fps`, capped at **1800** frames.
- **mp4**: H.264 (`libx264`, `yuv420p`, `+faststart`), width and height adjusted to even numbers. It is the most compatible.
- **webm**: VP9 (`libvpx-vp9`, `crf 34`), usually smaller than mp4.
- **gif**: palette generated by `palettegen`/`paletteuse`, looping forever. Good for a README; reduce it with `maxWidth` and `fps`.
- There is no sound; the result is only what the canvas shows.
- Requires the render engine with frame capture (updated desktop app) and **ffmpeg**, located in this order: the `MOCKUP_FFMPEG` environment variable (executable path), the `ffmpeg-static` package and `ffmpeg` on the `PATH`. In the packaged app the binary goes in `resources/ffmpeg/` and `MOCKUP_FFMPEG` points to it. Without ffmpeg the error explains how to install it. If encoding fails, the partial file is deleted.
- The response reports frames, fps, duration and file size. Assets are not copied in the animated formats.

More on the code formats in [EXPORT.md](EXPORT.md).
