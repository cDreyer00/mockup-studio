import { z } from 'zod';
import {
  TOKEN_GROUPS,
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
  .describe('Ids dos nós (veja get_tree_summary), ex.: ["fr_ab12cd34"].');

const themeNameField = (what: string) =>
  z.string().min(1).describe(`${what}, ex.: "dark" (letras, dígitos, "-" e "_").`);

const GROUP_IDS = TOKEN_GROUPS.map((g) => g.id).join(', ');

/** Mapa com as chaves normalizadas (`primary` vira `--primary`). */
function normalizeKeys<T>(map: Record<string, T> | undefined): Record<string, T> {
  return Object.fromEntries(Object.entries(map ?? {}).map(([k, v]) => [normalizeTokenName(k), v]));
}

function requireTheme(doc: Document, name: string): void {
  if (doc.themes?.some((t) => t.name === name)) return;
  const have = (doc.themes ?? []).map((t) => t.name);
  throw new ToolError(
    `Tema "${name}" não existe${have.length ? ` (existentes: ${have.join(', ')})` : ''}. Crie com create_theme({ name: "${name}" }).`,
  );
}

const quote = (names: string[]): string => names.join(', ');

function tokenLine(t: TokenInfo, theme?: string): string {
  const shown = theme ? (t.resolvedByTheme[theme] ?? t.resolved) : t.resolved;
  const parts = [`${t.name}: ${t.value ?? '(só nos temas)'}`];
  if (shown !== undefined && shown !== t.value) parts.push(`=> ${shown}`);
  const own = Object.entries(t.themes);
  if (!theme && own.length) {
    parts.push(
      `[${own.map(([n, v]) => `${n}: ${v}${t.resolvedByTheme[n] && t.resolvedByTheme[n] !== v ? ` => ${t.resolvedByTheme[n]}` : ''}`).join('; ')}]`,
    );
  } else if (theme && theme in t.themes) {
    parts.push('(sobrescrito no tema)');
  }
  const uses = t.usage.nodeIds.length + t.usage.tokens.length;
  parts.push(uses > 0 ? `| ${uses} uso(s)` : '| não usado');
  if (t.description) parts.push(`| ${t.description}`);
  if (t.problem)
    parts.push(`| ${t.problem.level === 'error' ? 'ERRO' : 'aviso'}: ${t.problem.message}`);
  return parts.join(' ');
}

function reportText(report: TokenReport, group?: string, theme?: string): string {
  if (report.tokens.length === 0 && report.themes.length === 0) {
    return 'Nenhum token definido. Crie com set_tokens({ tokens: { "--color-primary": "#2563eb" } }) e veja get_guide(\'tokens\').';
  }
  const out: string[] = [];
  const wanted = group
    ? report.tokens.filter((t) => t.group === group || tokenGroupLabel(t.group) === group)
    : report.tokens;
  const order = [...new Set(report.tokens.map((t) => t.group))].sort((a, b) => {
    const ia = TOKEN_GROUPS.findIndex((g) => g.id === a);
    const ib = TOKEN_GROUPS.findIndex((g) => g.id === b);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
  });
  out.push(
    `${wanted.length} token(s)${group ? ` no grupo "${tokenGroupLabel(group)}"` : ''}${theme ? ` (valores no tema "${theme}")` : ''}.`,
  );
  if (group && wanted.length === 0) {
    out.push(
      `Nenhum token nesse grupo. Grupos com tokens: ${order.map(tokenGroupLabel).join(', ') || '(nenhum)'}.`,
    );
  }
  for (const g of order) {
    const list = wanted.filter((t) => t.group === g);
    if (!list.length) continue;
    out.push('', `## ${tokenGroupLabel(g)} (${list.length})`);
    for (const t of list) out.push(tokenLine(t, theme));
  }
  if (!group) {
    out.push('', `## Temas (${report.themes.length})`);
    if (report.themes.length === 0) {
      out.push('Nenhum. Crie com create_theme({ name: "dark", overrides: { ... } }).');
    }
    for (const t of report.themes) {
      out.push(
        `${t.name}: ${t.overrides} override(s); frames: ${t.frames.length ? t.frames.join(', ') : 'nenhum'}`,
      );
    }
    if (report.unused.length) out.push('', `Não usados: ${quote(report.unused)}`);
    if (report.broken.length) {
      out.push('', 'Referências quebradas:');
      for (const b of report.broken) {
        const where = b.nodeId
          ? `nó ${b.nodeId} (${b.property})`
          : `token ${b.token}${b.theme ? ` no tema ${b.theme}` : ''}`;
        out.push(`- ${where} usa ${b.missing}, que não existe`);
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
      title: 'Tokens do documento',
      description:
        'Design system do documento: tokens por grupo (valor, valor resolvido, descrição, usos, não usados, problemas), temas (overrides, frames) e referências quebradas. format "json" devolve o relatório estruturado.',
      example: { group: 'color', theme: 'dark' },
      inputSchema: {
        group: z
          .string()
          .optional()
          .describe(`Só um grupo (${GROUP_IDS} ou grupo livre), ex.: "color".`),
        theme: z
          .string()
          .optional()
          .describe('Mostra os valores resolvidos nesse tema, ex.: "dark".'),
        format: z
          .enum(['text', 'json'])
          .optional()
          .describe('"text" (padrão) ou "json" (relatório estruturado).'),
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
          ? report.tokens.filter((t) => t.group === group || tokenGroupLabel(t.group) === group)
          : report.tokens;
        return JSON.stringify({ ...report, tokens }, null, 2);
      }
      return reportText(report, group, theme);
    },
  );

  tool(
    'set_tokens',
    {
      title: 'Definir tokens',
      description:
        'Define/remove tokens (variáveis CSS); "--" é acrescentado se faltar. Com theme grava nas sobrescritas do tema; unset sem tema remove da base, dos metadados e dos temas. groups/descriptions guardam grupo e descrição. Aceita var(), calc(), color-mix().',
      example: {
        tokens: { '--blue-600': '#2563eb', '--color-primary': 'var(--blue-600)' },
        groups: { '--blue-600': 'color' },
        descriptions: { '--color-primary': 'Ação principal' },
      },
      inputSchema: {
        tokens: z
          .record(z.string(), z.string())
          .optional()
          .describe(
            'Tokens a definir; o prefixo "--" é acrescentado se faltar ("primary" vira "--primary").',
          ),
        unset: z.array(z.string()).optional().describe('Tokens a remover, ex.: ["--old-color"].'),
        theme: z
          .string()
          .optional()
          .describe('Tema alvo (precisa existir): tokens/unset valem só nas sobrescritas dele.'),
        groups: z
          .record(z.string(), z.string())
          .optional()
          .describe(`Grupo por token, ex.: { "--brand": "color" } (${GROUP_IDS} ou livre).`),
        descriptions: z
          .record(z.string(), z.string())
          .optional()
          .describe('Descrição por token (texto vazio apaga), ex.: { "--brand": "Cor da marca" }.'),
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
          'Nada a fazer. Informe tokens, unset, groups e/ou descriptions. Ex.: tokens { "--color-primary": "#2563eb" }.',
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
            `Nome de token inválido: "${k}". Use letras, dígitos, "-" e "_", ex.: "--color-primary".`,
          );
        }
      }
      for (const [k, g] of Object.entries(groupMap)) {
        if (!g.trim()) throw new ToolError(`Grupo vazio para ${k}. Use um de: ${GROUP_IDS}.`);
      }

      // Documento hipotético com os novos valores: serve para resolver var() ao validar.
      const draft: Document = theme
        ? {
            ...doc,
            themes: (doc.themes ?? []).map((t) =>
              t.name === theme ? { ...t, overrides: { ...t.overrides, ...set } } : t,
            ),
          }
        : { ...doc, tokens: { ...doc.tokens, ...set } };
      // `invalid` distingue ciclo/referência quebrada (inclusive entre tokens desta chamada) de inexistente.
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
          `Nenhum token foi alterado; corrija o valor:\n${errors.map((e) => `- ${e}`).join('\n')}`,
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
            `Token "${name}" não existe; defina-o em tokens antes de dar grupo ou descrição.`,
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
        throw new ToolError(`Nada foi alterado: ${quote(missing)} não existe(m). Veja get_tokens.`);
      }

      const r = apply(id, ops, 'set_tokens');
      const out = [
        `Tokens atualizados${theme ? ` no tema "${theme}"` : ''}: ${setNames.length} definido(s), ${unsetNames.length - missing.length} removido(s), ${Object.keys(metaSet).length} com metadados (${Object.keys(r.doc.tokens).length} tokens no total).`,
      ];
      const after = resolvedTokens(r.doc, theme);
      for (const [k, v] of Object.entries(set)) {
        const shown = after[k] === undefined ? undefined : evaluateCss(after[k]);
        out.push(`${k}: ${v}${shown !== undefined && shown !== v ? ` => ${shown}` : ''}`);
      }
      if (missing.length) out.push(`Não existiam (ignorados): ${quote(missing)}`);
      if (warnings.length) out.push('Avisos:', ...warnings.map((w) => `- ${w}`));
      return out.join('\n');
    },
  );

  tool(
    'rename_token',
    {
      title: 'Renomear token',
      description:
        'Renomeia um token e atualiza todas as referências var(--antigo): estilos dos nós, outros tokens, temas e metadados.',
      example: { from: '--color-brand', to: '--color-primary' },
      inputSchema: {
        from: z.string().min(1).describe('Nome atual, ex.: "--color-brand".'),
        to: z.string().min(1).describe('Nome novo (não pode existir), ex.: "--color-primary".'),
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
      return `Token renomeado: ${a} -> ${b}. ${res.references ?? 0} referência(s) atualizada(s) em ${res.nodes ?? 0} nó(s).`;
    },
  );

  tool(
    'apply_token',
    {
      title: 'Aplicar token',
      description:
        'Liga uma propriedade CSS de um ou mais nós a um token: grava "propriedade: var(--token)". Devolve o valor resolvido e o resumo dos nós.',
      example: { nodeIds: ['el_ab12cd34'], property: 'background', token: '--color-primary' },
      inputSchema: {
        nodeIds: nodeIdsField,
        property: z
          .string()
          .min(1)
          .describe('Propriedade CSS, ex.: "background" ou "border-radius".'),
        token: z.string().min(1).describe('Token existente, ex.: "--color-primary".'),
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
      return `${property} = var(${name})${resolved ? ` (valor resolvido: ${resolved})` : ''} em ${nodeIds.length} nó(s).\n${ctx.summaryOf(r.doc, nodeIds)}`;
    },
  );

  tool(
    'create_theme',
    {
      title: 'Criar tema',
      description:
        'Cria um tema (ex.: "dark") com sobrescritas de tokens. Só liste o que muda; aliases acompanham. copyFrom parte das sobrescritas de outro tema. Aplique a frames com set_frame_theme.',
      example: {
        name: 'dark',
        overrides: { '--color-surface': '#0f172a', '--color-text': '#f8fafc' },
      },
      inputSchema: {
        name: themeNameField('Nome do tema'),
        overrides: z
          .record(z.string(), z.string())
          .optional()
          .describe('Tokens sobrescritos, ex.: { "--color-surface": "#0f172a" }.'),
        copyFrom: z.string().optional().describe('Tema existente de onde copiar as sobrescritas.'),
        docId: docIdField,
      },
      annotations: WRITE,
    },
    ({ name, overrides, copyFrom, docId }) => {
      const id = store.resolveDocId(docId);
      const doc = store.get(id);
      const ov = normalizeKeys(overrides);
      // O plano já valida nome, duplicidade e copyFrom; ele traz o tema novo com as sobrescritas
      // finais (copyFrom + overrides), que usamos num documento hipotético para resolver var().
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
          `Tema não criado; corrija o valor:\n${errors.map((e) => `- ${e}`).join('\n')}`,
        );
      }
      const r = apply(id, planned, 'create_theme');
      const theme = r.doc.themes?.find((t) => t.name === name.trim());
      const out = [
        `Tema "${name.trim()}" criado com ${Object.keys(theme?.overrides ?? {}).length} sobrescrita(s). Aplique com set_frame_theme({ nodeIds: [...], theme: "${name.trim()}" }).`,
      ];
      if (warnings.length) out.push('Avisos:', ...warnings.map((w) => `- ${w}`));
      return out.join('\n');
    },
  );

  tool(
    'delete_theme',
    {
      title: 'Remover tema',
      description: 'Remove um tema e tira o tema dos frames que o usavam (voltam aos tokens base).',
      example: { name: 'dark' },
      inputSchema: { name: themeNameField('Tema a remover'), docId: docIdField },
      annotations: DESTRUCTIVE,
    },
    ({ name, docId }) => {
      const id = store.resolveDocId(docId);
      const doc = store.get(id);
      requireTheme(doc, name);
      const frames = getTokenReport(doc).themes.find((t) => t.name === name)?.frames ?? [];
      apply(id, planDeleteTheme(doc, name), 'delete_theme');
      return `Tema "${name}" removido${frames.length ? `; ${frames.length} frame(s) voltaram aos tokens base (${frames.join(', ')})` : ''}.`;
    },
  );

  tool(
    'rename_theme',
    {
      title: 'Renomear tema',
      description: 'Renomeia um tema e atualiza o data-theme dos frames que o usam.',
      example: { from: 'dark', to: 'night' },
      inputSchema: {
        from: themeNameField('Nome atual'),
        to: themeNameField('Nome novo'),
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
      return `Tema renomeado: ${from} -> ${to.trim()} (${frames.length} frame(s) atualizado(s)).`;
    },
  );

  tool(
    'set_frame_theme',
    {
      title: 'Tema do frame',
      description:
        'Define o tema (atributo data-theme) de um ou mais frames; vale para o frame e os descendentes. theme null volta aos tokens base.',
      example: { nodeIds: ['fr_ab12cd34'], theme: 'dark' },
      inputSchema: {
        nodeIds: nodeIdsField,
        theme: z
          .string()
          .nullable()
          .describe('Nome do tema (veja get_tokens) ou null para os tokens base.'),
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
      return `${nodeIds.length} frame(s) ${theme === null ? 'voltaram aos tokens base' : `usam o tema "${theme}"`}.\n${ctx.summaryOf(r.doc, nodeIds)}`;
    },
  );

  tool(
    'import_tokens',
    {
      title: 'Importar tokens',
      description:
        'Importa tokens e temas de texto: CSS (:root, [data-theme="x"], @theme do Tailwind v4) ou JSON W3C Design Tokens. mode "merge" (padrão) mantém o que existe; "replace" troca o design system inteiro. Devolve contagens e avisos.',
      example: {
        content:
          ':root { --color-primary: #2563eb; }\n[data-theme="dark"] { --color-primary: #60a5fa; }',
        format: 'css',
        mode: 'merge',
      },
      inputSchema: {
        content: z.string().min(1).describe('Texto CSS ou JSON a importar.'),
        format: z
          .enum(['css', 'json'])
          .optional()
          .describe('"css" ou "json" (padrão: detectado pelo conteúdo).'),
        mode: z
          .enum(['merge', 'replace'])
          .optional()
          .describe('"merge" (padrão) mescla; "replace" substitui tokens, metadados e temas.'),
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
          `Não foi possível ler os tokens: ${e instanceof Error ? e.message : String(e)}. Passe format "css" ou "json" e o texto completo em content.`,
        );
      }
      const nTokens = Object.keys(set.tokens).length;
      if (nTokens === 0 && set.themes.length === 0) {
        throw new ToolError(
          `Nenhum token encontrado no conteúdo.${set.warnings.length ? `\nAvisos:\n${set.warnings.map((w) => `- ${w}`).join('\n')}` : ''}`,
        );
      }
      const m = mode ?? 'merge';
      const r = apply(id, planImportTokens(doc, set, m), 'import_tokens');
      const out = [
        `Importados (${m}): ${nTokens} token(s), ${set.themes.length} tema(s) [${set.themes.map((t) => t.name).join(', ')}]. O documento agora tem ${Object.keys(r.doc.tokens).length} token(s) e ${(r.doc.themes ?? []).length} tema(s).`,
      ];
      if (set.warnings.length) out.push('Avisos:', ...set.warnings.map((w) => `- ${w}`));
      return out.join('\n');
    },
  );

  tool(
    'export_tokens',
    {
      title: 'Exportar tokens',
      description:
        'Devolve o design system como texto: "css" (:root + [data-theme]), "json" (W3C Design Tokens, com grupos, descrições e temas) ou "tailwind" (@theme + @custom-variant).',
      example: { format: 'css' },
      inputSchema: {
        format: z.enum(['css', 'json', 'tailwind']).describe('"css", "json" ou "tailwind".'),
        docId: docIdField,
      },
      annotations: READ,
    },
    ({ format, docId }) => {
      const doc = store.get(store.resolveDocId(docId));
      if (Object.keys(doc.tokens).length === 0 && !(doc.themes ?? []).length) {
        throw new ToolError('O documento não tem tokens. Crie com set_tokens antes de exportar.');
      }
      return exportTokens(doc, format);
    },
  );
}
