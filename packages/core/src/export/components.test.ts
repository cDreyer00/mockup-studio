import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { parseDocument } from '../schema.js';
import type { Document, Node } from '../types.js';
import { exportHtml } from './html.js';
import { exportReact } from './react.js';
import { exportSvg } from './svg.js';
import { exportTailwind } from './tailwind.js';

const kit = parseDocument(
  fs.readFileSync(new URL('../../../../kits/shadcn-like.mockup.json', import.meta.url), 'utf8'),
);

type Raw = Partial<Node> & { id: string };
const n = (id: string, type: Node['type'], tag: string, extra: Partial<Node> = {}): Node =>
  ({
    name: id,
    attrs: {},
    style: {},
    children: [],
    locked: false,
    hidden: false,
    ...extra,
    id,
    type,
    tag,
  }) as Node;

const slot = (id: string, name: string, children: Node[]): Node =>
  n(id, 'element', 'div', { attrs: { 'data-slot': name }, children });

/** shadcn-like kit document with a screen that uses Button, Card (slots) and Navbar. */
function screen(extra: Raw[] = []): Document {
  const doc = structuredClone(kit);
  doc.pages = [
    {
      id: 'pg_comp0001',
      name: 'Screen',
      background: '#fff',
      frames: [
        n('fr_comp0001', 'frame', 'div', {
          name: 'Order Screen',
          style: { width: '800px', height: '600px', display: 'flex', 'flex-direction': 'column' },
          children: [
            n('in_btn00001', 'instance', 'button', {
              componentId: 'cp_sbutton1',
              props: { variant: 'outline', label: 'Save' },
            }),
            n('in_btn00002', 'instance', 'button', {
              componentId: 'cp_sbutton1',
              props: { size: 'lg' },
              style: { 'margin-top': '8px' },
            }),
            n('in_card0001', 'instance', 'div', {
              componentId: 'cp_scard001',
              props: { title: 'Order' },
              children: [
                slot('el_slotc001', 'content', [
                  n('tx_corpo001', 'text', 'p', { text: 'Card body' }),
                ]),
                slot('el_slotf001', 'footer', [
                  n('in_btn00003', 'instance', 'button', {
                    componentId: 'cp_sbutton1',
                    props: { label: 'Confirm' },
                  }),
                ]),
              ],
            }),
            ...(extra as Node[]),
          ],
        }),
      ],
    },
  ];
  return doc;
}

/* ---------------- compilation with strict tsc (as in react.test.ts) ---------------- */

const reactTypes = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../../node_modules/@types/react',
);

