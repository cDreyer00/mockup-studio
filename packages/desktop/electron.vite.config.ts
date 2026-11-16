import { defineConfig } from 'electron-vite';

/**
 * Processo principal em ESM com TODAS as dependências (server, core, express, ws, MCP SDK, zod...)
 * embutidas no bundle: só `electron` fica externo, então o electron-builder não precisa de node_modules.
 * Preload em CJS (exigência do sandbox). Não há build de renderer: o editor vem de packages/editor/dist.
 */
export default defineConfig({
  main: {
    build: {
      externalizeDeps: false,
      outDir: 'out/main',
      minify: false,
      rollupOptions: {
        input: { index: 'src/main/index.ts' },
        external: ['electron'],
        output: { format: 'es', entryFileNames: '[name].js' },
      },
    },
    ssr: { noExternal: true },
  },
  preload: {
    build: {
      externalizeDeps: false,
      outDir: 'out/preload',
      minify: false,
      rollupOptions: {
        input: { index: 'src/preload/index.ts' },
        external: ['electron'],
        output: { format: 'cjs', entryFileNames: '[name].cjs' },
      },
    },
  },
});
