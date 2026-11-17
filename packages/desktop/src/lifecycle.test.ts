import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  dataDirOverride,
  existingDaemonAction,
  mergeFiles,
  onAllWindowsClosed,
  shouldQuitAfterSessions,
} from './main/lifecycle.js';

const noArgs = { headless: false, files: [] as string[], cliArgs: [] as string[] };

describe('dataDirOverride', () => {
  it('without --data-dir or MOCKUP_DATA_DIR it does not change userData', () => {
    expect(dataDirOverride(noArgs, {})).toBeNull();
  });
  it('the user-provided --data-dir and MOCKUP_DATA_DIR change it; the flag wins', () => {
    expect(dataDirOverride(noArgs, { MOCKUP_DATA_DIR: 'a' })).toBe(path.resolve('a'));
    expect(dataDirOverride({ ...noArgs, dataDir: 'b' }, { MOCKUP_DATA_DIR: 'a' })).toBe(
      path.resolve('b'),
    );
  });
});

describe('closed windows and MCP sessions', () => {
  it('headless never quits when windows close', () => {
    expect(onAllWindowsClosed(true, 0)).toBe('stay');
    expect(onAllWindowsClosed(true, 3)).toBe('stay');
  });
  it('with active sessions it watches; without sessions it quits', () => {
    expect(onAllWindowsClosed(false, 2)).toBe('watch');
    expect(onAllWindowsClosed(false, 0)).toBe('quit');
  });
  it('the watch quits when the sessions drop to zero, unless headless or a window is open', () => {
    expect(shouldQuitAfterSessions(false, false, 1)).toBe(false);
    expect(shouldQuitAfterSessions(false, false, 0)).toBe(true);
    expect(shouldQuitAfterSessions(false, true, 0)).toBe(false);
    expect(shouldQuitAfterSessions(true, false, 0)).toBe(false);
  });
});

describe('taking over the port', () => {
  it('only takes over a daemon without render', () => {
    expect(existingDaemonAction({ render: false })).toBe('takeover');
    expect(existingDaemonAction({ render: true })).toBe('use');
  });
  it('mergeFiles merges without repeats', () => {
    expect(
      mergeFiles(['a.mockup.json', 'b.mockup.json'], ['A.mockup.json', 'c.mockup.json']),
    ).toEqual(['a.mockup.json', 'b.mockup.json', 'c.mockup.json']);
  });
});
