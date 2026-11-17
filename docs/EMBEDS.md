# Video, embeds and Three.js

Three kinds of media node besides effects ([EFFECTS.md](EFFECTS.md)): `video` (video file or URL), `embed` (Lottie, Rive, YouTube, iframe and Three.js) and `effect`. The schemas are in `packages/core/src/media.ts`.

## `video` node

`node.video`:

| Field      | Type    | Description                                                                                 |
| ---------- | ------- | ------------------------------------------------------------------------------------------- |
| `src`      | string  | Path relative to `assets/` (e.g. `videos/demo.mp4`) or http(s) URL. Required.               |
| `poster`   | string  | Cover image: path in `assets/`, http(s) URL or image data URL (PNG, JPEG, GIF, WebP, AVIF). |
| `autoplay` | boolean | Plays on its own.                                                                           |
| `loop`     | boolean | Repeats.                                                                                    |
| `muted`    | boolean | No sound.                                                                                   |
| `controls` | boolean | Shows the player controls.                                                                  |
| `time`     | number  | Start instant in seconds (from 0), used in the capture when no `time` is requested.         |

Defaults on insert (MCP): `muted`, `loop` and `autoplay` on, `controls` off, `640px` x `360px` with `object-fit: cover`. Browsers only autoplay when muted. In the export, the node becomes `<video>` with `playsinline`.

### Insert

- **MCP**: `insert_video(parentId, source, poster?, autoplay?, loop?, muted?, controls?, styles?, name?, index?)`.
  - Local `source`: **absolute** path of an mp4, m4v, mov, webm or ogg. The type is validated by the first bytes (not by the extension) and the file is **copied** to `assets/videos/` with a safe name, without overwriting (`-1`, `-2`...). Ogg is written as `.ogv`. Limit of **500 MB**.
  - http(s) URL `source`: referenced directly, not downloaded; it only plays with a network.
  - A document with no path on disk has no `assets/`: it only accepts a URL (save the document first).
  - `poster`: path, URL or data URL; goes to `assets/`. Without an assets folder, it only fits as a data URL of up to 2 MB.
- **Editor**: Media menu (clapperboard icon) > "Insert video...". The picker accepts `.mp4`, `.webm`, `.mov` and `.m4v`; the file is sent to the daemon (`assets/videos/`) and the node is created at `640x360` at the center of the screen, inside the container under it (or in a new frame, if there is none). A video URL pasted into "Embed from URL..." also creates a `video` node.
- To change options later: `update_media(nodeId, autoplay?, loop?, muted?, controls?, poster?, time?)`. `poster: ""` removes it. It does not swap the file: insert another video.

### Poster and screenshot

The render page has a rule for the poster:

- `get_screenshot` **without** `time` and a video **with** `poster`: shows the poster and does not download the video.
- `get_screenshot` **with** `time` (including `0`): discards the poster, seeks the video to that instant (with `loop`, at `t` modulo the duration; without `loop`, clamped to the end) and waits for the frame to be ready.
- Video without a poster: without `time`, uses `video.time` (or 0).

The animated export (mp4/webm/gif) always passes `time`, so it shows the video's frames, not the poster.

## `embed` node

`node.embed`: `provider` (`lottie`, `rive`, `youtube`, `three` or `iframe`) plus:

| Provider  | Required fields | Note                                                                                                                                                                           |
| --------- | --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `lottie`  | `src`           | File in `assets/lottie/` or http(s) URL.                                                                                                                                       |
| `rive`    | `src`           | File in `assets/rive/` or http(s) URL.                                                                                                                                         |
| `youtube` | `url`           | YouTube video URL (`watch?v=`, `youtu.be/`, `/embed/`, `/shorts/`, `/live/`, `/v/`, on `youtube.com`, `m.`, `music.` or `youtube-nocookie.com`). The id is 11 characters long. |
| `iframe`  | `url`           | Any http(s) URL.                                                                                                                                                               |
| `three`   | `code`          | Function body (up to 200,000 characters). See the Three.js island section.                                                                                                     |

