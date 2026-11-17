import { describe, expect, it } from 'vitest';
import { iframeSandbox, isLoopbackHost } from './iframeSandbox';

const ORIGIN = 'http://localhost:5173';
const FULL = 'allow-scripts allow-same-origin allow-popups';
const OPAQUE = 'allow-scripts allow-popups';

describe('iframeSandbox', () => {
  it('external URL keeps allow-same-origin', () => {
    expect(iframeSandbox('https://example.com/widget', ORIGIN)).toBe(FULL);
    expect(iframeSandbox('http://128.0.0.1/', ORIGIN)).toBe(FULL);
  });

  it('loopback and same origin end up without allow-same-origin', () => {
    for (const u of [
      'http://localhost:4000/',
      'http://app.localhost/x',
      'http://LOCALHOST./',
      'http://127.0.0.1:7777/',
      'http://127.5.6.7/',
      'http://0.0.0.0:80/',
      'http://[::1]:3000/',
      'http://[::ffff:127.0.0.1]/',
      'http://2130706433/',
    ])
      expect(iframeSandbox(u, 'https://other.dev'), u).toBe(OPAQUE);
    expect(iframeSandbox('https://studio.dev/app', 'https://studio.dev')).toBe(OPAQUE);
  });

  it('invalid URL falls back to the most restrictive', () => {
    expect(iframeSandbox('not a url', ORIGIN)).toBe(OPAQUE);
  });

  it('isLoopbackHost', () => {
    expect(isLoopbackHost('[::1]')).toBe(true);
    expect(isLoopbackHost('example.com')).toBe(false);
    expect(isLoopbackHost('localhost.evil.com')).toBe(false);
  });
});
