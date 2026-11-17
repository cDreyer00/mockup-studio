/** Decisões puras do ciclo de vida do app (testáveis sem Electron). */
import path from 'node:path';
import type { AppArgs } from './args.js';

/**
 * Pasta de dados que troca o `userData` (e, com ele, o lock de instância única): só quando o
 * usuário a pediu (`--data-dir` ou `MOCKUP_DATA_DIR` já definida antes de iniciar). Sem isso o app
 * aberto pelo menu Iniciar e o headless do CLI usam o mesmo lock e viram uma só instância.
 */
export function dataDirOverride(args: AppArgs, env: NodeJS.ProcessEnv): string | null {
  const raw = args.dataDir || env.MOCKUP_DATA_DIR;
  return raw ? path.resolve(raw) : null;
}

export type WindowsClosedAction = 'stay' | 'watch' | 'quit';

/** O que fazer quando a última janela fecha. */
export function onAllWindowsClosed(
  startedHeadless: boolean,
  sessions: number,
): WindowsClosedAction {
  if (startedHeadless) return 'stay';
  return sessions > 0 ? 'watch' : 'quit';
}

/** Verificação periódica em modo headless-após-fechar: sai quando as sessões MCP zeram. */
export function shouldQuitAfterSessions(
  startedHeadless: boolean,
  hasWindow: boolean,
  sessions: number,
): boolean {
  return !startedHeadless && !hasWindow && sessions <= 0;
}

/** Intervalo da verificação de sessões MCP (ms). */
export const SESSION_WATCH_MS = 5000;

/** Porta ocupada por outro daemon do Mockup Studio: assumir (sem render) ou usar o existente. */
export function existingDaemonAction(health: { render?: boolean }): 'takeover' | 'use' {
  return health.render === false ? 'takeover' : 'use';
}

/** Documentos a abrir ao assumir: os do daemon anterior e os do argv, sem repetir. */
export function mergeFiles(previous: string[], argv: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const f of [...previous, ...argv]) {
    const k = path.resolve(f).toLowerCase();
    if (!seen.has(k)) {
      seen.add(k);
      out.push(f);
    }
  }
  return out;
}
