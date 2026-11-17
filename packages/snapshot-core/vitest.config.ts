import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'snapshot-core',
    include: ['src/**/*.test.ts', 'test/**/*.test.ts'],
    testTimeout: 60000,
    hookTimeout: 60000,
  },
});
