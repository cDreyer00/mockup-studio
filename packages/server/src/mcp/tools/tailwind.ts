/**
 * Tailwind nativo no MCP: `write_html` com classes, `import_component` (shadcn/ui, Tailwind UI),
 * `set_classes`/`get_classes`/`suggest_classes`, `get_tailwind_config` e `set_css_base`. O motor
 * (`@mockup/core/tailwind`) é o mesmo do editor: classes viram `style`/`states` do nó e as classes
 * escritas ficam em `node.classes` (dica de round-trip para o export).
 */
import { z } from 'zod';
import {
  BREAKPOINT_PX,
  BREAKPOINTS,
  PSEUDO_STATES,
  fixedWidthPx,
  htmlToNodes,
  normalizeStateKey,
  normalizeStyles,
  tailwindThemeCss,
  type Node,
  type NodePath,
  type Op,
} from '@mockup/core';
import {
  SHADCN_COLOR_NAMES,
  applyTailwindToNodes,
  detectTailwind,
  getTailwindEngine,
  nodesWithClasses,
  planSetClasses,
  planShadcnTokens,
  usesShadcnColor,
  type TailwindEngine,
  type TailwindReport,
} from '@mockup/core/tailwind';
import { READ, ToolError, WRITE, docIdField, type ToolContext } from '../context.js';

const MAX_LISTED = 10;

/** Ops que inserem `nodes` em `target` conforme o modo (a mesma lógica do `write_html` sem Tailwind). */
export function htmlInsertOps(
  target: NodePath,
  mode: 'append' | 'replace' | 'replace-children',
  nodes: Node[],
): { ops: Op[]; summaryParent: string } {
  const targetId = target.node.id;
  const ops: Op[] = [];
  let summaryParent = targetId;
  if (mode === 'replace') {
    const parent = target.parent;
    if (!parent) {
      if (nodes.length !== 1) {
        throw new ToolError(
          'mode "replace" em frame raiz exige um único elemento de topo; envolva o conteúdo em um <div> ou use mode "replace-children".',
        );
      }
      const nn = nodes[0]!;
      const old = target.node;
      nn.type = 'frame';
      if (old.position) nn.position = { ...old.position };
      for (const k of ['width', 'height'] as const) {
        if (!nn.style[k] && old.style[k]) nn.style[k] = old.style[k]!;
      }
      const generic = nn.tag.charAt(0).toUpperCase() + nn.tag.slice(1);
      if (nn.name === generic) nn.name = old.name;
    }
    ops.push({ type: 'deleteNodes', nodeIds: [targetId] });
    nodes.forEach((node, i) => {
      ops.push(
        parent
          ? { type: 'createNode', parentId: parent.id, node, index: target.index + i }
          : {
              type: 'createNode',
              parentId: null,
              pageId: target.page.id,
              node,
              index: target.index + i,
            },
      );
    });
    summaryParent = parent?.id ?? '';
  } else {
    if (mode === 'replace-children' && target.node.children.length) {
      ops.push({ type: 'deleteNodes', nodeIds: target.node.children.map((c) => c.id) });
    }
    for (const node of nodes) ops.push({ type: 'createNode', parentId: targetId, node });
  }
  return { ops, summaryParent };
}

/** Resumo curto do relatório: classes desconhecidas e sem suporte (com o motivo), até `MAX_LISTED`. */
export function reportLines(report: TailwindReport): string[] {
  const lines: string[] = [];
  if (report.unknown.length) {
    const shown = report.unknown.slice(0, MAX_LISTED).join(', ');
    const more = report.unknown.length - MAX_LISTED;
    lines.push(
      `Classes desconhecidas (sem efeito no estilo; ficam em node.classes): ${shown}${more > 0 ? ` e mais ${more}` : ''}.`,
    );
  }
  if (report.unsupported.length) {
    const shown = report.unsupported
      .slice(0, MAX_LISTED)
      .map((u) => `${u.cls} (${u.reason})`)
      .join('; ');
    const more = report.unsupported.length - MAX_LISTED;
    lines.push(
      `Classes sem equivalente no modelo (ficam só em node.classes e no código exportado): ${shown}${more > 0 ? `; e mais ${more}` : ''}.`,
    );
  }
  return lines;
}

