import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  dataDirOverride,
  existingDaemonAction,
  mergeFiles,
  onAllWindowsClosed,
  shouldQuitAfterSessions,
} from './main/lifecycle.js';

const noArgs = { headless: false, files: [] as string[] };

describe('dataDirOverride', () => {
  it('sem --data-dir nem MOCKUP_DATA_DIR não troca o userData', () => {
    expect(dataDirOverride(noArgs, {})).toBeNull();
  });
  it('--data-dir e MOCKUP_DATA_DIR do usuário trocam; a flag vence', () => {
    expect(dataDirOverride(noArgs, { MOCKUP_DATA_DIR: 'a' })).toBe(path.resolve('a'));
    expect(dataDirOverride({ ...noArgs, dataDir: 'b' }, { MOCKUP_DATA_DIR: 'a' })).toBe(
      path.resolve('b'),
    );
  });
});

describe('janelas fechadas e sessões MCP', () => {
  it('headless nunca sai por fechar janelas', () => {
    expect(onAllWindowsClosed(true, 0)).toBe('stay');
    expect(onAllWindowsClosed(true, 3)).toBe('stay');
  });
  it('com sessões ativas vigia; sem sessões sai', () => {
    expect(onAllWindowsClosed(false, 2)).toBe('watch');
    expect(onAllWindowsClosed(false, 0)).toBe('quit');
  });
  it('a vigia sai quando as sessões zeram, salvo headless ou janela aberta', () => {
    expect(shouldQuitAfterSessions(false, false, 1)).toBe(false);
    expect(shouldQuitAfterSessions(false, false, 0)).toBe(true);
    expect(shouldQuitAfterSessions(false, true, 0)).toBe(false);
    expect(shouldQuitAfterSessions(true, false, 0)).toBe(false);
  });
});

describe('assumir a porta', () => {
  it('só assume daemon sem render', () => {
    expect(existingDaemonAction({ render: false })).toBe('takeover');
    expect(existingDaemonAction({ render: true })).toBe('use');
  });
  it('mergeFiles junta sem repetir', () => {
    expect(
      mergeFiles(['a.mockup.json', 'b.mockup.json'], ['A.mockup.json', 'c.mockup.json']),
    ).toEqual(['a.mockup.json', 'b.mockup.json', 'c.mockup.json']);
  });
});
