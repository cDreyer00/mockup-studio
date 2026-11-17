/** Guide `effects`: visual effects, video, embeds, Three.js and animated export. */
export const EFFECTS_GUIDE = `# Effects, video, embeds and animated export

## Effects as a background
- \`list_effects()\` shows the effects (WebGL shaders and particles), parameters and presets.
- \`add_effect(nodeId, kind, preset?, params?)\` creates the effect as the FIRST child of the container (\`placement: 'background'\`, the default), covering it behind the content. The parent gets \`position: relative\` and \`isolation: isolate\` in the same step (one \`undo\` reverts everything).
- E.g.: \`add_effect('fr_ab12cd34', 'mesh-gradient', preset: 'aurora')\` gives the whole frame an animated background; the existing content stays on top.
- \`placement: 'child'\` inserts a regular child (default 100% x 240px) to use as a decorative block.
- \`update_effect(nodeId, params?, preset?, kind?, reset?)\` merges parameters; \`kind\` switches the effect.
- Invalid parameters come back with the list of problems: check \`list_effects\`.

## Checking the result
- \`get_screenshot(nodeId, time)\` renders the animation frame at instant \`time\` (s): effects, particles, Lottie, Rive, Three.js and video. Compare \`time: 0\` and \`time: 2\`.
- A video with a \`poster\` shows the poster in the screenshot when \`time\` is not given.

## Video
- \`insert_video(parentId, source, poster?)\`: \`source\` is an absolute path (mp4, m4v, mov, webm, ogv; up to 500 MB; copied to \`assets/videos/\`) or an http(s) URL (referenced directly; only plays with network access). A document with no path on disk only accepts a URL.
- Defaults: muted, looping, autoplay, no controls, 640x360 with \`object-fit: cover\`. \`update_media\` changes the options.

## Embeds
- \`insert_embed(parentId, url)\` detects the provider: YouTube (uses \`?t=\` as the start), \`.json\`/\`.lottie\` (Lottie), \`.riv\` (Rive) and any other URL (iframe).
- Offline: Lottie and Rive are copied to \`assets/lottie/\` and \`assets/rive/\` and work without a network. YouTube and iframes NEED a network.
- \`update_media\` changes the url, src, code or parameters of an embed.

## Three.js island
- \`insert_three(parentId, code?, params?)\`. The code is the body of a function with \`THREE, renderer, canvas, width, height, params\` and returns \`{ scene, camera, update(t) }\` (t in seconds). Without \`code\`, it uses a spinning torus node.
- Runs isolated in a sandboxed iframe, with no access to the document (the sandbox does not block the network). Parameters arrive in \`params\`.

## Animated export
- \`export(nodeIds, format: 'mp4' | 'webm' | 'gif', fps?, duration?, start?, maxWidth?, scale?)\`: renders the frames and encodes them with ffmpeg. Defaults: 30 fps (gif 15, max 30), 3 s, \`start\` 0; duration up to 30 s. Requires render and ffmpeg (\`MOCKUP_FFMPEG\` or the bundled ffmpeg).
- mp4 is the most compatible, webm is smaller, gif suits a README (use \`maxWidth\` to shrink it).
- \`export(format: 'react', effects: 'live' | 'static')\`: with \`live\` (default) the component recreates the animated effects; with \`static\` it writes a PNG of each effect to \`assets/effects/\` (requires render).
`;
