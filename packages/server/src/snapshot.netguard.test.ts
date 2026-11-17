import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { guardedFetchBytes, isPrivateAddress } from './snapshot/netguard.js';

describe('isPrivateAddress', () => {
  it('private IPv4, loopback, link-local, CGNAT, 0/8, multicast and reserved', () => {
    for (const ip of [
      '127.0.0.1',
      '127.255.255.254',
      '10.0.0.1',
      '172.16.0.1',
      '172.31.255.255',
      '192.168.1.1',
      '169.254.169.254',
      '100.64.0.1',
      '100.127.255.255',
      '0.0.0.0',
      '0.1.2.3',
      '224.0.0.1',
      '240.0.0.1',
      '255.255.255.255',
    ]) {
      expect(isPrivateAddress(ip), ip).toBe(true);
    }
  });

  it('public IPv4 passes (including at the edges of the private ranges)', () => {
    for (const ip of [
      '8.8.8.8',
      '1.1.1.1',
      '172.15.0.1',
      '172.32.0.1',
      '100.63.0.1',
      '100.128.0.1',
    ]) {
      expect(isPrivateAddress(ip), ip).toBe(false);
    }
  });

  it('IPv6: loopback, unspecified, ULA, link-local and multicast are blocked', () => {
    for (const ip of ['::1', '::', 'fc00::1', 'fd12:3456::1', 'fe80::1', 'febf::1', 'ff02::1']) {
      expect(isPrivateAddress(ip), ip).toBe(true);
    }
    expect(isPrivateAddress('[::1]')).toBe(true);
    expect(isPrivateAddress('fe80::1%eth0')).toBe(true);
  });

  it('public IPv6 passes', () => {
    expect(isPrivateAddress('2606:4700:4700::1111')).toBe(false);
    expect(isPrivateAddress('2001:4860:4860::8888')).toBe(false);
  });

  it('IPv4-mapped IPv6 follows the IPv4 (dotted and hexadecimal forms)', () => {
    expect(isPrivateAddress('::ffff:127.0.0.1')).toBe(true);
    expect(isPrivateAddress('::ffff:7f00:1')).toBe(true);
    expect(isPrivateAddress('::ffff:10.1.2.3')).toBe(true);
    expect(isPrivateAddress('0:0:0:0:0:ffff:c0a8:101')).toBe(true);
    expect(isPrivateAddress('::ffff:8.8.8.8')).toBe(false);
    expect(isPrivateAddress('::ffff:808:808')).toBe(false);
  });

  it('text that is not an IP is treated as blocked', () => {
    expect(isPrivateAddress('example.com')).toBe(true);
    expect(isPrivateAddress('999.1.1.1')).toBe(true);
  });
});

describe('guardedFetchBytes', () => {
  let server: http.Server;
  let base: string;
  beforeAll(async () => {
    server = http.createServer((req, res) => {
      if (req.url === '/ok') {
        res.setHeader('content-type', 'Image/PNG; charset=x');
        res.end('abc');
      } else if (req.url === '/big') {
        res.end(Buffer.alloc(2000));
      } else if (req.url === '/redir') {
        res.statusCode = 302;
        res.setHeader('location', '/ok');
        res.end();
      } else if (req.url === '/loop') {
        res.statusCode = 302;
        res.setHeader('location', '/loop');
        res.end();
      } else if (req.url === '/to-metadata') {
        res.statusCode = 302;
        res.setHeader('location', 'http://169.254.169.254/latest');
        res.end();
      } else {
        res.statusCode = 404;
        res.end();
      }
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  });

  const opts = { maxBytes: 1000, timeoutMs: 5000 };

  it('literal local-network IP is blocked without a trusted origin', async () => {
    await expect(guardedFetchBytes(`${base}/ok`, opts)).rejects.toThrow(
      'local-network destination blocked: 127.0.0.1',
    );
    await expect(guardedFetchBytes('http://[::1]:1/x', opts)).rejects.toThrow(
      'local-network destination blocked',
    );
    await expect(
      guardedFetchBytes(`${base}/ok`, { ...opts, trustedOrigin: 'https://example.com' }),
    ).rejects.toThrow('local-network');
  });

  it('hostname that resolves to loopback is blocked (lookup)', async () => {
    const port = new URL(base).port;
    await expect(guardedFetchBytes(`http://localhost:${port}/ok`, opts)).rejects.toThrow(
      'local-network destination blocked: localhost',
    );
  });

  it('trusted origin downloads, returns the content-type without parameters and follows a local redirect', async () => {
    const trustedOrigin = `${base}/page`;
    const r = await guardedFetchBytes(`${base}/ok`, { ...opts, trustedOrigin });
    expect(r.bytes.toString()).toBe('abc');
    expect(r.contentType).toBe('image/png');
    const via = await guardedFetchBytes(`${base}/redir`, { ...opts, trustedOrigin });
    expect(via.bytes.toString()).toBe('abc');
  });

  it('the trusted-origin exception does not apply to a hop to another origin', async () => {
    await expect(
      guardedFetchBytes(`${base}/to-metadata`, { ...opts, trustedOrigin: base }),
    ).rejects.toThrow('local-network destination blocked: 169.254.169.254');
  });

  it('limits bytes, HTTP errors and redirect loops', async () => {
    const trustedOrigin = base;
    await expect(guardedFetchBytes(`${base}/big`, { ...opts, trustedOrigin })).rejects.toThrow(
      'limit',
    );
    await expect(guardedFetchBytes(`${base}/x`, { ...opts, trustedOrigin })).rejects.toThrow(
      'HTTP 404',
    );
    await expect(guardedFetchBytes(`${base}/loop`, { ...opts, trustedOrigin })).rejects.toThrow(
      'too many redirects',
    );
  });

  it('http(s) only', async () => {
    await expect(guardedFetchBytes('ftp://example.com/x', opts)).rejects.toThrow('http(s)');
  });
});
