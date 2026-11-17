import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'desktop',
    include: ['src/**/*.test.ts'],
    testTimeout: 120000,
    hookTimeout: 120000,
    // the integration test starts real Electron: one file at a time
    fileParallelism: false,
  },
});