`params` (optional): up to 64 pairs; name `[a-zA-Z][a-zA-Z0-9_]{0,39}`; value a number, boolean or text of up to 300 characters without `< > { } ; " \`` or `\`. The ones that take effect:

| Provider  | `params`                                                                                                       |
| --------- | -------------------------------------------------------------------------------------------------------------- |
| `youtube` | `start` (s; the URL's `?t=` wins), `autoplay`, `loop`, `muted` (default `false`), `controls` (default `true`). |
| `lottie`  | `autoplay`, `loop` (default `true`).                                                                           |
| `rive`    | `autoplay` (default `true`), `artboard` and `stateMachine` (text).                                             |
| `three`   | Any; they reach the code in `params`.                                                                          |

### Detection by URL

`detectEmbedProvider` (used by the MCP and the editor dialog) decides from the URL or path:

1. http(s) YouTube URL with a valid id: `youtube`.
2. Ends in `.json` or `.lottie` (ignoring `?` and `#`), or contains `lottiefiles.com`: `lottie`.
3. Ends in `.riv`: `rive`.
4. Ends in `.mp4`, `.webm`, `.mov`, `.m4v` or `.ogv`: video (use `insert_video`; the editor creates a `video` node).
5. Any other http(s) URL: `iframe`.
6. Otherwise: not recognized. In the MCP, `provider` forces the provider.

YouTube uses `?t=` or `?start=` (`90`, `1m30s`, `1h2m3s`) as the start.

### Insert

- **MCP**: `insert_embed(parentId, url?, provider?, src?, params?, styles?, name?, index?)`. `url` can be a URL or an absolute path of a `.json`/`.lottie`/`.riv`; `src` is the alternative for Lottie/Rive. Default sizes: `480x320` (YouTube: `560x315`).
  - **Lottie and Rive** are validated and **copied** (from a path or downloaded from a URL, 20 s timeout) to `assets/lottie/` or `assets/rive/`. Lottie JSON needs `v`, `fr` and `layers`; `.lottie` is a zip; a Rive file starts with `RIVE`. Limit of **50 MB**. An already-relative reference (`lottie/loader.json`) is accepted if the file exists in `assets/`.
  - **YouTube and iframe** store only the URL.
  - For Three.js use `insert_three`; `insert_embed` with `provider: 'three'` is rejected.
- **Editor** (Media menu): "Insert Lottie/Rive from file..." (`.json`, `.lottie`, `.riv`; goes to `assets/` through the daemon upload; `400x400`); "Embed from URL..." (shows the detected provider as you type; YouTube and iframe are created at `640x360`); "Three.js island" (`480x320`, opens the code editor right away). A Lottie/Rive URL pasted into the dialog is **referenced**, not copied: it needs a network.
- `update_media(nodeId, url?, src?, code?, params?)`: `params` are merged into the current ones; `src` (Lottie/Rive only) is imported the same way as on insert.

### Where the files live

Inside `assets/`, next to the `*.mockup.json`:

| Folder           | Contents                               | Limit  |
| ---------------- | -------------------------------------- | ------ |
| `assets/videos/` | Videos (mp4, m4v, mov, webm, ogv)      | 500 MB |
| `assets/lottie/` | Lottie animations (`.json`, `.lottie`) | 50 MB  |
| `assets/rive/`   | Rive animations (`.riv`)               | 50 MB  |
| `assets/`        | Posters and other images               | 20 MB  |

The limits also apply to the editor's upload to the daemon (by extension). The `export` for html/tailwind/react copies the `assets/` files the node uses to the output folder, including video, poster, Lottie and Rive.

## Three.js island

An island is a `three` embed whose `code` is a **function body**. The host creates the `WebGLRenderer` (with `alpha: true` and `antialias: true`, so the background is transparent) and calls the code with these variables:

| Variable   | What it is                                  |
| ---------- | ------------------------------------------- |
| `THREE`    | The Three.js library.                       |
| `renderer` | The already-created `WebGLRenderer`.        |
| `canvas`   | The node's `<canvas>`.                      |
| `width`    | Node width in px.                           |
| `height`   | Node height in px.                          |
| `params`   | The node's `params` (object; may be empty). |

