import path from 'node:path';
import { z } from 'zod';
import { searchNodes } from '@mockup/core';
import { FilesError, getFileIndex, type FileEntry, type FileIndex } from '../../files.js';
import { READ, ToolError, WRITE, DESTRUCTIVE, type ToolContext } from '../context.js';

const pathField = z
  .string()
  .optional()
  .describe('Caminho absoluto do .mockup.json, ex.: "C:/projetos/site.mockup.json".');

const line = (f: FileEntry): string => {
  const parts = [f.path];
  parts.push(`pasta: ${f.folder ?? '-'}`);
  if (f.tags.length) parts.push(`tags: ${f.tags.join(', ')}`);
  if (f.favorite) parts.push('favorito');
  parts.push(f.missing ? 'ARQUIVO AUSENTE' : `${f.pages} pág., ${f.frames} frames`);
  if (f.open) parts.push(`aberto (${f.docId})`);
  if (f.match) parts.push(`casou em ${f.match.field}: ${f.match.snippet}`);
  return parts.join(' | ');
};

/** Converte erros do índice em erros de ferramenta (mensagem em português já pronta). */
async function guard<T>(fn: () => Promise<T> | T): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof FilesError) throw new ToolError(e.message);
    throw e;
  }
}

export function registerFilesTools(ctx: ToolContext): void {
  const { tool, store, opts } = ctx;
  const index = (): FileIndex => getFileIndex(store, opts.dataDir);

  /** Caminho do arquivo a partir de `path` (absoluto) ou do `docId` de um documento aberto. */
  const resolvePath = (p?: string, docId?: string): string => {
    if (docId) {
      const info = store.getInfo(docId);
      if (!info.path)
        throw new ToolError(
          `O documento ${docId} ainda não tem arquivo em disco. Salve-o antes (save_document).`,
        );
      return info.path;
    }
    if (!p)
      throw new ToolError(
        'Informe path (caminho absoluto do .mockup.json) ou docId (documento aberto).',
      );
    if (!path.isAbsolute(p))
      throw new ToolError(
        `path deve ser absoluto: "${p}". Use o caminho completo (veja list_files) ou passe docId.`,
      );
    return p;
  };

  tool(
    'list_files',
    {
      title: 'Listar arquivos',
      description:
        'Lista os arquivos .mockup.json conhecidos (abertos, recentes e registrados), uma linha por arquivo com pasta, tags, favorito, páginas/frames, se está aberto e o trecho que casou. No topo vêm as pastas e tags existentes. Sem folder lista todos; com folder só os diretamente nela (recursive inclui subpastas; "/" = sem pasta). query busca em nome, tags e conteúdo (sem acento).',
      example: { folder: 'Clientes', recursive: true, query: 'plano mensal' },
      inputSchema: {
        folder: z
          .string()
          .optional()
          .describe('Pasta virtual, ex.: "Clientes/Acme" (padrão: todos os arquivos).'),
        tag: z.string().optional().describe('Só arquivos com esta tag, ex.: "rascunho".'),
        query: z
          .string()
          .optional()
          .describe('Texto buscado no nome, nas tags e no conteúdo, ex.: "plano mensal".'),
        favorites: z.boolean().optional().describe('true: só favoritos.'),
        recursive: z.boolean().optional().describe('true: inclui as subpastas de folder.'),
      },
      annotations: READ,
    },
    async ({ folder, tag, query, favorites, recursive }) => {
      const r = await guard(() => index().list({ folder, tag, query, favorites, recursive }));
      const head = [
        `Pastas: ${r.folders.length ? r.folders.join(', ') : '(nenhuma)'}`,
        `Tags: ${r.tags.length ? r.tags.join(', ') : '(nenhuma)'}`,
        `${r.files.length} arquivo(s):`,
      ];
      return [...head, ...r.files.map(line)].join('\n');
    },
  );

  tool(
    'search_nodes',
    {
      title: 'Buscar nós',
      description:
        'Busca nós por texto, nome, tag, classe, id, atributo e dados de repetidor nos documentos abertos (ou só em docId). Termos livres precisam aparecer todos; filtros: tag:button, name:hero, text:"fale conosco", class:card, id:tx_, attr:href, data:preço. Sem acento e sem diferenciar caixa. Uma linha por nó: docId nodeId "nome" tag campo: trecho.',
      example: { query: 'tag:button text:"Comprar"', limit: 10 },
      inputSchema: {
        query: z.string().describe('Consulta, ex.: "tag:button text:comprar" ou "preço".'),
        docId: z
          .string()
          .optional()
          .describe('Id do documento (padrão: busca em todos os abertos).'),
        limit: z.number().int().min(1).max(500).optional().describe('Máximo de nós (padrão 30).'),
      },
      annotations: READ,
    },
    ({ query, docId, limit }) => {
      if (!query.trim())
        throw new ToolError(
          'query vazia. Ex.: "tag:button", "text:\\"fale conosco\\"" ou "preço".',
        );
      const max = limit ?? 30;
      const infos = docId ? [store.getInfo(docId)] : store.list();
      if (infos.length === 0)
        throw new ToolError('Nenhum documento aberto. Use open_document(path) antes de buscar.');
      const lines: string[] = [];
      for (const info of infos) {
        if (lines.length >= max) break;
        for (const m of searchNodes(store.get(info.docId), query, { limit: max - lines.length })) {
          lines.push(`${info.docId} ${m.nodeId} "${m.name}" ${m.tag} ${m.field}: ${m.snippet}`);
        }
      }
      if (lines.length === 0) return `Nenhum nó casou com "${query}".`;
      return [`${lines.length} nó(s):`, ...lines].join('\n');
    },
  );

  tool(
    'tag_file',
    {
      title: 'Tags e favorito do arquivo',
      description:
        'Edita as tags e o favorito de um arquivo (path absoluto ou docId). tags substitui todas; add/remove ajustam. Tags são aparadas, sem vazias e sem duplicatas (sem diferenciar caixa).',
      example: { path: 'C:/projetos/site.mockup.json', add: ['cliente'], favorite: true },
      inputSchema: {
        path: pathField,
        docId: z.string().optional().describe('Documento aberto, no lugar de path.'),
        add: z.array(z.string()).optional().describe('Tags a adicionar, ex.: ["cliente"].'),
        remove: z.array(z.string()).optional().describe('Tags a remover, ex.: ["rascunho"].'),
        tags: z.array(z.string()).optional().describe('Substitui todas as tags, ex.: ["final"].'),
        favorite: z.boolean().optional().describe('Marca ou desmarca como favorito.'),
      },
      annotations: WRITE,
    },
    async ({ path: p, docId, add, remove, tags, favorite }) => {
      if (!add && !remove && !tags && favorite === undefined)
        throw new ToolError('Nada a alterar. Informe add, remove, tags ou favorite.');
      const e = await guard(() =>
        index().setMeta(resolvePath(p, docId), {
          tags,
          addTags: add,
          removeTags: remove,
          favorite,
        }),
      );
      return `${e.path}\ntags: ${e.tags.length ? e.tags.join(', ') : '(nenhuma)'} | favorito: ${e.favorite ? 'sim' : 'não'}`;
    },
  );

  tool(
    'manage_folders',
    {
      title: 'Pastas de arquivos',
      description:
        'Gerencia as pastas virtuais (aninhadas por "/", só organização, não mexem no disco). create cria com os ancestrais; rename (path -> to) move subpastas e arquivos; delete sobe os arquivos para a pasta-mãe e remove as subpastas; list mostra as pastas com a contagem de arquivos.',
      example: { action: 'rename', path: 'Clientes/Acme', to: 'Clientes/Acme Corp' },
      inputSchema: {
        action: z.enum(['create', 'rename', 'delete', 'list']).describe('Operação.'),
        path: z.string().optional().describe('Pasta, ex.: "Clientes/Acme" (não vale em list).'),
        to: z.string().optional().describe('Novo caminho (só em rename).'),
      },
      annotations: DESTRUCTIVE,
    },
    async ({ action, path: p, to }) => {
      if (action !== 'list' && !p)
        throw new ToolError(
          `${action} exige path. Ex.: { "action": "${action}", "path": "Clientes/Acme" }.`,
        );
      let folders: string[];
      if (action === 'list') folders = index().folders();
      else if (action === 'create') folders = await guard(() => index().createFolder(p!));
      else if (action === 'delete') folders = await guard(() => index().deleteFolder(p!));
      else {
        if (!to) throw new ToolError('rename exige to (novo caminho). Ex.: "Clientes/Acme Corp".');
        folders = await guard(() => index().renameFolder(p!, to));
      }
      const all = (await index().list()).files;
      const count = (f: string): number => all.filter((x) => x.folder === f).length;
      const body = folders.length
        ? folders.map((f) => `${f} (${count(f)} arquivo(s))`).join('\n')
        : '(nenhuma pasta)';
      return `${action === 'list' ? 'Pastas' : `Feito (${action}). Pastas agora`}:\n${body}`;
    },
  );

  tool(
    'move_files',
    {
      title: 'Mover arquivos para uma pasta',
      description:
        'Move arquivos (caminhos absolutos e/ou docIds abertos) para uma pasta virtual, criando-a se preciso. folder null (ou "") tira da pasta.',
      example: { paths: ['C:/projetos/site.mockup.json'], folder: 'Clientes/Acme' },
      inputSchema: {
        paths: z.array(z.string()).optional().describe('Caminhos absolutos dos arquivos.'),
        docIds: z.array(z.string()).optional().describe('Ids de documentos abertos.'),
        folder: z
          .string()
          .nullable()
          .describe('Pasta de destino, ex.: "Clientes/Acme"; null para tirar da pasta.'),
      },
      annotations: WRITE,
    },
    async ({ paths, docIds, folder }) => {
      const targets = [
        ...(paths ?? []).map((p) => resolvePath(p)),
        ...(docIds ?? []).map((d) => resolvePath(undefined, d)),
      ];
      if (targets.length === 0) throw new ToolError('Informe paths e/ou docIds a mover.');
      const lines: string[] = [];
      for (const t of targets) {
        const e = await guard(() => index().setMeta(t, { folder: folder || null }));
        lines.push(`${e.path} -> ${e.folder ?? '(sem pasta)'}`);
      }
      return [`${lines.length} arquivo(s) movido(s):`, ...lines].join('\n');
    },
  );
}
