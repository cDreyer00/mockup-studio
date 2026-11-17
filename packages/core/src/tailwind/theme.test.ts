import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { TAILWIND_THEME_CSS, TAILWIND_VERSION } from './theme.generated.js';

describe('theme.generated.ts', () => {
  it('está em dia com tailwindcss/theme.css (rode scripts/sync-tailwind-theme.mjs se falhar)', () => {
    const require = createRequire(import.meta.url);
    const pkgDir = path.dirname(require.resolve('tailwindcss/package.json'));
    const css = fs.readFileSync(path.join(pkgDir, 'theme.css'), 'utf8').replace(/\r\n/g, '\n');
    const version = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8')).version;
    expect(TAILWIND_VERSION).toBe(version);
    expect(TAILWIND_THEME_CSS).toBe(css);
  });
});
