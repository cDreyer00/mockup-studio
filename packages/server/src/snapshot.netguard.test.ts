import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { guardedFetchBytes, isPrivateAddress } from './snapshot/netguard.js';

describe('isPrivateAddress', () => {
  it('IPv4 privados, loopback, link-local, CGNAT, 0/8, multicast e reservados', () => {
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

  it('IPv4 públicos passam (inclusive nas bordas das faixas privadas)', () => {
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

  it('IPv6: loopback, não especificado, ULA, link-local e multicast bloqueados', () => {
    for (const ip of ['::1', '::', 'fc00::1', 'fd12:3456::1', 'fe80::1', 'febf::1', 'ff02::1']) {
      expect(isPrivateAddress(ip), ip).toBe(true);
    }
    expect(isPrivateAddress('[::1]')).toBe(true);
    expect(isPrivateAddress('fe80::1%eth0')).toBe(true);
  });

  it('IPv6 público passa', () => {
    expect(isPrivateAddress('2606:4700:4700::1111')).toBe(false);
    expect(isPrivateAddress('2001:4860:4860::8888')).toBe(false);
  });

  it('IPv4 mapeado em IPv6 vale pelo IPv4 (formas pontuada e hexadecimal)', () => {
    expect(isPrivateAddress('::ffff:127.0.0.1')).toBe(true);
    expect(isPrivateAddress('::ffff:7f00:1')).toBe(true);
    expect(isPrivateAddress('::ffff:10.1.2.3')).toBe(true);
    expect(isPrivateAddress('0:0:0:0:0:ffff:c0a8:101')).toBe(true);
    expect(isPrivateAddress('::ffff:8.8.8.8')).toBe(false);
    expect(isPrivateAddress('::ffff:808:808')).toBe(false);
  });

  it('texto que não é IP é tratado como bloqueado', () => {
    expect(isPrivateAddress('exemplo.com')).toBe(true);
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
      } else if (req.url === '/grande') {
        res.end(Buffer.alloc(2000));
      } else if (req.url === '/redir') {
        res.statusCode = 302;
        res.setHeader('location', '/ok');
        res.end();
      } else if (req.url === '/loop') {
        res.statusCode = 302;
        res.setHeader('location', '/loop');
        res.end();
      } else if (req.url === '/para-metadata') {
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

  it('IP literal de rede local é bloqueado sem origem confiável', async () => {
    await expect(guardedFetchBytes(`${base}/ok`, opts)).rejects.toThrow(
      'destino na rede local bloqueado: 127.0.0.1',
    );
    await expect(guardedFetchBytes('http://[::1]:1/x', opts)).rejects.toThrow(
      'destino na rede local bloqueado',
    );
    await expect(
      guardedFetchBytes(`${base}/ok`, { ...opts, trustedOrigin: 'https://exemplo.com' }),
    ).rejects.toThrow('rede local');
  });

  it('hostname que resolve para loopback é bloqueado (lookup)', async () => {
    const port = new URL(base).port;
    await expect(guardedFetchBytes(`http://localhost:${port}/ok`, opts)).rejects.toThrow(
      'destino na rede local bloqueado: localhost',
    );
  });

  it('origem confiável baixa, devolve o content-type sem parâmetros e segue redirecionamento local', async () => {
    const trustedOrigin = `${base}/pagina`;
    const r = await guardedFetchBytes(`${base}/ok`, { ...opts, trustedOrigin });
    expect(r.bytes.toString()).toBe('abc');
    expect(r.contentType).toBe('image/png');
    const via = await guardedFetchBytes(`${base}/redir`, { ...opts, trustedOrigin });
    expect(via.bytes.toString()).toBe('abc');
  });

  it('a exceção de origem confiável não vale para um salto de outra origem', async () => {
    await expect(
      guardedFetchBytes(`${base}/para-metadata`, { ...opts, trustedOrigin: base }),
    ).rejects.toThrow('destino na rede local bloqueado: 169.254.169.254');
  });

  it('limita bytes, HTTP de erro e laço de redirecionamentos', async () => {
    const trustedOrigin = base;
    await expect(guardedFetchBytes(`${base}/grande`, { ...opts, trustedOrigin })).rejects.toThrow(
      'limite',
    );
    await expect(guardedFetchBytes(`${base}/x`, { ...opts, trustedOrigin })).rejects.toThrow(
      'HTTP 404',
    );
    await expect(guardedFetchBytes(`${base}/loop`, { ...opts, trustedOrigin })).rejects.toThrow(
      'redirecionamentos demais',
    );
  });

  it('só http(s)', async () => {
    await expect(guardedFetchBytes('ftp://exemplo.com/x', opts)).rejects.toThrow('http(s)');
  });
});
