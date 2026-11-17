/**
 * Generates the CLI and Node daemon bundles for the packaged app (`out/cli/mockup.mjs` and
 * `out/cli/daemon.mjs`), self-contained (no node_modules at runtime): they run with Electron itself as
 * Node (`ELECTRON_RUN_AS_NODE=1`), since the end user has no Node installed.
 *
 * The entry is the already-compiled `dist/` of the cli and the server (the root build runs core, server, cli before
 * desktop), which avoids reconfiguring TypeScript here. ESM with CommonJS dependencies (express etc.):
 * the banner creates `require`, `__filename` and `__dirname` from `import.meta.url`.
 */
import { build } from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(root, 'out', 'cli');

const entries = {
  mockup: path.resolve(root, '..', 'cli', 'dist', 'bin.js'),
  daemon: path.resolve(root, '..', 'server', 'dist', 'bin.js'),
};
for (const file of Object.values(entries)) {
  if (!fs.existsSync(file)) {
    console.error(`[build-cli] ${file} does not exist: run the cli and server build first.`);
    process.exit(1);
  }
}

const banner = [
  "import { createRequire as __mockupCreateRequire } from 'node:module';",
  "import { fileURLToPath as __mockupFileURLToPath } from 'node:url';",
  "import { dirname as __mockupDirname } from 'node:path';",
  'const require = __mockupCreateRequire(import.meta.url);',
  'const __filename = __mockupFileURLToPath(import.meta.url);',
  'const __dirname = __mockupDirname(__filename);',
].join('\n');

fs.rmSync(outDir, { recursive: true, force: true });
await build({
  entryPoints: entries,
  outdir: outDir,
  outExtension: { '.js': '.mjs' },
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  minify: false,
  legalComments: 'none',
  // sharp is native and optional (dynamic import in optimize_assets) and ffmpeg-static is a binary
  // resolved at runtime: they stay out of the bundle; in the packaged app they come in resources/native.
  external: ['sharp', 'ffmpeg-static'],
  banner: { js: banner },
  logLevel: 'info',
});
