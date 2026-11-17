/**
 * Componentes no MCP (ver `docs/COMPONENTES.md`): biblioteca do documento, kits, instâncias com
 * props/slots/overrides e edição do principal. A lógica de domínio (expansão, ops, planejadores) é do
 * core; aqui ficam a validação com mensagens acionáveis, o HTML (com Tailwind) de slots e do principal
 * e o resumo devolvido ao agente.
 */
import { z } from 'zod';
import {
  applyOps,
  createComponentOps,
  detachInstanceOps,
  expandNodeTree,
  findComponent,
  findComponentNode,
  findInstanceNode,
  getComponent,
  getTreeSummary,
  htmlToNodes,
  importKitOps,
  inferProps,
  instanceNodeFor,
  isVirtualId,
  listInstances,
  mergeOverride,
  nodesToHtml,
  placeholderNames,
  pushOverridesToMainOps,
  resetInstanceOps,
  slotNames,
  walk,
  type ComponentDef,
  type ComponentVariant,
  type Document,
  type Node,
  type NodeOverride,
  type Op,
  type PropDef,
  type PropInput,
} from '@mockup/core';
import {
  applyTailwindToNodes,
  detectTailwind,
  getTailwindEngine,
  type TailwindReport,
} from '@mockup/core/tailwind';
import { resolveRead } from '../../component-view.js';
import { KitError, listKits, loadKit, type LoadedKit } from '../../kits.js';
import { READ, ToolError, WRITE, DESTRUCTIVE, docIdField, type ToolContext } from '../context.js';
import { reportLines } from './tailwind.js';

const propValueSchema = z.union([z.string(), z.number(), z.boolean()]);

const propDefSchema = z.object({
  name: z.string().describe('Nome da prop (letras, números e _), ex.: "label".'),
  type: z
    .enum(['string', 'number', 'boolean', 'enum', 'color', 'slot'])
    .describe('Tipo da prop: string, number, boolean, enum, color ou slot.'),
  default: propValueSchema.optional().describe('Valor padrão (slots não têm), ex.: "Enviar".'),
  options: z.array(z.string()).optional().describe('Opções do enum, ex.: ["sm", "md", "lg"].'),
  description: z.string().optional().describe('Descrição curta da prop.'),
});

const bindSchema = z
  .object({
    nodeId: z.string().describe('Id do nó (dentro do nó do componente) cujo valor vira a prop.'),
    target: z
      .string()
      .describe('O que vira {{prop}}: "text", "attr:<nome>" (ex.: "attr:href") ou "style:<prop>".'),
  })
  .describe(
    'Liga a prop a um valor do nó: o valor atual vira o padrão e o nó passa a usar {{nome}}.',
  );

const nodeOverrideSchema = z.object({
  style: z.record(z.string(), z.string()).optional().describe('Estilos CSS mesclados.'),
  unsetStyle: z.array(z.string()).optional().describe('Propriedades CSS removidas do principal.'),
  text: z.string().optional().describe('Texto do nó.'),
  attrs: z.record(z.string(), z.string()).optional().describe('Atributos HTML mesclados.'),
  hidden: z.boolean().optional().describe('Oculta o nó.'),
});

const variantSchema = z.object({
  when: z
    .record(z.string(), propValueSchema)
    .describe('Props que precisam bater, ex.: { "variant": "outline" }.'),
  overrides: z
    .record(z.string(), nodeOverrideSchema)
    .describe('Sobrescritas por id de nó do principal; chave "" = raiz. Aplicadas em ordem.'),
});

const fmtProp = (p: PropDef): string => {
  const t = p.type === 'enum' ? `enum(${(p.options ?? []).join('|')})` : p.type;
  const d = p.default !== undefined && p.default !== '' ? `=${JSON.stringify(p.default)}` : '';
  return `${p.name}:${t}${d}`;
};

const propsLine = (def: { props: PropDef[] }): string =>
  def.props.length ? def.props.map(fmtProp).join(', ') : '(sem props)';

const MAX_HTML_CHARS = 6000;

/** "3 instância(s)" nas páginas, mais as que estão dentro de outros componentes (ex.: botão no rodapé do Card). */
function instanceCount(doc: Document, componentId: string): string {
  const all = listInstances(doc, componentId);
  const nested = all.filter((i) => i.ownerComponentId).length;
  return `${all.length - nested} instância(s)${nested ? ` (+${nested} dentro de outros componentes)` : ''}`;
}

/** HTML (com Tailwind, se houver) → nós sem aplicar nada no documento. */
async function htmlToNodesTw(
  doc: Document,
  html: string,
  tailwind: 'auto' | 'on' | 'off' | undefined,
): Promise<{ nodes: Node[]; tailwind: boolean; report?: TailwindReport }> {
  const mode = tailwind ?? 'auto';
  let engine = undefined as Awaited<ReturnType<typeof getTailwindEngine>> | undefined;
  let use = mode === 'on';
  if (mode === 'auto' && /\bclass\s*=/i.test(html)) {
    engine = await getTailwindEngine(doc);
    use = detectTailwind(html, engine, '').tailwind;
  }
  if (!use) return { nodes: htmlToNodes(html), tailwind: false };
  const nodes = htmlToNodes(html, { keepClasses: true });
  engine ??= await getTailwindEngine(doc);
  const shadcn = '--color-border' in doc.tokens && '--color-primary' in doc.tokens;
  const report = applyTailwindToNodes(nodes, engine, {
    ...(shadcn ? { defaultBorderColor: 'var(--color-border)' } : {}),
  });
  return { nodes, tailwind: true, report };
}

