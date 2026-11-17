import { z } from 'zod';
import { findNode, type DocChangedEvent } from '@mockup/core';
import { touchedNodeIds } from '../../scripts/host.js';
import { DESTRUCTIVE, READ, ToolError, docIdField, type ToolContext } from '../context.js';

const MAX_LOG_CHARS = 6000;
const MAX_RESULT_CHARS = 4000;
const MAX_SUMMARY_NODES = 6;

const clip = (s: string, max: number): string =>
  s.length > max ? `${s.slice(0, max)}\n… (cortado: ${s.length} caracteres)` : s;

export function registerScriptTools(ctx: ToolContext): void {
  const { tool, store, opts } = ctx;

  const needScripts = () => {
    const s = opts.services?.scripts;
    if (!s) throw new ToolError('Scripts indisponíveis neste daemon.');
    return s;
  };

  tool(
    'run_script',
    {
      title: 'Executar script',
      description:
        'Roda JavaScript numa sandbox com a API doc (select, get, apply, screenshot, tokens; node.style/text/name) para edições em lote; um undo desfaz tudo. Informe code ou name (scripts/*.js). Veja get_guide("scripts").',
      example: {
        code: "doc.select('button').forEach(b => { b.style.background = '#2563eb'; }); return doc.select('button').length;",
      },
      inputSchema: {
        code: z
          .string()
          .optional()
          .describe(
            'Código JavaScript (corpo de async function, com await e return), ex.: "return doc.select(\'h1\').map(n => n.text);".',
          ),
        name: z
          .string()
          .optional()
          .describe('Nome de um script salvo em scripts/ (veja list_scripts), ex.: "renomear".'),
        timeoutMs: z
          .number()
          .int()
          .min(100)
          .max(60_000)
          .optional()
          .describe('Tempo máximo em ms, de 100 a 60000 (padrão 10000), ex.: 20000.'),
        docId: docIdField,
      },
      annotations: DESTRUCTIVE,
    },
    async ({ code, name, timeoutMs, docId }) => {
      const scripts = needScripts();
      const id = store.resolveDocId(docId);
      if ((code === undefined) === (name === undefined)) {
        throw new ToolError(
          'Informe code (JavaScript) OU name (script salvo em scripts/), não os dois. Ex.: code "return doc.select(\'button\').length;".',
        );
      }
      const source = code ?? (await scripts.read(id, name!)).code;
      // Dentro de um turno do assistente o script entra no mesmo grupo de undo do turno.
      const group = ctx.group();
      // Se o turno terminar (ou for cancelado) com o script rodando, o host recusa novas escritas e a
      // sandbox encerra o worker: o agente cancelado não continua gravando.
      const alive = (): boolean => {
        try {
          ctx.group();
          return true;
        } catch {
          return false;
        }
      };

      const touched = new Set<string>();
      const onChange = (e: DocChangedEvent): void => {
        if (e.docId === id) for (const t of touchedNodeIds(e.ops)) touched.add(t);
      };
      store.on('doc:changed', onChange);
      let r;
      try {
        r = await scripts.run(id, source, { group, source: 'mcp', timeoutMs, alive });
      } finally {
        store.off('doc:changed', onChange);
      }

      const lines: string[] = [];
      if (r.logs.length)
        lines.push('Logs:', clip(r.logs.map((l) => `  ${l}`).join('\n'), MAX_LOG_CHARS));
      if (!r.ok) {
        const head = `Script falhou: ${r.error ?? 'erro desconhecido'}`;
        const applied = r.opsCount
          ? `${r.opsCount} op(s) já foram aplicadas antes do erro (um undo as desfaz); confira com get_tree_summary.`
          : 'Nenhuma op foi aplicada.';
        throw new ToolError([head, ...lines, applied].join('\n'));
      }
      lines.unshift(`Script ok: ${r.opsCount} op(s) aplicada(s) em ${r.durationMs} ms.`);
      if (r.result !== undefined) {
        lines.push(
          `Resultado: ${clip(JSON.stringify(r.result, null, 2) ?? 'undefined', MAX_RESULT_CHARS)}`,
        );
      }
      if (r.images.length) {
        lines.push(
          `Imagens: ${r.images.length} (${r.images.map((i) => `${i.nodeId} ${i.width}x${i.height}`).join(', ')}).`,
        );
      }
      if (r.opsCount) {
        const doc = store.get(id);
        // só as raízes dos nós tocados: o resumo de um nó já mostra os descendentes
        const live = [...touched].filter((t) => findNode(doc, t));
        const roots = live.filter((t) => {
          const anc = findNode(doc, t)!.ancestors;
          return !anc.some((a) => touched.has(a.id));
        });
        const shown = roots.slice(0, MAX_SUMMARY_NODES);
        const fallback = doc.pages.flatMap((p) => p.frames).map((f) => f.id);
        lines.push(
          'Resumo:',
          ctx.summaryOf(doc, shown, fallback),
          ...(roots.length > shown.length
            ? [`… e mais ${roots.length - shown.length} nó(s).`]
            : []),
        );
      }
      return {
        text: lines.join('\n'),
        images: r.images.map((i) => ({ data: i.data, mimeType: i.mime })),
      };
    },
  );

  tool(
    'list_scripts',
    {
      title: 'Listar scripts',
      description:
        'Lista a biblioteca de scripts do documento (pasta scripts/ ao lado do .mockup.json): nome, tamanho e data. Rode um deles com run_script({ name }).',
      example: {},
      inputSchema: { docId: docIdField },
      annotations: READ,
    },
    async ({ docId }) => {
      const scripts = needScripts();
      const id = store.resolveDocId(docId);
      const { dir, scripts: list } = await scripts.list(id);
      if (!dir) {
        return 'O documento ainda não tem arquivo, então não há biblioteca de scripts. Salve-o (save_document) e crie arquivos .js na pasta scripts/ ao lado dele.';
      }
      if (!list.length) {
        return `Nenhum script em ${dir}. Crie arquivos .js nessa pasta (corpo de async function com a API doc; veja get_guide("scripts")) ou use run_script({ code }).`;
      }
      return [
        `${list.length} script(s) em ${dir}:`,
        ...list.map((s) => `- ${s.name} (${s.size} B, ${s.updatedAt})`),
        'Execute com run_script({ name: "<nome>" }).',
      ].join('\n');
    },
  );
}
