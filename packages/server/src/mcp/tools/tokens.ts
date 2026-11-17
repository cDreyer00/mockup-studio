import { z } from 'zod';
import {
  TOKEN_GROUPS,
  canonicalTokenGroup,
  evaluateCss,
  exportTokens,
  getTokenReport,
  normalizeTokenName,
  parseTokens,
  planApplyToken,
  planCreateTheme,
  planDeleteTheme,
  planDeleteTokens,
  planImportTokens,
  planRenameTheme,
  planSetFrameTheme,
  resolvedTokens,
  resolvedTokensDetailed,
  tokenGroup,
  tokenGroupLabel,
  validateTokenValue,
  type Document,
  type Op,
  type TokenInfo,
  type TokenMeta,
  type TokenReport,
} from '@mockup/core';
import { DESTRUCTIVE, READ, ToolError, WRITE, docIdField, type ToolContext } from '../context.js';

const nodeIdsField = z
  .array(z.string())
  .min(1)
  .describe('Node ids (see get_tree_summary), e.g. ["fr_ab12cd34"].');

const themeNameField = (what: string) =>
  z.string().min(1).describe(`${what}, e.g. "dark" (letters, digits, "-" and "_").`);

const GROUP_IDS = TOKEN_GROUPS.map((g) => g.id).join(', ');

/** Map with normalized keys (`primary` becomes `--primary`). */
function normalizeKeys<T>(map: Record<string, T> | undefined): Record<string, T> {
  return Object.fromEntries(Object.entries(map ?? {}).map(([k, v]) => [normalizeTokenName(k), v]));
}

function requireTheme(doc: Document, name: string): void {
  if (doc.themes?.some((t) => t.name === name)) return;
  const have = (doc.themes ?? []).map((t) => t.name);
  throw new ToolError(
    `Theme "${name}" does not exist${have.length ? ` (existing: ${have.join(', ')})` : ''}. Create it with create_theme({ name: "${name}" }).`,
  );
}

const quote = (names: string[]): string => names.join(', ');

function tokenLine(t: TokenInfo, theme?: string): string {
  const shown = theme ? (t.resolvedByTheme[theme] ?? t.resolved) : t.resolved;
  const parts = [`${t.name}: ${t.value ?? '(themes only)'}`];
  if (shown !== undefined && shown !== t.value) parts.push(`=> ${shown}`);
  const own = Object.entries(t.themes);
  if (!theme && own.length) {
    parts.push(
      `[${own.map(([n, v]) => `${n}: ${v}${t.resolvedByTheme[n] && t.resolvedByTheme[n] !== v ? ` => ${t.resolvedByTheme[n]}` : ''}`).join('; ')}]`,
    );
  } else if (theme && theme in t.themes) {
    parts.push('(overridden in the theme)');
  }
  const uses = t.usage.nodeIds.length + t.usage.tokens.length;
  parts.push(uses > 0 ? `| ${uses} use(s)` : '| unused');
  if (t.description) parts.push(`| ${t.description}`);
  if (t.problem)
    parts.push(`| ${t.problem.level === 'error' ? 'ERROR' : 'warning'}: ${t.problem.message}`);
  return parts.join(' ');
}

