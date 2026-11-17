/** Ready-made examples for the scripts panel. */
export interface ScriptExample {
  id: string;
  label: string;
  code: string;
}

export const SCRIPT_EXAMPLES: ScriptExample[] = [
  {
    id: 'rename-texts',
    label: 'Rename texts in sequence',
    code: `// Renames all text nodes as "Item 1", "Item 2"...
const texts = doc.select('text');
texts.forEach((n, i) => {
  n.name = 'Item ' + (i + 1);
});
return texts.length + ' nodes renamed';
`,
  },
  {
    id: 'button-color',
    label: 'Change the button color',
    code: `// Changes the background of all <button>s (in the selection, if any; otherwise in the document).
const root = doc.selection()[0];
const buttons = root ? root.select('button') : doc.select('button');
buttons.forEach((b) => b.setStyle({ 'background-color': '#2563eb', color: '#ffffff' }));
return buttons.length + ' buttons updated';
`,
  },
  {
    id: 'list-frames',
    label: 'List frames and node count',
    code: `// Result: the name of each frame and how many direct children it has.
return doc.frames().map((f) => ({ frame: f.name, children: f.children.length }));
`,
  },
  {
    id: 'screenshot',
    label: 'Capture the selection',
    code: `// Generates an image of each selected node (shows up in the output).
const sel = doc.selection();
for (const n of sel) await doc.screenshot(n);
return sel.length + ' capture(s)';
`,
  },
];
