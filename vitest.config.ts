import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      'packages/core',
      'packages/snapshot-core',
      'packages/server',
      'packages/cli',
      'packages/editor',
      'packages/desktop',
    ],
  },
});
