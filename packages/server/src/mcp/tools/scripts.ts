import { z } from 'zod';
import { findNode, type DocChangedEvent } from '@mockup/core';
import { touchedNodeIds } from '../../scripts/host.js';
import { DESTRUCTIVE, READ, ToolError, docIdField, type ToolContext } from '../context.js';

const MAX_LOG_CHARS = 6000;
const MAX_RESULT_CHARS = 4000;
const MAX_SUMMARY_NODES = 6;

const clip = (s: string, max: number): string =>
  s.length > max ? `${s.slice(0, max)}\n… (truncated: ${s.length} characters)` : s;

export function registerScriptTools(ctx: ToolContext): void {
  const { tool, store, opts } = ctx;

  const needScripts = () => {
    const s = opts.services?.scripts;
    if (!s) throw new ToolError('Scripts are unavailable in this daemon.');
    return s;
  };

  tool(
    'run_script',
    {
      title: 'Run script',
      description:
        'Runs JavaScript in a sandbox with the doc API (select, get, apply, screenshot, tokens; node.style/text/name) for batch edits; one undo reverts everything. Provide code or name (scripts/*.js). See get_guide("scripts").',
      example: {
        code: "doc.select('button').forEach(b => { b.style.background = '#2563eb'; }); return doc.select('button').length;",
      },
      inputSchema: {
        code: z
          .string()
          .optional()
          .describe(
            'JavaScript code (async function body, with await and return), e.g. "return doc.select(\'h1\').map(n => n.text);".',
          ),
        name: z
          .string()
          .optional()
          .describe('Name of a script saved in scripts/ (see list_scripts), e.g. "rename".'),
        timeoutMs: z
          .number()
          .int()
          .min(100)
          .max(60_000)
          .optional()
          .describe('Maximum time in ms, from 100 to 60000 (default 10000), e.g. 20000.'),
        docId: docIdField,
      },
      annotations: DESTRUCTIVE,
    },
    async ({ code, name, timeoutMs, docId }) => {
      const scripts = needScripts();
      const id = store.resolveDocId(docId);
      if ((code === undefined) === (name === undefined)) {
        throw new ToolError(
          'Provide code (JavaScript) OR name (script saved in scripts/), not both. E.g. code "return doc.select(\'button\').length;".',
        );
      }
      const source = code ?? (await scripts.read(id, name!)).code;
      // Inside an assistant turn the script joins the turn's undo group.
      const group = ctx.group();
      // If the turn ends (or is cancelled) while the script runs, the host refuses new writes and the
      // sandbox terminates the worker: a cancelled agent does not keep writing.
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
        const head = `Script failed: ${r.error ?? 'unknown error'}`;
        const applied = r.opsCount
          ? `${r.opsCount} op(s) were already applied before the error (one undo reverts them); check with get_tree_summary.`
          : 'No ops were applied.';
        throw new ToolError([head, ...lines, applied].join('\n'));
      }
      lines.unshift(`Script ok: ${r.opsCount} op(s) applied in ${r.durationMs} ms.`);
      if (r.result !== undefined) {
        lines.push(
          `Result: ${clip(JSON.stringify(r.result, null, 2) ?? 'undefined', MAX_RESULT_CHARS)}`,
        );
      }
      if (r.images.length) {
        lines.push(
          `Images: ${r.images.length} (${r.images.map((i) => `${i.nodeId} ${i.width}x${i.height}`).join(', ')}).`,
        );
      }
      if (r.opsCount) {
        const doc = store.get(id);
        // only the roots of touched nodes: a node's summary already shows its descendants
        const live = [...touched].filter((t) => findNode(doc, t));
        const roots = live.filter((t) => {
          const anc = findNode(doc, t)!.ancestors;
          return !anc.some((a) => touched.has(a.id));
        });
        const shown = roots.slice(0, MAX_SUMMARY_NODES);
        const fallback = doc.pages.flatMap((p) => p.frames).map((f) => f.id);
        lines.push(
          'Summary:',
          ctx.summaryOf(doc, shown, fallback),
          ...(roots.length > shown.length
            ? [`… and ${roots.length - shown.length} more node(s).`]
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
      title: 'List scripts',
      description:
        "Lists the document's script library (scripts/ folder next to the .mockup.json): name, size and date. Run one with run_script({ name }).",
      example: {},
      inputSchema: { docId: docIdField },
      annotations: READ,
    },
    async ({ docId }) => {
      const scripts = needScripts();
      const id = store.resolveDocId(docId);
      const { dir, scripts: list } = await scripts.list(id);
      if (!dir) {
        return 'The document has no file yet, so there is no script library. Save it (save_document) and create .js files in the scripts/ folder next to it.';
      }
      if (!list.length) {
        return `No scripts in ${dir}. Create .js files in that folder (async function body with the doc API; see get_guide("scripts")) or use run_script({ code }).`;
      }
      return [
        `${list.length} script(s) in ${dir}:`,
        ...list.map((s) => `- ${s.name} (${s.size} B, ${s.updatedAt})`),
        'Run with run_script({ name: "<name>" }).',
      ].join('\n');
    },
  );
}
