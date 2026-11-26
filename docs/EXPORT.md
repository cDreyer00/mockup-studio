# Code export

The exporters live in `packages/core/src/export/` and are pure functions over the `Document`
(no DOM, no I/O). All of them are exported from `@mockup/core`.

| Format     | Function                                     | Output                                                  |
| ---------- | -------------------------------------------- | ------------------------------------------------------- |
| `html`     | `exportHtml(doc, opts)`                      | HTML document (or fragment) + CSS in `<style>`          |
| `tailwind` | `exportTailwind(doc, opts)`, `cssToTailwind` | HTML with Tailwind v4 classes (+ theme in `@theme`)     |
| `react`    | `exportReact(doc, opts)`                     | `.tsx` component (+ theme `css`)                        |
| `svg`      | `exportSvg(doc, opts)`                       | Standalone SVG (measured geometry or `<foreignObject>`) |
| `png/jpg`  | render engine (server)                       | do not go through the core                              |

Rules common to all formats:

- Frames are artboards: the position on the canvas (the frame's `node.position`) does **not** go into the code.
  The root frame keeps `width` and `height` becomes `min-height` (the content can grow). In `svg`
  with layout the size is the measured one.
- Children with `position: absolute` use `node.position` as `left`/`top` when the style does not define them.
- `hidden` nodes are not exported.
- CSS declarations with an unsafe name or value (`{`, `}`, `;` outside quotes/parentheses, `</style`,
  comments, unbalanced quotes or parentheses) are **dropped** on export, even in
  old files. When editing (`updateStyles`, `normalizeStyles`) they are **rejected** with a message; when reading
  a file (`parseDocument`) only the bad declaration is dropped.
- `on*`, `style`, `class` and `srcdoc` attributes and non-image `javascript:`/`data:` URLs are removed.
  Inline SVG goes through `sanitizeSvg`.
- Fonts (`doc.fonts`): family and files have a restricted charset (no `< > { } ; " \`, line breaks, `..`), styles only `normal|italic|oblique` and integer weights from 1 to 1000; the schema rejects the rest and `fontFaceCss` drops invalid entries.

## Fonts in SVG

The SVG embeds the fonts registered in `doc.fonts` as `@font-face` with `src:url("data:font/woff2;base64,...")` in a `<style>` (escaped for XML), so the file opens with the correct typography without `assets/`. The server resolves each file in `assets/` to a data URL (`resolveImage`); fonts with no resolvable file (or `local`) do not generate a rule.

## Document base CSS

`documentBaseCss` (`packages/core/src/base.ts`) is the single source of the base CSS: the canvas, the render page (screenshot) and the exported code use the same one, so all three come out identical. The editor's UI CSS does not leak into the design. It defines:

- `box-sizing: border-box` and `margin: 0` on everything (`*`, `::before`, `::after`);
- controls (`button`, `input`, `select`, `textarea`) inherit font, color and `letter-spacing`;
- default root typography (`body` in the exported code): system font (`system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif`), 16px, `line-height: normal`, black text.

In the html, react with inline styles and svg formats it goes in as CSS (`documentBaseCssFor(doc)`). In Tailwind the preflight already covers the reset and the controls, so only the root typography becomes `@layer base { body { ... } }` in `theme.css` (`tailwindBaseCssFor(doc)`, inside `tailwindThemeCss`).

`doc.cssBase` chooses the base (op `setCssBase`):

- absent (default): the base above;
- `'tailwind'`: the Tailwind v4 preflight (`padding`/`border` reset, `h1..h6` without size, images `display: block`, lists without markers...) and the Tailwind typographic root (v4 system font, `line-height: 1.5`). In html, react inline and svg the preflight goes into the CSS; in Tailwind only the base layer's `body` changes (the `@import "tailwindcss"` already brings the preflight). `BASE_CSS` and `TAILWIND_BASE_CSS` remain exported as the default base constants.

## html

```ts
exportHtml(doc, { pageId?, nodeIds?, title?, mode?: 'classes' | 'inline', fragment?: boolean }): string
```

States (`node.states`) come out as `<style>` rules right after the node's base rule:
`.slug:hover { ... }`, `@media (min-width: 768px) { .slug { ... } }` (`sm` 640, `md` 768, `lg` 1024,
`xl` 1280, `2xl` 1536), `.slug:where([data-theme="dark"], [data-theme="dark"] *) { ... }` for `dark` and
combinations (the `@media` wraps the selector with the pseudo-class). See "States and variants" in the
Tailwind section.

- `mode: 'classes'` (default): one class per node, with the **slug of the layer name** (`Hero Title` →
  `.hero-title`; accents removed; duplicates get `-2`, `-3`). `mode: 'inline'`: `style=""` on each tag.
- `fragment: true`: only `<style>` + markup, no `<!doctype>`/`<head>`.
- Tokens go in `:root { --x: ... }`, then the document's base CSS (reset, controls and root typography) and the
  `@font-face` rules of the embedded fonts (`assets/<file>`).
- Default without `nodeIds`: all frames of the page (`pageId` or the first).

Navbar of the Desktop 1440 (`nodeIds: ['el_dsk00007'], fragment: true`, excerpt):

```html
<style>
  :root {
    --color-surface: #181b22;
    --radius: 12px;
    /* ... */
  }
  * {
    box-sizing: border-box;
    margin: 0;
  }
  .navbar {
    display: flex;
    flex-direction: row;
    align-items: center;
    justify-content: space-between;
    padding: 20px 64px;
    background-color: var(--color-surface);
  }
  .sign-in-button {
    background: var(--color-primary);
    color: #ffffff;
    padding: 10px 20px;
    border-radius: var(--radius);
    border: none;
    font-size: 15px;
    font-weight: 600;
  }
</style>
<header class="navbar">
  <div class="logo">Mockup</div>
  <nav class="links">
    <a class="product" href="#">Product</a>
    <!-- ... -->
  </nav>
  <button class="sign-in-button">Sign in</button>
</header>
```

## tailwind

```ts
exportTailwind(doc, { pageId?, nodeIds?, title?, fragment?: boolean, cdn?: boolean, tailwind?: TailwindEngine }): string
cssToTailwind(style, { tokens? }): { classes: string[]; rest: Record<string, string> }
tailwindThemeCss(doc, { import?: boolean }): string
neutralLeadingSizes(doc): Set<string>
```

Tailwind **v4**. The full document (default) includes

```html
<script src="https://cdn.jsdelivr.net/npm/@tailwindcss/browser@4"></script>
<style type="text/tailwindcss">
  @theme { ... } :root { ... } @font-face { ... }
</style>
```

`cdn: false` removes the `<script>` (the theme stays). `fragment: true` returns only the markup
(use `tailwindThemeCss(doc)` for your project's theme CSS: `@import "tailwindcss";` + `@theme`

- `:root` + `@font-face`).

Navbar (same node, `fragment: true`):

```html
<header class="flex flex-row items-center justify-between py-5 px-16 bg-surface">
  <div class="text-[22px] font-bold text-text">Mockup</div>
  <nav class="flex gap-8">
    <a class="text-muted text-base no-underline" href="#">Product</a>
    <!-- ... -->
  </nav>
  <button
    class="bg-primary text-white py-2.5 px-5 rounded-(--radius) border-none text-[15px] font-semibold"
  >
    Sign in
  </button>
</header>
```

### Mapping (summary)

| CSS                                                                            | Class                                                                                                                                                            |
| ------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `display: flex`, `flex-direction: column`                                      | `flex`, `flex-col`                                                                                                                                               |
| `align-items`/`justify-content`: `center`, `space-between`, `flex-end`         | `items-center`, `justify-between`, `justify-end`                                                                                                                 |
| `flex: 1`, `flex-grow: 1`, `flex-shrink: 0`                                    | `flex-1`, `grow`, `shrink-0`                                                                                                                                     |
| `grid-template-columns: repeat(3, 1fr)` / other                                | `grid-cols-3` / `grid-cols-[200px_1fr]`                                                                                                                          |
| `gap: 24px`, `gap: 8px 16px`                                                   | `gap-6`, `gap-y-2 gap-x-4`                                                                                                                                       |
| `padding: 16px`, `20px 64px`, `6px`, `13px`                                    | `p-4`, `py-5 px-16`, `p-1.5`, `p-[13px]` (v4 scale: 4px = 1, half steps ok)                                                                                      |
| `margin: 0 auto`, `margin-top: -8px`                                           | `my-0 mx-auto`, `-mt-2`                                                                                                                                          |
| `width`/`height`                                                               | `w-full`, `h-screen`, `w-1/2`, `w-auto`, `w-[1440px]`; equal → `size-10`                                                                                         |
| `min-height: 900px`, `max-width`                                               | `min-h-[900px]`, `max-w-md` (256–1280px named) or `max-w-[800px]`                                                                                                |
| `font-size` 12…128px                                                           | `text-xs` … `text-9xl`; otherwise `text-[17px]`                                                                                                                  |
| `font-weight` 100…900                                                          | `font-thin` … `font-black`; otherwise `font-[550]`                                                                                                               |
| `line-height`                                                                  | `leading-none/tight/snug/normal/relaxed/loose`, `leading-7`, `leading-[1.4]`                                                                                     |
| `letter-spacing`                                                               | `tracking-tighter` … `tracking-widest`, `tracking-[2px]`                                                                                                         |
| `text-align`, `text-transform`, `font-style`, `text-decoration`, `white-space` | `text-center`, `uppercase`, `italic`, `underline`/`no-underline`, `whitespace-pre-wrap`                                                                          |
| `color`/`background-color`/`border-color`                                      | `text-`/`bg-`/`border-` + `[#6c5ce7]`, `white`, `transparent`, `[rgba(0,0,0,0.5)]`, theme                                                                        |
| `background: linear-gradient(...)`                                             | `bg-[linear-gradient(90deg,#000,#fff)]`                                                                                                                          |
| `border: 1px solid c`, `border-top`, `border-width: 4px`                       | `border border-solid border-c`, `border-t border-t-c`, `border-4`                                                                                                |
| `border-radius`                                                                | 2/4/6/8/12/16/24/32px → `rounded-xs` … `rounded-4xl`; ≥9999 → `rounded-full`; `0` → `rounded-none`; otherwise `rounded-[10px]`; 2–4 values → `rounded-tl-*` etc. |
| `box-shadow`                                                                   | `shadow-[0_2px_4px_rgba(0,0,0,0.2)]` (spaces become `_`), `shadow-none`                                                                                          |
| `opacity: 0.5`                                                                 | `opacity-50`                                                                                                                                                     |
| `overflow`, `position`, `top/left/...`, `z-index`                              | `overflow-hidden`, `absolute`, `left-3`/`left-[13px]`, `z-10`/`z-[7]`                                                                                            |
| `object-fit`, `cursor`, `aspect-ratio`                                         | `object-cover`, `cursor-pointer`, `aspect-video`                                                                                                                 |
| `!important`                                                                   | `!` suffix (`p-4!`)                                                                                                                                              |
| any other property                                                             | arbitrary class `[prop:value]` (`[transition:all_0.2s_ease]`, `[--x:#f00]`)                                                                                      |

If even the arbitrary class is not safe (value with `<`, `>`, `{`, `}`, `;`, backticks), the declaration goes
to `rest` and the exporter emits it in `style=""`.

`line-height` detail: `text-sm` etc. bring a default `line-height` in Tailwind. So that the
line spacing stays the document's, `tailwindThemeCss` adds to `@theme`
`--text-<size>--line-height: inherit;` only for the named sizes used by some node (base or
state) whose `line-height` is **not** the Tailwind default for that size (or that has no
`line-height`). Nodes imported from Tailwind (`font-size: 0.875rem` + `line-height: 1.4286`, or `20px`)
do not need the neutralization; `neutralLeadingSizes(doc)` returns that set. A node with the default
that coexists with a non-default node at the same size gets an explicit `leading-*` so it does not change.

### Document engine (`options.tailwind`)

With `tailwind: await getTailwindEngine(doc)` (from `@mockup/core/tailwind`, which runs the
official Tailwind v4 compiler) each node's classes come from `engine.nodeClasses(node, { neutralLeading })`
instead of `cssToTailwind`:

- **`node.classes` hint**: the classes the author wrote (HTML Tailwind import, `set_classes`) are
  reused, in the original order, as long as they still reproduce the node's current style; whatever was edited
  afterwards is generated again. Classes the model does not represent (`group`, `group-hover:x`,
  `[&_svg]:size-4`, `has-[>svg]:px-3`, `aria-invalid:...`) and unknown ones come out as they are;
- **canonicalization + verification**: whatever does not come from the hint goes through the static mapping, is
  canonicalized by Tailwind (`p-[16px]` becomes `p-4`, `mt-2 mb-2` becomes `my-2`) and checked against the
  compiler (shorthand-independent comparison: `padding: 8px 16px` matches `py-2 px-4`). If it does not
  reproduce the style, it falls back to `[prop:value]`;
- whatever does not become a class still goes to `style=""` (`rest`).

Without the engine the mapping is the usual static one (output identical to before).

### States and variants

`node.states` (`hover`, `focus`, `focus-visible`, `focus-within`, `active`, `disabled`, `dark`,
`sm|md|lg|xl|2xl` and combinations like `md:hover`) are exported as classes with a variant prefix
(`hover:bg-[#5b4bd6]`, `md:px-6`, `dark:bg-[#222]`, `md:hover:...`). With the engine, `nodeClasses` already
does this (and reuses the author's `hover:bg-primary/90`); without the engine, `cssToTailwind` of the state with
the prefix (properties with no class or safe arbitrary form are dropped, since `style=""` has
no variants). When any node has a `dark` state, the exported theme includes
`@custom-variant dark (&:where([data-theme=dark], [data-theme=dark] *));` (the document's `dark`
theme, via `data-theme`).

### Tokens and `@theme`

A token whose name falls in a Tailwind v4 theme namespace becomes an `@theme` variable and the class uses
the short name:

| Token                         | Use in CSS                         | Class                                |
| ----------------------------- | ---------------------------------- | ------------------------------------ |
| `--color-primary`             | `background: var(--color-primary)` | `bg-primary` (`text-`, `border-`...) |
| `--radius-card`               | `border-radius`                    | `rounded-card`                       |
| `--font-sans`                 | `font-family`                      | `font-sans`                          |
| `--font-weight-heavy`         | `font-weight`                      | `font-heavy`                         |
| `--text-hero`                 | `font-size`                        | `text-hero`                          |
| `--shadow-soft`               | `box-shadow`                       | `shadow-soft`                        |
| `--spacing-gutter`            | `padding`, `gap`, `width`...       | `p-gutter`, `gap-gutter`             |
| `--leading-*`, `--tracking-*` | `line-height`, `letter-spacing`    | `leading-*`, `tracking-*`            |

Tokens **outside** the namespaces (`--radius`, `--font` in the example) stay in `:root { ... }` and use the
v4 variable syntax with parentheses, chosen because it is the documented short form in Tailwind v4:

| CSS                            | Class                       |
| ------------------------------ | --------------------------- |
| `border-radius: var(--radius)` | `rounded-(--radius)`        |
| `font-family: var(--font)`     | `font-(family-name:--font)` |
| `background: var(--surface)`   | `bg-(color:--surface)`      |
| `padding: var(--pad)`          | `p-(--pad)`                 |
| `font-size: var(--size)`       | `text-(length:--size)`      |

A `var(--color-x)` whose token does not exist in the document (when `tokens` is passed to
`cssToTailwind`) also uses the `(color:--color-x)` form. `var(--x, fallback)` becomes `[color:var(--x,#fff)]`.

## react

```ts
exportReact(doc, {
  nodeId, styles?: 'tailwind' | 'inline', componentName?, extractRepeats?: boolean, assetsBase?: string,
}): { componentName: string; code: string; css?: string }
```

Generates a TSX function component (`export function Name()` + `export default Name`) that compiles with
`tsc --strict` and `noUnusedLocals` in a Vite React TS template (the tests compile the output with the
TypeScript compiler). The name is the PascalCase of the node's name (accents removed).

- `styles: 'tailwind'` (default): `className` with the classes above (with `options.tailwind` those from the engine,
  including the variants from `node.states`); `css` carries `tailwindThemeCss(doc)` (put it in a `.css`
  imported by the app, with Tailwind v4 installed). Siblings are only extracted into `map(...)` if they also
  have the same states.
- `styles: 'inline'`: `style={{ backgroundColor: 'var(--color-bg)' }}` (camelCase, everything a string
  with a unit). The document's tokens become custom properties on the **root** element's `style`
  (`{ '--color-bg': '#0f1115', ... } as CSSProperties`, with `import type { CSSProperties } from 'react'`).
  `css` carries the document's base CSS and the `@font-face` rules. **States are not exported** in this mode
  (`style={{}}` has no `:hover` or `@media`); use `styles: 'tailwind'` to carry them over.
- Attributes: `for` → `htmlFor`, `tabindex` → `tabIndex={0}`, `readonly` → `readOnly`, boolean attributes with no
  value (`disabled`), `aria-*`/`data-*` kept, field `value` becomes `defaultValue`, void tags
  self-closed. Only known HTML attributes are included (the rest are dropped so the TSX compiles).
- Text as children; `{`, `}`, `<`, `>` escaped (`{'{'}`), `&` → `&amp;`; spaces at the edges become
  `{' text '}`. Line break: `{'\n'}` when `white-space` preserves, `<br />` otherwise.
- Images: `src="assets/file.png"` (prefix configurable through `assetsBase`; data URLs pass through) and `alt`.
- SVG: the sanitized markup becomes JSX (`stroke-width` → `strokeWidth`, `class` → `className`,
  `xlink:href` → `xlinkHref`, `style="a: b"` → `style={{ a: 'b' }}`; element names such as
  `linearGradient`/`clipPath` normalized; unknown elements dropped).

### Repeats in `map`

With `extractRepeats` (default), consecutive siblings (≥ 2) with the **same structure** (same tags, types,
styles, attributes and tree; differing only in text, `src`, `alt` and `href`) become an array
outside the component and a `map`. Only the fields that **vary** between the items go in the array. The
fields come from the layer name in camelCase (`Card title` → `cardTitle`, `src` →
`photoSrc`); if the layer names differ between items, `text1`, `text2`... The array is named
`<common item name, or parent name>Items`. The `key` is the index.

Cards of the Desktop 1440 (`nodeId: 'el_dsk00026'`, tailwind):

```tsx
const cardItems = [
  {
    icon: '🎨',
    cardTitle: 'Free design',
    cardText: 'Position frames on the canvas and adjust every CSS property.',
  },
  // ...
];

export function Cards() {
  return (
    <section className="flex flex-row gap-6 pt-8 pb-24 px-16">
      {cardItems.map((item, index) => (
        <div key={index} className="flex flex-col gap-3 p-8 flex-1 bg-surface rounded-(--radius)">
          <div className="text-[32px]">{item.icon}</div>
          <h3 className="text-[22px] font-bold text-text">{item.cardTitle}</h3>
          <p className="text-base leading-normal text-muted">{item.cardText}</p>
        </div>
      ))}
    </section>
  );
}

export default Cards;
```

## svg

```ts
exportSvg(doc, { nodeId, layout?: LayoutNode, resolveImage?: (src) => string | undefined }): string
```

The SVG is a static image: `node.states` (hover, dark, breakpoints) are ignored.

**With `layout`** (geometry measured by the render page, `measure(nodeId)`): `<svg>` with
`width`/`height`/`viewBox` of the measured root node; coordinates relative to it. For each visible node
(`display: none`, `opacity: 0` and `visibility: hidden` are ignored):

- background: `<rect>` with `fill` (rgba becomes `rgb()` + `fill-opacity`); equal radii → `rx`, different → `<path>`;
- `background-image: linear-gradient(...)` → `<linearGradient>` (linear only; others are ignored);
- uniform border → `stroke` inset by half the width (`dashed`/`dotted` with `stroke-dasharray`);
  different borders → one filled strip per side;
- `box-shadow` → `<filter>` with `feDropShadow` (only the first outer shadow; `inset` is ignored);
- `opacity` → `<g opacity>`; `overflow: hidden|clip|auto|scroll` → `<clipPath>` with the node's rect (and radius) applied to the children;
- text: one `<text>` per measured line, at `x`, `y + baseline`, with `font-family/size/weight/style`,
  `letter-spacing`, `text-decoration`, `text-transform` applied and `fill`;
- image: `<image href>` with `resolveImage(src)` (or the original `src`) and `preserveAspectRatio`
  (`cover` → `xMidYMid slice`, `contain` → `meet`, `fill` → `none`), with a clip if there is a radius;
- `svg` nodes: nested `<svg x y width height viewBox>` with the sanitized markup (the node's `color` in `color`);
- embedded fonts: `<style>` with `@font-face` when `resolveImage` returns the data URL of the font file.

**Without `layout`**: `<svg><foreignObject>` with the exported HTML (XHTML, inline styles, tokens on the
wrapper `<div>` and reset in `<style>`), with the size declared in the node style's `width`/`height`
(px; default 100x100) and `height` preserved.

Navbar with a hand-measured layout (background with shadow, logo and button with radius):

```svg
<svg xmlns="http://www.w3.org/2000/svg" width="1440" height="71" viewBox="0 0 1440 71">
<defs>
<filter id="shadow1" x="-50%" y="-50%" width="200%" height="200%" color-interpolation-filters="sRGB"><feDropShadow dx="0" dy="2" stdDeviation="4" flood-color="rgb(0,0,0)" flood-opacity="0.2"/></filter>
</defs>
<rect x="0" y="0" width="1440" height="71" fill="rgb(24,27,34)" filter="url(#shadow1)"/>
<text x="64" y="44" font-family="Inter, system-ui, sans-serif" font-size="22" font-weight="700" fill="rgb(232,232,238)">Mockup</text>
<rect x="1316" y="16" width="60" height="39" rx="12" fill="rgb(108,92,231)"/>
<text x="1326" y="41" font-family="Inter" font-size="15" font-weight="600" fill="rgb(255,255,255)">Sign in</text>
</svg>
```

## Components

Documents with main components (`doc.components`, see `COMPONENTS.md`) export like this:

| Format   | Instances                                                                                          |
| -------- | -------------------------------------------------------------------------------------------------- |
| html     | Expanded (`expandDocument`): the result is the same as the canvas. The slots' `data-slot` is kept. |
| tailwind | Expanded, as in html.                                                                              |
| svg      | Expanded; the layout (with `layout`) and the `<foreignObject>` fallback use the concrete tree.     |
| react    | One component per main component used; instances become JSX.                                       |

In html, tailwind and svg, `nodeIds`/`nodeId` also accept **virtual** ids (`in_x/tx_label01`, nodes
inside an instance); React also accepts them, and exports the already expanded node.

### React

For each main component used by the exported roots (including those used by other main components) the file
carries, before the screen's component:

```tsx
export interface ButtonProps {
  /** Visual style of the button. */
  variant?: 'default' | 'secondary' | 'outline' | 'ghost' | 'destructive';
  size?: 'sm' | 'default' | 'lg';
  /** Button text. */
  label?: string;
  className?: string;
  style?: CSSProperties;
}

export function Button({
  variant = 'default',
  size = 'default',
  label = 'Button',
  className,
  style,
}: ButtonProps) {
  return (
    <button
      className={[
        'inline-flex ... rounded-md',
        variant === 'outline' ? 'border' : 'border-0', // variants: one chain per property
        variant === 'secondary'
          ? 'bg-secondary'
          : variant === 'outline'
            ? 'bg-background'
            : 'bg-primary',
        className,
      ]
        .filter(Boolean)
        .join(' ')}
      style={style}
    >
      <span>{label}</span>
    </button>
  );
}
```

- **Props**: `string`/`color` become `string`, `number` and `boolean` keep their type, `enum` becomes the union of
  literals (the options plus the default) and `slot` becomes `ReactNode` (imported from `react`). The first slot
  also accepts `children`. Every prop is optional, with the main component's default in the destructuring (only the
  props used in the body are destructured, so `tsc --noUnusedParameters` still passes). Every
  component accepts `className` and `style`, merged on the root (`style` last).
- **Placeholders**: `{{prop}}` becomes `{label}` in text, `title={`Badge ${text}`}` in an attribute and
- **Prop URLs**: `{{prop}}` in `href`, `src`, `action`, `formaction`, `xlink:href` or `srcdoc` comes out as
  `href={safeUrl(url)}`; the file gets the `safeUrl` helper once (`javascript:`, `vbscript:` and non-image `data:`
  become `#`, ignoring spaces, control characters and uppercase).
  `width: `calc(${width}px + 2px)`` in a style (never becomes a Tailwind class). In a state (`hover` etc.)
  the placeholder keeps the default value.
- **Variants**: each style property (and state property, in Tailwind) changed by variants becomes a
  chain of ternaries `cond2 ? v2 : cond1 ? v1 : base`, in the order of the variants (the last one that matches wins,
  as in expansion); in Tailwind mode the chain chooses classes (`variant === 'outline' ? 'border' : 'border-0'`,
  with no class conflict), in inline mode it chooses `style` values. A variant's `text` also becomes a ternary.
- **Slots**: the `data-slot` container becomes `{content ?? children ?? (<>default content</>)}`.
- **Instances**: `<Button variant="outline" label="Save" />`; the instance's `style` (position, margin,
  width) always goes inline in `style={{...}}` (it beats the component's classes). Filled slots: the
  first as JSX children, the rest as a prop (`footer={<Button label="Confirm" />}`).
- **Expanded in place** (with the comment `{/* instance of Button with overrides */}`): instance with
  `overrides`, `attrs`, `classes` or `states`, custom slot container (style, attributes), props not
  declared or with a value outside the type (unknown enum, invalid number) and missing component.
- Unique PascalCase names: if the main component collides with the screen's component (or another one), it becomes
  `Button2` / `Button2Props`.

Limitations: variants that change `attrs`, `hidden`, `classes`, `src`, `svg` or `props` of nested nodes are not
exported (the component carries a `// Note:` comment listing the nodes); an instance's `states` and
variant conditions outside the prop's type are ignored or expanded; repeats in `map` are not
extracted inside the body of components.

## Effects, video, embeds and animated formats

`effect`, `video` and `embed` nodes ([EFFECTS.md](EFFECTS.md), [EMBEDS.md](EMBEDS.md)) are exported like this:

- `html` and `tailwind`: an effect becomes `<canvas data-mockup-effect>` with a CSS fallback background and a `<script>` that embeds the runtime; video becomes `<video>`; YouTube and iframe become `<iframe>`; Lottie, Rive and Three.js load their libraries from a **CDN** (lottie-web 5 and three 0.187 from jsDelivr, Rive from unpkg), so they need a network to animate. Effects, local video and the CSS fallback work offline. A local Lottie `.json` of up to 512 KB is embedded in the HTML by `export` (opens via `file://`); larger JSON, `.lottie` and Rive `.riv` are read by `fetch` from the copied file and require serving the folder over HTTP (e.g. `npx serve`), since `file://` blocks reading due to CORS. The `exportHtml`/`exportTailwind` API accepts `readAsset(ref)` to supply the content of the `assets/` files.
- `svg`: no scripts; the effect becomes the fallback gradient and video and embeds become placeholders.
- `react`, `effects` option (`export` only): `live` (default) recreates the animated effects with `<MockupEffect>` and the `mockup-effects.js`/`.d.ts` runtime written next to the `.tsx`; `static` writes a PNG of each effect to `assets/effects/` and uses `<img>` (requires render). `exportReact` returns these extra files in `files` and accepts `effectImages` (effect id → image). Video, YouTube, iframe, Lottie, Rive and Three.js islands: see [EMBEDS.md](EMBEDS.md#export).

### mp4, webm and gif

`export` also accepts `mp4`, `webm` and `gif`: it renders the node's frames with the animation clock and encodes them with ffmpeg (`MOCKUP_FFMPEG`, `ffmpeg-static` or `ffmpeg` on the `PATH`). Parameters: `fps` (1 to 60; default 30, gif 15 and at most 30), `duration` (up to 30 s; default 3), `start` (default 0), `scale` and `maxWidth`. They require the render engine with frame capture (desktop app). These formats do not go through the core and do not copy `assets/`. Details in [EFFECTS.md](EFFECTS.md#animated-export-mp4-webm-and-gif).

## Images and `assets/`

The `src` of `image` nodes is relative to `assets/` (or a data URL). In html/tailwind/react the exported `src` is
`assets/<file>` — copy the document's `assets/` folder next to the exported file (React:
`assetsBase` changes the prefix, e.g. `/img/`). In a Vite project, put the folder in `public/assets/`
so `src="assets/..."` resolves without an import. In SVG the images are only self-contained if `resolveImage`
returns data URLs; without it the original `src` is kept. Embedded fonts (`fonts[]` with
`source: 'file'`) become `@font-face` with `assets/<file>` (html/tailwind/react) or a data URL (svg).

## Motion

Node animations (`node.animations`) export as real CSS in html, tailwind and react; svg is static and ignores them. `node.slideTransition` is presentation-only and is never exported.

- Each animated element gets `data-mk="<n>"`; the rules target that attribute, so they work the same in classes, inline and Tailwind exports. `@keyframes` are named by a short content hash (`mk-3f9a1c`), emitted once however many elements share them, with a `-b<build>` suffix when the build is > 0.
- `animation` is comma-separated in composite order, with the fill mode per entry (entrances `backwards`, exits `forwards`, emphasis none), `infinite` for loops and `animation-play-state: paused` for builds > 0.
- Targets: `self` is the element; `child` is the i-th visible child; `segment` is a split-text span. A text with `split: 'words' | 'chars'` becomes inline-block `span[data-motion-seg]` (characters grouped per word in a `white-space: nowrap` `span[data-motion-word]`), each with `--mi` (its index) so the stagger is `calc(var(--mi) * stagger + delay)`; `split: 'children'` staggers the children.
- All animation rules are wrapped in `@media (prefers-reduced-motion: no-preference)`: with reduced motion the final design shows and an exit never hides content. Only the inline-block layout of split spans stays outside.
- Builds > 0: a small dependency-free script (html/tailwind: inline `<script>`; react: a `useEffect` in the root component, removed on unmount) plays the next build on click / ArrowRight / Space / PageDown. Without builds > 0 there is no script.
- Tailwind `animate-spin|ping|pulse|bounce`: the Tailwind export relies on Tailwind generating the keyframes; html and react inline get them from the base CSS when `cssBase: 'tailwind'`.

## Known limitations

- Tailwind: the mapping is per declaration. Arbitrary selectors and variants the model does not
  represent (`group-hover:`, `has-[...]:`, `aria-*:`, `[&_svg]:`) only survive as text in
  `node.classes` (with the engine they come out verbatim in Tailwind), with no corresponding CSS in the other formats.
  Shorthand properties with rare forms (`border-radius` with `/`, `border-color` with 4 values,
  `margin` with 5+ values) fall back to an arbitrary class or `rest`. Without the engine the classes follow the
  v4 documentation; with it the official compiler checks each one. Even with the engine, `shadow-sm`,
  color opacity (`bg-blue-500/50`), gradients and `ring-*` come out, without the `node.classes` hint, as an
  equivalent arbitrary class (`shadow-[...]`, `bg-[color-mix(...)]`) and not in the idiomatic form.
- States: in HTML they become rules in `<style>` (`.slug:hover`, `@media (min-width: 768px)`,
  `.slug:where([data-theme="dark"], [data-theme="dark"] *)`; breakpoints apply by the window width,
  not the frame's). In `inline` mode the base style stays in `style=""` and nodes with states get a
  class only for the state rules, which come out with `!important` (the inline `style` would win the
  cascade). States are not exported in inline React or in SVG.
- React: only known HTML attributes are emitted; custom tags (`my-element`) need a
  type declaration in the project; `selected`/`value` on `option` may produce React warnings.
  Repeat extraction is only for **consecutive** siblings and does not nest (inside an item, repeated
  children stay expanded).
- SVG with layout: `transform`, `z-index`, `inset box-shadow`, multiple shadows, radial/conic
  gradients, elliptical `border-radius` and per-side borders with a radius are not reproduced; text
  uses the approximate measured baseline and depends on the font existing where the SVG is opened (embed the font
  or convert it to outlines).
- SVG without layout: needs a browser with `foreignObject` support (it does not work in many vector
  editors) and the height is the declared one, not the measured one.
- Line breaks in `text` without a `white-space` that preserves them: in HTML/Tailwind they follow the CSS (they become a
  space); in React they become `<br />`.