function compile(code: string): string[] {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mockup-react-comp-'));
  try {
    const file = path.join(dir, 'Component.tsx');
    fs.writeFileSync(file, code);
    const program = ts.createProgram([file], {
      strict: true,
      noUnusedLocals: true,
      noUnusedParameters: true,
      noEmit: true,
      jsx: ts.JsxEmit.ReactJSX,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      target: ts.ScriptTarget.ES2022,
      lib: ['lib.es2022.d.ts', 'lib.dom.d.ts'],
      verbatimModuleSyntax: true,
      skipLibCheck: true,
      types: [],
      baseUrl: dir,
      paths: {
        react: [path.join(reactTypes, 'index.d.ts')],
        'react/jsx-runtime': [path.join(reactTypes, 'jsx-runtime.d.ts')],
      },
    });
    return ts
      .getPreEmitDiagnostics(program)
      .map((d) => ts.flattenDiagnosticMessageText(d.messageText, '\n'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** Custom component with props of every type and `{{prop}}` in text, attribute and style. */
function docWithBadge(): Document {
  const doc = screen();
  doc.components = [
    ...(doc.components ?? []),
    {
      id: 'cp_badge0001',
      name: 'Badge',
      props: [
        { name: 'text', type: 'string', default: 'New' },
        { name: 'color', type: 'color', default: '#ff0000' },
        { name: 'width', type: 'number', default: 80 },
        { name: 'active', type: 'boolean', default: true },
        { name: 'unused-prop', type: 'string', default: 'x' },
      ],
      root: n('el_badge001', 'element', 'span', {
        attrs: { title: 'Badge {{text}}' },
        style: {
          'background-color': '{{color}}',
          width: 'calc({{width}}px + 2px)',
          color: 'white',
        },
        children: [n('tx_badge001', 'text', 'span', { text: '{{text}} ({{width}}) {{active}}' })],
      }),
      variants: [
        {
          when: { active: false },
          overrides: {
            el_badge001: { style: { opacity: '0.5' } },
            tx_badge001: { text: 'inactive' },
          },
        },
      ],
    },
  ];
  doc.pages[0].frames[0].children.push(
    n('in_badge001', 'instance', 'span', {
      componentId: 'cp_badge0001',
      props: { text: 'Hello', width: 120, active: false },
    }),
  );
  return doc;
}

const withOverride = (): Document =>
  screen([
    n('in_over0001', 'instance', 'button', {
      componentId: 'cp_sbutton1',
      props: { label: 'Special' },
      overrides: { tx_sbtnlabl: { style: { color: 'rgb(255, 0, 0)' } } },
    }),
  ]);

describe('React export with components', () => {
  it('snapshot with Tailwind and with inline styles', () => {
    expect(exportReact(screen(), { nodeId: 'fr_comp0001' })).toMatchSnapshot();
    expect(exportReact(screen(), { nodeId: 'fr_comp0001', styles: 'inline' })).toMatchSnapshot();
  });

  it('one component per main component used, with a literal-union interface and defaults', () => {
    const { code } = exportReact(screen(), { nodeId: 'fr_comp0001' });
    expect(code).toContain('export interface ButtonProps {');
    expect(code).toContain(
      "variant?: 'default' | 'secondary' | 'outline' | 'ghost' | 'destructive';",
    );
    expect(code).toContain("size?: 'sm' | 'default' | 'lg';");
    expect(code).toContain('label?: string;');
    expect(code).toContain("variant = 'default',");
    expect(code).toContain("label = 'Button',");
    expect(code).toContain('export function Button({');
    expect(code).toContain('}: ButtonProps) {');
    // only the main components used (Card uses Button in the default footer); Input, Tabs etc. are left out
    expect(code).toContain('export function Card({');
    expect(code).not.toContain('export function Input');
    expect(code).not.toContain('export function Tabs');
    // variants become value conditionals; props become expressions
    expect(code).toContain("variant === 'outline'");
    expect(code).toContain('{label}');
  });

  it('instances become JSX with props and slots', () => {
    const { code } = exportReact(screen(), { nodeId: 'fr_comp0001' });
    expect(code).toContain('<Button variant="outline" label="Save" />');
    expect(code).toContain('<Button size="lg" style={{ marginTop: \'8px\' }} />');
    // first slot (content) as children, the others as props
    expect(code).toContain('        <p>Card body</p>\n      </Card>');
    expect(code).toContain('footer={\n          <Button label="Confirm" />\n        }');
    // `children` only for the first slot; the default content is the fallback
    expect(code).toContain('content?: ReactNode;');
    expect(code).toContain('children?: ReactNode;');
    expect(code).toContain('{content ?? children ?? (');
    expect(code).toContain('{footer ?? (');
    expect(code).toContain('<Button size="sm" label="Action" />'); // Button nested in the main component
    expect(code).toContain('export default OrderScreen;');
  });

  it('components accept className/style and merge them on the root', () => {
    const { code } = exportReact(screen(), { nodeId: 'fr_comp0001' });
    expect(code).toContain('className?: string;');
    expect(code).toContain('style?: CSSProperties;');
    expect(code).toContain('  className,\n  style,\n}: ButtonProps) {');
    expect(code).toContain("className,\n      ].filter(Boolean).join(' ')}");
    expect(code).toContain('style={style}');
  });

  it('inline: variants inside style, with the instance style last', () => {
    const { code } = exportReact(screen(), { nodeId: 'fr_comp0001', styles: 'inline' });
    expect(code).toContain("borderWidth: variant === 'outline' ? '1px' : '0'");
    expect(code).toContain('...style');
  });

  it('the component name does not clash with the exported screen name', () => {
    const { code, componentName } = exportReact(screen(), {
      nodeId: 'fr_comp0001',
      componentName: 'Button',
    });
    expect(componentName).toBe('Button');
    expect(code).toContain('export function Button2({');
    expect(code).toContain('export interface Button2Props {');
    expect(code).toContain('<Button2 variant="outline" label="Save" />');
    expect(code).toContain('export function Button() {');
    expect(compile(code)).toEqual([]);
  });

  it('an instance with an inner override is emitted expanded in place, with a comment', () => {
    const { code } = exportReact(withOverride(), { nodeId: 'fr_comp0001', styles: 'inline' });
    expect(code).toContain('{/* instance of Button with overrides */}');
    expect(code).toContain('Special');
    expect(code).toContain("color: 'rgb(255, 0, 0)'");
    expect(code).not.toContain('label="Special"');
    // the others remain components
    expect(code).toContain('<Button variant="outline" label="Save" />');
    expect(compile(code)).toEqual([]);
  });

  it('a slot with its own style on the instance is also emitted expanded', () => {
    const doc = screen();
    const card = doc.pages[0].frames[0].children.find((c) => c.id === 'in_card0001')!;
    card.children[0].style = { padding: '4px' };
    const { code } = exportReact(doc, { nodeId: 'fr_comp0001' });
    expect(code).toContain('{/* instance of Card with overrides */}');
    expect(code).toContain('Card body');
    expect(compile(code)).toEqual([]);
  });

  it('a virtual id (inner node of an instance) exports the expanded node', () => {
    const r = exportReact(screen(), { nodeId: 'in_btn00001/tx_sbtnlabl', styles: 'inline' });
    expect(r.code).toContain('Save');
    expect(r.code).not.toContain('Props');
  });

  it('placeholders become expressions; unused props stay only in the interface', () => {
    const { code } = exportReact(docWithBadge(), { nodeId: 'fr_comp0001' });
    expect(code).toContain('text?: string;');
    expect(code).toContain('color?: string;');
    expect(code).toContain('width?: number;');
    expect(code).toContain('active?: boolean;');
    expect(code).toContain('unusedProp?: string;');
    expect(code).toContain('width = 80');
    expect(code).toContain('active = true');
    expect(code).not.toContain('unusedProp =');
    expect(code).toContain('title={`Badge ${text}`}');
    expect(code).toContain('backgroundColor: color');
    expect(code).toContain('width: `calc(${width}px + 2px)`');
    expect(code).toContain('`${text} (${width}) ${active}`');
    expect(code).toContain("active === false ? 'inactive'");
    expect(code).toContain("active === false ? 'opacity-50' : ''");
    expect(code).toContain('<Badge text="Hello" width={120} active={false} />');
  });

  describe('compiles with strict tsc', () => {
    it.each(['tailwind', 'inline'] as const)('screen with Button and Card (%s)', (styles) => {
      expect(compile(exportReact(screen(), { nodeId: 'fr_comp0001', styles }).code)).toEqual([]);
    });
    it.each(['tailwind', 'inline'] as const)('props of every type and variants (%s)', (styles) => {
      expect(compile(exportReact(docWithBadge(), { nodeId: 'fr_comp0001', styles }).code)).toEqual(
        [],
      );
    });
    it('all kit components', () => {
      const doc = screen();
      const frame = doc.pages[0].frames[0];
      for (const [i, c] of (doc.components ?? []).entries()) {
        frame.children.push(
          n(`in_kit${String(i).padStart(5, '0')}`, 'instance', 'div', { componentId: c.id }),
        );
      }
      const { code } = exportReact(doc, { nodeId: 'fr_comp0001' });
      expect(code).toContain('export function Tabs({');
      expect(compile(code)).toEqual([]);
    });
  });
});

/** Link component with `<a href="{{url}}">` and one instance (with `javascript:` in the prop). */
function docWithLink(url: string | undefined): Document {
  const doc = screen();
  doc.components = [
    ...(doc.components ?? []),
    {
      id: 'cp_link00001',
      name: 'Link',
      props: [{ name: 'url', type: 'string', default: '/home' }],
      root: n('el_link0001', 'element', 'a', {
        attrs: { href: url === undefined ? '/fixed' : '{{url}}' },
        children: [n('tx_link0001', 'text', 'span', { text: 'Go' })],
      }),
      variants: [],
    },
  ];
  doc.pages[0].frames[0].children.push(
    n('in_link0001', 'instance', 'a', {
      componentId: 'cp_link00001',
      props: url === undefined ? {} : { url },
    }),
  );
  return doc;
}

describe('URLs coming from props in the React export', () => {
  it.each(['tailwind', 'inline'] as const)(
    'href with {{url}} uses safeUrl and compiles (%s)',
    (styles) => {
      const { code } = exportReact(docWithLink('javascript:alert(1)'), {
        nodeId: 'fr_comp0001',
        styles,
      });
      expect(code).toContain('href={safeUrl(url)}');
      expect(code.match(/function safeUrl\(/g)).toHaveLength(1);
      expect(code).toContain("startsWith('javascript:')");
      expect(code).toContain(String.raw`[\s\u0000-\u001f]`);
      expect(compile(code)).toEqual([]);
    },
  );

  it('the instance javascript: prop only appears as a prop value, never in a raw href', () => {
    const { code } = exportReact(docWithLink('javascript:alert(1)'), { nodeId: 'fr_comp0001' });
    expect(code).toContain('<Link url="javascript:alert(1)" />');
    expect(code).not.toMatch(/href="javascript:/);
    expect(code).not.toContain('href={url}');
  });

  it('without a URL attribute with a placeholder there is no helper', () => {
    const { code } = exportReact(docWithLink(undefined), { nodeId: 'fr_comp0001' });
    expect(code).toContain('href="/fixed"');
    expect(code).not.toContain('safeUrl');
    expect(compile(code)).toEqual([]);
  });

  it('an unsafe literal href is dropped by the existing sanitization', () => {
    const doc = docWithLink(undefined);
    doc.pages[0].frames[0].children.push(
      n('el_lit00001', 'element', 'a', { attrs: { href: 'javascript:alert(1)' } }),
    );
    const { code } = exportReact(doc, { nodeId: 'fr_comp0001' });
    expect(code).not.toContain('javascript:');
  });
});

describe('HTML, Tailwind and SVG expand the instances', () => {
  it('HTML: text and style of the outline variant', () => {
    const html = exportHtml(screen());
    expect(html).toContain('Save');
    expect(html).toContain('Card body');
    expect(html).toContain('Confirm');
    expect(html).toContain('border-color: var(--color-input);');
    expect(html).not.toContain('{{label}}');
  });

  it('Tailwind: classes of the outline variant', () => {
    const html = exportTailwind(screen(), { fragment: true });
    expect(html).toContain('Save');
    expect(html).toContain('border-input');
    expect(html).toContain('Card body');
    expect(html).not.toContain('{{label}}');
  });

  it('nodes by virtual id are exportable', () => {
    const doc = screen();
    expect(exportHtml(doc, { nodeIds: ['in_btn00001/tx_sbtnlabl'], fragment: true })).toContain(
      'Save',
    );
    const tw = exportTailwind(doc, { nodeIds: ['in_btn00001'], fragment: true });
    expect(tw).toContain('Save');
    expect(tw).toContain('<button');
  });

  it('SVG (layout-less fallback) with an instance', () => {
    const svg = exportSvg(screen(), { nodeId: 'in_btn00001' });
    expect(svg).toContain('<foreignObject');
    expect(svg).toContain('Save');
    expect(exportSvg(screen(), { nodeId: 'in_btn00001/tx_sbtnlabl' })).toContain('Save');
  });

  it('an instance with an inner override is emitted expanded', () => {
    const html = exportHtml(withOverride());
    expect(html).toContain('Special');
    expect(html).toContain('color: rgb(255, 0, 0);');
  });
});
