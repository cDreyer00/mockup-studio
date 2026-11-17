/* global console */
/**
 * Extension build: bundles content/background/popup with esbuild and assembles `dist/` (loadable via
 * "Load unpacked"). `@mockup/snapshot-core` is resolved to the sources, without depending on dist.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist');
const coreSrc = path.resolve(root, '../snapshot-core/src');

const snapshotSources = {
  '@mockup/snapshot-core': path.join(coreSrc, 'index.ts'),
  '@mockup/snapshot-core/browser': path.join(coreSrc, 'browser.ts'),
};
const snapshotSourcesPlugin = {
  name: 'snapshot-core-sources',
  setup(b) {
    b.onResolve({ filter: /^@mockup\/snapshot-core(\/browser)?$/ }, (args) => ({
      path: snapshotSources[args.path],
    }));
  },
};

fs.rmSync(dist, { recursive: true, force: true });
fs.mkdirSync(path.join(dist, 'icons'), { recursive: true });

const common = {
  bundle: true,
  platform: 'browser',
  target: ['chrome110'],
  legalComments: 'none',
  plugins: [snapshotSourcesPlugin],
  logLevel: 'warning',
};
await Promise.all([
  build({
    ...common,
    entryPoints: [path.join(root, 'src/content.ts')],
    format: 'iife',
    outfile: path.join(dist, 'content.js'),
  }),
  build({
    ...common,
    entryPoints: [path.join(root, 'src/background.ts')],
    format: 'esm',
    outfile: path.join(dist, 'background.js'),
  }),
  build({
    ...common,
    entryPoints: [path.join(root, 'src/popup.ts')],
    format: 'iife',
    outfile: path.join(dist, 'popup.js'),
  }),
]);

for (const file of ['manifest.json', 'popup.html', 'popup.css']) {
  fs.copyFileSync(path.join(root, file), path.join(dist, file));
}
fs.copyFileSync(path.resolve(root, '../desktop/build/icon.png'), path.join(dist, 'icons/icon.png'));
console.log(`extension assembled in ${dist}`);
