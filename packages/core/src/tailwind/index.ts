/**
 * Subpacote `@mockup/core/tailwind`: o motor Tailwind v4 (compilador oficial). Fica fora do
 * índice principal do core para que o editor o carregue sob demanda (`import()`), sem pesar no
 * chunk do canvas.
 */
export * from './engine.js';
export * from './apply.js';
export * from './cache.js';
export * from './shadcn.js';
