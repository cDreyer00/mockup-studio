import path from 'node:path';
import { StreamableHTTPError } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { McpError } from '@modelcontextprotocol/sdk/types.js';
import { describe, expect, it } from 'vitest';
import { parsePort, resolveNewDocument } from './commands.js';
import { isMockupHealth } from './discover.js';
import { isConnectionError } from './proxy.js';

describe('isConnectionError', () => {
  it('accepts connection errors', () => {
    expect(isConnectionError(Object.assign(new Error('x'), { code: 'ECONNREFUSED' }))).toBe(true);
    expect(
      isConnectionError(
        new TypeError('fetch failed', {
          cause: Object.assign(new Error(), { code: 'ECONNRESET' }),
        }),
      ),
    ).toBe(true);
    expect(isConnectionError(new StreamableHTTPError(404, 'Session not found'))).toBe(true);
  });
  it('rejects the others (without retrying calls)', () => {
    expect(isConnectionError(new StreamableHTTPError(500, 'x'))).toBe(false);
    expect(isConnectionError(new McpError(-32001, 'Request timed out'))).toBe(false);
    expect(isConnectionError(new Error('tool failed'))).toBe(false);
    expect(isConnectionError(null)).toBe(false);
  });
});

describe('isMockupHealth', () => {
  it('requires ok, name and version', () => {
    expect(isMockupHealth({ ok: true, name: 'mockup-studio', version: '0.1.0' })).toBe(true);
    expect(isMockupHealth({ ok: true })).toBe(false);
    expect(isMockupHealth({ status: 'ok' })).toBe(false);
    expect(isMockupHealth(null)).toBe(false);
  });
});

describe('parsePort', () => {
  it('accepts a valid number and undefined', () => {
    expect(parsePort('4747')).toBe(4747);
    expect(parsePort(undefined)).toBeUndefined();
  });
  it('rejects invalid values', () => {
    for (const v of ['abc', '-1', '70000', '1.5']) {
      expect(() => parsePort(v)).toThrow('--port requires an integer between 0 and 65535.');
    }
  });
});

describe('resolveNewDocument', () => {
  it('normalizes the extension and derives the name', () => {
    const a = resolveNewDocument('foo.json');
    expect(a.target).toBe(path.resolve('foo.mockup.json'));
    expect(a.docName).toBe('foo');
    expect(resolveNewDocument('a.mockup.json').target).toBe(path.resolve('a.mockup.json'));
    expect(resolveNewDocument('b').target).toBe(path.resolve('b.mockup.json'));
    expect(resolveNewDocument('b', 'Mine').docName).toBe('Mine');
  });
});