function reportText(report: TokenReport, group?: string, theme?: string): string {
  if (report.tokens.length === 0 && report.themes.length === 0) {
    return 'No tokens defined. Create them with set_tokens({ tokens: { "--color-primary": "#2563eb" } }) and see get_guide(\'tokens\').';
  }
  const out: string[] = [];
  const wanted = group
    ? report.tokens.filter(
        (t) => t.group === canonicalTokenGroup(group) || tokenGroupLabel(t.group) === group,
      )
    : report.tokens;
  const order = [...new Set(report.tokens.map((t) => t.group))].sort((a, b) => {
    const ia = TOKEN_GROUPS.findIndex((g) => g.id === a);
    const ib = TOKEN_GROUPS.findIndex((g) => g.id === b);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
  });
  out.push(
    `${wanted.length} token(s)${group ? ` in group "${tokenGroupLabel(group)}"` : ''}${theme ? ` (values in theme "${theme}")` : ''}.`,
  );
  if (group && wanted.length === 0) {
    out.push(
      `No tokens in this group. Groups with tokens: ${order.map(tokenGroupLabel).join(', ') || '(none)'}.`,
    );
  }
  for (const g of order) {
    const list = wanted.filter((t) => t.group === g);
    if (!list.length) continue;
    out.push('', `## ${tokenGroupLabel(g)} (${list.length})`);
    for (const t of list) out.push(tokenLine(t, theme));
  }
  if (!group) {
    out.push('', `## Themes (${report.themes.length})`);
    if (report.themes.length === 0) {
      out.push('None. Create one with create_theme({ name: "dark", overrides: { ... } }).');
    }
    for (const t of report.themes) {
      out.push(
        `${t.name}: ${t.overrides} override(s); frames: ${t.frames.length ? t.frames.join(', ') : 'none'}`,
      );
    }
    if (report.unused.length) out.push('', `Unused: ${quote(report.unused)}`);
    if (report.broken.length) {
      out.push('', 'Broken references:');
      for (const b of report.broken) {
        const where = b.nodeId
          ? `node ${b.nodeId} (${b.property})`
          : `token ${b.token}${b.theme ? ` in theme ${b.theme}` : ''}`;
        out.push(`- ${where} uses ${b.missing}, which does not exist`);
      }
    }
  }
  return out.join('\n');
}