/** Nome da cor shadcn que a classe usa (`hover:bg-primary/90` → `primary`). */
function shadcnColorOf(cls: string): string | null {
  const utility = cls
    .slice(cls.lastIndexOf(':') + 1)
    .replace(/^[!-]/, '')
    .replace(/\/\S+$/, '')
    .replace(/!$/, '');
  let best: string | null = null;
  for (const n of SHADCN_COLOR_NAMES) {
    if (utility.endsWith(`-${n}`) && (!best || n.length > best.length)) best = n;
  }
  return best;
}

export interface WriteHtmlArgs {
  html: string;
  mode?: 'append' | 'replace' | 'replace-children';
  parentId?: string;
  css?: string;
  tailwind?: 'auto' | 'on' | 'off';
  /** Só `import_component`: criar os tokens do preset shadcn (padrão `none` em write_html). */
  tokens?: 'auto' | 'shadcn' | 'none';
  docId?: string;
  label?: string;
}

/** Insere HTML (com ou sem Tailwind); é o miolo de `write_html` e `import_component`. */
export async function writeHtml(ctx: ToolContext, a: WriteHtmlArgs): Promise<string> {
  const { store, requireNode, apply, summaryOf, selectedOrFirstFrame } = ctx;
  const id = store.resolveDocId(a.docId);
  const doc = store.get(id);
  const mode = a.mode ?? 'append';
  let tw = a.tailwind ?? 'auto';
  let css = a.css;
  if (css !== undefined && css.trim().toLowerCase() === 'tailwind') {
    if (tw === 'off')
      throw new ToolError(
        'css: "tailwind" liga o Tailwind, mas tailwind: "off" o desliga. Remova um.',
      );
    tw = 'on';
    css = undefined;
  }
  const targetId = a.parentId ?? selectedOrFirstFrame(id, doc);
  const target = requireNode(doc, targetId);
  const label = a.label ?? 'write_html';
  const empty = () =>
    new ToolError('O HTML não gerou nenhum nó. Ex.: "<div><h1>Título</h1></div>".');

  let engine: TailwindEngine | undefined;
  let useTailwind = tw === 'on';
  if (tw === 'auto' && /\bclass\s*=/i.test(a.html)) {
    engine = await getTailwindEngine(doc);
    useTailwind = detectTailwind(a.html, engine, css ?? '').tailwind;
  }

  if (!useTailwind) {
    const nodes = htmlToNodes(a.html, { css });
    if (!nodes.length) throw empty();
    const { ops, summaryParent } = htmlInsertOps(target, mode, nodes);
    const r = apply(id, ops, label);
    const created = nodes.map((n) => n.id);
    return `HTML aplicado (${mode}). Nós criados: ${created.join(', ')}.\n${summaryParent ? summaryOf(r.doc, [summaryParent]) : summaryOf(r.doc, created)}`;
  }

  const nodes = htmlToNodes(a.html, { css, keepClasses: true });
  if (!nodes.length) throw empty();
  const extra: Op[] = [];
  const notes: string[] = [];

  // Tokens do preset shadcn (mesma chamada, mesmo undo) e o motor recompilado com eles.
  let tokens = doc.tokens;
  let themes = doc.themes;
  const tokensMode = a.tokens ?? 'none';
  if (tokensMode !== 'none') {
    const used = new Set<string>();
    for (const n of nodesWithClasses(nodes)) {
      for (const c of n.classes!.split(/\s+/)) {
        if (!c || !usesShadcnColor(c)) continue;
        const name = shadcnColorOf(c);
        if (name) used.add(name);
      }
    }
    const missing = [...used].some((n) => !(`--color-${n}` in doc.tokens));
    if (tokensMode === 'shadcn' || missing) {
      const plan = planShadcnTokens(doc);
      if (plan.created.length) {
        extra.push(...plan.ops);
        tokens = { ...doc.tokens };
        for (const op of plan.ops) {
          if (op.type === 'setTokens') Object.assign(tokens, op.set);
          if (op.type === 'setThemes') themes = op.themes;
        }
        notes.push(
          `Tokens do preset shadcn criados (${plan.created.length}, mais o tema "dark"): ${plan.created.slice(0, 6).join(', ')}${plan.created.length > 6 ? ', …' : ''}. Veja get_tokens.`,
        );
      }
    }
  }
  const newTokens = tokens !== doc.tokens;
  if (!engine || newTokens) engine = await getTailwindEngine({ tokens, themes });
  const shadcn = '--color-border' in tokens && '--color-primary' in tokens;
  const report = applyTailwindToNodes(nodes, engine, {
    ...(shadcn ? { defaultBorderColor: 'var(--color-border)' } : {}),
  });

  const ops: Op[] = [];
  if (doc.cssBase !== 'tailwind') {
    ops.push({ type: 'setCssBase', base: 'tailwind' });
    notes.push(
      'CSS base do documento trocado para o preflight do Tailwind (set_css_base). Para voltar ao padrão: set_css_base("default") (ou undo desfaz tudo desta chamada).',
    );
  }
  ops.push(...extra);
  const { ops: insert, summaryParent } = htmlInsertOps(target, mode, nodes);
  ops.push(...insert);
  const r = apply(id, ops, label);
  const created = nodes.map((n) => n.id);
  const lines = [
    `HTML com Tailwind aplicado (${mode}). Nós criados: ${created.join(', ')}.`,
    `${report.nodes} nó(s) com classes Tailwind compiladas para estilo; as classes ficam em node.classes.`,
    ...notes,
    ...reportLines(report),
    summaryParent ? summaryOf(r.doc, [summaryParent]) : summaryOf(r.doc, created),
    'Confira com get_screenshot (use state para hover/dark; md: só vale em frames com 768px ou mais).',
  ];
  return lines.join('\n');
}

