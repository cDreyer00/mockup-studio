import path from 'node:path';
import { z } from 'zod';
import { searchNodes } from '@mockup/core';
import { FilesError, getFileIndex, type FileEntry, type FileIndex } from '../../files.js';
import { READ, ToolError, WRITE, DESTRUCTIVE, type ToolContext } from '../context.js';

const pathField = z
  .string()
  .optional()
  .describe('Absolute path of the .mockup.json, e.g.: "C:/projects/site.mockup.json".');

const line = (f: FileEntry): string => {
  const parts = [f.path];
  parts.push(`folder: ${f.folder ?? '-'}`);
  if (f.tags.length) parts.push(`tags: ${f.tags.join(', ')}`);
  if (f.favorite) parts.push('favorite');
  parts.push(f.missing ? 'FILE MISSING' : `${f.pages} page(s), ${f.frames} frame(s)`);
  if (f.open) parts.push(`open (${f.docId})`);
  if (f.match) parts.push(`matched in ${f.match.field}: ${f.match.snippet}`);
  return parts.join(' | ');
};

/** Converts index errors into tool errors (message already ready). */
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

  /** File path from `path` (absolute) or from the `docId` of an open document. */
  const resolvePath = (p?: string, docId?: string): string => {
    if (docId) {
      const info = store.getInfo(docId);
      if (!info.path)
        throw new ToolError(
          `Document ${docId} has no file on disk yet. Save it first (save_document).`,
        );
      return info.path;
    }
    if (!p)
      throw new ToolError(
        'Provide path (absolute path of the .mockup.json) or docId (open document).',
      );
    if (!path.isAbsolute(p))
      throw new ToolError(
        `path must be absolute: "${p}". Use the full path (see list_files) or pass docId.`,
      );
    return p;
  };

  tool(
    'list_files',
    {
      title: 'List files',
      description:
        'Lists the known .mockup.json files (open, recent and registered): folder, tags, favorite, pages/frames and the matching snippet; folders and tags on top. folder filters (recursive includes subfolders; "/" = no folder); query searches name, tags and content.',
      example: { folder: 'Clients', recursive: true, query: 'monthly plan' },
      inputSchema: {
        folder: z
          .string()
          .optional()
          .describe('Virtual folder, e.g.: "Clients/Acme" (default: all files).'),
        tag: z.string().optional().describe('Only files with this tag, e.g.: "draft".'),
        query: z
          .string()
          .optional()
          .describe('Text searched in the name, tags and content, e.g.: "monthly plan".'),
        favorites: z.boolean().optional().describe('true: favorites only.'),
        recursive: z.boolean().optional().describe('true: includes the subfolders of folder.'),
      },
      annotations: READ,
    },
    async ({ folder, tag, query, favorites, recursive }) => {
      const r = await guard(() => index().list({ folder, tag, query, favorites, recursive }));
      const head = [
        `Folders: ${r.folders.length ? r.folders.join(', ') : '(none)'}`,
        `Tags: ${r.tags.length ? r.tags.join(', ') : '(none)'}`,
        `${r.files.length} file(s):`,
      ];
      return [...head, ...r.files.map(line)].join('\n');
    },
  );

  tool(
    'search_nodes',
    {
      title: 'Search nodes',
      description:
        'Searches nodes (text, name, tag, class, id, attribute, data) in the open documents or in docId; all terms must match. Filters: tag:button, name:hero, text:"contact us", class:card, id:tx_, attr:href, data:price. Accent- and case-insensitive.',
      example: { query: 'tag:button text:"Buy"', limit: 10 },
      inputSchema: {
        query: z.string().describe('Query, e.g.: "tag:button text:buy" or "price".'),
        docId: z
          .string()
          .optional()
          .describe('Document id (default: searches all open documents).'),
        limit: z.number().int().min(1).max(500).optional().describe('Maximum nodes (default 30).'),
      },
      annotations: READ,
    },
    ({ query, docId, limit }) => {
      if (!query.trim())
        throw new ToolError('Empty query. E.g.: "tag:button", "text:\\"contact us\\"" or "price".');
      const max = limit ?? 30;
      const infos = docId ? [store.getInfo(docId)] : store.list();
      if (infos.length === 0)
        throw new ToolError('No open documents. Use open_document(path) before searching.');
      const lines: string[] = [];
      for (const info of infos) {
        if (lines.length >= max) break;
        for (const m of searchNodes(store.get(info.docId), query, { limit: max - lines.length })) {
          lines.push(`${info.docId} ${m.nodeId} "${m.name}" ${m.tag} ${m.field}: ${m.snippet}`);
        }
      }
      if (lines.length === 0) return `No nodes matched "${query}".`;
      return [`${lines.length} node(s):`, ...lines].join('\n');
    },
  );

  tool(
    'tag_file',
    {
      title: 'File tags and favorite',
      description:
        'Edits the tags and favorite of a file (absolute path or docId). tags replaces all; add/remove adjust. Tags are trimmed, without empty ones or duplicates (case-insensitive).',
      example: { path: 'C:/projects/site.mockup.json', add: ['client'], favorite: true },
      inputSchema: {
        path: pathField,
        docId: z.string().optional().describe('Open document, instead of path.'),
        add: z.array(z.string()).optional().describe('Tags to add, e.g.: ["client"].'),
        remove: z.array(z.string()).optional().describe('Tags to remove, e.g.: ["draft"].'),
        tags: z.array(z.string()).optional().describe('Replaces all tags, e.g.: ["final"].'),
        favorite: z.boolean().optional().describe('Marks or unmarks as favorite.'),
      },
      annotations: WRITE,
    },
    async ({ path: p, docId, add, remove, tags, favorite }) => {
      if (!add && !remove && !tags && favorite === undefined)
        throw new ToolError('Nothing to change. Provide add, remove, tags or favorite.');
      const e = await guard(() =>
        index().setMeta(resolvePath(p, docId), {
          tags,
          addTags: add,
          removeTags: remove,
          favorite,
        }),
      );
      return `${e.path}\ntags: ${e.tags.length ? e.tags.join(', ') : '(none)'} | favorite: ${e.favorite ? 'yes' : 'no'}`;
    },
  );

  tool(
    'manage_folders',
    {
      title: 'File folders',
      description:
        'Manages virtual folders (nested by "/", organization only, they do not touch the disk). create creates with the ancestors; rename (path -> to) moves subfolders and files; delete moves the files up to the parent folder and removes the subfolders; list shows the folders with the file count.',
      example: { action: 'rename', path: 'Clients/Acme', to: 'Clients/Acme Corp' },
      inputSchema: {
        action: z.enum(['create', 'rename', 'delete', 'list']).describe('Operation.'),
        path: z.string().optional().describe('Folder, e.g.: "Clients/Acme" (not used by list).'),
        to: z.string().optional().describe('New path (rename only).'),
      },
      annotations: DESTRUCTIVE,
    },
    async ({ action, path: p, to }) => {
      if (action !== 'list' && !p)
        throw new ToolError(
          `${action} requires path. E.g.: { "action": "${action}", "path": "Clients/Acme" }.`,
        );
      let folders: string[];
      if (action === 'list') folders = index().folders();
      else if (action === 'create') folders = await guard(() => index().createFolder(p!));
      else if (action === 'delete') folders = await guard(() => index().deleteFolder(p!));
      else {
        if (!to) throw new ToolError('rename requires to (new path). E.g.: "Clients/Acme Corp".');
        folders = await guard(() => index().renameFolder(p!, to));
      }
      const all = (await index().list()).files;
      const count = (f: string): number => all.filter((x) => x.folder === f).length;
      const body = folders.length
        ? folders.map((f) => `${f} (${count(f)} file(s))`).join('\n')
        : '(no folders)';
      return `${action === 'list' ? 'Folders' : `Done (${action}). Folders now`}:\n${body}`;
    },
  );

  tool(
    'move_files',
    {
      title: 'Move files to a folder',
      description:
        'Moves files (absolute paths and/or open docIds) to a virtual folder, creating it if needed. folder null (or "") removes them from the folder.',
      example: { paths: ['C:/projects/site.mockup.json'], folder: 'Clients/Acme' },
      inputSchema: {
        paths: z.array(z.string()).optional().describe('Absolute paths of the files.'),
        docIds: z.array(z.string()).optional().describe('Ids of open documents.'),
        folder: z
          .string()
          .nullable()
          .describe('Destination folder, e.g.: "Clients/Acme"; null to remove from the folder.'),
      },
      annotations: WRITE,
    },
    async ({ paths, docIds, folder }) => {
      const targets = [
        ...(paths ?? []).map((p) => resolvePath(p)),
        ...(docIds ?? []).map((d) => resolvePath(undefined, d)),
      ];
      if (targets.length === 0) throw new ToolError('Provide paths and/or docIds to move.');
      const lines: string[] = [];
      for (const t of targets) {
        const e = await guard(() => index().setMeta(t, { folder: folder || null }));
        lines.push(`${e.path} -> ${e.folder ?? '(no folder)'}`);
      }
      return [`${lines.length} file(s) moved:`, ...lines].join('\n');
    },
  );
}
