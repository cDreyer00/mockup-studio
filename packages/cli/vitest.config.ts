import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'cli',
    include: ['src/**/*.test.ts'],
    // Tests use the Node daemon (headless Electron has its own tests in @mockup/desktop)
    env: { MOCKUP_NO_ELECTRON: '1' },
    testTimeout: 60000,
    hookTimeout: 60000,
  },
});
