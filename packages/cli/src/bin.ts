#!/usr/bin/env node
import { create, open, parsePort, serve, stop } from './commands.js';
import { formatDoctor, runDoctor } from './doctor.js';
import { installCli, uninstallCli } from './install.js';
import { parseLaunchKind } from './launch.js';
import { runStdioProxy } from './proxy.js';
import { runSetup, type SetupTarget } from './setup.js';
import { VERSION } from './version.js';

// parsePort vive em commands.ts (importar este arquivo executa o CLI); reexportado por conveniência.
export { parsePort };

const HELP = `mockup - Mockup Studio CLI

Uso:
  mockup mcp                       Servidor MCP por stdio (sobe o daemon se preciso;
                                   usa o Electron headless quando disponível, com screenshot)
  mockup serve [--port N] [arq...] Daemon Node em primeiro plano (editor em http://127.0.0.1:PORTA/)
  mockup serve --render [arq...]   Electron headless em primeiro plano (com screenshot)
  mockup open <arquivo>            Abre um .mockup.json no daemon
  mockup new <arquivo> [--name N]  Cria um .mockup.json e abre
  mockup stop                      Encerra o daemon descoberto (daemon Node ou Electron headless),
                                   salvando os documentos; o app desktop com janela recusa
  mockup doctor [--json] [--command K]
                                   Diagnóstico do ambiente e comandos de registro prontos
  mockup setup claude|codex|all [--http] [--skill] [--print] [--command K]
                                   Registra o servidor MCP no Claude Code/Codex (--print só mostra
                                   os comandos; --skill instala a skill no Claude Code;
                                   K = path|shim|absolute: como o cliente lança o mockup)
  mockup install-cli [--bin-dir D] [--quiet]
                                   Instala o comando mockup (shim + PATH do usuário)
  mockup uninstall-cli [--bin-dir D] [--quiet]
                                   Remove o shim e a entrada do PATH
  mockup version                   Versão do CLI
  mockup help

Variáveis: MOCKUP_PORT (padrão 4747), MOCKUP_DATA_DIR (pasta de dados; repassada ao app só se definida),
           MOCKUP_DESKTOP_EXE (executável do app desktop), MOCKUP_NO_ELECTRON=1 (força o daemon Node).`;

interface Parsed {
  command: string | undefined;
  positional: string[];
  flags: Record<string, string | boolean>;
}

/** Flags sem valor (não consomem o próximo argumento). */
const BOOLEAN_FLAGS = new Set(['render', 'http', 'skill', 'print', 'json', 'quiet']);

function parseArgs(argv: string[]): Parsed {
  const [command, ...rest] = argv;
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a.startsWith('--')) {
      const [k, inline] = a.slice(2).split('=', 2);
      if (inline !== undefined) flags[k] = inline;
      else if (BOOLEAN_FLAGS.has(k)) flags[k] = true;
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
      await serve({ port, files: positional, render: flags.render === true });
      return;
    case 'stop':
      await stop();
      return;
    case 'open':
      if (!positional[0]) throw new Error('Uso: mockup open <arquivo>');
      await open(positional[0]);
      return;
    case 'new':
      if (!positional[0]) throw new Error('Uso: mockup new <arquivo> [--name Nome]');
      await create(positional[0], typeof flags.name === 'string' ? flags.name : undefined);
      return;
    case 'doctor': {
      const report = await runDoctor({ command: parseLaunchKind(flags.command), port });
      console.log(flags.json === true ? JSON.stringify(report, null, 2) : formatDoctor(report));
      if (!report.ok) process.exitCode = 1;
      return;
    }
    case 'setup': {
      const target = positional[0];
      if (target !== 'claude' && target !== 'codex' && target !== 'all')
        throw new Error(
          'Uso: mockup setup claude|codex|all [--http] [--skill] [--print] [--command K]',
        );
      const r = runSetup(target as SetupTarget, {
        http: flags.http === true,
        skill: flags.skill === true,
        print: flags.print === true,
        command: parseLaunchKind(flags.command),
        port,
      });
      console.log(r.lines.join('\n'));
      if (r.code !== 0) process.exitCode = 1;
      return;
    }
    case 'install-cli':
    case 'uninstall-cli': {
      const binDir = typeof flags['bin-dir'] === 'string' ? flags['bin-dir'] : undefined;
      const r = (command === 'install-cli' ? installCli : uninstallCli)({ binDir });
      if (flags.quiet !== true) console.log(r.lines.join('\n'));
      process.exitCode = r.code;
      return;
    }
    case 'version':
    case '--version':
    case '-v':
      console.log(VERSION);
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