/** Ops que gravam `styles`/`unset` no estado `key` dos nós, mesclando com o que já existe. */
export function planStateStyles(
  nodes: Node[],
  key: string,
  styles: Record<string, string> | undefined,
  unset: string[] | undefined,
): Op[] {
  const norm = normalizeStyles(styles ?? {});
  const changes = nodes.map((node) => {
    const states = { ...(node.states ?? {}) };
    const cur = { ...(states[key] ?? {}) };
    for (const [k, v] of Object.entries(norm)) {
      if (v === '') delete cur[k];
      else cur[k] = v;
    }
    for (const k of unset ?? []) delete cur[k];
    if (Object.keys(cur).length > 0) states[key] = cur;
    else delete states[key];
    return { nodeId: node.id, states: Object.keys(states).length ? states : null };
  });
  return [{ type: 'setStates', changes }];
}

const fmtKv = (o: Record<string, string>): string =>
  Object.entries(o)
    .map(([k, v]) => `${k}: ${v}`)
    .join('; ');

export function registerTailwindTools(ctx: ToolContext): void {
  const { tool, store, requireNode, apply, summaryOf } = ctx;

  const engineOf = (docId?: string): Promise<TailwindEngine> => {
    if (!docId && store.list().length === 0) return getTailwindEngine({ tokens: {}, themes: [] });
    return getTailwindEngine(store.get(store.resolveDocId(docId)));
  };

  tool(
    'import_component',
    {
      title: 'Importar componente Tailwind/shadcn',
      description:
        'Cola HTML de componentes shadcn/ui ou Tailwind UI: as classes viram estilo (e ficam em node.classes), os estados hover:/focus:/dark: viram states. Com tokens "auto" cria os tokens shadcn (bg-primary...) que faltam, num undo só.',
      example: {
        parentId: 'fr_ab12cd34',
        html: '<button data-slot="button" class="bg-primary text-primary-foreground hover:bg-primary/90 h-9 px-4 py-2 rounded-md">Salvar</button>',
        tokens: 'auto',
      },
      inputSchema: {
        html: z
          .string()
          .describe(
            'HTML do componente com as classes Tailwind, ex.: "<button class=\\"h-9 px-4\\">Ok</button>".',
          ),
        parentId: z
          .string()
          .optional()
          .describe('Id do nó alvo, ex.: "fr_ab12cd34" (padrão: seleção ou primeiro frame).'),
        mode: z
          .enum(['append', 'replace', 'replace-children'])
          .optional()
          .describe('"append" (padrão), "replace-children" ou "replace" (como em write_html).'),
        tokens: z
          .enum(['auto', 'shadcn', 'none'])
          .optional()
          .describe(
            '"auto" (padrão): cria os tokens shadcn que faltam se o HTML usar cores como bg-primary; "shadcn": cria sempre; "none": não cria.',
          ),
        docId: docIdField,
      },
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    ({ html, parentId, mode, tokens, docId }) =>
      writeHtml(ctx, {
        html,
        parentId,
        mode,
        docId,
        tailwind: 'on',
        tokens: tokens ?? 'auto',
        label: 'import_component',
      }),
  );

  tool(
    'set_classes',
    {
      title: 'Definir classes Tailwind',
      description:
        'Aplica classes Tailwind em nós: viram estilo e states (hover:, dark:, md:) e ficam em node.classes. mode: replace (padrão, as classes passam a ser todo o estilo), add ou remove.',
      example: {
        nodeIds: ['el_ab12cd34'],
        classes: 'flex items-center gap-4 p-6 hover:bg-primary/90',
        mode: 'add',
      },
      inputSchema: {
        nodeIds: z.array(z.string()).min(1).describe('Ids dos nós, ex.: ["el_ab12cd34"].'),
        classes: z
          .string()
          .describe('Classes Tailwind separadas por espaço, ex.: "rounded-xl border shadow-sm".'),
        mode: z
          .enum(['replace', 'add', 'remove'])
          .optional()
          .describe(
            '"replace" (padrão): as classes viram todo o estilo; "add": acrescenta (troca as de mesma propriedade); "remove": tira as classes.',
          ),
        docId: docIdField,
      },
      annotations: WRITE,
    },
    async ({ nodeIds, classes, mode, docId }) => {
      const id = store.resolveDocId(docId);
      const doc = store.get(id);
      const paths = nodeIds.map((n) => requireNode(doc, n));
      const engine = await getTailwindEngine(doc);
      const plan = planSetClasses(
        paths.map((p) => ({ node: p.node, root: !p.parent })),
        classes,
        engine,
        mode ?? 'replace',
      );
      if (plan.ops.length === 0)
        return `Nada mudou: os nós já têm essas classes e estilos.\n${summaryOf(doc, nodeIds)}`;
      const r = apply(id, plan.ops, 'set_classes');
      const lines = [`Classes (${mode ?? 'replace'}) aplicadas em ${nodeIds.length} nó(s):`];
      for (const nid of nodeIds) lines.push(`- ${nid}: ${plan.classes[nid] || '(nenhuma)'}`);
      lines.push(...reportLines(plan.report));
      if (doc.cssBase !== 'tailwind')
        lines.push(
          'O CSS base do documento não é o do Tailwind (preflight); use set_css_base("tailwind") para o render bater com o Tailwind.',
        );
      lines.push(summaryOf(r.doc, nodeIds));
      return lines.join('\n');
    },
  );

  tool(
    'get_classes',
    {
      title: 'Classes Tailwind de nós',
      description:
        'Mostra cada nó como Tailwind: as classes escritas (node.classes), as classes idiomáticas geradas do estilo e estados atuais, e o resto (CSS sem classe equivalente).',
      example: { nodeIds: ['el_ab12cd34'] },
      inputSchema: {
        nodeIds: z.array(z.string()).min(1).describe('Ids dos nós, ex.: ["el_ab12cd34"].'),
        docId: docIdField,
      },
      annotations: READ,
    },
    async ({ nodeIds, docId }) => {
      const doc = store.get(store.resolveDocId(docId));
      const paths = nodeIds.map((n) => requireNode(doc, n));
      const engine = await getTailwindEngine(doc);
      return paths
        .map(({ node }) => {
          const r = engine.nodeClasses(node);
          return [
            `${node.id} "${node.name}":`,
            `  escritas: ${node.classes ?? '(nenhuma)'}`,
            `  atuais: ${r.classes.join(' ') || '(nenhuma)'}`,
            `  rest: ${Object.keys(r.rest).length ? fmtKv(r.rest) : '(nada)'}`,
          ].join('\n');
        })
        .join('\n');
    },
  );

  tool(
    'suggest_classes',
    {
      title: 'Sugerir classes Tailwind',
      description:
        'Autocomplete de classes Tailwind (inclui tokens do documento como bg-primary e prefixos de variante como hover:bg-). Use para descobrir o nome exato de uma classe.',
      example: { query: 'hover:bg-', limit: 10 },
      inputSchema: {
        query: z.string().describe('Início da classe, ex.: "bg-pri", "rounded-", "md:flex".'),
        limit: z
          .number()
          .int()
          .min(1)
          .max(100)
          .optional()
          .describe('Máximo de sugestões, de 1 a 100 (padrão 20).'),
        docId: docIdField,
      },
      annotations: READ,
    },
    async ({ query, limit, docId }) => {
      const engine = await engineOf(docId);
      const list = engine.suggest(query, limit ?? 20);
      return list.length ? list.join('\n') : `Nenhuma classe começa com "${query}".`;
    },
  );

  tool(
    'get_tailwind_config',
    {
      title: 'Configuração Tailwind do documento',
      description:
        'O CSS @theme gerado dos tokens (o mesmo do export), os estados/variantes suportados, os breakpoints em px e o CSS base atual (default ou tailwind).',
      example: {},
      inputSchema: { docId: docIdField },
      annotations: READ,
    },
    ({ docId }) => {
      const doc = store.get(store.resolveDocId(docId));
      const bps = BREAKPOINTS.map((b) => {
        const px = fixedWidthPx(doc.tokens[`--breakpoint-${b}`]) ?? BREAKPOINT_PX[b];
        return `${b}: ${px}px`;
      });
      const css = Object.keys(doc.tokens).length ? tailwindThemeCss(doc) : '';
      return [
        `cssBase: ${doc.cssBase ?? 'default'}`,
        `Breakpoints (valem quando o frame raiz tem largura >= ao valor): ${bps.join(', ')}`,
        `Estados suportados: ${PSEUDO_STATES.join(', ')}, dark e breakpoints (sm md lg xl 2xl); combinações como md:hover e dark:hover.`,
        'Variantes sem equivalente (ficam só na classe): group-*, peer-*, aria-*, data-*, before:, after:, [&_svg]:.',
        '',
        '@theme gerado dos tokens:',
        css || '(sem tokens: só o tema padrão do Tailwind)',
      ].join('\n');
    },
  );

  tool(
    'set_css_base',
    {
      title: 'CSS base do documento',
      description:
        'Escolhe o CSS base do render: "tailwind" (preflight do Tailwind v4: border-box, bordas e botões resetados) ou "default". write_html liga o tailwind sozinho ao receber classes Tailwind.',
      example: { base: 'tailwind' },
      inputSchema: {
        base: z.enum(['default', 'tailwind']).describe('"tailwind" ou "default".'),
        docId: docIdField,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    ({ base, docId }) => {
      const id = store.resolveDocId(docId);
      const doc = store.get(id);
      if ((doc.cssBase ?? 'default') === base) return `O CSS base já é "${base}".`;
      apply(id, [{ type: 'setCssBase', base }], 'set_css_base');
      return `CSS base definido como "${base}".`;
    },
  );
}

/** Contexto de estado (`pseudo`/`dark`) lido de uma chave como `hover`, `dark:hover`. */
export function parseStateOrThrow(state: string): string {
  const key = normalizeStateKey(state);
  if (!key)
    throw new ToolError(
      `Estado inválido: "${state}". Use ${PSEUDO_STATES.join(', ')}, dark ou breakpoints (${BREAKPOINTS.join(', ')}), combináveis com ":" (ex.: "md:hover", "dark").`,
    );
  return key;
}