export function registerTokenTools(ctx: ToolContext): void {
  const { store, tool, apply } = ctx;

  tool(
    'get_tokens',
    {
      title: 'Document tokens',
      description:
        'Document design system: tokens by group (value, resolved value, description, uses, unused, problems), themes (overrides, frames) and broken references. format "json" returns the structured report.',
      example: { group: 'color', theme: 'dark' },
      inputSchema: {
        group: z
          .string()
          .optional()
          .describe(`A single group (${GROUP_IDS} or a free-form group), e.g. "color".`),
        theme: z
          .string()
          .optional()
          .describe('Shows the values resolved in that theme, e.g. "dark".'),
        format: z
          .enum(['text', 'json'])
          .optional()
          .describe('"text" (default) or "json" (structured report).'),
        docId: docIdField,
      },
      annotations: READ,
    },
    ({ group, theme, format, docId }) => {
      const doc = store.get(store.resolveDocId(docId));
      if (theme) requireTheme(doc, theme);
      const report = getTokenReport(doc);
      if (format === 'json') {
        const tokens = group
          ? report.tokens.filter(
              (t) => t.group === canonicalTokenGroup(group) || tokenGroupLabel(t.group) === group,
            )
          : report.tokens;
        return JSON.stringify({ ...report, tokens }, null, 2);
      }
      return reportText(report, group, theme);
    },
  );

  tool(
    'set_tokens',
    {
      title: 'Set tokens',
      description:
        'Sets/removes tokens (CSS variables); "--" is added if missing. With theme it writes to the theme overrides; unset without a theme removes from the base, the metadata and the themes. groups/descriptions store group and description. Accepts var(), calc(), color-mix().',
      example: {
        tokens: { '--blue-600': '#2563eb', '--color-primary': 'var(--blue-600)' },
        groups: { '--blue-600': 'color' },
        descriptions: { '--color-primary': 'Primary action' },
      },
      inputSchema: {
        tokens: z
          .record(z.string(), z.string())
          .optional()
          .describe(
            'Tokens to set; the "--" prefix is added if missing ("primary" becomes "--primary").',
          ),
        unset: z.array(z.string()).optional().describe('Tokens to remove, e.g. ["--old-color"].'),
        theme: z
          .string()
          .optional()
          .describe('Target theme (must exist): tokens/unset only apply to its overrides.'),
        groups: z
          .record(z.string(), z.string())
          .optional()
          .describe(`Group per token, e.g. { "--brand": "color" } (${GROUP_IDS} or free-form).`),
        descriptions: z
          .record(z.string(), z.string())
          .optional()
          .describe(
            'Description per token (empty text clears it), e.g. { "--brand": "Brand color" }.',
          ),
        docId: docIdField,
      },
      annotations: WRITE,
    },
    ({ tokens, unset, theme, groups, descriptions, docId }) => {
      const id = store.resolveDocId(docId);
      const doc = store.get(id);
      const set = normalizeKeys(tokens);
      const unsetNames = [...new Set((unset ?? []).map(normalizeTokenName))];
      const groupMap = normalizeKeys(groups);
      const descMap = normalizeKeys(descriptions);
      const setNames = Object.keys(set);
      if (
        !setNames.length &&
        !unsetNames.length &&
        !Object.keys(groupMap).length &&
        !Object.keys(descMap).length
      ) {
        throw new ToolError(
          'Nothing to do. Provide tokens, unset, groups and/or descriptions. E.g. tokens { "--color-primary": "#2563eb" }.',
        );
      }
      if (theme) requireTheme(doc, theme);
      for (const k of [
        ...setNames,
        ...unsetNames,
        ...Object.keys(groupMap),
        ...Object.keys(descMap),
      ]) {
        if (!/^--[A-Za-z0-9_-]+$/.test(k)) {
          throw new ToolError(
            `Invalid token name: "${k}". Use letters, digits, "-" and "_", e.g. "--color-primary".`,
          );
        }
      }
      for (const [k, g] of Object.entries(groupMap)) {
        if (!g.trim()) throw new ToolError(`Empty group for ${k}. Use one of: ${GROUP_IDS}.`);
      }

      // Hypothetical document with the new values: used to resolve var() when validating.
      const draft: Document = theme
        ? {
            ...doc,
            themes: (doc.themes ?? []).map((t) =>
              t.name === theme ? { ...t, overrides: { ...t.overrides, ...set } } : t,
            ),
          }
        : { ...doc, tokens: { ...doc.tokens, ...set } };
      // `invalid` tells a cycle/broken reference (including among tokens in this call) from a nonexistent one.
      const { vars, invalid } = resolvedTokensDetailed(draft, theme);
      const errors: string[] = [];
      const warnings: string[] = [];
      for (const [name, value] of Object.entries(set)) {
        const group = groupMap[name] ?? tokenGroup(draft, name);
        const problem = validateTokenValue(name, value, { group, vars, invalid });
        if (!problem) continue;
        const line = `${name}: ${problem.message}`;
        (problem.level === 'error' ? errors : warnings).push(line);
      }
      if (errors.length) {
        throw new ToolError(
          `No token was changed; fix the value:\n${errors.map((e) => `- ${e}`).join('\n')}`,
        );
      }

      const ops: Op[] = [];
      const missing: string[] = [];
      if (theme) {
        if (setNames.length || unsetNames.length) {
          ops.push({
            type: 'setTokens',
            theme,
            set: setNames.length ? set : undefined,
            unset: unsetNames.length ? unsetNames : undefined,
          });
        }
      } else {
        if (setNames.length) ops.push({ type: 'setTokens', set });
        if (unsetNames.length) {
          const existing = unsetNames.filter(
            (n) =>
              n in doc.tokens ||
              (doc.tokenMeta && n in doc.tokenMeta) ||
              (doc.themes ?? []).some((t) => n in t.overrides),
          );
          missing.push(...unsetNames.filter((n) => !existing.includes(n)));
          if (existing.length) ops.push(...planDeleteTokens(doc, existing));
        }
      }
      const removed = new Set(theme ? [] : unsetNames);
      const metaSet: Record<string, TokenMeta> = {};
      for (const name of new Set([...Object.keys(groupMap), ...Object.keys(descMap)])) {
        if (removed.has(name)) continue;
        if (
          !(name in doc.tokens) &&
          !(name in set) &&
          !(doc.themes ?? []).some((t) => name in t.overrides)
        ) {
          throw new ToolError(
            `Token "${name}" does not exist; define it in tokens before giving it a group or description.`,
          );
        }
        const meta: TokenMeta = { ...doc.tokenMeta?.[name] };
        if (name in groupMap) meta.group = groupMap[name]!.trim();
        if (name in descMap) {
          const d = descMap[name]!.trim();
          if (d) meta.description = d;
          else delete meta.description;
        }
        metaSet[name] = meta;
      }
      if (Object.keys(metaSet).length) ops.push({ type: 'setTokenMeta', set: metaSet });
      if (!ops.length) {
        throw new ToolError(
          `Nothing was changed: ${quote(missing)} does not exist. See get_tokens.`,
        );
      }

      const r = apply(id, ops, 'set_tokens');
      const out = [
        `Tokens updated${theme ? ` in theme "${theme}"` : ''}: ${setNames.length} set, ${unsetNames.length - missing.length} removed, ${Object.keys(metaSet).length} with metadata (${Object.keys(r.doc.tokens).length} tokens in total).`,
      ];
      const after = resolvedTokens(r.doc, theme);
      for (const [k, v] of Object.entries(set)) {
        const shown = after[k] === undefined ? undefined : evaluateCss(after[k]);
        out.push(`${k}: ${v}${shown !== undefined && shown !== v ? ` => ${shown}` : ''}`);
      }
      if (missing.length) out.push(`Did not exist (ignored): ${quote(missing)}`);
      if (warnings.length) out.push('Warnings:', ...warnings.map((w) => `- ${w}`));
      return out.join('\n');
    },
  );

  tool(
    'rename_token',
    {
      title: 'Rename token',
      description:
        'Renames a token and updates all var(--old) references: node styles, other tokens, themes and metadata.',
      example: { from: '--color-brand', to: '--color-primary' },
      inputSchema: {
        from: z.string().min(1).describe('Current name, e.g. "--color-brand".'),
        to: z.string().min(1).describe('New name (must not exist), e.g. "--color-primary".'),
        docId: docIdField,
      },
      annotations: WRITE,
    },
    ({ from, to, docId }) => {
      const id = store.resolveDocId(docId);
      const a = normalizeTokenName(from);
      const b = normalizeTokenName(to);
      const r = apply(id, [{ type: 'renameToken', from: a, to: b }], 'rename_token');
      const res = (r.results[0] ?? {}) as { nodes?: number; references?: number };
      return `Token renamed: ${a} -> ${b}. ${res.references ?? 0} reference(s) updated in ${res.nodes ?? 0} node(s).`;
    },
  );

  tool(
    'apply_token',
    {
      title: 'Apply token',
      description:
        'Binds a CSS property of one or more nodes to a token: writes "property: var(--token)". Returns the resolved value and the node summary.',
      example: { nodeIds: ['el_ab12cd34'], property: 'background', token: '--color-primary' },
      inputSchema: {
        nodeIds: nodeIdsField,
        property: z.string().min(1).describe('CSS property, e.g. "background" or "border-radius".'),
        token: z.string().min(1).describe('Existing token, e.g. "--color-primary".'),
        docId: docIdField,
      },
      annotations: WRITE,
    },
    ({ nodeIds, property, token, docId }) => {
      const id = store.resolveDocId(docId);
      const doc = store.get(id);
      const ops = planApplyToken(doc, nodeIds, property, token);
      const r = apply(id, ops, 'apply_token');
      const name = normalizeTokenName(token);
      const resolved = getTokenReport(r.doc).tokens.find((t) => t.name === name)?.resolved;
      return `${property} = var(${name})${resolved ? ` (resolved value: ${resolved})` : ''} on ${nodeIds.length} node(s).\n${ctx.summaryOf(r.doc, nodeIds)}`;
    },
  );

  tool(
    'create_theme',
    {
      title: 'Create theme',
      description:
        'Creates a theme (e.g. "dark") with token overrides. List only what changes; aliases follow along. copyFrom starts from another theme\'s overrides. Apply it to frames with set_frame_theme.',
      example: {
        name: 'dark',
        overrides: { '--color-surface': '#0f172a', '--color-text': '#f8fafc' },
      },
      inputSchema: {
        name: themeNameField('Theme name'),
        overrides: z
          .record(z.string(), z.string())
          .optional()
          .describe('Overridden tokens, e.g. { "--color-surface": "#0f172a" }.'),
        copyFrom: z.string().optional().describe('Existing theme to copy the overrides from.'),
        docId: docIdField,
      },
      annotations: WRITE,
    },
    ({ name, overrides, copyFrom, docId }) => {
      const id = store.resolveDocId(docId);
      const doc = store.get(id);
      const ov = normalizeKeys(overrides);
      // The plan already validates name, duplicates and copyFrom; it returns the new theme with the final
      // overrides (copyFrom + overrides), which we use in a hypothetical document to resolve var().
      const planned = planCreateTheme(doc, name, { overrides: ov, copyFrom });
      const draft: Document = {
        ...doc,
        themes: (planned[0] as Extract<Op, { type: 'setThemes' }>).themes,
      };
      const { vars, invalid } = resolvedTokensDetailed(draft, name.trim());
      const errors: string[] = [];
      const warnings: string[] = [];
      for (const [k, v] of Object.entries(ov)) {
        const p = validateTokenValue(k, v, { group: tokenGroup(draft, k), vars, invalid });
        if (p) (p.level === 'error' ? errors : warnings).push(`${k}: ${p.message}`);
      }
      if (errors.length) {
        throw new ToolError(
          `Theme not created; fix the value:\n${errors.map((e) => `- ${e}`).join('\n')}`,
        );
      }
      const r = apply(id, planned, 'create_theme');
      const theme = r.doc.themes?.find((t) => t.name === name.trim());
      const out = [
        `Theme "${name.trim()}" created with ${Object.keys(theme?.overrides ?? {}).length} override(s). Apply it with set_frame_theme({ nodeIds: [...], theme: "${name.trim()}" }).`,
      ];
      if (warnings.length) out.push('Warnings:', ...warnings.map((w) => `- ${w}`));
      return out.join('\n');
    },
  );

  tool(
    'delete_theme',
    {
      title: 'Delete theme',
      description:
        'Deletes a theme and removes it from the frames that used it (they go back to the base tokens).',
      example: { name: 'dark' },
      inputSchema: { name: themeNameField('Theme to delete'), docId: docIdField },
      annotations: DESTRUCTIVE,
    },
    ({ name, docId }) => {
      const id = store.resolveDocId(docId);
      const doc = store.get(id);
      requireTheme(doc, name);
      const frames = getTokenReport(doc).themes.find((t) => t.name === name)?.frames ?? [];
      apply(id, planDeleteTheme(doc, name), 'delete_theme');
      return `Theme "${name}" deleted${frames.length ? `; ${frames.length} frame(s) went back to the base tokens (${frames.join(', ')})` : ''}.`;
    },
  );

  tool(
    'rename_theme',
    {
      title: 'Rename theme',
      description: 'Renames a theme and updates the data-theme of the frames that use it.',
      example: { from: 'dark', to: 'night' },
      inputSchema: {
        from: themeNameField('Current name'),
        to: themeNameField('New name'),
        docId: docIdField,
      },
      annotations: WRITE,
    },
    ({ from, to, docId }) => {
      const id = store.resolveDocId(docId);
      const doc = store.get(id);
      requireTheme(doc, from);
      const frames = getTokenReport(doc).themes.find((t) => t.name === from)?.frames ?? [];
      apply(id, planRenameTheme(doc, from, to), 'rename_theme');
      return `Theme renamed: ${from} -> ${to.trim()} (${frames.length} frame(s) updated).`;
    },
  );

  tool(
    'set_frame_theme',
    {
      title: 'Frame theme',
      description:
        'Sets the theme (data-theme attribute) of one or more frames; it applies to the frame and its descendants. theme null goes back to the base tokens.',
      example: { nodeIds: ['fr_ab12cd34'], theme: 'dark' },
      inputSchema: {
        nodeIds: nodeIdsField,
        theme: z
          .string()
          .nullable()
          .describe('Theme name (see get_tokens) or null for the base tokens.'),
        docId: docIdField,
      },
      annotations: WRITE,
    },
    ({ nodeIds, theme, docId }) => {
      const id = store.resolveDocId(docId);
      const doc = store.get(id);
      if (theme !== null) requireTheme(doc, theme);
      const ops = planSetFrameTheme(doc, nodeIds, theme);
      const r = apply(id, ops, 'set_frame_theme');
      return `${nodeIds.length} frame(s) ${theme === null ? 'went back to the base tokens' : `use theme "${theme}"`}.\n${ctx.summaryOf(r.doc, nodeIds)}`;
    },
  );

  tool(
    'import_tokens',
    {
      title: 'Import tokens',
      description:
        'Imports tokens and themes from text: CSS (:root, [data-theme="x"], Tailwind v4 @theme) or W3C Design Tokens JSON. mode "merge" (default) keeps what exists; "replace" swaps the whole design system. Returns counts and warnings.',
      example: {
        content:
          ':root { --color-primary: #2563eb; }\n[data-theme="dark"] { --color-primary: #60a5fa; }',
        format: 'css',
        mode: 'merge',
      },
      inputSchema: {
        content: z.string().min(1).describe('CSS or JSON text to import.'),
        format: z
          .enum(['css', 'json'])
          .optional()
          .describe('"css" or "json" (default: detected from the content).'),
        mode: z
          .enum(['merge', 'replace'])
          .optional()
          .describe('"merge" (default) merges; "replace" replaces tokens, metadata and themes.'),
        docId: docIdField,
      },
      annotations: DESTRUCTIVE,
    },
    ({ content, format, mode, docId }) => {
      const id = store.resolveDocId(docId);
      const doc = store.get(id);
      let set;
      try {
        set = parseTokens(content, format);
      } catch (e) {
        throw new ToolError(
          `Could not read the tokens: ${e instanceof Error ? e.message : String(e)}. Pass format "css" or "json" and the full text in content.`,
        );
      }
      const nTokens = Object.keys(set.tokens).length;
      if (nTokens === 0 && set.themes.length === 0) {
        throw new ToolError(
          `No tokens found in the content.${set.warnings.length ? `\nWarnings:\n${set.warnings.map((w) => `- ${w}`).join('\n')}` : ''}`,
        );
      }
      const m = mode ?? 'merge';
      const r = apply(id, planImportTokens(doc, set, m), 'import_tokens');
      const out = [
        `Imported (${m}): ${nTokens} token(s), ${set.themes.length} theme(s) [${set.themes.map((t) => t.name).join(', ')}]. The document now has ${Object.keys(r.doc.tokens).length} token(s) and ${(r.doc.themes ?? []).length} theme(s).`,
      ];
      if (set.warnings.length) out.push('Warnings:', ...set.warnings.map((w) => `- ${w}`));
      return out.join('\n');
    },
  );

  tool(
    'export_tokens',
    {
      title: 'Export tokens',
      description:
        'Returns the design system as text: "css" (:root + [data-theme]), "json" (W3C Design Tokens, with groups, descriptions and themes) or "tailwind" (@theme + @custom-variant).',
      example: { format: 'css' },
      inputSchema: {
        format: z.enum(['css', 'json', 'tailwind']).describe('"css", "json" or "tailwind".'),
        docId: docIdField,
      },
      annotations: READ,
    },
    ({ format, docId }) => {
      const doc = store.get(store.resolveDocId(docId));
      if (Object.keys(doc.tokens).length === 0 && !(doc.themes ?? []).length) {
        throw new ToolError(
          'The document has no tokens. Create them with set_tokens before exporting.',
        );
      }
      return exportTokens(doc, format);
    },
  );
}
