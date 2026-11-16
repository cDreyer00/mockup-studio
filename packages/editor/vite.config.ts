import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const dirname = path.dirname(fileURLToPath(import.meta.url));
const port = process.env.VITE_DAEMON_PORT ?? '4747';
const http = `http://127.0.0.1:${port}`;

export default defineConfig({
  plugins: [react()],
  resolve: {
    // O editor compila contra o fonte do core (apenas tipos).
    alias: { '@mockup/core': path.resolve(dirname, '../core/src/index.ts') },
  },
  server: {
    proxy: {
      '/api': http,
      '/assets': http,
      '/ws': { target: `ws://127.0.0.1:${port}`, ws: true },
    },
  },
  build: { outDir: 'dist' },
});
