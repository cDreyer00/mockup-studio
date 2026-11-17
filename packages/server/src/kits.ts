/**
 * Kits de componentes (`kits/*.mockup.json`): documentos com `components` (e os tokens que eles usam)
 * importáveis em qualquer documento (`import_kit`, `insert_component('kit/Nome')`, aba do editor).
 *
 * Onde fica a pasta `kits/`:
 * 1. `MOCKUP_KITS_DIR` (se definida e existente);
 * 2. empacotado: `process.resourcesPath/kits` (extraResources do electron-builder; também vale para o
 *    daemon que roda com `ELECTRON_RUN_AS_NODE=1` a partir de `resources/cli`);
 * 3. desenvolvimento e bundles (`out/cli/daemon.mjs`, `out/main`): sobe de `import.meta.url` até achar
 *    uma pasta `kits/` com arquivos `.mockup.json` (a raiz do repositório); por último, do cwd.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseDocument, type Document, type PropDef } from '@mockup/core';

export const KIT_EXT = '.mockup.json';

/** Erro de kit (inexistente, arquivo inválido); a mensagem diz o que fazer. */
export class KitError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
    this.name = 'KitError';
  }
}

function hasKitFiles(dir: string): boolean {
  try {
    return fs.readdirSync(dir).some((f) => f.toLowerCase().endsWith(KIT_EXT));
  } catch {
    return false;
  }
}

function walkUp(start: string): string | null {
  let dir = path.resolve(start);
  for (let i = 0; i < 16; i++) {
    const candidate = path.join(dir, 'kits');
    if (hasKitFiles(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/** Pasta dos kits (ver o cabeçalho do arquivo) ou `null` se não achar. */
export function findKitsDir(): string | null {
  const env = process.env.MOCKUP_KITS_DIR;
  if (env && fs.existsSync(env)) return path.resolve(env);
  const resources = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
  if (resources) {
    const packaged = path.join(resources, 'kits');
    if (hasKitFiles(packaged)) return packaged;
  }
  let here: string | null = null;
  try {
    here = path.dirname(fileURLToPath(import.meta.url));
  } catch {
    here = null;
  }
  return (here ? walkUp(here) : null) ?? walkUp(process.cwd());
}

/** Nomes dos kits disponíveis (arquivo sem `.mockup.json`), em ordem alfabética. */
export function listKitNames(): string[] {
  const dir = findKitsDir();
  if (!dir) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.toLowerCase().endsWith(KIT_EXT))
    .map((f) => f.slice(0, -KIT_EXT.length))
    .sort((a, b) => a.localeCompare(b));
}

export interface LoadedKit {
  /** Nome do kit (arquivo sem `.mockup.json`). */
  name: string;
  file: string;
  doc: Document;
}

const cache = new Map<string, { mtimeMs: number; size: number; kit: LoadedKit }>();

function loadFile(file: string, name: string): LoadedKit {
  let st: fs.Stats;
  try {
    st = fs.statSync(file);
  } catch {
    throw new KitError(404, `Arquivo de kit não encontrado: ${file}`);
  }
  const hit = cache.get(file);
  if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.kit;
  let doc: Document;
  try {
    doc = parseDocument(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    throw new KitError(
      400,
      `Kit inválido (${file}): ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  const kit: LoadedKit = { name, file, doc };
  cache.set(file, { mtimeMs: st.mtimeMs, size: st.size, kit });
  return kit;
}

/**
 * Carrega um kit pelo nome (`shadcn-like`) ou por um caminho absoluto de `.mockup.json`
 * (o nome do kit vem do arquivo). Cache por mtime.
 */
export function loadKit(nameOrPath: string): LoadedKit {
  const ref = nameOrPath.trim();
  if (!ref) throw new KitError(400, 'Informe o nome do kit (ex.: "shadcn-like").');
  if (path.isAbsolute(ref)) {
    const base = path.basename(ref);
    const name = base.toLowerCase().endsWith(KIT_EXT) ? base.slice(0, -KIT_EXT.length) : base;
    return loadFile(ref, name);
  }
  const names = listKitNames();
  const found = names.find((n) => n.toLowerCase() === ref.toLowerCase());
  const dir = findKitsDir();
  if (!found || !dir) {
    throw new KitError(
      404,
      `Kit "${ref}" não encontrado. Kits disponíveis: ${names.length ? names.join(', ') : '(nenhum)'}. Para um arquivo seu, passe o caminho absoluto do .mockup.json.`,
    );
  }
  return loadFile(path.join(dir, found + KIT_EXT), found);
}

export interface KitComponentInfo {
  id: string;
  name: string;
  description?: string;
  props: PropDef[];
}

export interface KitInfo {
  name: string;
  components: KitComponentInfo[];
}

/** Kits disponíveis com os componentes (id, nome, descrição, props); kits inválidos são ignorados. */
export function listKits(): KitInfo[] {
  const out: KitInfo[] = [];
  for (const name of listKitNames()) {
    try {
      const kit = loadKit(name);
      out.push({
        name,
        components: (kit.doc.components ?? []).map((c) => ({
          id: c.id,
          name: c.name,
          ...(c.description !== undefined ? { description: c.description } : {}),
          props: c.props,
        })),
      });
    } catch {
      // kit corrompido não derruba a listagem
    }
  }
  return out;
}
