import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build as esbuild } from 'esbuild';
import { defineConfig } from 'vitest/config';
import type { Plugin } from 'vite';
import react from '@vitejs/plugin-react';

const dirname = path.dirname(fileURLToPath(import.meta.url));
const port = process.env.VITE_DAEMON_PORT ?? '4747';
const http = `http://127.0.0.1:${port}`;
// O editor fala com o daemon pela mesma origem (dev e preview): /api, /assets e /ws vão por proxy.
const proxy = {
  '/api': http,
  '/assets': http,
  '/ws': { target: `ws://127.0.0.1:${port}`, ws: true },
};

/**
 * Gera `vendor/three.iife.js` (window.THREE) para as ilhas Three.js: o dev serve em memória e o
 * build emite o arquivo. O iframe sandbox (origem opaca) o carrega como script clássico.
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
    // O editor compila contra o fonte do core.
    alias: { '@mockup/core': path.resolve(dirname, '../core/src/index.ts') },
  },
  server: { proxy },
  preview: { proxy },
  build: {
    outDir: 'dist',
    // Duas páginas: o editor e a página de render (screenshots do app desktop).
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