function variantsLine(v: ComponentVariant): string {
  const when = Object.entries(v.when)
    .map(([k, x]) => `${k}=${String(x)}`)
    .join(', ');
  const parts = Object.entries(v.overrides).map(([path, ov]) => {
    const keys = [
      ...Object.keys(ov.style ?? {}),
      ...(ov.text !== undefined ? ['text'] : []),
      ...(ov.hidden !== undefined ? ['hidden'] : []),
      ...Object.keys(ov.attrs ?? {}).map((a) => `attr:${a}`),
    ];
    return `${path === '' ? 'raiz' : path}{${keys.join(',')}}`;
  });
  return `quando ${when}: ${parts.join(' ') || '(sem overrides)'}`;
}

export function registerComponentTools(ctx: ToolContext): void {
  const { tool, store, requireNode, apply, summaryOf, selectedOrFirstFrame } = ctx;

  const componentNotFound = (doc: Document, ref: string): ToolError => {
    const names = (doc.components ?? []).map((c) => c.name);
    const kits = listKits().flatMap((k) => k.components.map((c) => `${k.name}/${c.name}`));
    return new ToolError(
      `Componente "${ref}" não encontrado. No documento: ${names.length ? names.join(', ') : '(nenhum)'}. ` +
        `Use list_components para ver a biblioteca e os kits${kits.length ? ` (ex.: insert_component("${kits[0]}"))` : ''}.`,
    );
  };
  const requireComponent = (doc: Document, ref: string): ComponentDef => {
    const def = findComponent(doc, ref);
    if (!def) throw componentNotFound(doc, ref);
    return def;
  };

  const kitOrThrow = (nameOrPath: string): LoadedKit => {
    try {
      return loadKit(nameOrPath);
    } catch (e) {
      if (e instanceof KitError) throw new ToolError(e.message);
      throw e;
    }
  };

  /** Instância (real ou aninhada, por id virtual) ou erro dizendo como achar uma. */
  const requireInstance = (doc: Document, id: string): Node => {
    const real = findInstanceNode(doc, id);
    if (real) return real;
    const n = isVirtualId(id) ? resolveRead(doc, id)?.path.node : undefined;
    if (n?.componentId) return n;
    if (!resolveRead(doc, id) && !requireNodeSafe(doc, id)) {
      throw new ToolError(
        `Nó não encontrado: "${id}". Use get_tree_summary (instâncias aparecem como ◆Nome) ou insert_component para criar uma.`,
      );
    }
    throw new ToolError(
      `O nó "${id}" não é uma instância de componente. Instâncias aparecem como ◆Nome no get_tree_summary; para criar uma use insert_component, para transformar este nó em componente use create_component.`,
    );
  };
  const requireNodeSafe = (doc: Document, id: string): boolean => {
    try {
      requireNode(doc, id);
      return true;
    } catch {
      return false;
    }
  };

  /* ---------- leitura ---------- */

  tool(
    'list_components',
    {
      title: 'Listar componentes',
      description:
        'Biblioteca de componentes do documento (id, nome, kit, props, nº de instâncias) e os kits disponíveis com seus componentes. Insira com insert_component; importe um kit com import_kit.',
      example: {},
      inputSchema: { docId: docIdField },
      annotations: READ,
    },
    ({ docId }) => {
      const doc = store.get(store.resolveDocId(docId));
      const lines: string[] = [];
      const list = doc.components ?? [];
      lines.push(`Componentes do documento (${list.length}):`);
      for (const c of list) {
        lines.push(
          `- ${c.id} "${c.name}"${c.kit ? ` [kit ${c.kit}]` : ''} — ${instanceCount(doc, c.id)} | props: ${propsLine(c)}`,
        );
        if (c.description) lines.push(`    ${c.description}`);
      }
      if (!list.length)
        lines.push(
          '(nenhum) Crie com create_component(nodeId) ou importe um kit com import_kit("shadcn-like").',
        );
      const kits = listKits();
      lines.push(`Kits disponíveis (${kits.length}):`);
      for (const k of kits) {
        lines.push(`- ${k.name}:`);
        for (const c of k.components) {
          const slots = c.props.filter((p) => p.type === 'slot').map((p) => p.name);
          const props = c.props.filter((p) => p.type !== 'slot').map((p) => p.name);
          lines.push(
            `    ${k.name}/${c.name} (${props.join(', ') || 'sem props'}${slots.length ? `; slots: ${slots.join(', ')}` : ''})${c.description ? ` — ${c.description}` : ''}`,
          );
        }
      }
      lines.push('Detalhes de um componente: get_component(nome ou "kit/Nome").');
      return lines.join('\n');
    },
  );

  tool(
    'get_component',
    {
      title: 'Detalhes de um componente',
      description:
        'Props (tipos, padrões, opções), slots, variantes, árvore do principal com ids (edite-os com update_styles/set_text) e HTML. Aceita id, nome ou "kit/Nome" (também de um kit ainda não importado).',
      example: { component: 'shadcn-like/Button' },
      inputSchema: {
        component: z
          .string()
          .describe('Id (cp_...), nome ("Button") ou "kit/Nome" ("shadcn-like/Button").'),
        docId: docIdField,
      },
      annotations: READ,
    },
    ({ component, docId }) => {
      const doc = store.get(store.resolveDocId(docId));
      let def = findComponent(doc, component);
      let source = doc;
      let fromKit: string | undefined;
      if (!def) {
        const slash = component.lastIndexOf('/');
        const kits = listKits();
        const kitName = slash > 0 ? component.slice(0, slash) : undefined;
        const compName = (slash > 0 ? component.slice(slash + 1) : component).toLowerCase();
        for (const k of kits) {
          if (kitName && k.name.toLowerCase() !== kitName.toLowerCase()) continue;
          const hit = k.components.find(
            (c) => c.name.toLowerCase() === compName || c.id === component,
          );
          if (hit) {
            const kit = kitOrThrow(k.name);
            def = (kit.doc.components ?? []).find((c) => c.id === hit.id);
            source = kit.doc;
            fromKit = k.name;
            break;
          }
        }
      }
      if (!def) throw componentNotFound(doc, component);

      const lines: string[] = [];
      lines.push(
        `${def.id} "${def.name}"${def.kit || fromKit ? ` [kit ${def.kit ?? fromKit}]` : ''} — ${fromKit ? '0 instância(s)' : instanceCount(doc, def.id)}`,
      );
      if (fromKit)
        lines.push(
          `(ainda não está no documento; insert_component("${fromKit}/${def.name}") ou import_kit("${fromKit}") importa.)`,
        );
      if (def.description) lines.push(def.description);
      lines.push('Props:');
      for (const p of def.props) {
        const detail =
          p.type === 'enum'
            ? `enum, opções: ${(p.options ?? []).join(' | ')}`
            : p.type === 'slot'
              ? 'slot (HTML em insert_component.slots)'
              : p.type;
        lines.push(
          `- ${p.name}: ${detail}${p.default !== undefined ? `, padrão ${JSON.stringify(p.default)}` : ''}${p.description ? ` — ${p.description}` : ''}`,
        );
      }
      if (!def.props.length) lines.push('(nenhuma)');
      if (def.variants.length) {
        lines.push('Variantes:');
        for (const v of def.variants) lines.push(`- ${variantsLine(v)}`);
      }
      lines.push(
        'Árvore do principal (ids editáveis com update_styles, set_text...; mudam todas as instâncias):',
        getTreeSummary(def.root, 5, { doc: source }),
      );
      const html = nodesToHtml([expandNodeTree(source, def.root)], { mode: 'inline' }).html;
      lines.push(
        'HTML do principal ({{prop}} = valor da prop):',
        html.length > MAX_HTML_CHARS ? `${html.slice(0, MAX_HTML_CHARS)}\n… (truncado)` : html,
      );
      return lines.join('\n');
    },
  );

  /* ---------- principal ---------- */

  tool(
    'create_component',
    {
      title: 'Criar componente',
      description:
        'Transforma um nó (não frame) em componente: o nó vira a primeira instância. props declara as props; bind liga uma prop ao texto, atributo ou estilo de um nó interno ({{nome}}). data-slot cria slots.',
      example: {
        nodeId: 'el_ab12cd34',
        name: 'PrimaryButton',
        props: [{ name: 'label', type: 'string', bind: { nodeId: 'tx_9f8e7d6c', target: 'text' } }],
      },
      inputSchema: {
        nodeId: z
          .string()
          .describe('Id do nó das páginas que vira componente, ex.: "el_ab12cd34".'),
        name: z
          .string()
          .optional()
          .describe('Nome do componente em PascalCase, ex.: "PrimaryButton".'),
        description: z.string().optional().describe('Descrição para agentes e para o painel.'),
        props: z
          .array(propDefSchema.extend({ bind: bindSchema.optional() }))
          .optional()
          .describe(
            'Props, ex.: [{ "name": "label", "type": "string", "bind": { "nodeId": "tx_1", "target": "text" } }].',
          ),
        docId: docIdField,
      },
      annotations: WRITE,
    },
    ({ nodeId, name, description, props, docId }) => {
      const id = store.resolveDocId(docId);
      const doc = store.get(id);
      requireNode(doc, nodeId);
      const { ops, componentId, instanceId } = createComponentOps(doc, nodeId, {
        name,
        description,
        props: props as PropInput[] | undefined,
      });
      const r = apply(id, ops, 'create_component');
      const def = getComponent(r.doc, componentId)!;
      return `Componente criado: ${componentId} "${def.name}" (props: ${propsLine(def)}). O nó virou a instância ${instanceId}.\n${summaryOf(r.doc, [instanceId])}\nEdite o principal com update_styles/set_text nos ids do get_component, ou update_component_html.`;
    },
  );

  tool(
    'update_component',
    {
      title: 'Atualizar componente',
      description:
        'Altera nome, descrição, props (a lista inteira substitui a atual) e variantes (when + overrides por id de nó do principal, "" = raiz). Veja get_component antes. Propaga para as instâncias.',
      example: {
        componentId: 'cp_ab12cd34',
        variants: [
          {
            when: { variant: 'outline' },
            overrides: { '': { style: { background: 'transparent' } } },
          },
        ],
      },
      inputSchema: {
        componentId: z
          .string()
          .describe('Id, nome ou "kit/Nome" do componente, ex.: "cp_ab12cd34".'),
        name: z.string().optional().describe('Novo nome, ex.: "PrimaryButton".'),
        description: z
          .string()
          .optional()
          .describe('Nova descrição ("" remove), ex.: "Botão de ação principal".'),
        props: z
          .array(propDefSchema)
          .optional()
          .describe(
            'Lista completa de props (substitui a atual), ex.: [{ "name": "label", "type": "string", "default": "Ok" }].',
          ),
        variants: z
          .array(variantSchema)
          .optional()
          .describe('Lista completa de variantes (substitui a atual).'),
        docId: docIdField,
      },
      annotations: WRITE,
    },
    ({ componentId, name, description, props, variants, docId }) => {
      const id = store.resolveDocId(docId);
      const doc = store.get(id);
      const def = requireComponent(doc, componentId);
      if (name === undefined && description === undefined && !props && !variants)
        throw new ToolError(
          'Informe ao menos um de name, description, props ou variants. Ex.: name "PrimaryButton".',
        );
      const op: Op = {
        type: 'updateComponent',
        componentId: def.id,
        ...(name !== undefined ? { name } : {}),
        ...(description !== undefined
          ? { description: description === '' ? null : description }
          : {}),
        ...(props ? { props: props as PropDef[] } : {}),
        ...(variants ? { variants: variants as ComponentVariant[] } : {}),
      };
      const r = apply(id, [op], 'update_component');
      const next = getComponent(r.doc, def.id)!;
      return `Componente ${def.id} atualizado: "${next.name}" | props: ${propsLine(next)} | ${next.variants.length} variante(s) | ${instanceCount(r.doc, def.id)}.`;
    },
  );

  tool(
    'update_component_html',
    {
      title: 'Substituir o principal por HTML',
      description:
        'Substitui a árvore do principal por HTML (um único elemento raiz; classes Tailwind compiladas como em write_html). Mantenha {{prop}} e data-slot="nome"; props/slots novos são criados. Overrides em ids antigos perdem efeito.',
      example: {
        componentId: 'cp_ab12cd34',
        html: '<button style="padding:8px 16px;border-radius:6px;background:var(--color-primary)">{{label}}</button>',
      },
      inputSchema: {
        componentId: z
          .string()
          .describe('Id, nome ou "kit/Nome" do componente, ex.: "cp_ab12cd34".'),
        html: z
          .string()
          .describe('HTML do principal, um elemento raiz, ex.: "<button>{{label}}</button>".'),
        tailwind: z
          .enum(['auto', 'on', 'off'])
          .optional()
          .describe('Classes Tailwind: "auto" (padrão) detecta, "on" força, "off" trata como CSS.'),
        docId: docIdField,
      },
      annotations: DESTRUCTIVE,
    },
    async ({ componentId, html, tailwind, docId }) => {
      const id = store.resolveDocId(docId);
      const doc = store.get(id);
      const def = requireComponent(doc, componentId);
      const { nodes, tailwind: usedTw, report } = await htmlToNodesTw(doc, html, tailwind);
      if (nodes.length !== 1)
        throw new ToolError(
          `O HTML do principal precisa de um único elemento raiz (recebi ${nodes.length}); envolva tudo em um <div>. Ex.: "<button>{{label}}</button>".`,
        );
      const root = nodes[0]!;
      delete root.position;
      root.name = def.root.name;

      // props: `{{x}}` e `data-slot` do HTML sem prop correspondente são criados; avisa o que sobra
      const inferred = inferProps(root);
      const have = new Set(def.props.map((p) => p.name));
      const added = inferred.filter((p) => !have.has(p.name));
      const props = [...def.props, ...added];
      const usedNames = new Set(inferred.map((p) => p.name));
      for (const v of def.variants) for (const k of Object.keys(v.when)) usedNames.add(k);
      walk(root, (n) => {
        for (const v of Object.values(n.props ?? {}))
          if (typeof v === 'string') for (const p of placeholderNames(v)) usedNames.add(p);
      });
      const unused = props.filter((p) => !usedNames.has(p.name)).map((p) => p.name);

      const ops: Op[] = [];
      if (usedTw && doc.cssBase !== 'tailwind') ops.push({ type: 'setCssBase', base: 'tailwind' });
      ops.push({
        type: 'updateComponent',
        componentId: def.id,
        root,
        ...(added.length ? { props } : {}),
      });
      const r = apply(id, ops, 'update_component_html');
      const lines = [
        `Principal de "${def.name}" (${def.id}) substituído; atualizadas: ${instanceCount(r.doc, def.id)}. Novo id da raiz: ${root.id}.`,
        ...(usedTw
          ? [
              `Classes Tailwind compiladas (${report?.nodes ?? 0} nó(s)).`,
              ...(report ? reportLines(report) : []),
            ]
          : []),
      ];
      if (added.length)
        lines.push(
          `Props criadas a partir do HTML: ${added.map(fmtProp).join(', ')} (ajuste com update_component).`,
        );
      if (unused.length)
        lines.push(
          `Aviso: props sem uso no HTML (nem em variantes): ${unused.join(', ')}. Use {{nome}} ou remova com update_component.`,
        );
      lines.push(
        'Os nós têm ids novos: overrides de instâncias nos ids antigos ficam sem efeito (reset_instance limpa).',
        summaryOf(r.doc, [root.id]),
      );
      return lines.join('\n');
    },
  );

  tool(
    'delete_component',
    {
      title: 'Excluir componente',
      description:
        'Remove o principal (reversível com undo). Recusa se houver instâncias, a menos que detach_instances seja true (as instâncias viram nós comuns antes).',
      example: { componentId: 'cp_ab12cd34', detach_instances: true },
      inputSchema: {
        componentId: z
          .string()
          .describe('Id, nome ou "kit/Nome" do componente, ex.: "cp_ab12cd34".'),
        detach_instances: z
          .boolean()
          .optional()
          .describe(
            'true destaca as instâncias (viram nós comuns) antes de excluir. Padrão false.',
          ),
        docId: docIdField,
      },
      annotations: DESTRUCTIVE,
    },
    ({ componentId, detach_instances, docId }) => {
      const id = store.resolveDocId(docId);
      const doc = store.get(id);
      const def = requireComponent(doc, componentId);
      const instances = listInstances(doc, def.id);
      if (instances.length && !detach_instances)
        throw new ToolError(
          `O componente "${def.name}" tem ${instanceCount(doc, def.id)}. Use detach_instances: true para destacá-las (viram nós comuns) ou exclua/destaque-as antes.`,
        );
      const ops: Op[] = [];
      const detached: string[] = [];
      for (const inst of instances) {
        ops.push(...detachInstanceOps(doc, inst.node.id));
        detached.push(inst.node.id);
      }
      ops.push({ type: 'deleteComponent', componentId: def.id });
      const r = apply(id, ops, 'delete_component');
      return `Componente "${def.name}" (${def.id}) excluído${detached.length ? `; ${detached.length} instância(s) destacada(s) (${instanceCount(doc, def.id)})` : ''}.\n${getDocSummary(r.doc)}`;
    },
  );

  const getDocSummary = (doc: Document): string => summaryOf(doc, []);

  /* ---------- instâncias ---------- */

  tool(
    'insert_component',
    {
      title: 'Inserir componente',
      description:
        'Insere uma instância (id, nome ou "kit/Nome"; um kit ausente é importado na mesma entrada de histórico). props define valores; slots recebe HTML por slot ({ content: "<p>…</p>" }). Devolve o id da instância e dos slots.',
      example: {
        component: 'shadcn-like/Button',
        parentId: 'fr_ab12cd34',
        props: { variant: 'outline', label: 'Salvar' },
      },
      inputSchema: {
        component: z
          .string()
          .describe('Id (cp_...), nome ou "kit/Nome", ex.: "shadcn-like/Button".'),
        parentId: z
          .string()
          .optional()
          .describe(
            'Id do pai (ou contêiner de slot de outra instância), ex.: "fr_ab12cd34" (padrão: seleção ou primeiro frame).',
          ),
        props: z
          .record(z.string(), propValueSchema)
          .optional()
          .describe('Valores das props, ex.: { "variant": "outline", "label": "Salvar" }.'),
        slots: z
          .record(z.string(), z.string())
          .optional()
          .describe('HTML por slot (classes Tailwind aceitas), ex.: { "content": "<p>Olá</p>" }.'),
        index: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe('Posição entre os filhos, ex.: 0 (padrão: final).'),
        name: z.string().optional().describe('Nome da camada da instância, ex.: "Botão salvar".'),
        styles: z
          .record(z.string(), z.string())
          .optional()
          .describe('Estilos da raiz da instância (largura, margem...), ex.: { "width": "100%" }.'),
        docId: docIdField,
      },
      annotations: WRITE,
    },
    async ({ component, parentId, props, slots, index, name, styles, docId }) => {
      const id = store.resolveDocId(docId);
      const doc = store.get(id);
      const parent = parentId ?? selectedOrFirstFrame(id, doc);
      requireNode(doc, parent);

      // `kit/Nome` fora do documento: importa o kit na mesma entrada de histórico
      let def = findComponent(doc, component);
      let work = doc;
      const ops: Op[] = [];
      let imported = '';
      if (!def) {
        const slash = component.lastIndexOf('/');
        if (slash <= 0) {
          const kits = listKits();
          const hit = kits
            .flatMap((k) => k.components.map((c) => ({ kit: k.name, name: c.name })))
            .find((c) => c.name.toLowerCase() === component.trim().toLowerCase());
          throw hit
            ? new ToolError(
                `Componente "${component}" não está no documento. Use "${hit.kit}/${hit.name}" para importar do kit.`,
              )
            : componentNotFound(doc, component);
        }
        const kit = kitOrThrow(component.slice(0, slash));
        const compName = component
          .slice(slash + 1)
          .trim()
          .toLowerCase();
        const kc = (kit.doc.components ?? []).find(
          (c) => c.name.toLowerCase() === compName || c.id === component.slice(slash + 1),
        );
        if (!kc)
          throw new ToolError(
            `O kit "${kit.name}" não tem o componente "${component.slice(slash + 1)}". Componentes: ${(kit.doc.components ?? []).map((c) => c.name).join(', ')}.`,
          );
        const imp = importKitOps(doc, kit.doc, kit.name);
        ops.push(...imp.ops);
        work = applyOps(doc, imp.ops).doc;
        def = getComponent(work, kc.id);
        if (!def) throw componentNotFound(doc, component);
        imported = ` Kit "${kit.name}" importado (${imp.components.filter((c) => c.status !== 'unchanged').length} componente(s)${imp.tokensAdded.length ? `, ${imp.tokensAdded.length} token(s)` : ''}).`;
      }

      // slots: HTML → nós (Tailwind aceito, como em write_html)
      const slotNodes: Record<string, Node[]> = {};
      let usedTw = false;
      const valid = slotNames(def);
      for (const [slot, html] of Object.entries(slots ?? {})) {
        if (!valid.includes(slot))
          throw new ToolError(
            `O componente "${def.name}" não tem o slot "${slot}"${valid.length ? ` (slots: ${valid.join(', ')})` : ' (não tem slots)'}.`,
          );
        const r = await htmlToNodesTw(work, html, undefined);
        usedTw ||= r.tailwind;
        slotNodes[slot] = r.nodes;
      }
      if (usedTw && work.cssBase !== 'tailwind') ops.push({ type: 'setCssBase', base: 'tailwind' });

      const node = instanceNodeFor(work, def.id, {
        props,
        slots: slotNodes,
        name,
        style: styles,
      });
      ops.push({ type: 'createNode', parentId: parent, node, index });
      const r = apply(id, ops, 'insert_component');
      const slotIds = node.children.map((c) => `${c.attrs['data-slot']}=${c.id}`).join(', ');
      return [
        `Instância criada: ${node.id} de "${def.name}" em ${parent}.${imported}`,
        slotIds
          ? `Slots (use como parentId em write_html/insert_component): ${slotIds}.`
          : undefined,
        summaryOf(r.doc, [node.id]),
      ]
        .filter(Boolean)
        .join('\n');
    },
  );

  tool(
    'set_instance_props',
    {
      title: 'Definir props de instâncias',
      description:
        'Define e/ou remove props de uma ou mais instâncias (unset volta ao padrão). Valores são validados pelo tipo (enum só aceita as opções). Slots não são props: use write_html no contêiner do slot.',
      example: { nodeIds: ['in_ab12cd34'], set: { variant: 'secondary', label: 'Cancelar' } },
      inputSchema: {
        nodeIds: z.array(z.string()).min(1).describe('Ids das instâncias, ex.: ["in_ab12cd34"].'),
        set: z
          .record(z.string(), propValueSchema)
          .optional()
          .describe('Props a definir, ex.: { "variant": "secondary", "label": "Cancelar" }.'),
        unset: z.array(z.string()).optional().describe('Props a voltar ao padrão, ex.: ["label"].'),
        docId: docIdField,
      },
      annotations: WRITE,
    },
    ({ nodeIds, set, unset, docId }) => {
      const id = store.resolveDocId(docId);
      const doc = store.get(id);
      for (const n of nodeIds) requireInstance(doc, n);
      if (!set && !unset?.length)
        throw new ToolError('Informe set e/ou unset. Ex.: set { "variant": "outline" }.');
      const r = apply(
        id,
        [{ type: 'setInstanceProps', changes: nodeIds.map((nodeId) => ({ nodeId, set, unset })) }],
        'set_instance_props',
      );
      return `Props atualizadas em ${nodeIds.length} instância(s).\n${summaryOf(r.doc, nodeIds)}`;
    },
  );

  tool(
    'set_instance_override',
    {
      title: 'Sobrescrever um nó da instância',
      description:
        'Muda um nó interno só nesta instância (estilo, texto, atributos, oculto), mesclando no override existente. path = id do nó no principal ("" = raiz; instância aninhada: "in_x/tx_y"). Equivale a update_styles/set_text no id virtual.',
      example: {
        nodeId: 'in_ab12cd34',
        path: 'tx_9f8e7d6c',
        style: { color: '#dc2626' },
        text: 'Excluir',
      },
      inputSchema: {
        nodeId: z.string().describe('Id da instância, ex.: "in_ab12cd34".'),
        path: z
          .string()
          .describe(
            'Id do nó no principal, ex.: "tx_9f8e7d6c" ("" = raiz; aninhada: "in_ab12cd34/tx_9f8e7d6c"). Veja get_tree_summary da instância.',
          ),
        style: z
          .record(z.string(), z.string())
          .optional()
          .describe('Estilos CSS a mesclar, ex.: { "color": "#dc2626" }.'),
        unset_style: z
          .array(z.string())
          .optional()
          .describe('Propriedades CSS do principal a remover, ex.: ["border"].'),
        text: z.string().optional().describe('Texto do nó, ex.: "Excluir".'),
        attrs: z
          .record(z.string(), z.string())
          .optional()
          .describe('Atributos HTML a mesclar, ex.: { "href": "/inicio" }.'),
        hidden: z.boolean().optional().describe('true oculta o nó nesta instância.'),
        docId: docIdField,
      },
      annotations: WRITE,
    },
    ({ nodeId, path, style, unset_style, text, attrs, hidden, docId }) => {
      const id = store.resolveDocId(docId);
      const doc = store.get(id);
      const inst = findInstanceNode(doc, nodeId);
      if (!inst) {
        requireInstance(doc, nodeId); // lança o erro adequado se não for instância
        throw new ToolError(
          `"${nodeId}" é uma instância aninhada: edite-a com update_styles/set_text/set_instance_props neste id virtual, ou use set_instance_override na instância de fora (path "<id aninhado>/<nó>").`,
        );
      }
      const target = path === '' ? nodeId : `${nodeId}/${path}`;
      if (!resolveRead(doc, target)) {
        const tree = resolveRead(doc, nodeId);
        throw new ToolError(
          `O caminho "${path}" não existe nesta instância. Use o id de um nó do principal (e "in_x/..." para instâncias aninhadas):\n${tree ? getTreeSummary(tree.path.node, 4, { doc }) : ''}`,
        );
      }
      const ov: NodeOverride = {};
      if (style && Object.keys(style).length) ov.style = style;
      if (unset_style?.length) ov.unsetStyle = unset_style;
      if (text !== undefined) ov.text = text;
      if (attrs && Object.keys(attrs).length) ov.attrs = attrs;
      if (hidden !== undefined) ov.hidden = hidden;
      if (Object.keys(ov).length === 0)
        throw new ToolError(
          'Informe ao menos um de style, unset_style, text, attrs ou hidden. Ex.: style { "color": "#dc2626" }.',
        );
      const prev = inst.overrides?.[path];
      const merged = prev ? mergeOverride(prev, ov) : ov;
      const r = apply(
        id,
        [
          {
            type: 'setInstanceOverrides',
            changes: [{ nodeId, overrides: { ...(inst.overrides ?? {}), [path]: merged } }],
          },
        ],
        'set_instance_override',
      );
      return `Override aplicado em ${target}.\n${summaryOf(r.doc, [nodeId])}`;
    },
  );

  tool(
    'reset_instance',
    {
      title: 'Restaurar instâncias',
      description:
        'Remove todos os overrides das instâncias (props e slots ficam). Para gravar os overrides no principal em vez de descartá-los, use push_overrides_to_main.',
      example: { nodeIds: ['in_ab12cd34'] },
      inputSchema: {
        nodeIds: z.array(z.string()).min(1).describe('Ids das instâncias, ex.: ["in_ab12cd34"].'),
        docId: docIdField,
      },
      annotations: DESTRUCTIVE,
    },
    ({ nodeIds, docId }) => {
      const id = store.resolveDocId(docId);
      const doc = store.get(id);
      for (const n of nodeIds) requireInstance(doc, n);
      const r = apply(
        id,
        nodeIds.flatMap((n) => resetInstanceOps(doc, n)),
        'reset_instance',
      );
      return `Overrides removidos de ${nodeIds.length} instância(s).\n${summaryOf(r.doc, nodeIds)}`;
    },
  );

  tool(
    'detach_instance',
    {
      title: 'Destacar instância',
      description:
        'Transforma a instância em nós comuns (ids novos), desligando-a do principal. Devolve o novo id da raiz. Reversível com undo.',
      example: { nodeId: 'in_ab12cd34' },
      inputSchema: {
        nodeId: z.string().describe('Id da instância, ex.: "in_ab12cd34".'),
        docId: docIdField,
      },
      annotations: DESTRUCTIVE,
    },
    ({ nodeId, docId }) => {
      const id = store.resolveDocId(docId);
      const doc = store.get(id);
      requireInstance(doc, nodeId);
      const ops = detachInstanceOps(doc, nodeId);
      const r = apply(id, ops, 'detach_instance');
      const rep = ops[0];
      const newId = rep && rep.type === 'replaceNode' ? rep.node.id : nodeId;
      return `Instância ${nodeId} destacada. Novo id: ${newId}.\n${summaryOf(r.doc, [newId])}`;
    },
  );

  tool(
    'push_overrides_to_main',
    {
      title: 'Enviar overrides ao principal',
      description:
        'Grava os overrides da instância no principal (todas as instâncias passam a ter essa aparência) e limpa os da instância. Sem overrides não faz nada.',
      example: { nodeId: 'in_ab12cd34' },
      inputSchema: {
        nodeId: z.string().describe('Id da instância, ex.: "in_ab12cd34".'),
        docId: docIdField,
      },
      annotations: DESTRUCTIVE,
    },
    ({ nodeId, docId }) => {
      const id = store.resolveDocId(docId);
      const doc = store.get(id);
      const inst = requireInstance(doc, nodeId);
      const ops = pushOverridesToMainOps(doc, nodeId);
      if (!ops.length) return `A instância ${nodeId} não tem overrides: nada a enviar.`;
      const r = apply(id, ops, 'push_overrides_to_main');
      const def = getComponent(r.doc, inst.componentId);
      const n = def ? instanceCount(r.doc, def.id) : '0 instância(s)';
      return `Overrides de ${nodeId} gravados no principal "${def?.name ?? inst.componentId}" (afeta ${n}).\n${summaryOf(r.doc, [nodeId])}`;
    },
  );

  tool(
    'go_to_main',
    {
      title: 'Ir para o principal',
      description:
        'Seleciona a raiz do principal no editor (que entra na edição do principal) e devolve sua árvore com ids. Aceita uma instância, um id virtual ("in_x/...") ou um id de componente.',
      example: { nodeId: 'in_ab12cd34' },
      inputSchema: {
        nodeId: z
          .string()
          .describe('Id de uma instância, id virtual ("in_x/tx_y") ou componente (cp_...).'),
        docId: docIdField,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    ({ nodeId, docId }) => {
      const id = store.resolveDocId(docId);
      const doc = store.get(id);
      let def = getComponent(doc, nodeId);
      if (!def) {
        const read = resolveRead(doc, nodeId);
        const node = read?.path.node;
        if (node?.componentId) def = getComponent(doc, node.componentId);
        else if (read?.component) def = read.component;
        else if (isVirtualId(nodeId))
          def = findComponentNode(doc, nodeId.slice(nodeId.lastIndexOf('/') + 1))?.component;
      }
      if (!def) {
        if (!read0(doc, nodeId))
          throw new ToolError(
            `Nó não encontrado: "${nodeId}". Use get_tree_summary (instâncias aparecem como ◆Nome) ou list_components.`,
          );
        throw new ToolError(
          `"${nodeId}" não é uma instância nem faz parte de um principal. Use list_components para ver os componentes.`,
        );
      }
      store.setSelection(id, [def.root.id], 'mcp');
      return [
        `Principal "${def.name}" (${def.id}) selecionado: raiz ${def.root.id} (${instanceCount(doc, def.id)}).`,
        getTreeSummary(def.root, 5, { doc }),
        'Edite com update_styles/set_text/set_attrs nesses ids (propaga para todas as instâncias), update_component_html ou update_component.',
      ].join('\n');
    },
  );
  const read0 = (doc: Document, id: string): boolean => !!resolveRead(doc, id);

  /* ---------- kits ---------- */

  tool(
    'import_kit',
    {
      title: 'Importar kit de componentes',
      description:
        'Importa os componentes de um kit (nome, ex. "shadcn-like", ou caminho absoluto de um .mockup.json) com os tokens que faltam. Idempotente: importar de novo atualiza em vez de duplicar. Veja os kits em list_components.',
      example: { name: 'shadcn-like' },
      inputSchema: {
        name: z
          .string()
          .describe('Nome do kit ("shadcn-like") ou caminho absoluto de um .mockup.json.'),
        docId: docIdField,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    ({ name, docId }) => {
      const id = store.resolveDocId(docId);
      const doc = store.get(id);
      const kit = kitOrThrow(name);
      const imp = importKitOps(doc, kit.doc, kit.name);
      const list = imp.components.map((c) => `${c.name} (${c.status})`).join(', ');
      if (imp.ops.length === 0) return `Kit "${kit.name}" já está importado e atualizado: ${list}.`;
      apply(id, imp.ops, 'import_kit');
      return [
        `Kit "${kit.name}" importado: ${list}.`,
        imp.tokensAdded.length
          ? `Tokens criados (${imp.tokensAdded.length}): ${imp.tokensAdded.slice(0, 8).join(', ')}${imp.tokensAdded.length > 8 ? ', …' : ''}.`
          : 'Nenhum token novo (o documento já tinha os usados).',
        'Insira com insert_component("kit/Nome", parentId, props); detalhes em get_component.',
      ].join('\n');
    },
  );
}
