/** Guide `get_guide('motion')`: node animations, builds, slide transitions and the iterate loop. */
export const MOTION_GUIDE = `# Motion: animations, builds and slide transitions

Every node can have a list of animations; root frames can have a slide transition. All times are in MILLISECONDS (except get_screenshot \`time\`/\`times\` and preview_motion \`time\`, which are seconds). Presets and easings: \`list_motion_presets\`.

## Concepts

- **kind**: \`in\` (entrance: hidden until it plays), \`out\` (exit: hidden afterwards), \`emphasis\` (plays and returns to rest; loops are emphasis with \`iterations: "infinite"\`).
- **Design state vs timeline**: with no animation playing the canvas shows the design state (everything at rest, as you styled it). Animations only exist on the timeline, a presentation, the canvas preview and animated exports.
- **build**: the click order. \`build: 0\` (default) plays when the slide/frame appears; \`1, 2, ...\` play on the 1st, 2nd... click of a presentation (\`presentation_goto step "next"\` plays the next build before moving on). Only the order counts: builds 0, 2, 5 play on appear, 1st click, 2nd click, and \`get_screenshot build\` / \`presentation_goto build\` count clicks.
- **Linear timeline**: builds laid back to back (build 0, then 1...). \`get_screenshot time\`, the editor timeline and the animated export use it. \`get_timeline\` prints it.
- **delay / cascade**: \`delay\` waits inside the build. \`cascade\` (animate only) adds that many ms to the delay of each successive node: node i waits delay + i x cascade.
- **split**: \`children\`, \`words\` or \`chars\` animates each part of ONE node, \`stagger\` ms apart (defaults 80 / 60 / 30). words/chars need a text node.
- **easing**: named (\`smooth-out\`, \`expo-out\`, \`back-out\` overshoot, \`spring\`, \`spring-bouncy\`, \`bounce\`, \`elastic\`...) or any CSS easing. Entrances like \`smooth-out\`/\`expo-out\`; playful ones \`spring\`/\`back-out\`; spins and loops \`linear\`/\`ease-in-out\`.
- **loops**: \`iterations: "infinite"\` (or a number) plus \`alternate: true\` for yoyo. \`float\`, \`spin\`, \`breathe\`, \`glow\`, \`ping\` already loop.
- **custom**: \`preset: "custom"\` with \`keyframes\` (kebab-case CSS, optional \`offset\` 0..1 and \`easing\`).

## Recipes

Title revealed by characters:
\`\`\`
animate({ nodeIds: ["tx_title"], preset: "fade-up", split: "chars", stagger: 25, duration: 500 })
\`\`\`

Cards that enter one after another (ONE call, one undo):
\`\`\`
animate({ nodeIds: ["el_card1", "el_card2", "el_card3"], preset: "fade-up", duration: 600, easing: "smooth-out", cascade: 80 })
\`\`\`

Bullets one per click:
\`\`\`
animate({ nodeIds: ["tx_b1"], preset: "fade-right", build: 1 })
animate({ nodeIds: ["tx_b2"], preset: "fade-right", build: 2 })
animate({ nodeIds: ["tx_b3"], preset: "fade-right", build: 3 })
\`\`\`

Floating badge loop:
\`\`\`
animate({ nodeIds: ["el_badge"], preset: "float", params: { amount: 10 } })
\`\`\`

Full sequence on one node (entrance, then a click emphasis):
\`\`\`
set_animations({ nodeId: "el_cta", animations: [{ preset: "pop" }, { kind: "emphasis", preset: "pulse", build: 1 }] })
\`\`\`

Deck with push transitions:
\`\`\`
set_slide_transition({ pageId: "pg_deck", preset: "push", direction: "left", duration: 600 })
\`\`\`

Magic move between two slides: give the layers the SAME NAME on both slides (rename_nodes) and use \`set_slide_transition({ frameIds: ["fr_slide2"], preset: "magic" })\`. Matching layers glide from their position/size on slide 1 to slide 2.

Edit later: \`update_animation({ nodeId, index, duration: 900, params: { distance: 60 } })\` (null clears a field), \`remove_animations({ nodeIds, kind: "emphasis" })\`, \`set_slide_transition({ ..., preset: null })\`.

## Iterate loop

1. \`animate\` (or \`set_animations\`) - one call can animate many nodes.
2. \`get_timeline\` - check builds, starts/ends, loops and warnings.
3. \`get_screenshot\` with \`times: [0, 0.2, 0.4, 0.7, 1, 1.5]\` - a filmstrip of the whole animation in ONE image (cheap). Use \`build: 1\` for the state after the first click, \`time\` for a single instant.
4. \`preview_motion\` - plays it on the canvas for the user (needs an open editor).
5. \`start_presentation\` + \`presentation_goto\` - runs click builds and slide transitions for real.
Fix with \`update_animation\`, repeat.

## Performance

- transform, opacity and filter presets run on the GPU; wipes use clip-path and repaint (marked [paint] in list_motion_presets). Dozens of animations per frame are fine.
- Prefer short durations (300-800 ms) for entrances; keep infinite loops subtle and few.
- Animated export (\`export\` mp4/webm/gif) records the whole linear timeline by default (timeline + 0.5 s); loops are cut at that length.
- Instances: animating an inner id (\`in_x/el_y\`) becomes an override of that instance only; animating the main component's node changes all instances.
`;
