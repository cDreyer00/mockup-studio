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

/** Documento do kit shadcn-like com uma tela que usa Button, Card (slots) e Navbar. */
function tela(extra: Raw[] = []): Document {
  const doc = structuredClone(kit);
  doc.pages = [
    {
      id: 'pg_comp0001',
      name: 'Tela',
      background: '#fff',
      frames: [
        n('fr_comp0001', 'frame', 'div', {
          name: 'Tela de Pedido',
          style: { width: '800px', height: '600px', display: 'flex', 'flex-direction': 'column' },
          children: [
            n('in_btn00001', 'instance', 'button', {
              componentId: 'cp_sbutton1',
              props: { variant: 'outline', label: 'Salvar' },
            }),
            n('in_btn00002', 'instance', 'button', {
              componentId: 'cp_sbutton1',
              props: { size: 'lg' },
              style: { 'margin-top': '8px' },
            }),
            n('in_card0001', 'instance', 'div', {
              componentId: 'cp_scard001',
              props: { title: 'Pedido' },
              children: [
                slot('el_slotc001', 'content', [
                  n('tx_corpo001', 'text', 'p', { text: 'Corpo do cartão' }),
                ]),
                slot('el_slotf001', 'footer', [
                  n('in_btn00003', 'instance', 'button', {
                    componentId: 'cp_sbutton1',
                    props: { label: 'Confirmar' },
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

/* ---------------- compilação com tsc strict (como em react.test.ts) ---------------- */

const reactTypes = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../../node_modules/@types/react',
);

function compile(code: string): string[] {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mockup-react-comp-'));
  try {
    const file = path.join(dir, 'Componente.tsx');
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

/** Componente próprio com props de todos os tipos e `{{prop}}` em texto, atributo e estilo. */
function docComBadge(): Document {
  const doc = tela();
  doc.components = [
    ...(doc.components ?? []),
    {
      id: 'cp_badge0001',
      name: 'Badge',
      props: [
        { name: 'texto', type: 'string', default: 'Novo' },
        { name: 'cor', type: 'color', default: '#ff0000' },
        { name: 'largura', type: 'number', default: 80 },
        { name: 'ativo', type: 'boolean', default: true },
        { name: 'nao-usada', type: 'string', default: 'x' },
      ],
      root: n('el_badge001', 'element', 'span', {
        attrs: { title: 'Selo {{texto}}' },
        style: {
          'background-color': '{{cor}}',
          width: 'calc({{largura}}px + 2px)',
          color: 'white',
        },
        children: [n('tx_badge001', 'text', 'span', { text: '{{texto}} ({{largura}}) {{ativo}}' })],
      }),
      variants: [
        {
          when: { ativo: false },
          overrides: {
            el_badge001: { style: { opacity: '0.5' } },
            tx_badge001: { text: 'inativo' },
          },
        },
      ],
    },
  ];
  doc.pages[0].frames[0].children.push(
    n('in_badge001', 'instance', 'span', {
      componentId: 'cp_badge0001',
      props: { texto: 'Olá', largura: 120, ativo: false },
    }),
  );
  return doc;
}

const comOverride = (): Document =>
  tela([
    n('in_over0001', 'instance', 'button', {
      componentId: 'cp_sbutton1',
      props: { label: 'Especial' },
      overrides: { tx_sbtnlabl: { style: { color: 'rgb(255, 0, 0)' } } },
    }),
  ]);

describe('export React com componentes', () => {
  it('snapshot com Tailwind e com estilos inline', () => {
    expect(exportReact(tela(), { nodeId: 'fr_comp0001' })).toMatchSnapshot();
    expect(exportReact(tela(), { nodeId: 'fr_comp0001', styles: 'inline' })).toMatchSnapshot();
  });

  it('um componente por principal usado, com interface de união de literais e padrões', () => {
    const { code } = exportReact(tela(), { nodeId: 'fr_comp0001' });
    expect(code).toContain('export interface ButtonProps {');
    expect(code).toContain(
      "variant?: 'default' | 'secondary' | 'outline' | 'ghost' | 'destructive';",
    );
    expect(code).toContain("size?: 'sm' | 'default' | 'lg';");
    expect(code).toContain('label?: string;');
    expect(code).toContain("variant = 'default',");
    expect(code).toContain("label = 'Botão',");
    expect(code).toContain('export function Button({');
    expect(code).toContain('}: ButtonProps) {');
    // só os principais usados (o Card usa Button no rodapé padrão); Input, Tabs etc. ficam de fora
    expect(code).toContain('export function Card({');
    expect(code).not.toContain('export function Input');
    expect(code).not.toContain('export function Tabs');
    // variantes viram condicionais por valor; props viram expressões
    expect(code).toContain("variant === 'outline'");
    expect(code).toContain('{label}');
  });

  it('instâncias viram JSX com props e slots', () => {
    const { code } = exportReact(tela(), { nodeId: 'fr_comp0001' });
    expect(code).toContain('<Button variant="outline" label="Salvar" />');
    expect(code).toContain('<Button size="lg" style={{ marginTop: \'8px\' }} />');
    // primeiro slot (content) como children, os demais como prop
    expect(code).toContain('        <p>Corpo do cartão</p>\n      </Card>');
    expect(code).toContain('footer={\n          <Button label="Confirmar" />\n        }');
    // `children` só para o primeiro slot; o conteúdo padrão é o fallback
    expect(code).toContain('content?: ReactNode;');
    expect(code).toContain('children?: ReactNode;');
    expect(code).toContain('{content ?? children ?? (');
    expect(code).toContain('{footer ?? (');
    expect(code).toContain('<Button size="sm" label="Ação" />'); // Button aninhado no principal
    expect(code).toContain('export default TelaDePedido;');
  });

  it('componentes aceitam className/style e mesclam na raiz', () => {
    const { code } = exportReact(tela(), { nodeId: 'fr_comp0001' });
    expect(code).toContain('className?: string;');
    expect(code).toContain('style?: CSSProperties;');
    expect(code).toContain('  className,\n  style,\n}: ButtonProps) {');
    expect(code).toContain("className,\n      ].filter(Boolean).join(' ')}");
    expect(code).toContain('style={style}');
  });

  it('inline: variantes dentro do style, com o style da instância por último', () => {
    const { code } = exportReact(tela(), { nodeId: 'fr_comp0001', styles: 'inline' });
    expect(code).toContain("borderWidth: variant === 'outline' ? '1px' : '0'");
    expect(code).toContain('...style');
  });

  it('o nome do componente não colide com o da tela exportada', () => {
    const { code, componentName } = exportReact(tela(), {
      nodeId: 'fr_comp0001',
      componentName: 'Button',
    });
    expect(componentName).toBe('Button');
    expect(code).toContain('export function Button2({');
    expect(code).toContain('export interface Button2Props {');
    expect(code).toContain('<Button2 variant="outline" label="Salvar" />');
    expect(code).toContain('export function Button() {');
    expect(compile(code)).toEqual([]);
  });

  it('instância com override interno sai expandida no lugar, com comentário', () => {
    const { code } = exportReact(comOverride(), { nodeId: 'fr_comp0001', styles: 'inline' });
    expect(code).toContain('{/* instância de Button com overrides */}');
    expect(code).toContain('Especial');
    expect(code).toContain("color: 'rgb(255, 0, 0)'");
    expect(code).not.toContain('label="Especial"');
    // as demais continuam componentes
    expect(code).toContain('<Button variant="outline" label="Salvar" />');
    expect(compile(code)).toEqual([]);
  });

  it('slot com estilo próprio na instância também sai expandido', () => {
    const doc = tela();
    const card = doc.pages[0].frames[0].children.find((c) => c.id === 'in_card0001')!;
    card.children[0].style = { padding: '4px' };
    const { code } = exportReact(doc, { nodeId: 'fr_comp0001' });
    expect(code).toContain('{/* instância de Card com overrides */}');
    expect(code).toContain('Corpo do cartão');
    expect(compile(code)).toEqual([]);
  });

  it('id virtual (nó interno de uma instância) exporta o nó expandido', () => {
    const r = exportReact(tela(), { nodeId: 'in_btn00001/tx_sbtnlabl', styles: 'inline' });
    expect(r.code).toContain('Salvar');
    expect(r.code).not.toContain('Props');
  });

  it('placeholders viram expressões; props não usadas ficam só na interface', () => {
    const { code } = exportReact(docComBadge(), { nodeId: 'fr_comp0001' });
    expect(code).toContain('texto?: string;');
    expect(code).toContain('cor?: string;');
    expect(code).toContain('largura?: number;');
    expect(code).toContain('ativo?: boolean;');
    expect(code).toContain('naoUsada?: string;');
    expect(code).toContain('largura = 80');
    expect(code).toContain('ativo = true');
    expect(code).not.toContain('naoUsada =');
    expect(code).toContain('title={`Selo ${texto}`}');
    expect(code).toContain('backgroundColor: cor');
    expect(code).toContain('width: `calc(${largura}px + 2px)`');
    expect(code).toContain('`${texto} (${largura}) ${ativo}`');
    expect(code).toContain("ativo === false ? 'inativo'");
    expect(code).toContain("ativo === false ? 'opacity-50' : ''");
    expect(code).toContain('<Badge texto="Olá" largura={120} ativo={false} />');
  });

  describe('compila com tsc strict', () => {
    it.each(['tailwind', 'inline'] as const)('tela com Button e Card (%s)', (styles) => {
      expect(compile(exportReact(tela(), { nodeId: 'fr_comp0001', styles }).code)).toEqual([]);
    });
    it.each(['tailwind', 'inline'] as const)(
      'props de todos os tipos e variantes (%s)',
      (styles) => {
        expect(compile(exportReact(docComBadge(), { nodeId: 'fr_comp0001', styles }).code)).toEqual(
          [],
        );
      },
    );
    it('todos os componentes do kit', () => {
      const doc = tela();
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

describe('HTML, Tailwind e SVG expandem as instâncias', () => {
  it('HTML: texto e estilo da variante outline', () => {
    const html = exportHtml(tela());
    expect(html).toContain('Salvar');
    expect(html).toContain('Corpo do cartão');
    expect(html).toContain('Confirmar');
    expect(html).toContain('border-color: var(--color-input);');
    expect(html).not.toContain('{{label}}');
  });

  it('Tailwind: classes da variante outline', () => {
    const html = exportTailwind(tela(), { fragment: true });
    expect(html).toContain('Salvar');
    expect(html).toContain('border-input');
    expect(html).toContain('Corpo do cartão');
    expect(html).not.toContain('{{label}}');
  });

  it('nós por id virtual são exportáveis', () => {
    const doc = tela();
    expect(exportHtml(doc, { nodeIds: ['in_btn00001/tx_sbtnlabl'], fragment: true })).toContain(
      'Salvar',
    );
    const tw = exportTailwind(doc, { nodeIds: ['in_btn00001'], fragment: true });
    expect(tw).toContain('Salvar');
    expect(tw).toContain('<button');
  });

  it('SVG (fallback sem layout) com instância', () => {
    const svg = exportSvg(tela(), { nodeId: 'in_btn00001' });
    expect(svg).toContain('<foreignObject');
    expect(svg).toContain('Salvar');
    expect(exportSvg(tela(), { nodeId: 'in_btn00001/tx_sbtnlabl' })).toContain('Salvar');
  });

  it('instância com override interno sai expandida', () => {
    const html = exportHtml(comOverride());
    expect(html).toContain('Especial');
    expect(html).toContain('color: rgb(255, 0, 0);');
  });
});
