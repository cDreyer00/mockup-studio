import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
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

export default defineConfig({
  plugins: [react()],
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
