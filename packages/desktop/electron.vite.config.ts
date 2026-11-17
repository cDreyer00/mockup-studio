import { defineConfig } from 'electron-vite';

/**
 * Main process in ESM with ALL dependencies (server, core, express, ws, MCP SDK, zod...)
 * embedded in the bundle: only `electron` stays external, so electron-builder does not need node_modules.
 * `sharp` (native, optional, loaded with a dynamic import by `optimize_assets`) is also left out:
 * in development it resolves from the repository's node_modules; in the packaged app it is copied to
 * `resources/native/node_modules` (electron-builder extraResources), where the server looks for it.
 * Preload in CJS (sandbox requirement). There is no renderer build: the editor comes from packages/editor/dist.
 *
 * `bufferutil` and `utf-8-validate` (optional `ws` dependencies) are not installed: Vite replaces
 * them with an empty object instead of letting the `require` fail, and `ws` would then call
 * `{}.unmask` on every frame of 32 bytes or more coming from a client, hanging the main process
 * (the daemon stops responding at the first `op:apply`). The variables below make `ws` use the
 * JS implementation.
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
        // sharp (native, optional) and ffmpeg-static (binary) are resolved at runtime
        external: ['electron', 'sharp', 'ffmpeg-static'],
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
