import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'desktop',
    include: ['src/**/*.test.ts'],
    testTimeout: 120000,
    hookTimeout: 120000,
    // o teste de integração sobe o Electron real: um arquivo por vez
    fileParallelism: false,
  },
});
