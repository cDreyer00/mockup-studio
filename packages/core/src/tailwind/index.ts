/**
 * `@mockup/core/tailwind` subpackage: the Tailwind v4 engine (official compiler). It stays out of the
 * core main index so the editor loads it on demand (`import()`), without weighing on the
 * canvas chunk.
 */
export * from './engine.js';
export * from './apply.js';
export * from './cache.js';
export * from './shadcn.js';
