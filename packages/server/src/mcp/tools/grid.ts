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

/** Validates a text list of tracks: loose tracks that CSS does not understand become an error with a hint. */
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
        `${label}: invalid track "${t.value}". Use "1fr", "200px", "auto", "minmax(100px, 1fr)", "repeat(3, 1fr)"; e.g. "1fr 200px minmax(100px, 1fr)".`,
      );
    }
  }
}

/** CSS Grid tools: define tracks and place children in cells. */
export function registerGridTools(ctx: ToolContext): void {
  const { tool, store, requireNode, apply, summaryOf } = ctx;

  tool(
    'set_grid',
    {
      title: 'Define CSS Grid',
      description:
        'Turns the node into a grid container: columns/rows (number = N 1fr tracks, CSS text "1fr 200px minmax(100px, 1fr)" or list), gap, areas and alignment. Then use place_in_grid and check the tracks with get_layout.',
      example: {
        nodeId: 'el_ab12cd34',
        columns: 3,
        rows: 2,
        gap: 16,
        areas: ['a b c', 'd d e'],
        alignItems: 'start',
      },
      inputSchema: {
        nodeId: z.string().describe('Id of the node that becomes a grid, e.g. "el_ab12cd34".'),
        columns: trackField.describe(
          'Columns: number (3 = three 1fr columns), CSS text ("1fr 2fr", "repeat(auto-fill, minmax(200px, 1fr))") or list (["200px", "1fr"]).',
        ),
        rows: trackField
          .optional()
          .describe(
            'Rows, in the same format as columns, e.g. 2 or "auto 1fr" (default: implicit).',
          ),
        gap: gapField
          .optional()
          .describe('Space between tracks: number (px) or CSS text, e.g. 16 or "16px 24px".'),
        columnGap: gapField.optional().describe('Space between columns, e.g. 24 or "1.5rem".'),
        rowGap: gapField.optional().describe('Space between rows, e.g. 16.'),
        areas: z
          .array(z.string())
          .min(1)
          .optional()
          .describe(
            'grid-template-areas, one string per row, "." is an empty cell, e.g. ["header header", "side main"]. Each name forms a rectangle.',
          ),
        placeItems: z
          .string()
          .optional()
          .describe(
            'place-items (aligns and justifies the items), e.g. "center" or "start stretch".',
          ),
        justifyItems: z
          .string()
          .optional()
          .describe('justify-items, e.g. "center", "start", "end", "stretch".'),
        alignItems: z
          .string()
          .optional()
          .describe('align-items, e.g. "center", "start", "end", "stretch".'),
        autoFlow: z
          .string()
          .optional()
          .describe('grid-auto-flow, e.g. "row" (default), "column", "row dense".'),
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
          `Node ${nodeId} is ${node.type === 'text' ? 'a text' : node.type === 'image' ? 'an image' : 'an svg'} and cannot be a grid container. Use a div/section node (or create one with create_node) and put the children inside.`,
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
        const isAuto = parseTrackList(styles['grid-template-columns']).some(
          (t) => t.kind === 'other',
        );
        if (!isAuto && w !== nCols) {
          notes.push(
            `Warning: areas has ${w} column(s) and columns defines ${nCols}; the grid creates implicit tracks. Adjust to the same number.`,
          );
        }
        if (rows !== undefined) {
          const nRows = trackCount(styles, 'rows');
          if (
            nRows !== areas.length &&
            !parseTrackList(styles['grid-template-rows']).some((t) => t.kind === 'other')
          ) {
            notes.push(`Warning: areas has ${areas.length} row(s) and rows defines ${nRows}.`);
          }
        }
      }
      if ((node.style['display'] ?? '').includes('flex')) {
        notes.push(
          'The display was flex before; it is grid now (flex-direction and justify-content no longer apply).',
        );
      }
      const unset: string[] = [];
      // the general gap and the per-axis gaps overlap: remove the ones that were not given
      if (styles['gap'] !== undefined) unset.push('column-gap', 'row-gap');
      else if (styles['column-gap'] !== undefined || styles['row-gap'] !== undefined)
        unset.push('gap');
      const unsetFinal = unset.filter(
        (k) => node.style[k] !== undefined && styles[k] === undefined,
      );
      const r = apply(
        id,
        [
          {
            type: 'updateStyles',
            nodeIds: [nodeId],
            styles,
            unset: unsetFinal.length ? unsetFinal : undefined,
          },
        ],
        'set_grid',
      );
      const summary = [
        `columns ${styles['grid-template-columns']}`,
        rows !== undefined ? `rows ${styles['grid-template-rows']}` : null,
        styles['gap'] ??
          (styles['column-gap'] || styles['row-gap']
            ? `gap ${styles['column-gap'] ?? '-'} / ${styles['row-gap'] ?? '-'}`
            : null),
        styles['grid-template-areas'] ? `areas ${styles['grid-template-areas']}` : null,
      ]
        .filter(Boolean)
        .join('; ');
      return `Grid defined on ${nodeId}: ${summary}.${notes.length ? `\n${notes.join('\n')}` : ''}\nPlace the children with place_in_grid(nodeIds, column, row, span?) and see the real tracks with get_layout(${nodeId}) (needs render).\n${summaryOf(r.doc, [nodeId])}`;
    },
  );

  tool(
    'place_in_grid',
    {
      title: 'Place in a grid cell',
      description:
        'Places the children of a grid (grid-column/grid-row or grid-area). column and row start at 1; span is a number (columns) or { columns, rows }. The parent must be display:grid (see set_grid).',
      example: { nodeIds: ['el_ab12cd34'], column: 2, row: 1, span: { columns: 2, rows: 1 } },
      inputSchema: {
        nodeIds: z
          .array(z.string())
          .min(1)
          .describe('Ids of the grid children, e.g. ["el_ab12cd34"].'),
        column: z
          .number()
          .int()
          .min(1)
          .optional()
          .describe('Start column (the first is 1), e.g. 2.'),
        row: z.number().int().min(1).optional().describe('Start row (the first is 1), e.g. 1.'),
        span: z
          .union([
            z.number().int().min(1),
            z.object({
              columns: z.number().int().min(1).optional().describe('Columns spanned, e.g. 2.'),
              rows: z.number().int().min(1).optional().describe('Rows spanned, e.g. 2.'),
            }),
          ])
          .optional()
          .describe('Span: number = columns spanned (2), or { "columns": 2, "rows": 1 }.'),
        columnSpan: z
          .number()
          .int()
          .min(1)
          .optional()
          .describe('Columns spanned, e.g. 2 (alternative to span).'),
        rowSpan: z.number().int().min(1).optional().describe('Rows spanned, e.g. 2.'),
        area: z
          .string()
          .optional()
          .describe('Named area from grid-template-areas, e.g. "header" (replaces column/row).'),
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
      if (
        area === undefined &&
        column === undefined &&
        row === undefined &&
        cs === undefined &&
        rs === undefined
      ) {
        throw new ToolError(
          'Pass column/row (and span) or area. E.g. column 2, row 1, span 2; or area "header".',
        );
      }
      for (const p of found) {
        const parent = p.parent;
        if (!parent || !isGridContainer(parent.style)) {
          const where = parent
            ? `The parent of ${p.node.id} (${parent.id}) is not a grid (display: ${parent.style['display'] ?? 'block'}).`
            : `${p.node.id} is a root frame and has no grid parent.`;
          throw new ToolError(
            `${where} Make the parent a grid with set_grid(nodeId: "${parent?.id ?? '<parentId>'}", columns: 3) before using place_in_grid.`,
          );
        }
        if (area !== undefined) {
          const names = gridAreaNames(parent.style['grid-template-areas']);
          if (!names.includes(area.trim())) {
            throw new ToolError(
              names.length
                ? `Area "${area}" does not exist in grid ${parent.id}. Areas: ${names.join(', ')}.`
                : `Grid ${parent.id} has no named areas. Define them with set_grid(nodeId: "${parent.id}", columns: ..., areas: ["a b", "c c"]) or use column/row.`,
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
            `${p.node.id}: column ${column}${cs ? ` with span ${cs}` : ''} goes past the grid's ${nCols} column(s); the browser creates implicit columns.`,
          );
        }
      }
      // Named area, shorthands and longhand forms (-start/-end) overlap: remove what would conflict
      // (grid-area resets the four longhands; grid-column/grid-row reset those of their axis).
      const conflicting =
        area !== undefined
          ? [
              'grid-column',
              'grid-row',
              'grid-column-start',
              'grid-column-end',
              'grid-row-start',
              'grid-row-end',
            ]
          : [
              'grid-area',
              ...(placement['grid-column'] !== undefined
                ? ['grid-column-start', 'grid-column-end']
                : []),
              ...(placement['grid-row'] !== undefined ? ['grid-row-start', 'grid-row-end'] : []),
            ];
      const unset = conflicting.filter(
        (k) => placement[k] === undefined && found.some((p) => p.node.style[k] !== undefined),
      );
      const r = apply(
        id,
        [
          {
            type: 'updateStyles',
            nodeIds,
            styles: placement,
            unset: unset.length ? unset : undefined,
          },
        ],
        'place_in_grid',
      );
      const text = Object.entries(placement)
        .map(([k, v]) => `${k}: ${v}`)
        .join('; ');
      return `${nodeIds.length} node(s) placed in the grid (${text}).${notes.length ? `\n${notes.join('\n')}` : ''}\n${summaryOf(r.doc, nodeIds)}`;
    },
  );
}
