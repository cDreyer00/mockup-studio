#!/usr/bin/env node
import { startDaemon } from './daemon.js';

function parseArgs(argv: string[]) {
  const opts: {
    port?: number;
    host?: string;
    headless: boolean;
    dataDir?: string;
    openFiles: string[];
  } = {
    headless: false,
    openFiles: [],
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--port') {
      const n = Number(argv[++i]);
      if (!Number.isInteger(n) || n < 0 || n > 65535)
        throw new Error('--port exige um número entre 0 e 65535.');
      opts.port = n;
    } else if (a === '--host') opts.host = argv[++i];
    else if (a === '--headless') opts.headless = true;
    else if (a === '--data-dir') opts.dataDir = argv[++i];
    else if (a.startsWith('--')) throw new Error(`Opção desconhecida: ${a}`);
    else opts.openFiles.push(a);
  }
  return opts;
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.dataDir) process.env.MOCKUP_DATA_DIR = opts.dataDir;
  const d = await startDaemon({ ...opts, writeInfo: true });
  console.error(`[mockup-daemon] url:    ${d.url}`);
  console.error(`[mockup-daemon] mcp:    ${d.mcpUrl}`);
  console.error(`[mockup-daemon] ws:     ${d.wsUrl}`);
}

main().catch((e: unknown) => {
  console.error('[mockup-daemon] erro:', e instanceof Error ? e.message : e);
  process.exit(1);
});
