/** Argumentos de linha de comando do app (puro, testável sem Electron). */
export interface AppArgs {
  headless: boolean;
  port?: number;
  dataDir?: string;
  files: string[];
}

const DOC_FILE = /\.json$/i;

/**
 * Interpreta `argv` já sem o executável (e sem o caminho do app em dev). Opções do Chromium
 * (`--inspect`, `--no-sandbox`...) e desconhecidas são ignoradas; só arquivos `.json` entram em `files`.
 */
export function parseArgs(args: string[]): AppArgs {
  const out: AppArgs = { headless: false, files: [] };
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === '--headless') out.headless = true;
    else if (a === '--port' || a.startsWith('--port=')) {
      const raw = a.includes('=') ? a.slice(a.indexOf('=') + 1) : args[++i];
      const n = raw !== undefined && raw.trim() !== '' ? Number(raw) : NaN;
      if (!Number.isInteger(n) || n < 0 || n > 65535)
        throw new Error('--port exige um número inteiro entre 0 e 65535.');
      out.port = n;
    } else if (a === '--data-dir' || a.startsWith('--data-dir=')) {
      const raw = a.includes('=') ? a.slice(a.indexOf('=') + 1) : args[++i];
      if (!raw) throw new Error('--data-dir exige um caminho.');
      out.dataDir = raw;
    } else if (!a.startsWith('-') && DOC_FILE.test(a)) out.files.push(a);
  }
  return out;
}

/** Remove o executável (e o caminho do app quando roda via `electron .`). */
export function userArgs(argv: string[], defaultApp: boolean | undefined): string[] {
  return argv.slice(defaultApp ? 2 : 1);
}
