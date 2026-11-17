/**
 * Component kits (`kits/*.mockup.json`): documents with `components` (and the tokens they use)
 * importable into any document (`import_kit`, `insert_component('kit/Name')`, editor tab).
 *
 * Where the `kits/` folder lives:
 * 1. `MOCKUP_KITS_DIR` (if set and existing);
 * 2. packaged: `process.resourcesPath/kits` (electron-builder extraResources; also applies to the
 *    daemon running with `ELECTRON_RUN_AS_NODE=1` from `resources/cli`);
 * 3. development and bundles (`out/cli/daemon.mjs`, `out/main`): walks up from `import.meta.url` until it finds
 *    a `kits/` folder with `.mockup.json` files (the repository root); lastly, from the cwd.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateDocument, type Document, type PropDef } from '@mockup/core';

export const KIT_EXT = '.mockup.json';

/** Kit error (missing, invalid file); the message says what to do. */
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

/** Kits folder (see the file header) or `null` if not found. */
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

/** Names of the available kits (file without `.mockup.json`), in alphabetical order. */
export function listKitNames(): string[] {
  const dir = findKitsDir();
  if (!dir) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.toLowerCase().endsWith(KIT_EXT))
    .map((f) => f.slice(0, -KIT_EXT.length))
    .sort((a, b) => a.localeCompare(b, 'en-US'));
}

export interface LoadedKit {
  /** Kit name (file without `.mockup.json`). */
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
    throw new KitError(404, `Kit file not found: ${file}`);
  }
  const hit = cache.get(file);
  if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.kit;
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    throw new KitError(400, `Could not read the kit file: ${file}`);
  }
  // The raw JSON.parse message can carry excerpts of the file: only "Invalid JSON".
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new KitError(400, `Invalid kit (${file}): Invalid JSON`);
  }
  const r = validateDocument(data);
  if (!r.ok) {
    const more = r.errors.length > 5 ? ` (+${r.errors.length - 5})` : '';
    throw new KitError(400, `Invalid kit (${file}): ${r.errors.slice(0, 5).join('; ')}${more}`);
  }
  const doc = r.doc;
  const kit: LoadedKit = { name, file, doc };
  cache.set(file, { mtimeMs: st.mtimeMs, size: st.size, kit });
  return kit;
}

/**
 * Loads a kit by name (`shadcn-like`) or by an absolute `.mockup.json` path
 * (the extension is required; the kit name comes from the file). Cached by mtime. File with
 * malformed JSON: "Invalid JSON" (without passing on the parser's message); invalid document: the
 * schema errors.
 */
export function loadKit(nameOrPath: string): LoadedKit {
  const ref = nameOrPath.trim();
  if (!ref) throw new KitError(400, 'Pass the kit name (e.g. "shadcn-like").');
  if (path.isAbsolute(ref)) {
    const base = path.basename(ref);
    if (!base.toLowerCase().endsWith(KIT_EXT) || base.length === KIT_EXT.length) {
      throw new KitError(400, `The kit file must have the ${KIT_EXT} extension (got "${base}").`);
    }
    return loadFile(ref, base.slice(0, -KIT_EXT.length));
  }
  const names = listKitNames();
  const found = names.find((n) => n.toLowerCase() === ref.toLowerCase());
  const dir = findKitsDir();
  if (!found || !dir) {
    throw new KitError(
      404,
      `Kit "${ref}" not found. Available kits: ${names.length ? names.join(', ') : '(none)'}. For your own file, pass the absolute path of the .mockup.json.`,
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

/** Available kits with their components (id, name, description, props); invalid kits are ignored. */
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
      // a corrupted kit does not break the listing
    }
  }
  return out;
}
