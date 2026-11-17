import { z } from 'zod';
import {
  gridAreaNames,
  gridContainerStyles,
  gridPlacementStyles,
  isGridContainer,
  parseTrackList,
  trackCount,
  validateGridAreas,
  type GridTemplateInput,
} from '@mockup/core';
import { ToolError, WRITE, docIdField, type ToolContext } from '../context.js';

const trackField = z.union([
  z.number().int().min(1).max(200),
  z.string(),
  z.array(z.union([z.string(), z.number()])).min(1),
]);

const gapField = z.union([z.number().min(0), z.string()]);

/** Valida uma lista de trilhas em texto: trilhas soltas que o CSS não entende viram erro com dica. */
function checkTemplate(input: GridTemplateInput, label: string): void {
  const text =
    typeof input === 'string'
      ? input
      : Array.isArray(input)
        ? input.map((t) => (typeof t === 'number' ? `${t}px` : String(t))).join(' ')
        : '';
  if (!text) return;
  for (const t of parseTrackList(text)) {
    if (t.kind === 'other' && !t.value.includes('(') && !/^(subgrid|masonry)/i.test(t.value)) {
      throw new ToolError(
        `${label}: trilha "${t.value}" inválida. Use "1fr", "200px", "auto", "minmax(100px, 1fr)", "repeat(3, 1fr)"; ex.: "1fr 200px minmax(100px, 1fr)".`,
      );
    }
  }
}

