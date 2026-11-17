// Copia o tema padrão do Tailwind (`tailwindcss/theme.css`) para um módulo TS do core, que não lê
// arquivos (roda no daemon, no editor e no Electron). Rode depois de atualizar o `tailwindcss`:
//   node packages/core/scripts/sync-tailwind-theme.mjs
// O teste `tailwind/theme.test.ts` falha se o módulo gerado estiver desatualizado.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const pkgDir = path.dirname(require.resolve('tailwindcss/package.json'));
const version = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8')).version;
const css = fs.readFileSync(path.join(pkgDir, 'theme.css'), 'utf8').replace(/\r\n/g, '\n');
const out = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '../src/tailwind/theme.generated.ts',
);
fs.writeFileSync(
  out,
  [
    '// Gerado por scripts/sync-tailwind-theme.mjs a partir de tailwindcss/theme.css (MIT). Não edite.',
    `export const TAILWIND_VERSION = ${JSON.stringify(version)};`,
    `export const TAILWIND_THEME_CSS = ${JSON.stringify(css)};`,
    '',
  ].join('\n'),
);
process.stdout.write(
  `theme.generated.ts atualizado (tailwindcss ${version}, ${css.length} caracteres)\n`,
);
