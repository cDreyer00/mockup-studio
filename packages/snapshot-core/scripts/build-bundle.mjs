/* global console */
/**
 * Gera o bundle IIFE injetável (`dist/snapshot.iife.js`, global `MockupSnapshot`) e o módulo
 * `dist/inject.js`, que exporta o mesmo código como string (`SNAPSHOT_SCRIPT`) para quem injeta via
 * `executeJavaScript` (app desktop).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist');
fs.mkdirSync(dist, { recursive: true });

const result = await build({
  entryPoints: [path.join(root, 'src/iife.ts')],
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: ['chrome110'],
  minify: true,
  legalComments: 'none',
  write: false,
});
const code = result.outputFiles[0].text;
fs.writeFileSync(path.join(dist, 'snapshot.iife.js'), code);
fs.writeFileSync(
  path.join(dist, 'inject.js'),
  `/** Código do bundle IIFE (define globalThis.MockupSnapshot). Gerado por scripts/build-bundle.mjs. */\nexport const SNAPSHOT_SCRIPT = ${JSON.stringify(code)};\n`,
);
fs.writeFileSync(
  path.join(dist, 'inject.d.ts'),
  '/** Código do bundle IIFE (define globalThis.MockupSnapshot). */\nexport declare const SNAPSHOT_SCRIPT: string;\n',
);
console.log(`snapshot.iife.js ${(code.length / 1024).toFixed(1)} KB`);
