# Motion

Node animations (entrances, exits, emphasis and loops), click builds and slide transitions: a slide editor with motion design, authored in the editor or through the MCP, previewed on the canvas, inspected with screenshots at any instant, played in presentation mode and exported as real CSS.

## Model

Animations live on the node (`node.animations`, a list) and slide transitions on root frames (`frame.slideTransition`). Times are milliseconds. Fields equal to the preset's defaults are omitted from the file, so a complete animation is as small as:

```json
{ "kind": "in", "preset": "fade-up" }
```

| Field        | Description                                                                                                                                                                                                                                                 |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `kind`       | `in` (entrance: hidden until it plays), `out` (exit: hidden after it plays) or `emphasis` (plays and returns; loops are emphasis with `iterations: infinite`).                                                                                              |
| `preset`     | A catalog preset (below) or `custom` with `keyframes`.                                                                                                                                                                                                      |
| `duration`   | One iteration (default: the preset's; exits default to 75% of it).                                                                                                                                                                                          |
| `delay`      | Wait after the start of its build.                                                                                                                                                                                                                          |
| `easing`     | Named easing (below) or any CSS easing (`cubic-bezier()`, `steps()`, `linear()`); `spring(0.4)` = spring with that bounce.                                                                                                                                  |
| `build`      | 0 (default) plays when the frame/slide appears; 1, 2… play on the 1st, 2nd… click of a presentation. Distinct values play in increasing order.                                                                                                              |
| `iterations` | Number of plays or `infinite`.                                                                                                                                                                                                                              |
| `alternate`  | Alternates direction on every other iteration.                                                                                                                                                                                                              |
| `split`      | `children`, `words` or `chars`: animates each child / word / character instead of the node, `stagger` ms apart (default 80, 60, 30). `words`/`chars` only on text nodes: edits reject them elsewhere, files and HTML drop the split and keep the animation. |
| `params`     | Preset parameters (distance, scale, angle, blur, amount, color).                                                                                                                                                                                            |
| `keyframes`  | `custom` only: Web Animations keyframes (CSS declarations per `offset`, optional per-keyframe `easing`).                                                                                                                                                    |

`slideTransition`: `{ preset, duration?, easing?, direction? }` (`direction` = `left` \| `right` \| `up` \| `down` for directional presets; default `left`). It describes how the slide **enters**; going back plays the transition of the slide being left, time-reversed (push left returns as push right, cover returns as reveal).

The op is `setMotion` (`changes: [{ nodeId, animations?, transition? }]`, each field replacing the whole value, `null` removing it), with an exact inverse. It works on component instances (an `animations` override; `[]` removes the main component's animations in that instance) and on main component nodes. HTML round trip: `get_html` writes `data-motion='[…]'` and `data-motion-transition='{…}'`, and `write_html` reads them back. The tree summary marks animated nodes (`motion:in fade-up+b1,emphasis float`) and frames with a transition (`transition:push-left`).

Source: `packages/core/src/types.ts` (types), `packages/core/src/motion/` (engine), `packages/core/src/apply.ts` (`doSetMotion`).

### Presets

Entrances double as exits (`kind: out`): presets named after a direction keep moving the same way when leaving (`fade-up` leaves upwards), the others play reversed (`pop` shrinks away). Entrances and exits animate `transform`, `opacity` and `filter`, composed with the node's own `transform`/`opacity`/`filter`; emphasis presets animate the individual `translate`, `rotate` and `scale` properties (composed with the node's own values through `calc()`), so a loop keeps running while the node enters or leaves.

| Preset        | Kinds    | Description                                                              | Default                                      | Params                                        |
| ------------- | -------- | ------------------------------------------------------------------------ | -------------------------------------------- | --------------------------------------------- |
| `fade`        | in, out  | Fades in (or out).                                                       | 400 ms, smooth                               | —                                             |
| `fade-up`     | in, out  | Fades in while moving up.                                                | 600 ms, smooth-out                           | distance 24px                                 |
| `fade-down`   | in, out  | Fades in while moving down.                                              | 600 ms, smooth-out                           | distance 24px                                 |
| `fade-left`   | in, out  | Fades in while moving left.                                              | 600 ms, smooth-out                           | distance 24px                                 |
| `fade-right`  | in, out  | Fades in while moving right.                                             | 600 ms, smooth-out                           | distance 24px                                 |
| `slide-up`    | in, out  | Flies in moving up, from its own size away (100% = one width/height).    | 700 ms, expo-out                             | distance 100%                                 |
| `slide-down`  | in, out  | Flies in moving down, from its own size away.                            | 700 ms, expo-out                             | distance 100%                                 |
| `slide-left`  | in, out  | Flies in moving left, from its own size away.                            | 700 ms, expo-out                             | distance 100%                                 |
| `slide-right` | in, out  | Flies in moving right, from its own size away.                           | 700 ms, expo-out                             | distance 100%                                 |
| `zoom-in`     | in, out  | Grows into place from slightly smaller.                                  | 500 ms, expo-out                             | scale 0.85                                    |
| `zoom-out`    | in, out  | Settles into place from slightly bigger.                                 | 600 ms, expo-out                             | scale 1.15                                    |
| `pop`         | in, out  | Springs in from small with a bounce.                                     | 550 ms, spring-bouncy                        | scale 0.5                                     |
| `blur`        | in, out  | Comes into focus while fading in.                                        | 700 ms, smooth-out                           | blur 12px                                     |
| `rise`        | in, out  | Rises softly out of a blur (keynote titles).                             | 900 ms, expo-out                             | distance 40px, blur 8px                       |
| `drop`        | in, out  | Falls into place and bounces.                                            | 900 ms, bounce                               | distance 80px                                 |
| `flip-up`     | in, out  | Flips up in 3D around its horizontal axis.                               | 800 ms, spring                               | angle 75deg, perspective 800px                |
| `flip-left`   | in, out  | Flips in 3D around its vertical axis.                                    | 800 ms, spring                               | angle 75deg, perspective 800px                |
| `swing`       | in, out  | Swings in from its top edge like a hanging sign.                         | 1000 ms, spring-wobbly                       | angle 25deg                                   |
| `spin-in`     | in, out  | Spins and grows into place.                                              | 800 ms, spring                               | angle -180deg, scale 0.4                      |
| `wipe-right`  | in, out  | Reveals it with a mask moving right (clip-path: repaints while it runs). | 700 ms, expo-in-out                          | —                                             |
| `wipe-left`   | in, out  | Mask moving left (repaints).                                             | 700 ms, expo-in-out                          | —                                             |
| `wipe-up`     | in, out  | Mask moving up (repaints).                                               | 700 ms, expo-in-out                          | —                                             |
| `wipe-down`   | in, out  | Mask moving down (repaints).                                             | 700 ms, expo-in-out                          | —                                             |
| `pulse`       | emphasis | Grows a little and back.                                                 | 600 ms, ease-in-out                          | amount 1.06                                   |
| `bounce`      | emphasis | Hops up twice.                                                           | 900 ms, linear (eased per hop)               | amount 18px                                   |
| `shake`       | emphasis | Shakes sideways (“no”).                                                  | 600 ms, ease-in-out                          | amount 8px                                    |
| `wiggle`      | emphasis | Rotates back and forth.                                                  | 700 ms, ease-in-out                          | amount 7deg                                   |
| `tada`        | emphasis | Shrinks, then grows with a celebratory wiggle.                           | 1000 ms, ease-in-out                         | amount 1.1                                    |
| `heartbeat`   | emphasis | Two quick beats.                                                         | 1200 ms, ease-in-out                         | amount 1.15                                   |
| `rubber`      | emphasis | Squashes and stretches like rubber.                                      | 900 ms, ease-out                             | amount 0.25                                   |
| `flash`       | emphasis | Blinks twice.                                                            | 900 ms, ease-in-out                          | —                                             |
| `jump`        | emphasis | Squashes, jumps and lands (squash & stretch, bottom edge kept).          | 800 ms, ease-in-out                          | amount 28px                                   |
| `float`       | emphasis | Floats up and down, forever.                                             | 3000 ms, ease-in-out, loops                  | amount 10px                                   |
| `spin`        | emphasis | Turns around, forever (negative = counter-clockwise).                    | 1600 ms, linear, loops                       | angle 360deg                                  |
| `breathe`     | emphasis | Slowly grows and shrinks, forever.                                       | 4000 ms, ease-in-out, loops                  | amount 1.04                                   |
| `sway`        | emphasis | Tilts gently from side to side, forever.                                 | 3200 ms, ease-in-out, loops                  | amount 4deg                                   |
| `glow`        | emphasis | A soft glow that comes and goes, forever.                                | 2400 ms, ease-in-out, loops                  | amount 18px, color `rgba(255, 255, 255, 0.8)` |
| `ping`        | emphasis | Expands and fades out, forever (radar / notification dot).               | 1400 ms, `cubic-bezier(0, 0, 0.2, 1)`, loops | amount 1.9                                    |

The catalog is `MOTION_PRESETS` in `packages/core/src/motion/presets.ts` (MCP `list_motion_presets`).

### Easings

`linear`, `ease`, `ease-in`, `ease-out`, `ease-in-out`, `smooth` (standard UI curve), `smooth-out` / `smooth-in` (emphasized decelerate / accelerate, for entrances / exits), `expo-out`, `expo-in`, `expo-in-out`, `back-out` (overshoot), `back-in` (anticipation), `back-in-out`, `spring-soft`, `spring`, `spring-bouncy`, `spring-wobbly`, `bounce` (ball), `elastic`. Springs, bounce and elastic are generated as CSS `linear()` curves (sampled and simplified with Ramer–Douglas–Peucker to stay within 0.15% of the curve), so one string drives the Web Animations API, the render page and the exported CSS. A duration-based spring settles exactly at the end of `duration`; `bounce` sets the damping ratio (`ζ = 1 − bounce`).

### Slide transitions

| Preset   | Description                                                                                               | Default             | Direction |
| -------- | --------------------------------------------------------------------------------------------------------- | ------------------- | --------- |
| `fade`   | Crossfades into the new slide.                                                                            | 500 ms, smooth      | —         |
| `dip`    | Fades out to black, then fades the new slide in.                                                          | 800 ms, ease-in-out | —         |
| `push`   | The new slide pushes the old one out.                                                                     | 700 ms, expo-in-out | yes       |
| `cover`  | The new slide slides over the old one, which sinks back.                                                  | 700 ms, expo-out    | yes       |
| `reveal` | The old slide slides away, revealing the new one.                                                         | 700 ms, expo-out    | yes       |
| `wipe`   | A straight edge wipes the new slide in (clip-path: repaints while it runs).                               | 700 ms, expo-in-out | yes       |
| `zoom`   | The old slide zooms past the camera while the new one settles in.                                         | 650 ms, expo-out    | —         |
| `blur`   | Blurs out of the old slide into the new one.                                                              | 650 ms, smooth      | —         |
| `flip`   | Flips the slide over like a card, in 3D.                                                                  | 900 ms, smooth      | yes       |
| `cube`   | Rotates to the new slide as the next face of a cube, in 3D.                                               | 900 ms, expo-in-out | yes       |
| `magic`  | Layers with the same name on both slides move, resize and crossfade into their new place; the rest fades. | 800 ms, smooth      | —         |

Without a transition the slide fades in quickly (200 ms), as before. `transitionPlan` (`packages/core/src/motion/transitions.ts`) produces the keyframes of both slides; the presentation plays them.

## Builds and the timeline

A frame's animations are grouped in **builds**: build 0 plays when the frame appears, and each click of a presentation plays the next build. The **linear timeline** lays the builds back to back (each starts when the previous one ends; loops do not extend a build): it is what the editor's timeline scrubs, what `get_screenshot` `time` renders and what the animated export records. `frameMotionTimeline(frame)` (`packages/core/src/motion/timeline.ts`) computes builds, the start/end of every animation on the linear timeline, the number of clicks, loops and warnings (two entrances on one node, an exit before its entrance, a split without targets, timelines over 30 s); `formatMotionTimeline` is the text of MCP `get_timeline`.

## Runtime

`MotionScope` (`packages/editor/src/motion/scope.ts`) plays the animations with the Web Animations API. One scope per surface: the canvas (`canvasMotion`), the presentation and the render page.

- `NodeView` attaches the element of each animated node (`attach`, in a layout effect) and the root frame registers its timeline (`setFrame`). Compiled keyframes are cached per node object (structural sharing keeps unchanged nodes), so an edit only recompiles what changed.
- Each frame has a mode: `rest` (design state), `seek` (paused at a point: linear time or a build state), `play` (the linear timeline in real time) or `builds` (presentation: N clicks played; the newest build starts now, older ones keep running).
- **No React render per frame and no per-node timers**: all the animations of a build share one start time on the document timeline (`startTime`), so the browser runs them in sync on its own; seeking writes `currentTime`; play/pause/scrub never go through React state (the timeline playhead is moved by a requestAnimationFrame loop that writes a transform).
- **Lazy**: in the design state only infinite loops exist (on the canvas, following the effects play/pause, Shift+Space); entrances, exits and emphasis are created only for the frame being previewed, presented or captured, and cancelled afterwards.
- **Off screen**: an `IntersectionObserver` on the canvas viewport pauses the loops of frames that are not visible (25% margin) and re-syncs them when they come back.
- **GPU**: presets touch `transform`, `opacity`, `filter` and the individual transform properties, which Chromium animates on the compositor; only the wipes (clip-path) repaint while they run.
- Fill rules: entrances fill backwards (hidden while they wait for their build or delay; afterwards the element simply shows its own style, which is the last keyframe), exits fill forwards (stay hidden), emphasis does not fill. Animations are `persist()`ed so the browser never auto-removes a filling exit.
- Text with `split: words | chars` renders one inline-block `span[data-motion-seg]` per segment (characters grouped in a `white-space: nowrap` word span so lines still break only between words), in the design state too, so the layout is the same everywhere.

## Editor

See [EDITOR.md](EDITOR.md#motion): the **Animation** section of the Design panel (preset gallery with live previews, every field, cascade over a multiple selection), the **Slide transition** section of root frames and the **Motion timeline** panel (builds, bars per layer, drag to retime, scrub, play).

## Presentation

See [EDITOR.md](EDITOR.md#presentation): each slide enters with its transition while its build 0 plays; → / Space / click plays the next build before moving to the next slide; ← undoes the last build (instantly) or goes back to the previous slide shown with all its builds; `magic` morphs layers with the same name between the two slides.

## MCP

Tools (see [MCP.md](MCP.md)): `list_motion_presets`, `animate` (several nodes, `cascade` to stagger them, one undo step), `update_animation`, `remove_animations`, `set_animations`, `set_slide_transition`, `get_timeline`, `preview_motion` (plays / scrubs / stops the timeline on the editor canvas), plus `get_screenshot` `time` / `build` / `times`, `presentation_goto` `build` and the `motion` guide. The loop for an agent: `animate` → `get_timeline` → `get_screenshot` with `times` (a filmstrip of several instants in one image) → `preview_motion` → `start_presentation`.

## Screenshot and export

- `get_screenshot`: without `time`/`build` the node animations show the design state (as on the canvas). `time` (s) renders the frame's linear timeline at that instant (and the effects clock); `build` renders the state after that many clicks (with `time`, seconds into the build it reaches), counted in play order like `presentation_goto` `build`, so sparse build numbers (0, 2, 5) still give 1 = after the first click; `times` returns a filmstrip, one cell per instant, in a single image. The render page seeks a `MotionScope` and waits for the frame like for effects (see [EFFECTS.md](EFFECTS.md#how-the-render-captures)).
- `export` `mp4` / `webm` / `gif` record the linear timeline (default duration: the frame's timeline + 0.5 s when it has animations).
- `export` `html` / `tailwind` / `react` emit real CSS animations (`@keyframes` deduplicated, `prefers-reduced-motion` respected) and a tiny script that plays click builds (see [EXPORT.md](EXPORT.md#motion)). Slide transitions are presentation-only.

## Performance

Stress scenario: `packages/editor/e2e/motion-perf.spec.ts` (12 slides × ~18 animated layers: character-split titles, staggered cards with springs and blur, loops, three click builds per slide, a different transition on each slide: push, cube, zoom, magic, cover, blur). It runs with the e2e suite (`npm run test:e2e`) and writes `motion-perf.json` to the e2e folder.

Measured on 2026-11-26 (Windows 11, Playwright 1.65 headless Chromium, 1440×900 viewport). Frame times are the intervals between `requestAnimationFrame` callbacks, so they show any work that blocks the main thread; "long" = frames over 25 ms.

| Document                 | Value                                                                        |
| ------------------------ | ---------------------------------------------------------------------------- |
| Layers / animated layers | 252 / 216                                                                    |
| Animations               | 288 (60 infinite loops), 12 slide transitions                                |
| `.mockup.json` size      | 177.6 KB, of which 56 KB of motion (199 bytes per animation, pretty-printed) |
| Slide 1 timeline         | 4.58 s linear, 4 click builds, 35 animations                                 |

| Scenario                                                              | fps  | p50 / p95 / max frame | Long frames | Main thread busy |
| --------------------------------------------------------------------- | ---- | --------------------- | ----------- | ---------------- |
| Canvas, all 12 slides in view, 60 loops running (design state)        | 60   | 16.7 / 16.8 / 16.8 ms | 0           | 0.7%             |
| Same, loops paused (Shift+Space)                                      | 60.5 | 16.7 / 16.7 / 16.8 ms | 0           | 0.8%             |
| Panning across the deck while the loops run                           | 60   | 16.7 / 16.8 / 16.8 ms | 0           | —                |
| Timeline preview of slide 1 (107 live Web Animations)                 | 60   | 16.7 / 16.7 / 16.8 ms | 0           | —                |
| Presentation: 12 clicks through builds and transitions (cube, magic…) | 60.1 | 16.7 / 16.8 / 16.8 ms | 0           | —                |

| MCP (end to end, HTTP)                               | Time |
| ---------------------------------------------------- | ---- |
| `write_html` of a slide with 18 animated layers      | 6 ms |
| `set_slide_transition`                               | 2 ms |
| `animate` on 12 nodes with `cascade` (one undo step) | 9 ms |

Three runs of the same scenario gave the same frame numbers, except one 33 ms frame (one dropped frame) out of 540 during the presentation clicks in one of them; the MCP times varied by a few ms (`write_html` 5–9 ms, `set_slide_transition` 2–3 ms). Running loops cost nothing measurable on the main thread (0.7% busy with 60 loops vs 0.8% paused: Chromium runs them on the compositor). The existing editor measurement (`perf.spec.ts`, 300 nodes) is unchanged by this work: MCP → DOM latency 48 ms on this branch vs 47 ms on the base commit, dragging p95 16.8 ms on both.

## Limitations

- Character split uses inline-block spans: kerning and ligatures across characters are lost, `text-decoration` does not reach the spans and gradient text (`background-clip: text`) may not cover transformed spans.
- `wipe` presets and the `wipe` transition animate `clip-path`, which repaints every frame (fine for a few elements at a time).
- Magic move matches layers by name: give the layers to morph the same, unique name on both slides.
- Slide transitions are not exported to code.
