/** MCP guide for the `import` topic (importing sites); lives here to avoid bloating `mcp/guides.ts`. */

export const IMPORT_GUIDE_INFO = {
  title: 'Guide: importing sites',
  description:
    'Extension vs import_url vs import_html, selector and width, Reference frame, cleanup_imported, tokens and limitations.',
};

export const IMPORT_GUIDE = `# Importing sites into the canvas

Turns a page (or a section) of an existing site into an editable frame: real HTML/CSS nodes with computed styles, images in \`assets/\` and fonts registered in the document.

## Which path to use

- **Browser extension** — the user opens the site already logged in, picks the element and sends it to Mockup Studio. It is the only way for pages behind a login or paywall, or with state (open menus, tabs).
- \`import_url({ url, selector?, width? })\` — the daemon opens the URL in an isolated window and captures it. Requires the render engine (desktop app or \`mockup serve --render\`); without it the tool explains and you use \`import_html\`.
- \`import_html({ html, css?, assets_base_url? })\` — for HTML you already have (pasted snippet, local file). With render it captures like import_url; without render it does a simple, less faithful conversion (no computed styles or fonts), and the frame gets the viewport height: adjust it.

## Selector and width

- \`selector\` limits the capture to one element (\`"header"\`, \`"#pricing"\`, \`".hero"\`); without it the whole page comes in. Separate sections give smaller trees that are easier to edit.
- \`width\` picks the site's breakpoint (320 to 3840; default 1440). For the same site at several sizes, import once per width (e.g. 1440, 768, 390) and name each frame with \`name\`.

## After importing

1. The result carries the frame id (\`fr_...\`), counts and warnings. Check with \`get_screenshot(frameId)\`.
2. Compare with the original: the capture comes along in a hidden frame called "Reference — <name>", to the right. To see it, use \`set_node_flags\` with \`hidden:false\` on that frame and \`get_screenshot\` (hide or delete it afterwards). \`reference:false\` does not attach the reference.
3. \`cleanup_imported(frameId)\` simplifies the tree: removes empty wrappers, unwraps unstyled divs, replaces a px width equal to the parent's with auto, and replaces the px height of blocks with content with min-height, so the content can grow (\`remove_empty\`, \`unwrap\` and \`fluid\` turn each rule on and off). It is one history entry: \`undo\` reverts it. Check the screenshot again.
4. Tokens: repeated colors and spacings become variables. Read with \`get_html\`/\`get_styles\`, group the most frequent values (brand color, text, background, radius) and define them with \`set_tokens\`; then replace the values with \`var(--...)\` using \`update_styles\` (see \`get_guide('design-system')\`).

## Where images and fonts go

- Saved document: images and fonts go to \`assets/\` and \`assets/fonts\`. Document with no path: images are embedded (data URL) and fonts are skipped (save the document and import again).
- \`url()\` backgrounds are embedded up to ~2 MB; above that the style points to the original URL (warning).

## Limitations

- Pages with login/paywall: use the extension (import_url opens a window with no session).
- \`canvas\`, \`video\`, \`iframe\` and maps become placeholders; content loaded by scripts after the capture may be missing. The selector is awaited for up to 5 s after load (1 s in \`import_html\` without \`assets_base_url\`, where JS is off); if it does not appear, the import fails with "Selector ... not found".
- A URL that answers 4xx/5xx is imported anyway (you get the error page) with the warning "The page responded HTTP <status>": check the URL before going on.
- Fonts from another domain without CORS may not come in the capture bytes; the daemon tries to download them by URL and warns when it fails (the family falls back to the system font).
- Animations, hover and dynamic states become the captured frame; \`position: sticky\`/\`fixed\` and background videos stay static.
- Limit of ~5000 nodes per import: use \`selector\` for smaller sections.
`;
