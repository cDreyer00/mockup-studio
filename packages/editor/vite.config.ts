import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build as esbuild } from 'esbuild';
import { defineConfig } from 'vitest/config';
import type { Plugin } from 'vite';
import react from '@vitejs/plugin-react';

const dirname = path.dirname(fileURLToPath(import.meta.url));
const port = process.env.VITE_DAEMON_PORT ?? '4747';
const http = `http://127.0.0.1:${port}`;
// The editor talks to the daemon over the same origin (dev and preview): /api, /assets, /cdn and /ws go through a proxy.
const proxy = {
  '/api': http,
  '/assets': http,
  '/cdn': http,
  '/ws': { target: `ws://127.0.0.1:${port}`, ws: true },
};

/**
 * Generates `vendor/three.iife.js` (window.THREE) for the Three.js islands: dev serves it from memory and the
 * build emits the file. The sandboxed iframe (opaque origin) loads it as a classic script.
 */
function threeIife(): Plugin {
  let cached: Promise<string> | undefined;
  const bundle = (): Promise<string> =>
    (cached ??= esbuild({
      stdin: {
        contents: "import * as THREE from 'three'; window.THREE = THREE;",
        resolveDir: dirname,
      },
      bundle: true,
      format: 'iife',
      minify: true,
      write: false,
    }).then((r) => r.outputFiles[0]!.text));
  return {
    name: 'mockup-three-iife',
    configureServer(server) {
      server.middlewares.use('/vendor/three.iife.js', (_req, res, next) => {
        bundle().then((code) => {
          res.setHeader('Content-Type', 'text/javascript; charset=utf-8');
          res.end(code);
        }, next);
      });
    },
    async generateBundle() {
      this.emitFile({ type: 'asset', fileName: 'vendor/three.iife.js', source: await bundle() });
    },
  };
}

export default defineConfig({
  plugins: [react(), threeIife()],
  resolve: {
    // The editor compiles against the core source.
    // The Tailwind subpackage comes first: the engine ends up in its own chunk (loaded on demand).
    alias: [
      {
        find: /^@mockup\/core\/tailwind$/,
        replacement: path.resolve(dirname, '../core/src/tailwind/index.ts'),
      },
      { find: /^@mockup\/core$/, replacement: path.resolve(dirname, '../core/src/index.ts') },
      {
        find: /^@mockup\/snapshot-core$/,
        replacement: path.resolve(dirname, '../snapshot-core/src/index.ts'),
      },
    ],
  },
  server: { proxy },
  preview: { proxy },
  build: {
    outDir: 'dist',
    // Two pages: the editor and the render page (desktop app screenshots).
    rollupOptions: {
      input: {
        main: path.resolve(dirname, 'index.html'),
        render: path.resolve(dirname, 'render.html'),
      },
    },
  },
  test: {
    name: 'editor',
    environment: 'node',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
  },
});
