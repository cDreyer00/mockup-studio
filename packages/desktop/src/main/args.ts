/** App command-line arguments (pure, testable without Electron). */

/**
 * Windowless mode (daemon + render only, started by `mockup mcp`). Deliberately not `--headless`:
 * Chromium reads that as its own headless switch, and then no window of the instance ever shows up.
 */
export const HEADLESS_FLAG = '--mockup-headless';
/** Name used before the rename, still accepted from older CLIs (main also drops Chromium's switch). */
export const LEGACY_HEADLESS_FLAG = '--headless';

export interface AppArgs {
  headless: boolean;
  /** Windowless mode was requested with the old `--headless` flag. */
  legacyHeadless?: boolean;
  port?: number;
  dataDir?: string;
  files: string[];
  /** `--install-cli` / `--uninstall-cli`: runs the embedded CLI and exits, with no window or daemon. */
  cliAction?: 'install-cli' | 'uninstall-cli';
  /** Remaining arguments passed to the CLI in that action (e.g. `--bin-dir D`, `--quiet`). */
  cliArgs: string[];
}

const DOC_FILE = /\.json$/i;

/**
 * Parses `argv` already stripped of the executable (and of the app path in dev). Chromium options
 * (`--inspect`, `--no-sandbox`...) and unknown ones are ignored; only `.json` files go into `files`.
 */
export function parseArgs(args: string[]): AppArgs {
  const out: AppArgs = { headless: false, files: [], cliArgs: [] };
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === HEADLESS_FLAG) out.headless = true;
    else if (a === LEGACY_HEADLESS_FLAG) out.headless = out.legacyHeadless = true;
    else if (a === '--install-cli' || a === '--uninstall-cli')
      out.cliAction = a.slice(2) as AppArgs['cliAction'];
    else if (a === '--port' || a.startsWith('--port=')) {
      const raw = a.includes('=') ? a.slice(a.indexOf('=') + 1) : args[++i];
      const n = raw !== undefined && raw.trim() !== '' ? Number(raw) : NaN;
      if (!Number.isInteger(n) || n < 0 || n > 65535)
        throw new Error('--port requires an integer between 0 and 65535.');
      out.port = n;
    } else if (a === '--data-dir' || a.startsWith('--data-dir=')) {
      const raw = a.includes('=') ? a.slice(a.indexOf('=') + 1) : args[++i];
      if (!raw) throw new Error('--data-dir requires a path.');
      out.dataDir = raw;
    } else if (!a.startsWith('-') && DOC_FILE.test(a)) out.files.push(a);
  }
  if (out.cliAction) {
    const flag = `--${out.cliAction}`;
    out.cliArgs = args.filter((x) => x !== flag);
  }
  return out;
}

/** Removes the executable (and the app path when run via `electron .`). */
export function userArgs(argv: string[], defaultApp: boolean | undefined): string[] {
  return argv.slice(defaultApp ? 2 : 1);
}
