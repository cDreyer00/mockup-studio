#!/usr/bin/env node
import { create, open, parsePort, serve, stop } from './commands.js';
import { formatDoctor, runDoctor } from './doctor.js';
import { installCli, uninstallCli } from './install.js';
import { parseLaunchKind } from './launch.js';
import { runStdioProxy } from './proxy.js';
import { runSetup, type SetupTarget } from './setup.js';
import { VERSION } from './version.js';

// parsePort lives in commands.ts (importing this file runs the CLI); re-exported for convenience.
export { parsePort };

const HELP = `mockup - Mockup Studio CLI

Usage:
  mockup mcp                       MCP server over stdio (starts the daemon if needed;
                                   uses headless Electron when available, with screenshots)
  mockup serve [--port N] [file...] Node daemon in the foreground (editor at http://127.0.0.1:PORT/)
  mockup serve --render [file...]  Headless Electron in the foreground (with screenshots)
  mockup open <file>               Opens a .mockup.json in the daemon
  mockup new <file> [--name N]     Creates a .mockup.json and opens it
  mockup stop                      Stops the discovered daemon (Node daemon or headless Electron),
                                   saving the documents; the desktop app with a window refuses
  mockup doctor [--json] [--command K]
                                   Environment diagnostics and ready-made registration commands
  mockup setup claude|codex|all [--http] [--skill] [--print] [--command K] [--force]
                                [--approve] [--agents]
                                   Registers the MCP server in Claude Code/Codex. If it is already registered
                                   with the same command, does nothing; if it differs, updates it while
                                   preserving the Codex config (--force recreates from scratch). --print
                                   only shows the commands; --skill installs the skill in Claude Code;
                                   --approve (Codex) writes default_tools_approval_mode = "approve";
                                   --agents (Codex) appends the snippet to ~/.codex/AGENTS.md;
                                   K = path|shim|absolute: how the client launches mockup
  mockup install-cli [--bin-dir D] [--quiet]
                                   Installs the mockup command (shim + user PATH)
  mockup uninstall-cli [--bin-dir D] [--quiet]
                                   Removes the shim and the PATH entry
  mockup version                   CLI version
  mockup help

Variables: MOCKUP_PORT (default 4747), MOCKUP_DATA_DIR (data folder; passed to the app only if set),
           MOCKUP_DESKTOP_EXE (desktop app executable), MOCKUP_NO_ELECTRON=1 (forces the Node daemon).`;

interface Parsed {
  command: string | undefined;
  positional: string[];
  flags: Record<string, string | boolean>;
}

/** Flags without a value (they do not consume the next argument). */
const BOOLEAN_FLAGS = new Set([
  'render',
  'http',
  'skill',
  'print',
  'json',
  'quiet',
  'force',
  'approve',
  'agents',
]);

function parseArgs(argv: string[]): Parsed {
  const [command, ...rest] = argv;
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      const k = eq === -1 ? a.slice(2) : a.slice(2, eq);
      const inline = eq === -1 ? undefined : a.slice(eq + 1);
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
      if (!positional[0]) throw new Error('Usage: mockup open <file>');
      await open(positional[0]);
      return;
    case 'new':
      if (!positional[0]) throw new Error('Usage: mockup new <file> [--name Name]');
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
          'Usage: mockup setup claude|codex|all [--http] [--skill] [--print] [--command K] [--force] [--approve] [--agents]',
        );
      const r = runSetup(target as SetupTarget, {
        http: flags.http === true,
        skill: flags.skill === true,
        print: flags.print === true,
        force: flags.force === true,
        approve: flags.approve === true,
        agents: flags.agents === true,
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
    case 'help':
    case '--help':
    case '-h':
      console.log(HELP);
      return;
    case undefined:
      console.error(HELP);
      return;
    default:
      throw new Error(`Unknown command: ${command}\n\n${HELP}`);
  }
}

main().catch((err: unknown) => {
  console.error('[mockup] error:', err instanceof Error ? err.message : err);
  process.exit(1);
});