/** Ferramentas de CSS Grid: definir trilhas e posicionar filhos em células. */
export function registerGridTools(ctx: ToolContext): void {
  const { tool, store, requireNode, apply, summaryOf } = ctx;

  tool(
    'set_grid',
    {
      title: 'Definir CSS Grid',
      description:
        'Transforma um nó em contêiner grid (display:grid) com colunas, linhas, gap, áreas e alinhamento. columns/rows: número (N trilhas iguais 1fr), texto CSS ("1fr 200px minmax(100px, 1fr)", "repeat(3, 1fr)") ou lista (["200px", "1fr"]). Depois posicione filhos com place_in_grid e confira as trilhas com get_layout.',
      example: {
        nodeId: 'el_ab12cd34',
        columns: 3,
        rows: 2,
        gap: 16,
        areas: ['a b c', 'd d e'],
        alignItems: 'start',
      },
      inputSchema: {
        nodeId: z.string().describe('Id do nó que vira grid, ex.: "el_ab12cd34".'),
        columns: trackField.describe(
          'Colunas: número (3 = três colunas 1fr), texto CSS ("1fr 2fr", "repeat(auto-fill, minmax(200px, 1fr))") ou lista (["200px", "1fr"]).',
        ),
        rows: trackField
          .optional()
          .describe('Linhas, no mesmo formato de columns, ex.: 2 ou "auto 1fr" (padrão: implícitas).'),
        gap: gapField
          .optional()
          .describe('Espaço entre trilhas: número (px) ou texto CSS, ex.: 16 ou "16px 24px".'),
        columnGap: gapField.optional().describe('Espaço entre colunas, ex.: 24 ou "1.5rem".'),
        rowGap: gapField.optional().describe('Espaço entre linhas, ex.: 16.'),
        areas: z
          .array(z.string())
          .min(1)
          .optional()
          .describe(
            'grid-template-areas, uma string por linha, "." é célula vazia, ex.: ["header header", "side main"]. Cada nome forma um retângulo.',
          ),
        placeItems: z
          .string()
          .optional()
          .describe('place-items (alinha e justifica os itens), ex.: "center" ou "start stretch".'),
        justifyItems: z
          .string()
          .optional()
          .describe('justify-items, ex.: "center", "start", "end", "stretch".'),
        alignItems: z
          .string()
          .optional()
          .describe('align-items, ex.: "center", "start", "end", "stretch".'),
        autoFlow: z
          .string()
          .optional()
          .describe('grid-auto-flow, ex.: "row" (padrão), "column", "row dense".'),
        docId: docIdField,
      },
      annotations: WRITE,
    },
    ({
      nodeId,
      columns,
      rows,
      gap,
      columnGap,
      rowGap,
      areas,
      placeItems,
      justifyItems,
      alignItems,
      autoFlow,
      docId,
    }) => {
      const id = store.resolveDocId(docId);
      const { node } = requireNode(store.get(id), nodeId);
      if (node.type === 'text' || node.type === 'image' || node.type === 'svg') {
        throw new ToolError(
          `O nó ${nodeId} é ${node.type === 'text' ? 'um texto' : node.type === 'image' ? 'uma imagem' : 'um svg'} e não pode ser contêiner grid. Use um nó div/section (ou crie um com create_node) e coloque os filhos dentro.`,
        );
      }
      checkTemplate(columns, 'columns');
      if (rows !== undefined) checkTemplate(rows, 'rows');
      let styles: Record<string, string>;
      try {
        if (areas) validateGridAreas(areas);
        styles = gridContainerStyles({
          columns,
          rows,
          gap,
          columnGap,
          rowGap,
          areas,
          placeItems,
          autoFlow,
        });
      } catch (e) {
        throw new ToolError(e instanceof Error ? e.message : String(e));
      }
      if (justifyItems?.trim()) styles['justify-items'] = justifyItems.trim();
      if (alignItems?.trim()) styles['align-items'] = alignItems.trim();

      const notes: string[] = [];
      const nCols = trackCount(styles, 'columns');
      if (areas) {
        const w = areas[0]!.trim().split(/\s+/).length;
        const isAuto = parseTrackList(styles['grid-template-columns']).some((t) => t.kind === 'other');
        if (!isAuto && w !== nCols) {
          notes.push(
            `Atenção: areas tem ${w} coluna(s) e columns define ${nCols}; o grid cria trilhas implícitas. Ajuste para o mesmo número.`,
          );
        }
        if (rows !== undefined) {
          const nRows = trackCount(styles, 'rows');
          if (nRows !== areas.length && !parseTrackList(styles['grid-template-rows']).some((t) => t.kind === 'other')) {
            notes.push(`Atenção: areas tem ${areas.length} linha(s) e rows define ${nRows}.`);
          }
        }
      }
      if ((node.style['display'] ?? '').includes('flex')) {
        notes.push('O display antes era flex; agora é grid (flex-direction e justify-content deixam de valer).');
      }
      const unset: string[] = [];
      // gap geral e gaps por eixo se sobrepõem: remove os que não vieram
      if (styles['gap'] !== undefined) unset.push('column-gap', 'row-gap');
      else if (styles['column-gap'] !== undefined || styles['row-gap'] !== undefined) unset.push('gap');
      const unsetFinal = unset.filter((k) => node.style[k] !== undefined && styles[k] === undefined);
      const r = apply(
        id,
        [{ type: 'updateStyles', nodeIds: [nodeId], styles, unset: unsetFinal.length ? unsetFinal : undefined }],
        'set_grid',
      );
      const summary = [
        `colunas ${styles['grid-template-columns']}`,
        rows !== undefined ? `linhas ${styles['grid-template-rows']}` : null,
        styles['gap'] ?? (styles['column-gap'] || styles['row-gap'] ? `gap ${styles['column-gap'] ?? '-'} / ${styles['row-gap'] ?? '-'}` : null),
        styles['grid-template-areas'] ? `áreas ${styles['grid-template-areas']}` : null,
      ]
        .filter(Boolean)
        .join('; ');
      return `Grid definido em ${nodeId}: ${summary}.${notes.length ? `\n${notes.join('\n')}` : ''}\nPosicione os filhos com place_in_grid(nodeIds, column, row, span?) e veja as trilhas reais com get_layout(${nodeId}) (precisa de render).\n${summaryOf(r.doc, [nodeId])}`;
    },
  );

  tool(
    'place_in_grid',
    {
      title: 'Posicionar em célula do grid',
      description:
        'Posiciona filhos de um contêiner grid (grid-column / grid-row, ou grid-area para área nomeada). column e row começam em 1; span é número (colunas) ou { columns, rows }. O pai precisa ser display:grid (use set_grid).',
      example: { nodeIds: ['el_ab12cd34'], column: 2, row: 1, span: { columns: 2, rows: 1 } },
      inputSchema: {
        nodeIds: z
          .array(z.string())
          .min(1)
          .describe('Ids dos filhos do grid, ex.: ["el_ab12cd34"].'),
        column: z.number().int().min(1).optional().describe('Coluna inicial (a primeira é 1), ex.: 2.'),
        row: z.number().int().min(1).optional().describe('Linha inicial (a primeira é 1), ex.: 1.'),
        span: z
          .union([
            z.number().int().min(1),
            z.object({
              columns: z.number().int().min(1).optional().describe('Colunas ocupadas, ex.: 2.'),
              rows: z.number().int().min(1).optional().describe('Linhas ocupadas, ex.: 2.'),
            }),
          ])
          .optional()
          .describe('Extensão: número = colunas ocupadas (2), ou { "columns": 2, "rows": 1 }.'),
        columnSpan: z.number().int().min(1).optional().describe('Colunas ocupadas, ex.: 2 (alternativa a span).'),
        rowSpan: z.number().int().min(1).optional().describe('Linhas ocupadas, ex.: 2.'),
        area: z
          .string()
          .optional()
          .describe('Área nomeada de grid-template-areas, ex.: "header" (substitui column/row).'),
        docId: docIdField,
      },
      annotations: WRITE,
    },
    ({ nodeIds, column, row, span, columnSpan, rowSpan, area, docId }) => {
      const id = store.resolveDocId(docId);
      const doc = store.get(id);
      const found = nodeIds.map((n) => requireNode(doc, n));
      const cs = columnSpan ?? (typeof span === 'number' ? span : span?.columns);
      const rs = rowSpan ?? (typeof span === 'object' ? span.rows : undefined);
      if (area === undefined && column === undefined && row === undefined && cs === undefined && rs === undefined) {
        throw new ToolError(
          'Informe column/row (e span) ou area. Ex.: column 2, row 1, span 2; ou area "header".',
        );
      }
      for (const p of found) {
        const parent = p.parent;
        if (!parent || !isGridContainer(parent.style)) {
          const where = parent
            ? `O pai de ${p.node.id} (${parent.id}) não é um grid (display: ${parent.style['display'] ?? 'block'}).`
            : `${p.node.id} é um frame raiz e não tem pai grid.`;
          throw new ToolError(
            `${where} Torne o pai um grid com set_grid(nodeId: "${parent?.id ?? '<paiId>'}", columns: 3) antes de usar place_in_grid.`,
          );
        }
        if (area !== undefined) {
          const names = gridAreaNames(parent.style['grid-template-areas']);
          if (!names.includes(area.trim())) {
            throw new ToolError(
              names.length
                ? `A área "${area}" não existe no grid ${parent.id}. Áreas: ${names.join(', ')}.`
                : `O grid ${parent.id} não tem áreas nomeadas. Defina com set_grid(nodeId: "${parent.id}", columns: ..., areas: ["a b", "c c"]) ou use column/row.`,
            );
          }
        }
      }
      let placement: Record<string, string>;
      try {
        placement = gridPlacementStyles({ column, row, columnSpan: cs, rowSpan: rs, area });
      } catch (e) {
        throw new ToolError(e instanceof Error ? e.message : String(e));
      }
      const notes: string[] = [];
      for (const p of found) {
        const parent = p.parent!;
        const nCols = trackCount(parent.style, 'columns');
        const colTracks = parseTrackList(parent.style['grid-template-columns']);
        if (
          area === undefined &&
          column !== undefined &&
          !colTracks.some((t) => t.kind === 'other') &&
          column + (cs ?? 1) - 1 > nCols
        ) {
          notes.push(
            `${p.node.id}: a coluna ${column}${cs ? ` com span ${cs}` : ''} passa das ${nCols} coluna(s) do grid; o navegador cria colunas implícitas.`,
          );
        }
      }
      // área nomeada e linhas/colunas explícitas se excluem: remove o lado que não foi pedido
      const unset = area !== undefined ? ['grid-column', 'grid-row'] : ['grid-area'];
      const r = apply(
        id,
        [
          {
            type: 'updateStyles',
            nodeIds,
            styles: placement,
            unset: unset.filter((k) => placement[k] === undefined),
          },
        ],
        'place_in_grid',
      );
      const text = Object.entries(placement)
        .map(([k, v]) => `${k}: ${v}`)
        .join('; ');
      return `${nodeIds.length} nó(s) posicionado(s) no grid (${text}).${notes.length ? `\n${notes.join('\n')}` : ''}\n${summaryOf(r.doc, nodeIds)}`;
    },
  );
}
