#!/usr/bin/env node
import { create, open, parsePort, serve } from './commands.js';
import { runStdioProxy } from './proxy.js';

// parsePort vive em commands.ts (importar este arquivo executa o CLI); reexportado por conveniência.
export { parsePort };

const HELP = `mockup - Mockup Studio CLI

Uso:
  mockup mcp                       Servidor MCP por stdio (sobe o daemon se preciso)
  mockup serve [--port N] [arq...] Daemon em primeiro plano
  mockup open <arquivo>            Abre um .mockup.json no daemon
  mockup new <arquivo> [--name N]  Cria um .mockup.json e abre
  mockup help

Variáveis: MOCKUP_PORT (padrão 4747), MOCKUP_DATA_DIR (pasta de dados).`;

interface Parsed {
  command: string | undefined;
  positional: string[];
  flags: Record<string, string | boolean>;
}

function parseArgs(argv: string[]): Parsed {
  const [command, ...rest] = argv;
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a.startsWith('--')) {
      const [k, inline] = a.slice(2).split('=', 2);
      if (inline !== undefined) flags[k] = inline;
      else if (rest[i + 1] !== undefined && !rest[i + 1].startsWith('--')) flags[k] = rest[++i];
      else flags[k] = true;
    } else positional.push(a);
  }
  return { command, positional, flags };
}

async function main(): Promise<void> {
  const { command, positional, flags } = parseArgs(process.argv.slice(2));
  const port = parsePort(typeof flags.port === 'string' ? flags.port : undefined);

  switch (command) {
    case 'mcp':
      await runStdioProxy();
      return;
    case 'serve':
      await serve({ port, files: positional });
      return;
    case 'open':
      if (!positional[0]) throw new Error('Uso: mockup open <arquivo>');
      await open(positional[0]);
      return;
    case 'new':
      if (!positional[0]) throw new Error('Uso: mockup new <arquivo> [--name Nome]');
      await create(positional[0], typeof flags.name === 'string' ? flags.name : undefined);
      return;
    case undefined:
    case 'help':
    case '--help':
    case '-h':
      console.error(HELP);
      return;
    default:
      throw new Error(`Comando desconhecido: ${command}\n\n${HELP}`);
  }
}

main().catch((err: unknown) => {
  console.error('[mockup] erro:', err instanceof Error ? err.message : err);
  process.exit(1);
});
