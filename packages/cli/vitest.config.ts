import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'cli',
    include: ['src/**/*.test.ts'],
    // os testes usam o daemon Node (o Electron headless tem teste próprio em @mockup/desktop)
    env: { MOCKUP_NO_ELECTRON: '1' },
    testTimeout: 60000,
    hookTimeout: 60000,
  },
});