The code **returns** `{ scene, camera, update(t) }`: `scene` and `camera` are required to draw; `update` is optional and receives `t` in **seconds**. On each frame the host calls `update(t)` and then `renderer.render(scene, camera)`; do not call `render` or create the renderer. Perspective cameras get their `aspect` updated when the node is resized.

Default code (`insert_three` without `code`, or the editor menu): a spinning metallic torus knot (`TorusKnotGeometry`), with ambient and directional lights and the color taken from `params.color` (default `#7c5cff`):

```js
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(45, width / height, 0.1, 100);
camera.position.set(0, 0, 6);
const mesh = new THREE.Mesh(
  new THREE.TorusKnotGeometry(1.2, 0.38, 220, 32),
  new THREE.MeshStandardMaterial({
    color: params.color ?? '#7c5cff',
    metalness: 0.6,
    roughness: 0.25,
  }),
);
scene.add(mesh);
scene.add(new THREE.AmbientLight(0xffffff, 0.4));
const light = new THREE.DirectionalLight(0xffffff, 2.2);
light.position.set(3, 4, 5);
scene.add(light);
return {
  scene,
  camera,
  update(t) {
    mesh.rotation.x = t * 0.4;
    mesh.rotation.y = t * 0.6;
  },
};
```

Write `update` as a **pure function of time** (position = f(t), without accumulating state between frames): the screenshot with `time` and the mp4/webm/gif export call `update(t)` at chosen instants, not in continuous sequence.

MCP: `insert_three(parentId, code?, params?, styles?, name?, index?)` (code up to 200,000 characters). To change it later: `update_media(nodeId, code?, params?)`.

### Sandbox in the editor

In the editor and on the render page the code runs inside an `<iframe sandbox="allow-scripts" srcdoc>` **without** `allow-same-origin`: the iframe's origin is opaque, so the code cannot touch the editor's document, cookies, `localStorage` or the daemon, and only communicates with the page through `postMessage` (`init`, `time`, `play`, `resize` from the parent; `ready`, `error`, `drawn` from the child; each side checks `event.source`). The library comes from the daemon itself (`/vendor/three.iife.js`), with no CDN, so it works offline. Errors from the code or from WebGL appear in a red banner over the node.

The sandbox isolates the origin; it does **not** install a content policy that blocks the network, so do not rely on it to stop third-party code from trying to send data. Review the code before using code you did not write.

### Code editor

The Media menu > "Three.js island" inserts the island and opens the "Three.js island" dialog. Today the dialog only opens at that moment; to edit the code of an existing island use `update_media(nodeId, code)` through the MCP. It has the code in **CodeMirror** (JavaScript, dark theme, line numbers and the other `basicSetup` features) on the left and a **live preview** on the right, which updates 600 ms after the last keystroke. **Ctrl+Enter** (or Apply) writes the code to the node (one undo step, and nothing happens if the code did not change); **Esc** (or Close) discards it. If the node disappears (undo, remote deletion), the dialog closes.

## Offline

| Type                         | Editor and render                                                                                                                                                           | Exported code                                                                     |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| Effects                      | Works offline.                                                                                                                                                              | Works offline (runtime embedded in the file).                                     |
| Local video                  | Works offline.                                                                                                                                                              | Works offline (file copied to `assets/`).                                         |
| Local Lottie and Rive        | Work offline (`lottie-web` and the Rive wasm come from the package, never from a CDN).                                                                                      | Load the library from a **CDN** (table below); the `.json`/`.riv` file is local.  |
| Three.js                     | Works offline (library served by the daemon).                                                                                                                               | Loads Three.js from a **CDN** in the HTML; in React, imports the `three` package. |
| YouTube                      | The editor shows the player and **needs a network**; the render shows the thumbnail (`i.ytimg.com`) with a play button and, without a network, a "YouTube" frame after 5 s. | Needs a network.                                                                  |
| iframe                       | **Needs a network** (the render waits for loading for up to 5 s).                                                                                                           | Needs a network.                                                                  |
| Video, Lottie or Rive by URL | Need a network.                                                                                                                                                             | Need a network.                                                                   |

