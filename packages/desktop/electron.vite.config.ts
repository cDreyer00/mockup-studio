import { defineConfig } from 'electron-vite';

/**
 * Processo principal em ESM com TODAS as dependências (server, core, express, ws, MCP SDK, zod...)
 * embutidas no bundle: só `electron` fica externo, então o electron-builder não precisa de node_modules.
 * Preload em CJS (exigência do sandbox). Não há build de renderer: o editor vem de packages/editor/dist.
 *
 * `bufferutil` e `utf-8-validate` (dependências opcionais do `ws`) não estão instalados: o Vite os
 * troca por um objeto vazio em vez de deixar o `require` falhar, e o `ws` passaria a chamar
 * `{}.unmask` em todo frame de 32 bytes ou mais vindo de um cliente, travando o processo principal
 * (o daemon para de responder ao primeiro `op:apply`). As variáveis abaixo fazem o `ws` usar a
 * implementação em JS.
 */
export default defineConfig({
  main: {
    define: {
      'process.env.WS_NO_BUFFER_UTIL': JSON.stringify('1'),
      'process.env.WS_NO_UTF_8_VALIDATE': JSON.stringify('1'),
    },
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
