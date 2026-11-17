/**
 * Gera o bundle do CLI e do daemon Node para o app empacotado (`out/cli/mockup.mjs` e
 * `out/cli/daemon.mjs`), autocontidos (sem node_modules em runtime): rodam com o próprio Electron como
 * Node (`ELECTRON_RUN_AS_NODE=1`), pois o usuário final não tem Node instalado.
 *
 * A entrada é o `dist/` já compilado do cli e do server (o build da raiz roda core, server, cli antes
 * do desktop), que evita reconfigurar o TypeScript aqui. ESM com dependências CommonJS (express etc.):
 * o banner cria `require`, `__filename` e `__dirname` a partir de `import.meta.url`.
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
    console.error(`[build-cli] ${file} não existe: rode o build do cli e do server antes.`);
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
  // sharp é nativo e opcional (import dinâmico em optimize_assets) e ffmpeg-static é um binário
  // resolvido em runtime: ficam fora do bundle; no app empacotado vêm em resources/native.
  external: ['sharp', 'ffmpeg-static'],
  banner: { js: banner },
  logLevel: 'info',
});