CDN libraries in the exported HTML and Tailwind (constants in `packages/core/src/export/media.ts`):

| Use      | URL                                                                          |
| -------- | ---------------------------------------------------------------------------- |
| Lottie   | `https://cdn.jsdelivr.net/npm/lottie-web@5/build/player/lottie_light.min.js` |
| Rive     | `https://unpkg.com/@rive-app/canvas@2`                                       |
| Three.js | `https://cdn.jsdelivr.net/npm/three@0.187/build/three.module.js` (ES module) |

Only the scripts for the features the document uses are included. Lottie is mounted with the SVG renderer. When the `export` (MCP) can read the file from `assets/` and it is a `.json` of up to **512 KB**, the JSON is **embedded** in the HTML (`<script type="application/json">` with `<`, U+2028 and U+2029 escaped) and the HTML opens directly from `file://`. In the other cases (JSON above 512 KB, `.lottie`, any Rive `.riv`, or HTML generated without access to `assets/`, such as `get_html`) the runtime reads the file through `data-src`, and browsers block that read from `file://` (CORS): serve the output folder over an HTTP server, for example `npx serve`. In the exported HTML, the Three.js code runs directly on the page, **without** the editor's sandbox, and animates with the real clock (`performance.now`).

## Export

- **html and tailwind**: video becomes `<video>` (with `poster`, if any, and `playsinline`); YouTube becomes an `<iframe>` at `youtube-nocookie.com/embed/<id>` with `allow="autoplay; encrypted-media; picture-in-picture"`, `allowfullscreen` and `loading="lazy"`; iframe becomes `<iframe sandbox="allow-scripts allow-same-origin allow-popups" loading="lazy">`; Lottie, Rive and Three.js become `div`/`canvas` with `data-mockup-embed` and the CDN scripts above. Values with dangerous characters are dropped or escaped (`</script>` inside Three.js code becomes `<\/script>`).
- **`get_html` / `write_html` (round trip)**: the read HTML is not the export HTML. All embeds (Lottie, Rive, Three.js, YouTube and iframe) come out as an inert `<div data-mockup-embed="<provider>">`, with `data-src`, `data-url`, `data-code` and `data-params` (JSON), with no `<iframe>` or scripts; `write_html` converts that `div` back into the `embed` node (validated by the schema: a loopback URL becomes a plain `div`). Video stays as `<video>` and effects as `data-mockup-effect`.
- **svg**: embeds become placeholders (video shows the poster or a dark rectangle; an embed shows the provider name), with no scripts.
- **react**: video becomes `<video ... autoPlay loop muted playsInline />`; YouTube and iframe become `<iframe>` with the same props as the HTML (`allowFullScreen`, `sandbox`). Lottie becomes `<MockupLottie src=... />` (uses the `lottie-web` package), Rive becomes `<MockupRive src=... artboard=... stateMachine=... />` (uses `@rive-app/canvas`). These components are embedded in the `.tsx`. Each Three.js island generates `<slug>-three-<n>.js` + `.d.ts` next to the `.tsx` (with `import * as THREE from 'three'`) and becomes `<ThreeIsland setup={setupThreeN} params={...} />`. The project must install `lottie-web`, `@rive-app/canvas` and `three` depending on what it uses. `assets/...` paths are relative to the page: in a Vite project, put the folder in `public/` or use `assetsBase: '/assets/'`.
- **Animated (mp4, webm, gif)**: renders the node with the manual clock, so video, Lottie, Rive and Three.js are included frame by frame. YouTube and iframe appear as in the render (thumbnail or content loaded at that moment). Details in [EFFECTS.md](EFFECTS.md#animated-export-mp4-webm-and-gif).

Code formats in [EXPORT.md](EXPORT.md); tools in [MCP.md](MCP.md).
